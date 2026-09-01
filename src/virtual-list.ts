import { type AnchorPolicy, Geometry } from "./geometry";
import { type Glide, glideDuration, startGlide } from "./glide";
import { createItemMeasurer, type ItemMeasurer } from "./premeasure";
import {
  createScrollSettleController,
  detectScrollSettleStrategy,
  type ScrollSettleController,
  type VirtualListScrollSettleStrategy,
} from "./scroll-settle";

// The v2 runtime, built on the two preserved primitives — the browser-
// adaptive scroll-settle controller and detached premeasurement — under
// the core contract (docs/lean-core.md):
//
// 1. While a scroll phase is active (native gesture OR programmatic glide),
//    the scroll surface's GEOMETRY is immutable: key order, heights,
//    offsets, canvas size, scroll range. Only window reconciliation — the
//    mounting and unmounting of already-committed rows at their fixed
//    positions — runs during scrolling.
// 2. Every change is PREPARED off-scroller: new and re-rendered rows are
//    built and premeasured in the detached measurement root; the resulting
//    node is retained and is what mounts.
// 3. Only when the phase settles (or immediately while idle) does ONE
//    atomic commit apply keys, heights, canvas geometry, the mounted window,
//    and a single anchor-preserving scroll write.
// 4. A mounted row lives inside a dimensionally stable SLOT (fixed height,
//    overflow hidden). Same-key content changes — streaming text, toggles,
//    late images, font swaps — may mutate the row any time: the slot clips
//    them, geometry stays put, and the row is marked dirty; its real height
//    is read in place at the next commit. Idle: the commit is immediate,
//    in the same frame as the ResizeObserver delivery.
//
// There is no compensation machinery: no mid-gesture corrections, no
// canvas translation, no "safe update" exceptions. What v1 patched cannot
// occur here because geometry never changes under a live scroll.

export interface ReachContext {
  /**
   * Aborted when the runtime objectively knows the load is no longer
   * wanted: the user reached the OPPOSITE edge, or the list was disposed.
   * Wire fetches to it; ignore it to keep a scrollback fetch alive.
   */
  signal: AbortSignal;
}

export interface VirtualListOptions<T> {
  items: readonly T[];
  key: (item: T) => string;
  /**
   * Build a row's element, or update `existing` in place for a same-key
   * item change (return it) or replace it (return a new element). Runs
   * off-scroller for unmounted rows; for mounted rows an in-place update
   * mutates inside the row's fixed slot.
   */
  render: (item: T, existing?: HTMLElement) => HTMLElement;
  overscanPx?: number;
  onState?: (state: VirtualListState) => void;
  onReachStart?: (context: ReachContext) => void;
  onReachEnd?: (context: ReachContext) => void;
  /**
   * The runtime is done with this element forever — its key was removed,
   * it was superseded by a replacement render, its prepared snapshot was
   * superseded before committing, or the list was disposed. Tear down
   * per-element resources here; called exactly once per element.
   */
  onDestroy?: (element: HTMLElement, item: T) => void;
  /** Settle strategy override (labs and tests); auto-detected otherwise. */
  settleStrategy?: VirtualListScrollSettleStrategy;
}

export interface VirtualListState {
  count: number;
  start: number;
  end: number;
  atStart: boolean;
  atEnd: boolean;
  totalSize: number;
  /** A prepared snapshot or dirty measurements are waiting for settle. */
  held: boolean;
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

const EDGE_ENTER_PX = 800;
const EDGE_EXIT_PX = 1200;
const MEASURE_EPSILON_PX = 0.5;
const SCROLL_WRITE_EPSILON_PX = 0.5;
const AT_EDGE_EPSILON_PX = 1;

interface Row<T> {
  key: string;
  item: T;
  element: HTMLElement;
  /** Dimensionally stable container: fixed committed height, overflow hidden. */
  slot: HTMLElement;
  height: number;
  mounted: boolean;
  /** Content changed (or the width did): re-measure at the next commit. */
  dirty: boolean;
}

interface Prepared<T> {
  items: readonly T[];
  keys: readonly string[];
  itemByKey: Map<string, T>;
  /** Rows built and premeasured off-scroller for new or replaced keys. */
  newRows: Map<string, Row<T>>;
  anchor: AnchorPolicy;
}

export function createVirtualList<T>(
  viewport: HTMLElement,
  options: VirtualListOptions<T>,
): VirtualList<T> {
  const { key: keyOf, render } = options;
  const overscanPx = options.overscanPx ?? Math.max(300, viewport.clientHeight);

  // --- Committed state --------------------------------------------------------
  // Heights are never estimated: every key is measured before it commits,
  // so the kernel's estimate is only a validation placeholder.
  const geometry = new Geometry(1);
  const rows = new Map<string, Row<T>>();

  // --- Pending work (waits for the scroll phase to settle) ------------------
  let pending: Prepared<T> | null = null;
  let anyDirty = false;

  // --- DOM ------------------------------------------------------------------
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  canvas.style.overflowAnchor = "none";
  viewport.appendChild(canvas);
  const measurer: ItemMeasurer = createItemMeasurer({ viewport });

  let disposed = false;
  let inCommit = false;
  const afterCommit: { run: () => void; discard?: () => void }[] = [];
  let glide: Glide | null = null;
  let glideTarget: (() => number) | null = null;
  let lastState: VirtualListState | null = null;
  let reachStartArmed = true;
  let reachEndArmed = true;
  let reachStartAbort: AbortController | null = null;
  let reachEndAbort: AbortController | null = null;

  function viewportState(): { scrollTop: number; height: number } {
    return { scrollTop: viewport.scrollTop, height: viewport.clientHeight };
  }

  function idle(): boolean {
    return !controller.isUserScrollActive();
  }

  // --- Reentrancy (I4): API calls from host callbacks queue behind the commit
  function enqueueDuringCommit(
    work: () => void,
    discard?: () => void,
  ): boolean {
    if (!inCommit) return false;
    afterCommit.push({ run: work, discard });
    return true;
  }

  function guarded(work: () => void): void {
    if (inCommit) {
      work();
      return;
    }
    inCommit = true;
    try {
      work();
    } finally {
      inCommit = false;
    }
    while (!disposed && afterCommit.length > 0) afterCommit.shift()?.run();
  }

  // --- Rows: build, measure, retain, destroy --------------------------------
  function createSlot(): HTMLElement {
    const slot = document.createElement("div");
    slot.style.position = "absolute";
    slot.style.top = "0";
    slot.style.left = "0";
    slot.style.right = "0";
    slot.style.overflow = "hidden";
    return slot;
  }

  /** Build a fresh row off-scroller: render, premeasure, retain. */
  function buildRow(key: string, item: T): Row<T> {
    const { element, height } = measurer.measure(() => render(item));
    const slot = createSlot();
    slot.appendChild(element);
    slot.style.height = `${height}px`;
    return { key, item, element, slot, height, mounted: false, dirty: false };
  }

  /** Re-render an existing (retained or mounted) row for a changed item. */
  function updateRow(row: Row<T>, item: T): Row<T> {
    const next = render(item, row.element);
    if (next === row.element) {
      // In place: mounted rows mutate inside their fixed slot (clipped
      // until commit); unmounted rows mutate off-scroller. Either way the
      // real height is read at the next commit.
      row.item = item;
      row.dirty = true;
      return row;
    }
    // Replacement element: premeasure it off-scroller into a new row; the
    // old one is destroyed when the replacement commits.
    const { element, height } = measurer.measure(() => next);
    const slot = createSlot();
    slot.appendChild(element);
    slot.style.height = `${height}px`;
    return {
      key: row.key,
      item,
      element,
      slot,
      height,
      mounted: false,
      dirty: false,
    };
  }

  function destroyRow(row: Row<T>): void {
    if (row.mounted) unmountRow(row);
    row.slot.remove();
    options.onDestroy?.(row.element, row.item);
  }

  /** A retained, unmounted row is measured detached with the width synced. */
  function remeasureDetached(row: Row<T>): number {
    const { height } = measurer.measure(() => row.element);
    row.slot.appendChild(row.element); // The measurer detaches it.
    return height;
  }

  function measureInPlace(row: Row<T>): number {
    const height = row.element.getBoundingClientRect().height;
    return Number.isFinite(height) && height > 0 ? height : row.height;
  }

  // --- Measurements: ResizeObserver marks mounted rows dirty ----------------
  // Observing from inside the observer's own delivery schedules
  // undeliverable notifications ("loop completed with undelivered
  // notifications"); registrations made during a delivery wait a frame.
  let inMeasurementDelivery = false;
  const pendingObserves: HTMLElement[] = [];
  let observeFlushFrame = 0;
  const keyByElement = new WeakMap<HTMLElement, string>();

  function observeRow(row: Row<T>): void {
    keyByElement.set(row.element, row.key);
    if (!inMeasurementDelivery) {
      rowObserver.observe(row.element);
      return;
    }
    pendingObserves.push(row.element);
    if (observeFlushFrame === 0) {
      observeFlushFrame = requestAnimationFrame(() => {
        observeFlushFrame = 0;
        for (const element of pendingObserves) {
          const key = keyByElement.get(element);
          const row = key === undefined ? undefined : rows.get(key);
          if (row && row.element === element && row.mounted) {
            rowObserver.observe(element);
          }
        }
        pendingObserves.length = 0;
      });
    }
  }

  const rowObserver = new ResizeObserver((entries) => {
    if (disposed) return;
    let changed = false;
    for (const entry of entries) {
      const key = keyByElement.get(entry.target as HTMLElement);
      const row = key === undefined ? undefined : rows.get(key);
      if (!row?.mounted || row.element !== entry.target) continue;
      const height =
        entry.borderBoxSize?.[0]?.blockSize ??
        (entry.target as HTMLElement).getBoundingClientRect().height;
      if (Math.abs(height - row.height) <= MEASURE_EPSILON_PX) continue;
      row.dirty = true;
      changed = true;
    }
    if (!changed) return;
    anyDirty = true;
    // Idle: commit in the same frame as the delivery (after layout, before
    // paint — I6). Scrolling: the slot clips; the commit waits for settle.
    inMeasurementDelivery = true;
    try {
      if (idle()) flush(null);
      else publish();
    } finally {
      inMeasurementDelivery = false;
    }
  });

  // A width change invalidates every held measurement: mounted rows are
  // re-read in place, retained rows re-premeasured, all at the next commit.
  let lastViewportWidth = viewport.clientWidth;
  const viewportObserver = new ResizeObserver(() => {
    if (disposed) return;
    const width = viewport.clientWidth;
    const widthChanged = Math.abs(width - lastViewportWidth) > 0.5;
    lastViewportWidth = width;
    if (widthChanged) {
      for (const row of rows.values()) row.dirty = true;
      if (pending) for (const row of pending.newRows.values()) row.dirty = true;
      anyDirty = rows.size > 0 || pending !== null;
    }
    if (idle()) flush(null, "viewport");
    else publish();
  });
  viewportObserver.observe(viewport);

  // --- Preparation (off-scroller) -------------------------------------------
  function prepare(next: readonly T[], anchor: AnchorPolicy): Prepared<T> {
    const keys = next.map(keyOf);
    const itemByKeyNext = new Map<string, T>();
    for (let index = 0; index < next.length; index++) {
      const key = keys[index] as string;
      if (itemByKeyNext.has(key)) {
        throw new Error(`duplicate key "${key}"`);
      }
      itemByKeyNext.set(key, next[index] as T);
    }

    const previous = pending;
    const newRows = new Map<string, Row<T>>();
    for (const key of keys) {
      const item = itemByKeyNext.get(key) as T;
      // A row prepared by a superseded pending snapshot is adopted when its
      // item is unchanged, re-rendered when it changed (a replacement
      // destroys it, exactly once), and never left for the sweep below.
      const preparedBefore = previous?.newRows.get(key);
      if (preparedBefore) {
        previous?.newRows.delete(key);
        if (preparedBefore.item === item) {
          newRows.set(key, preparedBefore);
        } else {
          const updated = updateRow(preparedBefore, item);
          if (updated !== preparedBefore) destroyRow(preparedBefore);
          newRows.set(key, updated);
        }
        continue;
      }
      const committed = rows.get(key);
      if (committed === undefined) {
        newRows.set(key, buildRow(key, item));
      } else if (committed.item !== item) {
        // In place: the committed row is now dirty. Replacement: the new
        // row commits over it, and the old one is destroyed at commit.
        const updated = updateRow(committed, item);
        if (updated !== committed) newRows.set(key, updated);
      }
    }
    // Whatever the superseded snapshot prepared and this one did not adopt.
    if (previous) {
      for (const row of previous.newRows.values()) destroyRow(row);
    }
    return { items: next, keys, itemByKey: itemByKeyNext, newRows, anchor };
  }

  // --- The atomic commit ----------------------------------------------------
  function flush(
    snapshot: Prepared<T> | null,
    policyOverride?: AnchorPolicy,
  ): void {
    if (disposed) return;
    guarded(() => {
      const applying = snapshot ?? pending;
      pending = null;
      const policy = policyOverride ?? applying?.anchor ?? "auto";
      const vp = viewportState();
      const capture = geometry.capture(vp, policy);

      if (applying) {
        // Keys and rows: drop removed, swap replaced, adopt new.
        const nextKeys = new Set(applying.keys);
        for (const [key, row] of rows) {
          if (!nextKeys.has(key)) {
            rows.delete(key);
            destroyRow(row);
          }
        }
        for (const [key, row] of applying.newRows) {
          const replaced = rows.get(key);
          if (replaced && replaced !== row) destroyRow(replaced);
          rows.set(key, row);
        }
        for (const [key, item] of applying.itemByKey) {
          const row = rows.get(key);
          if (row) row.item = item;
        }
        geometry.setKeys(applying.keys);
        for (const row of applying.newRows.values()) {
          if (!row.dirty && !geometry.isMeasured(row.key)) {
            geometry.measure(row.key, row.height);
          }
        }
      }

      // Latest heights, exactly once: dirty rows are re-read now.
      for (const row of rows.values()) {
        if (!row.dirty && geometry.isMeasured(row.key)) continue;
        const height = row.mounted
          ? measureInPlace(row)
          : row.dirty
            ? remeasureDetached(row)
            : row.height;
        row.dirty = false;
        row.height = height;
        row.slot.style.height = `${height}px`;
        geometry.measure(row.key, height);
      }
      anyDirty = false;

      const commit = geometry.resolve(capture);
      canvas.style.height = `${commit.totalSize}px`;
      if (
        Math.abs(commit.scrollTop - viewport.scrollTop) >
        SCROLL_WRITE_EPSILON_PX
      ) {
        controller.recordProgrammaticScrollTop(commit.scrollTop);
        viewport.scrollTop = commit.scrollTop;
      }
      reconcileWindow();
      if (disposed) return;
      publish();
    });
  }

  // --- Window reconciliation (allowed during scrolling) ---------------------
  function mountRow(row: Row<T>): void {
    row.mounted = true;
    canvas.appendChild(row.slot);
    observeRow(row);
  }

  function unmountRow(row: Row<T>): void {
    row.mounted = false;
    rowObserver.unobserve(row.element);
    row.slot.remove();
  }

  function reconcileWindow(): void {
    const range = geometry.window(viewportState(), overscanPx);
    const wanted = new Set<string>();
    for (let index = range.start; index < range.end; index++) {
      const key = geometry.keyAt(index);
      if (key !== undefined) wanted.add(key);
    }
    for (const row of rows.values()) {
      if (row.mounted && !wanted.has(row.key)) unmountRow(row);
    }
    for (const key of wanted) {
      const row = rows.get(key);
      if (!row) continue;
      if (!row.mounted) mountRow(row);
      row.slot.style.transform = `translateY(${geometry.offsetOf(key)}px)`;
    }
  }

  // --- Events ---------------------------------------------------------------
  function publish(): void {
    if (disposed) return;
    const vp = viewportState();
    const range = geometry.window(vp, overscanPx);
    const maxTop = geometry.maxScrollTop(vp.height);
    const state: VirtualListState = {
      count: geometry.count,
      start: range.start,
      end: range.end,
      atStart: vp.scrollTop <= AT_EDGE_EPSILON_PX,
      atEnd: maxTop - vp.scrollTop <= AT_EDGE_EPSILON_PX,
      totalSize: geometry.totalSize,
      held: pending !== null || anyDirty,
    };
    const changed =
      lastState === null ||
      (Object.keys(state) as (keyof VirtualListState)[]).some(
        (field) => lastState?.[field] !== state[field],
      );
    lastState = state;
    if (changed) options.onState?.(state);
    if (disposed) return;

    // Proximity signals with entry/exit hysteresis (I3). Reaching one edge
    // aborts the other edge's outstanding load: the user's intent moved on.
    const startDistance = vp.scrollTop;
    const endDistance = maxTop - vp.scrollTop;
    if (startDistance <= EDGE_ENTER_PX && reachStartArmed) {
      reachStartArmed = false;
      if (options.onReachStart) {
        reachEndAbort?.abort();
        reachEndAbort = null;
        reachStartAbort = new AbortController();
        options.onReachStart({ signal: reachStartAbort.signal });
      }
    } else if (startDistance > EDGE_EXIT_PX) {
      reachStartArmed = true;
    }
    if (disposed) return;
    if (endDistance <= EDGE_ENTER_PX && reachEndArmed) {
      reachEndArmed = false;
      if (options.onReachEnd) {
        reachStartAbort?.abort();
        reachStartAbort = null;
        reachEndAbort = new AbortController();
        options.onReachEnd({ signal: reachEndAbort.signal });
      }
    } else if (endDistance > EDGE_EXIT_PX) {
      reachEndArmed = true;
    }
  }

  // --- The settle controller (the scroll-phase authority) -------------------
  const controller: ScrollSettleController = createScrollSettleController({
    viewport,
    strategy: options.settleStrategy ?? detectScrollSettleStrategy(),
    measureEpsilon: MEASURE_EPSILON_PX,
    isDisposed: () => disposed,
    // Edge protection arms where the host can actually grow the list.
    canLoadAtBoundary: (boundary) =>
      boundary === "top"
        ? options.onReachStart !== undefined
        : options.onReachEnd !== undefined,
    cancelActiveSmoothScroll: () => glide?.cancel(),
    smoothScrollReachedTarget: () =>
      glide === null ||
      glideTarget === null ||
      Math.abs(viewport.scrollTop - glideTarget()) <= 2,
    onGestureActivity: () => {},
    onGestureStarted: () => {},
    onGestureSettled: () => {
      // The phase reached idle: everything held commits, once.
      if (pending !== null || anyDirty) flush(null);
      else publish();
    },
    onGestureReset: () => {},
    onScrollEventObserved: () => {
      if (disposed || inCommit) return;
      // Geometry is untouchable here; only the window moves.
      guarded(() => {
        reconcileWindow();
        publish();
      });
    },
    onNativeScrollEndIdle: () => {},
  });

  /**
   * An explicit command takes the viewport over: genuinely stop the
   * browser-owned animation (a clamped write plus an overflow toggle
   * through a forced reflow — merely clearing timers would leave momentum
   * alive), then settle the phase so held work commits before the command.
   */
  function interruptNativeScroll(): void {
    if (!controller.isUserScrollActive()) return;
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const currentTop = Math.max(0, Math.min(viewport.scrollTop, maxTop));
    controller.recordProgrammaticScrollTop(currentTop);
    viewport.scrollTop = currentTop;
    const previousOverflowY = viewport.style.overflowY;
    viewport.style.overflowY = "hidden";
    void viewport.offsetHeight;
    viewport.style.overflowY = previousOverflowY;
    viewport.scrollTop = currentTop;
    controller.finishGesture();
  }

  // --- Data -----------------------------------------------------------------
  function setItems(
    next: readonly T[],
    setOptions: { anchor?: AnchorPolicy } = {},
  ): void {
    if (disposed) return;
    const snapshot = [...next];
    const anchor = setOptions.anchor ?? "auto";
    if (enqueueDuringCommit(() => applyItems(snapshot, anchor))) return;
    applyItems(snapshot, anchor);
  }

  function applyItems(snapshot: readonly T[], anchor: AnchorPolicy): void {
    if (disposed) return;
    // Always prepared now (off-scroller, inside the reentrancy guard since
    // render() is a host callback); committed now only when idle.
    guarded(() => {
      const prepared = prepare(snapshot, anchor);
      if (idle()) {
        flush(prepared);
      } else {
        pending = prepared;
        publish();
      }
    });
  }

  // --- Commands -------------------------------------------------------------
  function scrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" } = {},
  ): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
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
          () => resolve(false),
        )
      ) {
        return;
      }
      guarded(() => performScrollTo(target, owned, resolve));
    });
  }

  function performScrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" },
    done: (completed: boolean) => void,
  ): void {
    const keyed = target !== "start" && target !== "end";
    // Explicit command > gesture: take the viewport over, settling held
    // work first so the command sees committed geometry.
    interruptNativeScroll();
    glide?.cancel(); // A prior command resolves interrupted.
    if (disposed) {
      done(false);
      return;
    }
    if (keyed && geometry.indexOf(target) < 0) {
      done(false);
      return;
    }
    // A keyed target with align:"start" reserves the shortfall (I5) — a
    // geometry change, committed now (the phase is idle).
    if (keyed && scrollOptions.align === "start") {
      geometry.pin(target);
      flush(null, "none");
    }

    let targetLost = false;
    const destination = (): number => {
      const height = viewport.clientHeight;
      if (target === "start") return 0;
      if (target === "end") return geometry.maxScrollTop(height);
      const offset = geometry.offsetOf(target);
      if (offset < 0) {
        targetLost = true;
        return viewport.scrollTop;
      }
      return Math.min(offset, geometry.maxScrollTop(height));
    };

    if (scrollOptions.behavior !== "smooth") {
      const top = destination();
      if (Math.abs(top - viewport.scrollTop) > SCROLL_WRITE_EPSILON_PX) {
        controller.recordProgrammaticScrollTop(top);
        viewport.scrollTop = top;
      }
      reconcileWindow();
      publish();
      done(!disposed);
      return;
    }

    // A glide is a programmatic scroll phase: held work waits for its
    // landing settle, exactly like a native gesture.
    controller.beginProgrammaticGesture();
    glideTarget = destination;
    glide = startGlide(
      {
        read: () => viewport.scrollTop,
        write: (top) =>
          guarded(() => {
            controller.recordProgrammaticScrollTop(top);
            viewport.scrollTop = top;
            reconcileWindow();
          }),
        target: destination,
      },
      (distancePx) => glideDuration(distancePx, viewport.clientHeight),
      (completed) =>
        guarded(() => {
          glide = null;
          glideTarget = null;
          if (completed) controller.markSettlePending();
          const targetGone =
            targetLost || (keyed && geometry.indexOf(target) < 0);
          publish();
          done(completed && !targetGone && !disposed);
        }),
    );
  }

  // --- Boot -----------------------------------------------------------------
  flush(prepare(options.items, "end"));

  return {
    setItems,
    scrollTo,
    get state(): VirtualListState {
      return (
        lastState ?? {
          count: 0,
          start: 0,
          end: 0,
          atStart: true,
          atEnd: true,
          totalSize: 0,
          held: false,
        }
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of afterCommit) entry.discard?.();
      afterCommit.length = 0;
      glide?.cancel();
      reachStartAbort?.abort();
      reachEndAbort?.abort();
      controller.dispose();
      if (observeFlushFrame !== 0) cancelAnimationFrame(observeFlushFrame);
      rowObserver.disconnect();
      viewportObserver.disconnect();
      measurer.dispose();
      canvas.remove();
      // Every retained node — committed or pending — is destroyed exactly once.
      for (const row of rows.values())
        options.onDestroy?.(row.element, row.item);
      rows.clear();
      if (pending) {
        for (const row of pending.newRows.values()) {
          options.onDestroy?.(row.element, row.item);
        }
        pending = null;
      }
    },
  };
}
