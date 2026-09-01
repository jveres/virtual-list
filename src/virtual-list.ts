import { type AnchorPolicy, Geometry } from "./geometry";
import { createGestureSensor, type GestureSensor } from "./gesture";
import { type Glide, glideDuration, startGlide } from "./glide";

// The runtime: one commit pipeline over the geometry kernel, one scroll
// arbiter, a keyed DOM renderer, and the gesture sensor gating when commits
// may move the viewport.
//
// Every logical update runs as one transaction (I4):
//   capture anchor intent → mutate geometry → resolve one absolute scroll
//   target → apply (canvas size, one arbitrated scroll write, keyed
//   mount/update/position/unmount) → publish events.
// The transaction guard stays up through DOM reconciliation AND publication:
// API calls made from host callbacks queue and run after the callbacks
// return, as the next transactions' input.
//
// The arbiter is the only scrollTop writer, with the documented precedence:
// an active user gesture refuses all writes; explicit commands issued during
// a gesture defer to settle (where they outrank the anchors); end-anchor and
// position-anchor targets come from the kernel's resolve.
//
// End-follow is explicit state: engaged when a commit lands at the end,
// disengaged when the user scrolls upward, re-engaged when they return to
// the end. A gesture suppresses the write of an end-resolved commit but not
// its intent — the settle flush runs with the "end" policy and lands
// exactly (I2).
//
// ResizeObserver measurements commit synchronously inside the observer
// callback — after layout, before paint — so a discrete in-row height change
// lands in the same painted frame (I6). During an active user gesture,
// structural updates, explicitly anchored updates, and above-viewport
// corrections defer and flush at settle (the explicit policy is honored
// there); once a snapshot is deferred, every later one replaces it
// (latest wins).
//
// Edge chrome does not exist here (I3): `onReachStart/End` are proximity
// signals with entry/exit hysteresis; loaders are the host's overlays.

export interface VirtualListOptions<T> {
  items: readonly T[];
  key: (item: T) => string;
  render: (item: T, existing?: HTMLElement) => HTMLElement;
  /** Height guess for unmeasured items; finite and > 0 (enforced). */
  estimateSize?: number | ((item: T) => number);
  overscanPx?: number;
  onState?: (state: VirtualListState) => void;
  onReachStart?: () => void;
  onReachEnd?: () => void;
}

export interface VirtualListState {
  count: number;
  start: number;
  end: number;
  atStart: boolean;
  atEnd: boolean;
  totalSize: number;
}

export interface VirtualList<T> {
  setItems(items: readonly T[], options?: { anchor?: AnchorPolicy }): void;
  scrollTo(
    target: string | "start" | "end",
    options?: { align?: "start"; behavior?: "auto" | "smooth" },
  ): void;
  readonly state: VirtualListState;
  dispose(): void;
}

const DEFAULT_ESTIMATE_PX = 100;
const EDGE_ENTER_PX = 800;
const EDGE_EXIT_PX = 1200;
const MEASURE_EPSILON_PX = 0.5;
const SCROLL_WRITE_EPSILON_PX = 0.5;
const AT_EDGE_EPSILON_PX = 1;
const FOLLOW_DISENGAGE_PX = 2;

export function createVirtualList<T>(
  viewport: HTMLElement,
  options: VirtualListOptions<T>,
): VirtualList<T> {
  const { key: keyOf, render } = options;
  const overscanPx = options.overscanPx ?? Math.max(300, viewportHeight());

  // --- Owned snapshot -------------------------------------------------------
  let items: readonly T[] = [];
  let itemByKey = new Map<string, T>();
  const estimateOption = options.estimateSize ?? DEFAULT_ESTIMATE_PX;
  const geometry = new Geometry(
    typeof estimateOption === "number"
      ? estimateOption
      : (key) => {
          const item = itemByKey.get(key);
          return item === undefined
            ? DEFAULT_ESTIMATE_PX
            : estimateOption(item);
        },
  );

  // --- DOM ------------------------------------------------------------------
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  canvas.style.overflowAnchor = "none";
  viewport.appendChild(canvas);

  const mounted = new Map<string, HTMLElement>();
  const renderedItem = new Map<string, T>();
  const keyByElement = new WeakMap<HTMLElement, string>();

  // --- Deferred work (flushed as one transaction on gesture settle) ---------
  let deferredItems: {
    items: readonly T[];
    anchor: AnchorPolicy;
  } | null = null;
  const deferredMeasures = new Map<string, number>();
  let pendingCommand: {
    target: string;
    options: { align?: "start"; behavior?: "auto" | "smooth" };
  } | null = null;
  const afterCommit: (() => void)[] = [];

  let inTransaction = false;
  let disposed = false;
  let glide: Glide | null = null;
  let following = false;
  let lastScrollTop = 0;
  let gestureHighWaterTop = 0;
  let reachStartArmed = true;
  let reachEndArmed = true;
  let lastState: VirtualListState | null = null;

  function viewportHeight(): number {
    return viewport.clientHeight;
  }

  function currentViewport(): { scrollTop: number; height: number } {
    return { scrollTop: viewport.scrollTop, height: viewportHeight() };
  }

  function atEndTop(top: number): boolean {
    return geometry.maxScrollTop(viewportHeight()) - top <= AT_EDGE_EPSILON_PX;
  }

  /** I4: while a transaction is open, API calls queue as its successors. */
  function enqueueDuringCommit(work: () => void): boolean {
    if (!inTransaction) return false;
    afterCommit.push(work);
    return true;
  }

  // --- The scroll arbiter (the only scrollTop writer) -----------------------
  /** Returns false when an active user gesture owns the viewport. */
  function arbitratedWrite(top: number): boolean {
    if (sensor.active) return false;
    if (Math.abs(top - viewport.scrollTop) > SCROLL_WRITE_EPSILON_PX) {
      sensor.expectWrite(top);
      viewport.scrollTop = top;
      lastScrollTop = top;
    }
    return true;
  }

  // --- The commit pipeline --------------------------------------------------
  /**
   * Run one complete logical operation under the I4 guard: host callbacks
   * invoked anywhere inside (render, onState, edge signals) see their API
   * calls queued, and the queue drains only after the whole operation — so
   * a newer command queued mid-operation always executes last and wins.
   */
  function guarded(work: () => void): void {
    if (inTransaction) {
      work(); // Nested inside an open guard: the outer drain handles it.
      return;
    }
    inTransaction = true;
    try {
      work();
    } finally {
      inTransaction = false;
    }
    while (!disposed && afterCommit.length > 0) afterCommit.shift()?.();
  }

  function transaction(policy: AnchorPolicy, mutate: () => void): void {
    if (disposed) return;
    if (enqueueDuringCommit(() => transaction(policy, mutate))) return;
    guarded(() => commitOnce(policy, mutate));
  }

  function commitOnce(policy: AnchorPolicy, mutate: () => void): void {
    const capture = geometry.capture(currentViewport(), policy);
    mutate();
    const commit = geometry.resolve(capture);

    canvas.style.height = `${commit.totalSize}px`;
    if (arbitratedWrite(commit.scrollTop)) {
      following = atEndTop(commit.scrollTop);
    }
    // A gesture-refused write keeps its intent: `following` is untouched
    // and the settle flush lands on the end exactly (I2).
    renderWindow();
    if (disposed) return;
    publish();
  }

  // --- Keyed renderer -------------------------------------------------------
  function renderWindow(): void {
    const range = geometry.window(currentViewport(), overscanPx);
    const wanted = new Set<string>();
    for (let index = range.start; index < range.end; index++) {
      const key = geometry.keyAt(index);
      if (key !== undefined) wanted.add(key);
    }

    for (const [key, element] of mounted) {
      if (!wanted.has(key)) {
        itemResizeObserver.unobserve(element);
        element.remove();
        mounted.delete(key);
        renderedItem.delete(key);
      }
    }

    for (const key of wanted) {
      const item = itemByKey.get(key);
      if (item === undefined) continue;
      let element = mounted.get(key);
      if (element === undefined) {
        const created = render(item);
        // render() is a host callback: it may dispose the list, and then
        // reconciliation must abort — no appends, observes, or bookkeeping
        // on a torn-down canvas.
        if (disposed) return;
        element = adoptElement(key, created);
        canvas.appendChild(element);
        itemResizeObserver.observe(element);
        renderedItem.set(key, item);
      } else if (renderedItem.get(key) !== item) {
        // Changed identity (streaming updates): re-render in place. A
        // replacement element takes over the row's bookkeeping and is
        // positioned below like any other — inside the transaction.
        const next = render(item, element);
        if (disposed) return;
        renderedItem.set(key, item);
        if (next !== element) {
          itemResizeObserver.unobserve(element);
          keyByElement.delete(element);
          element.replaceWith(next);
          element = adoptElement(key, next);
          itemResizeObserver.observe(element);
        }
      }
      element.style.transform = `translateY(${geometry.offsetOf(key)}px)`;
    }
  }

  function adoptElement(key: string, element: HTMLElement): HTMLElement {
    element.style.position = "absolute";
    element.style.top = "0";
    element.style.left = "0";
    element.style.right = "0";
    mounted.set(key, element);
    keyByElement.set(element, key);
    return element;
  }

  // --- Measurements (I6: same painted frame) --------------------------------
  const itemResizeObserver = new ResizeObserver((entries) => {
    if (disposed) return;
    const scrollTop = viewport.scrollTop;
    const immediate: [string, number][] = [];
    for (const entry of entries) {
      const key = keyByElement.get(entry.target as HTMLElement);
      if (key === undefined || !mounted.has(key)) continue;
      const height =
        entry.borderBoxSize?.[0]?.blockSize ??
        (entry.target as HTMLElement).getBoundingClientRect().height;
      if (Math.abs(height - geometry.heightOf(key)) <= MEASURE_EPSILON_PX) {
        continue; // Noise suppression lives here, not in the kernel.
      }
      const wholeItemAbove =
        geometry.offsetOf(key) + geometry.heightOf(key) <= scrollTop;
      if (sensor.active && wholeItemAbove) {
        // Above-viewport corrections would need a scroll write mid-gesture;
        // hold them for the settle flush.
        deferredMeasures.set(key, height);
      } else {
        immediate.push([key, height]);
      }
    }
    if (immediate.length > 0) {
      transaction("auto", () => {
        for (const [key, height] of immediate) geometry.measure(key, height);
      });
    }
  });

  const viewportResizeObserver = new ResizeObserver(() => {
    if (disposed) return;
    transaction("viewport", () => {});
  });
  viewportResizeObserver.observe(viewport);

  // --- Gesture sensor + settle flush ----------------------------------------
  const sensor: GestureSensor = createGestureSensor(viewport, {
    onStart: () => {
      glide?.cancel();
      // Disengagement is cumulative per gesture, from the downward
      // high-water mark — the pre-gesture position or the first event's,
      // whichever is lower on the page.
      gestureHighWaterTop = Math.max(viewport.scrollTop, lastScrollTop);
    },
    onSettle: () => {
      if (disposed) return;
      // Returning to the end by hand re-engages following.
      if (atEndTop(viewport.scrollTop)) following = true;
      const pendingItems = deferredItems;
      deferredItems = null;
      const command = pendingCommand;
      pendingCommand = null;
      // The whole settle — flush transaction AND the gesture-deferred
      // command — is ONE guarded boundary: a newer command queued by the
      // flush's publication drains only afterward, so it executes after
      // the older deferred one and wins.
      guarded(() => {
        // One flush commit: the deferred structural update, deferred
        // measures, reserve re-evaluation (released reserve drains once
        // out of view) — and the suppressed end-follow catch-up (I2).
        commitOnce(
          pendingItems?.anchor ?? (following ? "end" : "viewport"),
          () => {
            if (pendingItems) adoptItems(pendingItems.items);
            for (const [key, height] of deferredMeasures) {
              geometry.measure(key, height);
            }
            deferredMeasures.clear();
          },
        );
        if (disposed) return;
        // The deferred command executes inside the boundary, outranking
        // the anchor policies it settled with.
        if (command) performScrollTo(command.target, command.options);
      });
    },
  });

  viewport.addEventListener("scroll", handleScroll, { passive: true });
  function handleScroll(): void {
    if (disposed || inTransaction) return;
    const top = viewport.scrollTop;
    if (sensor.active) {
      if (top > gestureHighWaterTop) {
        gestureHighWaterTop = top;
      } else if (top < gestureHighWaterTop - FOLLOW_DISENGAGE_PX) {
        // Cumulative upward motion beyond the threshold disengages follow
        // until the user returns to the end — measured against the
        // gesture's high-water mark, so sub-pixel per-event jitter cannot
        // scroll away without ever disarming.
        following = false;
      }
    }
    lastScrollTop = top;
    // Geometry is unchanged by scrolling; only the window and signals move.
    guarded(() => {
      renderWindow();
      if (!disposed) publish();
    });
  }

  // --- Events ---------------------------------------------------------------
  function publish(): void {
    if (disposed) return;
    const vp = currentViewport();
    const range = geometry.window(vp, overscanPx);
    const maxTop = geometry.maxScrollTop(vp.height);
    const state: VirtualListState = {
      count: geometry.count,
      start: range.start,
      end: range.end,
      atStart: vp.scrollTop <= AT_EDGE_EPSILON_PX,
      atEnd: maxTop - vp.scrollTop <= AT_EDGE_EPSILON_PX,
      totalSize: geometry.totalSize,
    };
    const changed =
      lastState === null ||
      Object.entries(state).some(
        ([field, value]) =>
          lastState?.[field as keyof VirtualListState] !== value,
      );
    lastState = state;
    if (changed) options.onState?.(state);
    if (disposed) return; // Disposal from a callback halts publication.

    // Proximity signals with entry/exit hysteresis (I3): fire on entering
    // the near zone, re-arm only after leaving the wider exit zone — so
    // oscillation on the boundary cannot refire.
    const startDistance = vp.scrollTop;
    const endDistance = maxTop - vp.scrollTop;
    if (startDistance <= EDGE_ENTER_PX && reachStartArmed) {
      reachStartArmed = false;
      options.onReachStart?.();
    } else if (startDistance > EDGE_EXIT_PX) {
      reachStartArmed = true;
    }
    if (disposed) return;
    if (endDistance <= EDGE_ENTER_PX && reachEndArmed) {
      reachEndArmed = false;
      options.onReachEnd?.();
    } else if (endDistance > EDGE_EXIT_PX) {
      reachEndArmed = true;
    }
  }

  // --- Data -----------------------------------------------------------------
  function adoptItems(next: readonly T[]): void {
    const nextItems = [...next];
    const nextByKey = new Map(nextItems.map((item) => [keyOf(item), item]));
    // The estimator closure reads itemByKey, so validation must see the
    // candidate snapshot — swap in, validate, roll back on failure, keeping
    // runtime data and geometry coherent either way.
    const previousItems = items;
    const previousByKey = itemByKey;
    items = nextItems;
    itemByKey = nextByKey;
    try {
      geometry.setKeys(nextItems.map(keyOf));
    } catch (error) {
      items = previousItems;
      itemByKey = previousByKey;
      throw error;
    }
  }

  function isEndCompatible(next: readonly T[]): boolean {
    if (next.length < geometry.count) return false;
    for (let index = 0; index < geometry.count; index++) {
      if (keyOf(next[index] as T) !== geometry.keyAt(index)) return false;
    }
    return true;
  }

  function setItems(
    next: readonly T[],
    setOptions: { anchor?: AnchorPolicy } = {},
  ): void {
    if (disposed) return;
    // Inputs are captured at call time — the caller's array stays theirs,
    // and mutating it after the call (even from inside a callback, before
    // the queued operation runs) cannot leak into the runtime.
    const snapshot = [...next];
    const anchor = setOptions.anchor ?? "auto";
    if (enqueueDuringCommit(() => applySetItems(snapshot, anchor))) return;
    applySetItems(snapshot, anchor);
  }

  /** `snapshot` is runtime-owned (copied by setItems at call time). */
  function applySetItems(snapshot: readonly T[], anchor: AnchorPolicy): void {
    if (disposed) return;
    // Mid-gesture, only "auto" end-compatible updates commit immediately
    // (their resolved target is where the user already is). Everything else
    // defers: structural changes, and any explicit anchor policy — settle
    // must honor the stated policy, not re-derive one from follow state.
    // Once anything is deferred, every later snapshot replaces it (latest
    // wins; a newer update must not leapfrog an older deferred one).
    if (
      sensor.active &&
      (deferredItems !== null ||
        anchor !== "auto" ||
        !isEndCompatible(snapshot))
    ) {
      deferredItems = { items: snapshot, anchor };
      return;
    }
    transaction(anchor, () => adoptItems(snapshot));
  }

  // --- Commands -------------------------------------------------------------
  function scrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" } = {},
  ): void {
    if (disposed) return;
    // Options are normalized into a runtime-owned object at call time.
    const owned = {
      align: scrollOptions.align,
      behavior: scrollOptions.behavior,
    };
    if (enqueueDuringCommit(() => scrollTo(target, owned))) return;
    if (sensor.active) {
      // The user owns the viewport (documented precedence); the command
      // defers to settle, latest wins.
      pendingCommand = { target, options: owned };
      return;
    }
    performScrollTo(target, owned);
  }

  /** The command body; runs only when no gesture is active. */
  function performScrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" },
  ): void {
    const destination = (): number => {
      const height = viewportHeight();
      if (target === "start") return 0;
      if (target === "end") return geometry.maxScrollTop(height);
      const offset = geometry.offsetOf(target);
      return offset < 0
        ? viewport.scrollTop
        : Math.min(offset, geometry.maxScrollTop(height));
    };

    // The whole command — glide interruption, pin commit (a keyed target
    // with align:"start" reserves the shortfall, I5), write or glide start,
    // render, publish — is ONE guarded operation. A newer command queued by
    // a callback inside it (including the cancelled glide's onDone
    // publication) drains only afterwards, so it executes last and wins.
    guarded(() => {
      glide?.cancel();
      if (disposed) return;
      commitOnce("none", () => {
        if (target !== "start" && target !== "end") geometry.pin(target);
      });
      if (disposed) return;

      if (scrollOptions.behavior !== "smooth") {
        arbitratedWrite(destination());
        following = atEndTop(viewport.scrollTop);
        renderWindow();
        if (!disposed) publish();
        return;
      }

      glide = startGlide(
        {
          read: () => viewport.scrollTop,
          write: (top) =>
            // Guarded: mounting invokes the host's render() callback.
            guarded(() => {
              if (arbitratedWrite(top)) renderWindow();
            }),
          target: destination,
        },
        glideDuration(destination() - viewport.scrollTop, viewportHeight()),
        () =>
          guarded(() => {
            glide = null;
            following = atEndTop(viewport.scrollTop);
            publish();
          }),
      );
    });
  }

  // --- Boot -----------------------------------------------------------------
  transaction("end", () => adoptItems(options.items));
  lastScrollTop = viewport.scrollTop;

  return {
    setItems,
    scrollTo,
    get state(): VirtualListState {
      return lastState ?? { ...publishInitial() };
    },
    dispose(): void {
      // Terminal and immediate, deliberately not queued: callable from any
      // host callback, it halts publication mid-flight (publish checks
      // `disposed` around every callback) and empties the pending queue.
      if (disposed) return;
      disposed = true;
      afterCommit.length = 0;
      glide?.cancel();
      sensor.dispose();
      itemResizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      canvas.remove();
      mounted.clear();
      renderedItem.clear();
    },
  };

  function publishInitial(): VirtualListState {
    publish();
    return lastState as VirtualListState;
  }
}
