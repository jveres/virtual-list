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
//    node is retained and is what mounts. Preparation is failure-atomic:
//    a throwing render or measurement rolls back everything it built and
//    leaves committed and pending state untouched.
// 3. Only when the phase settles (or immediately while idle) does ONE
//    atomic commit apply keys, heights, canvas geometry, the mounted window,
//    and a single anchor-preserving scroll write. Retained nodes are
//    re-measured immediately before they commit (a detached image may have
//    decoded since preparation), so the latest heights commit once.
// 4. A mounted row lives inside a dimensionally stable SLOT (fixed height,
//    clipped). Same-key content changes — streaming text, toggles, late
//    images, font swaps — may mutate the row any time: the slot clips
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
   * Every reach at an edge gets its own signal; all of them abort together.
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
   * superseded before committing, its measurement failed after build, or
   * the list was disposed. Tear down per-element resources here; called
   * exactly once per element.
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
   * Resolves true when the command landed on its target AND the target is
   * still under the viewport once the command's scroll phase has settled
   * and held work has committed; false when interrupted (user gesture,
   * newer command, dispose), when the target does not exist, or when the
   * settle-time commit moved the viewport off it. Always settles.
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
  /** The committed (or, for a pending row, prepared) item. */
  item: T;
  /** The item the element's DOM currently reflects (when known). */
  renderedItem: T;
  /**
   * A render on this element threw — the host may have mutated it before
   * failing — and no successful render has happened since. Item identity
   * cannot represent this state: the next preparation re-renders the row
   * regardless of what its item is.
   */
  renderUnknown: boolean;
  element: HTMLElement;
  /** Dimensionally stable container: fixed committed height, clipped. */
  slot: HTMLElement;
  height: number;
  mounted: boolean;
  /** Content changed (or the width did): re-measure at the next commit. */
  dirty: boolean;
  /** The commit that last measured this row (freshness on remount). */
  measuredEpoch: number;
  destroyed: boolean;
}

interface Prepared<T> {
  keys: readonly string[];
  itemByKey: Map<string, T>;
  /** Rows built and premeasured off-scroller for new or replaced keys. */
  newRows: Map<string, Row<T>>;
  anchor: AnchorPolicy;
}

type Edge = "start" | "end";

/** Preparation bail-out: the host disposed the list from inside a callback. */
class DisposedDuringPreparation extends Error {}

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
  let commitEpoch = 0;

  // --- Pending work (waits for the scroll phase to settle) ------------------
  let pending: Prepared<T> | null = null;
  /** The snapshot mid-commit: its not-yet-adopted rows are dispose()'s too. */
  let committing: Prepared<T> | null = null;
  let anyDirty = false;
  let idleFlushFrame = 0;
  let inFlush = false;

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
  // A landed glide resolves only once its phase settles and held work has
  // committed, revalidated against the final geometry.
  let awaitingSettle: {
    done: (completed: boolean) => void;
    landed: () => boolean;
  } | null = null;
  let lastState: VirtualListState | null = null;
  let reachStartArmed = true;
  let reachEndArmed = true;
  const reachAborts: Record<Edge, Set<AbortController>> = {
    start: new Set(),
    end: new Set(),
  };

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

  // Host teardown failures raised by a COMMITTED operation are not
  // transaction failures: the state the host observed was fully reached.
  // They are deferred here and surfaced by the outermost guard only after
  // the queued work has drained — a scrollTo() issued from onState after a
  // commit whose onDestroy threw still runs (I4).
  const deferredTeardown: unknown[] = [];

  function deferTeardown(failures: readonly unknown[]): void {
    deferredTeardown.push(...failures);
  }

  function takeDeferredTeardown(): unknown[] {
    return deferredTeardown.splice(0);
  }

  function guarded(work: () => void): void {
    if (inCommit) {
      work();
      return;
    }
    inCommit = true;
    try {
      work();
    } catch (error) {
      inCommit = false;
      // A genuine failure: what its callbacks queued would run against a
      // state that was never reached. Discard it — settling every queued
      // command's promise (false) so nothing hangs.
      for (const entry of afterCommit) entry.discard?.();
      afterCommit.length = 0;
      const deferred = takeDeferredTeardown();
      if (deferred.length === 0) throw error;
      throw new AggregateError([error, ...deferred], "transaction failed");
    }
    inCommit = false;
    const failures = takeDeferredTeardown();
    // Drain everything queued; each entry runs as its own transaction and
    // any failure it surfaces joins the report instead of stranding the
    // entries behind it.
    while (!disposed && afterCommit.length > 0) {
      try {
        afterCommit.shift()?.run();
      } catch (error) {
        failures.push(...failuresOf(error));
      }
    }
    throwTeardown(failures);
  }

  // --- Rows: build, measure, retain, destroy --------------------------------
  function createSlot(): HTMLElement {
    const slot = document.createElement("div");
    slot.style.position = "absolute";
    slot.style.top = "0";
    slot.style.left = "0";
    slot.style.right = "0";
    // `clip` avoids making every row a scroll container; fall back where
    // the engine does not accept it.
    slot.style.overflow = "clip";
    if (slot.style.overflow !== "clip") slot.style.overflow = "hidden";
    return slot;
  }

  /** Wrap a freshly premeasured element into a retained row. */
  function retain(
    key: string,
    item: T,
    element: HTMLElement,
    height: number,
  ): Row<T> {
    const slot = createSlot();
    slot.appendChild(element);
    slot.style.height = `${height}px`;
    return {
      key,
      item,
      renderedItem: item,
      renderUnknown: false,
      element,
      slot,
      height,
      mounted: false,
      dirty: false,
      measuredEpoch: -1,
      destroyed: false,
    };
  }

  /**
   * Premeasure a built element. A measurement failure after the build
   * destroys the element through the host (it will never be returned);
   * a build failure has nothing to destroy.
   */
  function premeasure(
    item: T,
    build: () => HTMLElement,
  ): { element: HTMLElement; height: number } {
    return measurer.measure(build, (element) =>
      options.onDestroy?.(element, item),
    );
  }

  /** Destroy exactly once; safe to call from any path, host included. */
  function destroyRow(row: Row<T>): void {
    if (row.destroyed) return;
    row.destroyed = true;
    if (row.mounted) unmountRow(row);
    row.slot.remove();
    options.onDestroy?.(row.element, row.item);
  }

  /**
   * Destroy every row, attempting all of them even when a host teardown
   * throws. Failures are RETURNED, never thrown here: the enclosing
   * operation first reaches its consistent terminal state (the commit
   * completes, the snapshot is handed off, the rollback finishes) and
   * only then surfaces them via throwTeardown.
   */
  function destroyAll(rowsToDestroy: Iterable<Row<T>>): unknown[] {
    const failures: unknown[] = [];
    for (const row of rowsToDestroy) {
      try {
        destroyRow(row);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  function throwTeardown(failures: readonly unknown[]): void {
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError([...failures], "row teardown failed");
  }

  /** Flatten a caught error into its constituent failures. */
  function failuresOf(error: unknown): unknown[] {
    return error instanceof AggregateError ? [...error.errors] : [error];
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

  function markDirty(row: Row<T>): void {
    row.dirty = true;
    anyDirty = true;
  }

  /** Idle dirty work commits at the next frame (never inside reconciliation). */
  function scheduleIdleFlush(): void {
    if (idleFlushFrame !== 0 || disposed) return;
    idleFlushFrame = requestAnimationFrame(() => {
      idleFlushFrame = 0;
      if (disposed || !anyDirty || !idle()) return;
      flush(null);
    });
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
      markDirty(row);
      changed = true;
    }
    if (!changed) return;
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
      for (const row of rows.values()) markDirty(row);
      if (pending) for (const row of pending.newRows.values()) markDirty(row);
    }
    if (idle()) flush(null, "viewport");
    else publish();
  });
  viewportObserver.observe(viewport);

  // --- Preparation (off-scroller, failure-atomic) ---------------------------
  function prepare(
    next: readonly T[],
    anchor: AnchorPolicy,
  ): { prepared: Prepared<T>; teardownFailures: unknown[] } {
    const keys = next.map(keyOf);
    const itemByKey = new Map<string, T>();
    for (let index = 0; index < next.length; index++) {
      const key = keys[index] as string;
      if (itemByKey.has(key)) throw new Error(`duplicate key "${key}"`);
      itemByKey.set(key, next[index] as T);
    }

    // Phase 1 — render and measure into local structures only. Nothing in
    // `rows` or `pending` is mutated until every host call has succeeded.
    // In-place renders DO touch existing elements' DOM as they go; on a
    // later failure they are rolled back by re-rendering the row's own
    // item, and a row whose rollback fails stays marked so the next
    // preparation re-renders it regardless of item identity.
    const previous = pending;
    const newRows = new Map<string, Row<T>>();
    const built: Row<T>[] = [];
    const inPlace: { row: Row<T>; item: T }[] = [];
    const adopted = new Set<string>();

    // Every in-place candidate is recorded BEFORE its render is invoked:
    // the host may mutate the element and then throw, and rollback must
    // see that row. A fresh element the host returns is owned (destroyed
    // on any bail-out) from the moment it exists.
    const touched: { row: Row<T>; item: T }[] = [];

    const rollBack = (): unknown[] => {
      const failures = destroyAll(built);
      for (const { row } of touched) {
        if (row.destroyed) continue;
        try {
          const back = render(row.item, row.element);
          if (back === row.element) {
            row.renderedItem = row.item;
            row.renderUnknown = false;
          } else {
            // The host handed back a fresh element we will never adopt;
            // the old element's state is whatever the failed render left.
            row.renderUnknown = true;
            try {
              options.onDestroy?.(back, row.item);
            } catch (teardownError) {
              failures.push(teardownError);
            }
          }
        } catch {
          row.renderUnknown = true; // Re-rendered next time, whatever the item.
        }
        markDirty(row); // The DOM may have changed either way; re-measure.
      }
      return failures;
    };

    /** Render then measure, taking ownership of a fresh element first. */
    const measureFresh = (
      key: string,
      item: T,
      element: HTMLElement,
    ): Row<T> => {
      if (disposed) {
        options.onDestroy?.(element, item);
        throw new DisposedDuringPreparation();
      }
      const measured = premeasure(item, () => element);
      const row = retain(key, item, measured.element, measured.height);
      built.push(row);
      return row;
    };

    const renderInPlaceOrReplace = (row: Row<T>, item: T): Row<T> | null => {
      touched.push({ row, item });
      const previouslyRendered = row.renderedItem;
      row.renderedItem = item; // Provisional: rollback restores on failure.
      let rendered: HTMLElement;
      try {
        rendered = render(item, row.element);
      } catch (error) {
        row.renderUnknown = true; // Mutated-then-thrown is indistinguishable.
        throw error;
      }
      if (rendered === row.element) {
        row.renderUnknown = false;
        inPlace.push({ row, item });
        return null;
      }
      // A replacement: the old element's DOM was not advanced.
      row.renderedItem = previouslyRendered;
      return measureFresh(row.key, item, rendered);
    };

    try {
      for (const key of keys) {
        const item = itemByKey.get(key) as T;
        const preparedBefore = previous?.newRows.get(key);
        if (preparedBefore) {
          adopted.add(key);
          if (
            preparedBefore.renderedItem === item &&
            !preparedBefore.renderUnknown
          ) {
            newRows.set(key, preparedBefore);
          } else {
            const replacement = renderInPlaceOrReplace(preparedBefore, item);
            if (replacement === null) {
              newRows.set(key, preparedBefore);
            } else {
              newRows.set(key, replacement); // preparedBefore dies in phase 2.
              adopted.delete(key);
            }
          }
        } else {
          const committed = rows.get(key);
          if (committed === undefined) {
            newRows.set(key, measureFresh(key, item, render(item)));
          } else if (
            committed.renderUnknown ||
            committed.renderedItem !== item
          ) {
            const replacement = renderInPlaceOrReplace(committed, item);
            if (replacement !== null) newRows.set(key, replacement);
          }
        }
        if (disposed) throw new DisposedDuringPreparation();
      }
    } catch (error) {
      // DOM restoration and local cleanup complete first; teardown
      // failures then surface together with the original error.
      const failures = rollBack();
      if (error instanceof DisposedDuringPreparation) {
        return {
          prepared: { keys, itemByKey, newRows: new Map(), anchor },
          teardownFailures: failures,
        };
      }
      if (failures.length === 0) throw error;
      throw new AggregateError(
        [error, ...failures],
        "preparation failed and row teardown failed",
      );
    }

    // Phase 2 — apply. The only host calls are destructions of what the
    // superseded pending snapshot prepared and this one did not adopt; a
    // host disposing from one of them must not leak what was built here,
    // so preparation keeps cleanup ownership until the hand-off returns.
    for (const entry of inPlace) {
      entry.row.item = entry.item;
      markDirty(entry.row);
    }
    const teardownFailures: unknown[] = [];
    if (previous) {
      const superseded = [...previous.newRows]
        .filter(([key]) => !adopted.has(key))
        .map(([, row]) => row);
      teardownFailures.push(...destroyAll(superseded));
      if (disposed) {
        teardownFailures.push(...destroyAll(built));
        return {
          prepared: { keys, itemByKey, newRows: new Map(), anchor },
          teardownFailures,
        };
      }
    }
    return { prepared: { keys, itemByKey, newRows, anchor }, teardownFailures };
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
      committing = applying;
      commitEpoch += 1;
      inFlush = true;
      try {
        flushBody(applying, policyOverride);
      } finally {
        inFlush = false;
        committing = null;
      }
    });
  }

  function flushBody(
    applying: Prepared<T> | null,
    policyOverride: AnchorPolicy | undefined,
  ): void {
    // Teardown failures are collected here and surfaced only after the
    // commit has reached its consistent terminal state.
    const teardownFailures: unknown[] = [];
    try {
      const policy = policyOverride ?? applying?.anchor ?? "auto";
      const capture = geometry.capture(viewportState(), policy);

      if (applying) {
        // Keys and rows: drop removed, swap replaced, adopt new. A row is
        // removed from the map BEFORE its destruction so a host disposing
        // from onDestroy can never destroy it twice.
        const nextKeys = new Set(applying.keys);
        const removed: Row<T>[] = [];
        for (const [key, row] of [...rows]) {
          if (nextKeys.has(key)) continue;
          rows.delete(key);
          removed.push(row);
        }
        const replaced: Row<T>[] = [];
        for (const [key, row] of applying.newRows) {
          const old = rows.get(key);
          rows.set(key, row);
          if (old && old !== row) replaced.push(old);
        }
        teardownFailures.push(...destroyAll([...removed, ...replaced]));
        if (disposed) return;
        for (const [key, item] of applying.itemByKey) {
          const row = rows.get(key);
          if (row) row.item = item;
        }
        geometry.setKeys(applying.keys);
        // Latest heights, exactly once: every retained node is measured
        // again immediately before it commits — a detached image may have
        // decoded since preparation — and replacements ALWAYS reach the
        // kernel (the key was measured before, but with the old element).
        for (const row of applying.newRows.values()) {
          commitHeight(row, remeasureDetached(row));
        }
      }

      for (const row of rows.values()) {
        if (!row.dirty) continue;
        commitHeight(
          row,
          row.mounted ? measureInPlace(row) : remeasureDetached(row),
        );
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
    } finally {
      deferTeardown(teardownFailures);
    }
  }

  function commitHeight(row: Row<T>, height: number): void {
    row.dirty = false;
    row.height = height;
    row.measuredEpoch = commitEpoch;
    row.slot.style.height = `${height}px`;
    geometry.measure(row.key, height);
  }

  // --- Window reconciliation (allowed during scrolling) ---------------------
  function mountRow(row: Row<T>): void {
    // A retained row may have changed while detached (an image decoded)
    // with no observer to notice. Check its freshness before it remounts —
    // unless this very commit just measured it: any difference is QUEUED,
    // the slot mounts at the committed height, geometry stays put, and the
    // new height commits at settle (or the next idle frame). Never inside
    // an active scroll.
    const justMeasured = inFlush && row.measuredEpoch === commitEpoch;
    if (!justMeasured) {
      const height = remeasureDetached(row);
      if (Math.abs(height - row.height) > MEASURE_EPSILON_PX) {
        markDirty(row);
        if (idle()) scheduleIdleFlush();
      }
    }
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
  function abortEdge(edge: Edge): void {
    for (const abort of reachAborts[edge]) abort.abort();
    reachAborts[edge].clear();
  }

  function fireReach(edge: Edge): void {
    // Reaching one edge aborts EVERY started operation at the other — the
    // user's intent moved on — whether or not this edge has a callback.
    abortEdge(edge === "start" ? "end" : "start");
    const callback =
      edge === "start" ? options.onReachStart : options.onReachEnd;
    if (!callback) return;
    const abort = new AbortController();
    reachAborts[edge].add(abort);
    abort.signal.addEventListener("abort", () =>
      reachAborts[edge].delete(abort),
    );
    callback({ signal: abort.signal });
  }

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

    // Proximity signals with entry/exit hysteresis (I3).
    const startDistance = vp.scrollTop;
    const endDistance = maxTop - vp.scrollTop;
    if (startDistance <= EDGE_ENTER_PX && reachStartArmed) {
      reachStartArmed = false;
      fireReach("start");
    } else if (startDistance > EDGE_EXIT_PX) {
      reachStartArmed = true;
    }
    if (disposed) return;
    if (endDistance <= EDGE_ENTER_PX && reachEndArmed) {
      reachEndArmed = false;
      fireReach("end");
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
    // Genuine user input: an in-flight glide is cancelled, and a landed
    // command still parked for its settle resolves interrupted NOW — the
    // user owns the viewport from here, whatever the settle later finds.
    cancelActiveSmoothScroll: () => {
      glide?.cancel();
      cancelParkedCommand();
    },
    smoothScrollReachedTarget: () =>
      glide === null ||
      glideTarget === null ||
      Math.abs(viewport.scrollTop - glideTarget()) <= 2,
    onGestureActivity: () => {},
    onGestureStarted: () => {},
    onGestureSettled: () => {
      // The phase reached idle: everything held commits, once — and only
      // then does a landed command learn whether it is still on target.
      if (pending !== null || anyDirty) flush(null);
      else publish();
      resolveAwaitingSettle();
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

  function resolveAwaitingSettle(): void {
    const awaiting = awaitingSettle;
    if (!awaiting) return;
    awaitingSettle = null;
    awaiting.done(!disposed && awaiting.landed());
  }

  /** A landed command parked for its settle is superseded: false, now. */
  function cancelParkedCommand(): void {
    const awaiting = awaitingSettle;
    if (!awaiting) return;
    awaitingSettle = null;
    awaiting.done(false);
  }

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
      const { prepared, teardownFailures } = prepare(snapshot, anchor);
      // Hand-off happens regardless of supersession teardown failures;
      // they are deferred to the outermost guard, which surfaces them only
      // after the snapshot is pending or committed AND queued work drained.
      deferTeardown(teardownFailures);
      if (disposed) return;
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

  /** Whether the viewport is on the command's target under current geometry. */
  function landedOn(target: string | "start" | "end"): boolean {
    const top = viewport.scrollTop;
    const maxTop = geometry.maxScrollTop(viewport.clientHeight);
    if (target === "start") return top <= AT_EDGE_EPSILON_PX;
    if (target === "end") return maxTop - top <= AT_EDGE_EPSILON_PX;
    const offset = geometry.offsetOf(target);
    if (offset < 0) return false;
    return Math.abs(top - Math.min(offset, maxTop)) <= AT_EDGE_EPSILON_PX;
  }

  function performScrollTo(
    target: string | "start" | "end",
    scrollOptions: { align?: "start"; behavior?: "auto" | "smooth" },
    done: (completed: boolean) => void,
  ): void {
    const keyed = target !== "start" && target !== "end";
    // A newer command supersedes the previous one whatever its state: a
    // parked landed command resolves false BEFORE its phase is finished
    // (finishing it would otherwise resolve it true), an in-flight glide
    // is cancelled. Then: explicit command > gesture — take the viewport
    // over, settling held work first so the command sees committed
    // geometry.
    cancelParkedCommand();
    glide?.cancel();
    interruptNativeScroll();
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

    const destination = (): number => {
      const height = viewport.clientHeight;
      if (target === "start") return 0;
      if (target === "end") return geometry.maxScrollTop(height);
      const offset = geometry.offsetOf(target);
      if (offset < 0) return viewport.scrollTop; // Lost: revalidation fails.
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
      done(!disposed && landedOn(target));
      return;
    }

    // A glide is a programmatic scroll phase: held work waits for its
    // landing settle, exactly like a native gesture — and so does the
    // command's own result.
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
          if (!completed || disposed) {
            done(false);
            return;
          }
          awaitingSettle = { done, landed: () => landedOn(target) };
          controller.markSettlePending();
        }),
    );
  }

  // --- Boot -----------------------------------------------------------------
  flush(prepare(options.items, "end").prepared);

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
      cancelParkedCommand();
      abortEdge("start");
      abortEdge("end");
      controller.dispose();
      if (observeFlushFrame !== 0) cancelAnimationFrame(observeFlushFrame);
      if (idleFlushFrame !== 0) cancelAnimationFrame(idleFlushFrame);
      rowObserver.disconnect();
      viewportObserver.disconnect();
      measurer.dispose();
      canvas.remove();
      // Every retained node — committed or pending — is destroyed exactly
      // once (destroyRow is idempotent, so a host disposing from onDestroy
      // mid-commit cannot double-destroy).
      const doomed = [...rows.values()];
      rows.clear();
      const pendingRows = pending ? [...pending.newRows.values()] : [];
      pending = null;
      const committingRows = committing ? [...committing.newRows.values()] : [];
      committing = null;
      // One pass over everything: a throwing teardown never prevents the
      // remaining destructions; failures surface together afterwards.
      throwTeardown(destroyAll([...doomed, ...pendingRows, ...committingRows]));
    },
  };
}
