import { type AnchorPolicy, Geometry } from "./geometry";
import { createGestureSensor, type GestureSensor } from "./gesture";
import { type Glide, glideDuration, startGlide } from "./glide";

// The lean runtime: one commit pipeline over the geometry kernel, one scroll
// arbiter, a keyed DOM renderer, and the gesture sensor gating when commits
// may move the viewport.
//
// Every logical update runs as one transaction (I4):
//   capture anchor intent → mutate geometry → resolve one absolute scroll
//   target → apply (canvas size, one optional scroll write, mount/update/
//   position/unmount by key) → publish events.
// Host callbacks run only after the commit; API calls made from them are
// queued as the next transaction's input — there is no reentrancy machinery
// because there is no reentrancy.
//
// ResizeObserver measurements commit synchronously inside the observer
// callback — after layout, before paint — so a discrete in-row height change
// lands in the same painted frame (I6). During an active user gesture,
// structural updates (non-appends) and above-viewport measurements are
// deferred and flushed as one transaction on settle; everything else commits
// immediately with no scroll write, since its resolved target is the current
// position.
//
// Edge chrome does not exist here (I3): `onReachStart/End` are proximity
// signals; loaders are the host's overlays.

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
const EDGE_PROXIMITY_PX = 800;
const MEASURE_EPSILON_PX = 0.5;
const SCROLL_WRITE_EPSILON_PX = 0.5;
const AT_EDGE_EPSILON_PX = 1;

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
  const keyByElement = new WeakMap<HTMLElement, string>();

  // --- Deferred work (flushed as one transaction on gesture settle) ---------
  let deferredItems: {
    items: readonly T[];
    anchor: AnchorPolicy;
  } | null = null;
  const deferredMeasures = new Map<string, number>();
  const afterCommit: (() => void)[] = [];

  let inTransaction = false;
  let disposed = false;
  let glide: Glide | null = null;
  let reachStartArmed = true;
  let reachEndArmed = true;
  let lastState: VirtualListState | null = null;

  function viewportHeight(): number {
    return viewport.clientHeight;
  }

  function currentViewport(): { scrollTop: number; height: number } {
    return { scrollTop: viewport.scrollTop, height: viewportHeight() };
  }

  // --- The commit pipeline --------------------------------------------------
  function transaction(policy: AnchorPolicy, mutate: () => void): void {
    if (disposed) return;
    if (inTransaction) {
      // I4: calls from host callbacks are the next transaction's input.
      afterCommit.push(() => transaction(policy, mutate));
      return;
    }
    inTransaction = true;
    try {
      const capture = geometry.capture(currentViewport(), policy);
      mutate();
      const commit = geometry.resolve(capture);

      canvas.style.height = `${commit.totalSize}px`;
      if (
        !sensor.active &&
        Math.abs(commit.scrollTop - viewport.scrollTop) >
          SCROLL_WRITE_EPSILON_PX
      ) {
        sensor.expectWrite(commit.scrollTop);
        viewport.scrollTop = commit.scrollTop;
      }
      renderWindow();
    } finally {
      inTransaction = false;
    }
    publish();
    while (afterCommit.length > 0) afterCommit.shift()?.();
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
      }
    }

    for (const key of wanted) {
      const item = itemByKey.get(key);
      if (item === undefined) continue;
      let element = mounted.get(key);
      if (element === undefined) {
        element = mountElement(key, render(item));
      }
      element.style.transform = `translateY(${geometry.offsetOf(key)}px)`;
    }
  }

  function mountElement(key: string, element: HTMLElement): HTMLElement {
    element.style.position = "absolute";
    element.style.top = "0";
    element.style.left = "0";
    element.style.right = "0";
    mounted.set(key, element);
    keyByElement.set(element, key);
    canvas.appendChild(element);
    itemResizeObserver.observe(element);
    return element;
  }

  /** Re-render rows whose item object changed identity (streaming updates). */
  function updateChangedRows(previous: Map<string, T>): void {
    for (const [key, element] of mounted) {
      const item = itemByKey.get(key);
      if (item === undefined || previous.get(key) === item) continue;
      const next = render(item, element);
      if (next !== element) {
        itemResizeObserver.unobserve(element);
        keyByElement.delete(element);
        element.replaceWith(next);
        mountElement(key, next);
      }
    }
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
    },
    onSettle: () => {
      if (disposed) return;
      const pendingItems = deferredItems;
      deferredItems = null;
      const previous = itemByKey;
      // One flush transaction: structural update, deferred measures, and the
      // reserve re-evaluation (released reserve drains once out of view).
      transaction(pendingItems?.anchor ?? "viewport", () => {
        if (pendingItems) adoptItems(pendingItems.items);
        for (const [key, height] of deferredMeasures) {
          geometry.measure(key, height);
        }
        deferredMeasures.clear();
      });
      if (pendingItems) updateChangedRows(previous);
    },
  });

  viewport.addEventListener("scroll", handleScroll, { passive: true });
  function handleScroll(): void {
    if (disposed || inTransaction) return;
    // Geometry is unchanged by scrolling; only the window and signals move.
    renderWindow();
    publish();
  }

  // --- Events ---------------------------------------------------------------
  function publish(): void {
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

    // Proximity signals, re-armed after leaving the zone (I3).
    const nearStart = vp.scrollTop <= EDGE_PROXIMITY_PX;
    const nearEnd = maxTop - vp.scrollTop <= EDGE_PROXIMITY_PX;
    if (nearStart && reachStartArmed) {
      reachStartArmed = false;
      options.onReachStart?.();
    } else if (!nearStart) {
      reachStartArmed = true;
    }
    if (nearEnd && reachEndArmed) {
      reachEndArmed = false;
      options.onReachEnd?.();
    } else if (!nearEnd) {
      reachEndArmed = true;
    }
  }

  // --- Data -----------------------------------------------------------------
  function adoptItems(next: readonly T[]): void {
    items = [...next];
    itemByKey = new Map(items.map((item) => [keyOf(item), item]));
    geometry.setKeys(items.map(keyOf));
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
    const anchor = setOptions.anchor ?? "auto";
    if (sensor.active && !isEndCompatible(next)) {
      // Structural change mid-gesture: latest snapshot wins at settle.
      deferredItems = { items: next, anchor };
      return;
    }
    const previous = itemByKey;
    transaction(anchor, () => adoptItems(next));
    updateChangedRows(previous);
  }

  // --- Commands -------------------------------------------------------------
  function scrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" } = {},
  ): void {
    if (disposed) return;
    glide?.cancel();

    // A keyed target with align:"start" reserves the shortfall (I5) inside
    // the same transaction that computes the destination.
    transaction("none", () => {
      if (target !== "start" && target !== "end") geometry.pin(target);
    });

    const destination = (): number => {
      const height = viewportHeight();
      if (target === "start") return 0;
      if (target === "end") return geometry.maxScrollTop(height);
      const offset = geometry.offsetOf(target);
      return offset < 0
        ? viewport.scrollTop
        : Math.min(offset, geometry.maxScrollTop(height));
    };

    if (scrollOptions.behavior !== "smooth") {
      const top = destination();
      sensor.expectWrite(top);
      viewport.scrollTop = top;
      renderWindow();
      publish();
      return;
    }

    glide = startGlide(
      {
        read: () => viewport.scrollTop,
        write: (top) => {
          sensor.expectWrite(top);
          viewport.scrollTop = top;
          renderWindow();
        },
        target: destination,
      },
      glideDuration(destination() - viewport.scrollTop, viewportHeight()),
      () => {
        glide = null;
        publish();
      },
    );
  }

  // --- Boot -----------------------------------------------------------------
  transaction("end", () => adoptItems(options.items));

  return {
    setItems,
    scrollTo,
    get state(): VirtualListState {
      return lastState ?? { ...publishInitial() };
    },
    dispose(): void {
      disposed = true;
      glide?.cancel();
      sensor.dispose();
      itemResizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      canvas.remove();
      mounted.clear();
    },
  };

  function publishInitial(): VirtualListState {
    publish();
    return lastState as VirtualListState;
  }
}
