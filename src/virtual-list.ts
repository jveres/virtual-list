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
// explicit command > user gesture > end-anchor > position-anchor. A command
// issued during an active gesture takes the viewport over immediately —
// the sensor is interrupted (trailing momentum absorbed in its grace
// window), the gesture shift is exchanged, deferred geometry flushes, and
// the command starts, all in one guarded operation. Anchor-driven writes
// still yield to an active gesture until settle.
//
// End-follow is explicit state: engaged when a commit lands at the end,
// disengaged when the user scrolls upward, re-engaged when they return to
// the end. A gesture suppresses the write of an end-resolved commit but not
// its intent — the settle flush runs with the "end" policy and lands
// exactly (I2).
//
// ResizeObserver measurements commit synchronously inside the observer
// callback — after layout, before paint — so a discrete in-row height change
// lands in the same painted frame (I6). Measurements always commit; during
// a gesture the runtime writes NO scrollTop — the anchor-preserving delta
// is applied as a temporary canvas translation (the gesture shift) and
// exchanged for one scrollTop write at settle, in the same frame.
// Structural and explicitly anchored updates defer during a gesture and
// flush at settle (the explicit policy is honored there); once a snapshot
// is deferred, every later one replaces it (latest wins).
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
  /**
   * A row's element left the DOM — scrolled out of the window, replaced by
   * a new element from render(item, existing), or removed by dispose().
   * `item` is the item the element was last rendered with.
   */
  onUnmount?: (element: HTMLElement, item: T) => void;
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
  /**
   * Resolves true when the command landed on its target, false when it was
   * interrupted (user gesture, newer command, dispose) or the target does
   * not exist. Always settles, dispose() included.
   */
  scrollTo(
    target: string | "start" | "end",
    options?: { align?: "start"; behavior?: "auto" | "smooth" },
  ): Promise<boolean>;
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

  // --- Deferred work (flushed on gesture settle) ----------------------------
  let deferredItems: {
    items: readonly T[];
    anchor: AnchorPolicy;
  } | null = null;
  const afterCommit: { run: () => void; discard?: () => void }[] = [];

  let inTransaction = false;
  let disposed = false;
  let glide: Glide | null = null;
  let following = false;
  let lastScrollTop = 0;
  let gestureHighWaterTop = 0;
  // Content-coordinate offset accumulated during a gesture (see the gesture
  // shift below): content scrollTop = viewport.scrollTop + gestureShiftPx.
  let gestureShiftPx = 0;
  let reachStartArmed = true;
  let reachEndArmed = true;
  let lastState: VirtualListState | null = null;

  function viewportHeight(): number {
    return viewport.clientHeight;
  }

  function currentViewport(): { scrollTop: number; height: number } {
    return {
      scrollTop: viewport.scrollTop + gestureShiftPx,
      height: viewportHeight(),
    };
  }

  function atEndTop(top: number): boolean {
    return geometry.maxScrollTop(viewportHeight()) - top <= AT_EDGE_EPSILON_PX;
  }

  /**
   * I4: while a transaction is open, API calls queue as its successors.
   * `discard` runs if the queued work is dropped by dispose(), so pending
   * command promises always settle.
   */
  function enqueueDuringCommit(
    work: () => void,
    discard?: () => void,
  ): boolean {
    if (!inTransaction) return false;
    afterCommit.push({ run: work, discard });
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

  /**
   * The gesture shift: while the user owns the viewport, the runtime writes
   * NO scrollTop at all. An anchor-preserving correction (content above the
   * anchor changed size) is applied as a temporary canvas translation of the
   * opposite delta, so the page stays still under the user's finger (I1
   * during gestures) with zero scroll writes. Content coordinates diverge
   * from raw scrollTop by the accumulated shift; currentViewport() bridges
   * the two. At settle the translation is exchanged for one scrollTop write
   * in the same frame — visually a no-op.
   */
  function applyGestureShift(delta: number): void {
    if (Math.abs(delta) <= SCROLL_WRITE_EPSILON_PX) return;
    gestureShiftPx += delta;
    canvas.style.transform = `translateY(${-gestureShiftPx}px)`;
  }

  function reconcileGestureShift(): void {
    if (gestureShiftPx === 0) return;
    const target = Math.min(
      Math.max(0, viewport.scrollTop + gestureShiftPx),
      geometry.maxScrollTop(viewportHeight()),
    );
    gestureShiftPx = 0;
    canvas.style.transform = "";
    sensor.expectWrite(target);
    viewport.scrollTop = target;
    lastScrollTop = target;
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
    while (!disposed && afterCommit.length > 0) afterCommit.shift()?.run();
  }

  function transaction(
    policy: AnchorPolicy,
    mutate: () => void,
    compensate = false,
  ): void {
    if (disposed) return;
    if (enqueueDuringCommit(() => transaction(policy, mutate, compensate))) {
      return;
    }
    guarded(() => commitOnce(policy, mutate, compensate));
  }

  function commitOnce(
    policy: AnchorPolicy,
    mutate: () => void,
    compensate = false,
  ): void {
    const vp = currentViewport();
    const capture = geometry.capture(vp, policy);
    mutate();
    const commit = geometry.resolve(capture);

    canvas.style.height = `${commit.totalSize}px`;
    if (arbitratedWrite(commit.scrollTop)) {
      following = atEndTop(commit.scrollTop);
    } else if (compensate) {
      // Zero scrollTop writes during a gesture: the anchor delta becomes a
      // canvas translation instead, reconciled at settle.
      applyGestureShift(commit.scrollTop - vp.scrollTop);
    }
    // A gesture-refused moving write keeps its intent: `following` is
    // untouched and the settle flush lands on the end exactly (I2).
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
        const item = renderedItem.get(key);
        renderedItem.delete(key);
        if (item !== undefined) options.onUnmount?.(element, item);
        if (disposed) return;
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
        observeItem(element);
        renderedItem.set(key, item);
      } else if (renderedItem.get(key) !== item) {
        // Changed identity (streaming updates): re-render in place. A
        // replacement element takes over the row's bookkeeping and is
        // positioned below like any other — inside the transaction.
        const previous = renderedItem.get(key);
        const next = render(item, element);
        if (disposed) return;
        renderedItem.set(key, item);
        if (next !== element) {
          itemResizeObserver.unobserve(element);
          keyByElement.delete(element);
          element.replaceWith(next);
          const replaced = element;
          element = adoptElement(key, next);
          observeItem(element);
          if (previous !== undefined) {
            options.onUnmount?.(replaced, previous);
          }
          if (disposed) return;
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
  // Observing an element from inside the observer's own delivery schedules a
  // notification that cannot be delivered in the same loop — the browser
  // reports "ResizeObserver loop completed with undelivered notifications".
  // Rows mounted by a measurement commit are therefore registered on the
  // next frame; their heights stay estimates until then, which is the same
  // one-delivery latency every fresh mount has.
  let inMeasurementDelivery = false;
  const pendingObserves: HTMLElement[] = [];
  let observeFlushFrame = 0;

  function observeItem(element: HTMLElement): void {
    if (!inMeasurementDelivery) {
      itemResizeObserver.observe(element);
      return;
    }
    pendingObserves.push(element);
    if (observeFlushFrame === 0) {
      observeFlushFrame = requestAnimationFrame(() => {
        observeFlushFrame = 0;
        for (const pending of pendingObserves) {
          const key = keyByElement.get(pending);
          if (key !== undefined && mounted.get(key) === pending) {
            itemResizeObserver.observe(pending);
          }
        }
        pendingObserves.length = 0;
      });
    }
  }

  const itemResizeObserver = new ResizeObserver((entries) => {
    if (disposed) return;
    const measures: [string, number][] = [];
    for (const entry of entries) {
      const key = keyByElement.get(entry.target as HTMLElement);
      if (key === undefined || !mounted.has(key)) continue;
      const height =
        entry.borderBoxSize?.[0]?.blockSize ??
        (entry.target as HTMLElement).getBoundingClientRect().height;
      if (Math.abs(height - geometry.heightOf(key)) <= MEASURE_EPSILON_PX) {
        continue; // Noise suppression lives here, not in the kernel.
      }
      measures.push([key, height]);
    }
    if (measures.length === 0) return;
    // Measurements always commit — deferring them would leave mounted rows
    // positioned by stale geometry and visually overlapping mid-gesture.
    // While the user owns the viewport, the commit anchors to the visible
    // item and applies as a pure compensation write; end-follow catch-up
    // still happens at settle (I2).
    const gesture = sensor.active;
    inMeasurementDelivery = true;
    try {
      transaction(
        gesture ? "viewport" : "auto",
        () => {
          for (const [key, height] of measures) geometry.measure(key, height);
        },
        gesture,
      );
    } finally {
      inMeasurementDelivery = false;
    }
  });

  const viewportResizeObserver = new ResizeObserver(() => {
    if (disposed) return;
    // Compensated: a mid-gesture viewport resize (mobile URL bar) must not
    // shift the anchor either.
    transaction("viewport", () => {}, sensor.active);
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
      // Exchange the gesture shift for its one scrollTop write (visually a
      // no-op) before anything reads raw positions.
      reconcileGestureShift();
      // Returning to the end by hand re-engages following.
      if (atEndTop(viewport.scrollTop)) following = true;
      const pendingItems = deferredItems;
      deferredItems = null;
      // One flush transaction: the deferred structural update, reserve
      // re-evaluation (released reserve drains once out of view) — and
      // the suppressed end-follow catch-up (I2).
      transaction(
        pendingItems?.anchor ?? (following ? "end" : "viewport"),
        () => {
          if (pendingItems) adoptItems(pendingItems.items);
        },
      );
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
  ): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    // Options are normalized into a runtime-owned object at call time.
    const owned = {
      align: scrollOptions.align,
      behavior: scrollOptions.behavior,
    };
    return new Promise((resolve) => {
      if (
        enqueueDuringCommit(
          () => {
            void scrollTo(target, owned).then(resolve);
          },
          // dispose() drops the queue; the command resolves interrupted.
          () => resolve(false),
        )
      ) {
        return;
      }
      guarded(() => {
        if (sensor.active) {
          // Explicit command > gesture (documented precedence): take the
          // viewport over NOW — end the gesture without settling (the
          // sensor absorbs trailing momentum in its grace window),
          // exchange the gesture shift, flush the deferred snapshot, and
          // start the command; one guarded operation.
          sensor.interrupt();
          reconcileGestureShift();
          const pendingItems = deferredItems;
          deferredItems = null;
          if (pendingItems) {
            commitOnce(pendingItems.anchor, () =>
              adoptItems(pendingItems.items),
            );
            if (disposed) {
              resolve(false);
              return;
            }
          }
        }
        performScrollTo(target, owned, resolve);
      });
    });
  }

  /** The command body; runs only when no gesture is active. */
  function performScrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" },
    done: (completed: boolean) => void,
  ): void {
    // A keyed target can vanish mid-glide (a snapshot removed it); the
    // glide then holds position and the command resolves interrupted —
    // "true" means landed on the target, and the target no longer exists.
    let targetLost = false;
    const destination = (): number => {
      const height = viewportHeight();
      if (target === "start") return 0;
      if (target === "end") return geometry.maxScrollTop(height);
      const offset = geometry.offsetOf(target);
      if (offset < 0) {
        targetLost = true;
        return viewport.scrollTop;
      }
      return Math.min(offset, geometry.maxScrollTop(height));
    };

    // The whole command — glide interruption, pin commit (a keyed target
    // with align:"start" reserves the shortfall, I5), write or glide start,
    // render, publish — is ONE guarded operation. A newer command queued by
    // a callback inside it (including the cancelled glide's onDone
    // publication) drains only afterwards, so it executes last and wins.
    guarded(() => {
      // A target that does not exist resolves interrupted without touching
      // anything — no pin, no glide cancellation, no movement. This also
      // covers a gesture-deferred command whose key the settle snapshot
      // removed (the flush commit runs before the command).
      if (
        target !== "start" &&
        target !== "end" &&
        geometry.indexOf(target) < 0
      ) {
        done(false);
        return;
      }
      // Cancelling a prior glide resolves its command as interrupted.
      glide?.cancel();
      if (disposed) {
        done(false);
        return;
      }
      commitOnce("none", () => {
        if (target !== "start" && target !== "end") geometry.pin(target);
      });
      if (disposed) {
        done(false);
        return;
      }

      if (scrollOptions.behavior !== "smooth") {
        arbitratedWrite(destination());
        following = atEndTop(viewport.scrollTop);
        renderWindow();
        if (disposed) {
          done(false);
          return;
        }
        publish();
        done(!disposed);
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
        // A policy function: a rebase (prepend moved the position, snapshot
        // moved the target) re-derives the pace for the remaining distance.
        (distancePx) => glideDuration(distancePx, viewportHeight()),
        (completed) =>
          guarded(() => {
            glide = null;
            following = atEndTop(viewport.scrollTop);
            if (!disposed) publish();
            done(completed && !targetLost && !disposed);
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
      // Dropped queued work still settles its promises (discard hooks).
      for (const entry of afterCommit) entry.discard?.();
      afterCommit.length = 0;
      glide?.cancel();
      sensor.dispose();
      gestureShiftPx = 0;
      if (observeFlushFrame !== 0) cancelAnimationFrame(observeFlushFrame);
      pendingObserves.length = 0;
      itemResizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      canvas.remove();
      // Every mounted row leaves the DOM with the canvas; report each so
      // hosts can tear down per-row resources.
      for (const [key, element] of mounted) {
        const item = renderedItem.get(key);
        if (item !== undefined) options.onUnmount?.(element, item);
      }
      mounted.clear();
      renderedItem.clear();
    },
  };

  function publishInitial(): VirtualListState {
    publish();
    return lastState as VirtualListState;
  }
}
