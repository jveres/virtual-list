import {
  type AnchorPolicy,
  type CapturePolicy,
  Geometry,
  type GeometryViewport,
} from "./geometry";
import { type Glide, type GlideHost, glidePace, startGlide } from "./glide";

import {
  createItemMeasurer,
  type ItemMeasurer,
  positionRowElement,
} from "./premeasure";
import {
  createScrollSettleController,
  detectScrollSettleStrategy,
  type ScrollSettleController,
  type VirtualListScrollSettleStrategy,
} from "./scroll-settle";

export type { AnchorPolicy } from "./geometry";

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
//    and a single anchor-preserving scroll write. Retained nodes that
//    waited for a settle are re-measured immediately before they commit (a
//    detached image may have decoded since preparation), so the latest
//    heights commit once.
// 4. Same-key updates during a phase follow `scrollingUpdates`.
//    "same-height": committed elements are frozen along with geometry;
//    the update is rendered fresh and premeasured off-scroller, PROMOTED
//    into the committed slot at once when its height is unchanged, and
//    otherwise retained until the settle commit swaps content, height,
//    offsets, canvas, and anchor together — nothing mounted ever shows
//    content that disagrees with its slot. "freeze" holds every such
//    update; "live" (the default) renders it in place and commits its
//    height at once whenever no anchor-preserving scroll write is needed
//    for it (rows at or below the anchor row). Idle, every mode renders in
//    place and commits at once.
//    A mounted row lives inside a dimensionally stable SLOT (fixed
//    height, clipped) as the safety net for changes made outside setItems
//    (direct DOM mutation, late resources): the ResizeObserver marks the
//    row dirty and its real height commits at settle, or in the same
//    delivery when idle — geometry never drifts, but such content clips
//    or gaps until then, so hosts route size changes through setItems.
//
// There is no compensation machinery: no mid-gesture corrections, no
// canvas translation, no "safe update" exceptions. What v1 patched cannot
// occur here because geometry never changes under a live scroll — except
// what "live" commits below the anchor by explicit product choice.

export interface ReachContext {
  /**
   * Aborted when the runtime objectively knows the load is no longer
   * wanted: the user reached the OPPOSITE edge, or the list was disposed.
   * Every reach at an edge gets its own signal; all of them abort together.
   * Wire fetches to it; ignore it to keep a scrollback fetch alive.
   */
  signal: AbortSignal;
}

export type ScrollingUpdates = "freeze" | "same-height" | "live";

export type Edge = "start" | "end";

/**
 * A fixed-height row the runtime keeps at an edge of the scroll surface — a
 * "load more" / "at the top" slot in the flow, where an overlay would fight
 * a sticky header for the same strip. It is geometry (it scrolls, it adds to
 * the range) but never the anchor: when content replaces it, the content the
 * user was reading keeps its place and the slot's strip shows the new rows.
 * The element is the host's; it is not premeasured (the declared height is
 * the committed height, the box clips) and receives no onDestroy. The host
 * may change its content in place as long as the height holds.
 */
export interface EdgeSlot {
  key: string;
  height: number;
  render: () => HTMLElement;
}

export interface VirtualListOptions<T> {
  items: readonly T[];
  /** Stable identity. Keys beginning with the reserved NUL edge-slot prefix are rejected. */
  key: (item: T) => string;
  /**
   * Build a row's element, or update `existing` in place for a same-key
   * item change (return it) or replace it (return a new element).
   * `existing` is offered when mutating it is safe: while the list is
   * idle, when it is an off-scroller element (a pending replacement), or
   * in "live" mode. In the other modes a committed row's phase-time update
   * is rendered fresh (no `existing`), premeasured, and either promoted
   * into the committed slot at once (height unchanged) or swapped in at
   * settle.
   */
  render: (item: T, existing?: HTMLElement) => HTMLElement;
  overscanPx?: number;
  /**
   * Called whenever a state field changes, and after every commit even
   * when none did — committed positions may have moved (a companion that
   * reads positionOf, like a sticky header, re-reads them here).
   */
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
  /** Settle strategy; detected from the user agent when not given. */
  settleStrategy?: VirtualListScrollSettleStrategy;
  /** Fixed-height loader slots at the edges; see EdgeSlot. */
  edgeSlots?: { start?: EdgeSlot | null; end?: EdgeSlot | null };
  /**
   * What happens to a same-key update that arrives during a scroll phase
   * (a structural change waits for the settle in every mode, except one
   * confined below the anchor under "live", which needs no scroll write):
   * - "same-height": rendered fresh and premeasured off-scroller; if its
   *   height equals the committed height, and the committed row has no
   *   measurement of its own waiting, it is swapped into the committed slot
   *   at once (no geometry change), otherwise held until settle —
   *   streaming keeps flowing until a wrap changes the height;
   * - "freeze": every such update is held until settle;
   * - "live" (default): rendered in place on the committed element right
   *   away, and its height commits right away too when nothing on screen
   *   has to move for it — the row is at or below the viewport's anchor row, so
   *   only it and what lies below it change, with no scroll write. The
   *   complete updated content is always visible: never a cut or blank
   *   line. A dirty row strictly above the anchor is entirely off-screen
   *   and commits at settle (or the moment the viewport reaches it). The
   *   trade-off is a scroll range that changes under a live scroll. A
   *   shrink near the end can make the browser clamp scrollTop to the new
   *   maximum; the runtime reconciles that position in the same frame.
   */
  scrollingUpdates?: ScrollingUpdates;
  /** Animate automatic end-follow as content grows; instant by default. */
  followBehavior?: "instant" | "smooth";
}

export interface VirtualListState {
  count: number;
  start: number;
  end: number;
  atStart: boolean;
  atEnd: boolean;
  /** A smooth automatic end-follow currently owns the end target. */
  following: boolean;
  totalSize: number;
  /** A prepared snapshot or dirty measurements are waiting for settle. */
  held: boolean;
}

export type ScrollTarget = string | "start" | "end";

/** Edge slot keys live in a namespace no host key can collide with. */
const SLOT_KEY_PREFIX = "\u0000edge:";
function slotKey(edge: Edge, key: string): string {
  return `${SLOT_KEY_PREFIX}${edge}:${key}`;
}
function isSlotKey(key: string): boolean {
  return key.startsWith(SLOT_KEY_PREFIX);
}

function ownEdgeSlot(slot: EdgeSlot | null | undefined): EdgeSlot | null {
  if (slot == null) return null;
  if (!Number.isFinite(slot.height) || slot.height <= 0) {
    throw new Error(
      `edge slot "${slot.key}" height must be finite and > 0, got ${slot.height}`,
    );
  }
  return { key: slot.key, height: slot.height, render: slot.render };
}
export type ScrollOptions = {
  align?: "start";
  behavior?: "auto" | "smooth";
  /**
   * Smooth only: the pace of the glide, in milliseconds. It is the landing
   * time of a one-viewport hop and the cap on the approach a longer trip
   * makes before that same landing, so a trip from the far end takes at
   * most twice it. A hop that should read as deliberate — a chat's
   * pin-to-top on send — sets it; the default lands in 600ms.
   */
  duration?: number;
  /**
   * Keyed targets only: land this many pixels below the viewport top — room
   * for a floating sticky header, so a pinned message is not covered by it.
   */
  offset?: number;
};

export type RemeasureOptions = {
  /** How the viewport should resolve the discrete, host-driven size change. */
  anchor?: AnchorPolicy;
};

export interface VirtualList<T> {
  setItems(items: readonly T[], options?: { anchor?: AnchorPolicy }): void;
  /**
   * Resolves true when the command landed on its target AND the target is
   * still under the viewport once the command's scroll phase has settled
   * and held work has committed; false when interrupted (user gesture,
   * newer command, dispose), when the target does not exist, or when the
   * settle-time commit moved the viewport off it. Always settles.
   */
  scrollTo(target: ScrollTarget, options?: ScrollOptions): Promise<boolean>;
  /**
   * Schedule a mounted row for measurement on the next animation frame.
   * This is the intent-bearing path for discrete host interactions such as
   * opening a <details>: the frame runs after the default action changed
   * layout, but before paint. The viewport anchor is the default, so a user
   * expansion never re-engages automatic end-follow. Missing or unmounted
   * keys are harmless no-ops.
   */
  remeasure(key: string, options?: RemeasureOptions): void;
  readonly state: VirtualListState;
  /**
   * Set or clear an edge slot: a structural change that commits like any
   * snapshot — at the settle during a scroll, except under "live" when it
   * lies below the anchor (an end slot), which commits at once.
   */
  setEdgeSlot(edge: Edge, slot: EdgeSlot | null): void;
  /** Committed content-space top and height of an item key (offsets include edge slots); null if unknown. */
  positionOf(key: string): { top: number; height: number } | null;
  /** The mounted element of a key, or null when unmounted or unknown. */
  elementOf(key: string): HTMLElement | null;
  dispose(): void;
}

const EDGE_ENTER_PX = 800;
const EDGE_EXIT_PX = 1200;

/** Float noise a measurement may carry (100.0000001 is 100, not 101). */
const HEIGHT_NOISE = 1e-6;

/**
 * Committed heights are whole pixels (rounded up, so content is never
 * clipped by the quantization). Fractional heights made every offset,
 * canvas size, and anchor target fractional; engines then snap transformed
 * rows to device pixels differently as the scroll position changes, which
 * showed as a 1px layout shift after a top load. Integral geometry has no
 * such seam: anchor writes land exactly.
 */
function quantizeHeight(height: number): number {
  return Math.max(1, Math.ceil(height - HEIGHT_NOISE));
}
const MEASURE_EPSILON_PX = 0.5;
const SCROLL_WRITE_EPSILON_PX = 0.5;
const AT_EDGE_EPSILON_PX = 1;
const FOLLOW_LANDING_MS = 320;
/** Rows are mounted at least this far beyond the viewport (a full viewport when taller). */
const MIN_OVERSCAN_PX = 300;

const EMPTY_STATE: VirtualListState = {
  count: 0,
  start: 0,
  end: 0,
  atStart: true,
  atEnd: true,
  following: false,
  totalSize: 0,
  held: false,
};

interface Row<T> {
  key: string;
  /** The committed (or, for a pending row, prepared) item. */
  item: T;
  /** The item the element's DOM reflects — meaningful unless `renderUnknown`. */
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
  /** The offset last written to the slot's transform (NaN: never). */
  offset: number;
  /** An edge slot row: no item, declared height, no observer, no onDestroy. */
  edge?: Edge;
  /**
   * The EdgeSlot a slot row was built from. setEdgeSlot stores a fresh copy,
   * so every setEdgeSlot call re-renders; the identity check only spares
   * successive setItems calls that leave the slots untouched.
   */
  edgeSlot?: EdgeSlot;
  mounted: boolean;
  /**
   * Its size may differ from `height`: content or width changed, or it
   * waited for a settle. Re-measured at the next commit.
   */
  dirty: boolean;
  destroyed: boolean;
}

interface Prepared<T> {
  keys: readonly string[];
  /** Rows built and premeasured off-scroller for new or replaced keys. */
  newRows: Map<string, Row<T>>;
  anchor: AnchorPolicy;
}

type Transaction = { run: () => void; discard?: () => void };
type Scope = Transaction[];

/** Preparation bail-out: the host disposed the list from inside a callback. */
class DisposedDuringPreparation extends Error {}

export function createVirtualList<T>(
  viewport: HTMLElement,
  options: VirtualListOptions<T>,
): VirtualList<T> {
  const { key: keyOf, render } = options;
  const scrollingUpdates: ScrollingUpdates = options.scrollingUpdates ?? "live";
  const promoteSameHeight = scrollingUpdates === "same-height";
  const liveUpdates = scrollingUpdates === "live";
  const overscanPx =
    options.overscanPx ?? Math.max(MIN_OVERSCAN_PX, viewport.clientHeight);

  // --- Committed state --------------------------------------------------------
  // Heights are never estimated: every key is measured before it commits,
  // so the kernel's estimate is only a validation placeholder.
  const geometry = new Geometry(1);
  geometry.setAnchorExclusion(isSlotKey);
  const rows = new Map<string, Row<T>>();
  const edgeSlots: Record<Edge, EdgeSlot | null> = {
    start: ownEdgeSlot(options.edgeSlots?.start),
    end: ownEdgeSlot(options.edgeSlots?.end),
  };
  /** The last snapshot handed in — what a slot change re-applies. */
  let lastItems: readonly T[] = [...options.items];
  const mountedRows = new Set<Row<T>>();
  /** Committed rows whose size may differ from their committed height. */
  const dirtyRows = new Set<Row<T>>();
  /** Advances on every commit; window reconciliation is memoized on it and onState fires when it moved. */
  let geometryEpoch = 0;

  // --- Pending work (waits for the scroll phase to settle) ------------------
  let pending: Prepared<T> | null = null;
  /** The snapshot mid-commit: its not-yet-adopted rows are dispose()'s too. */
  let committing: Prepared<T> | null = null;

  // --- DOM ------------------------------------------------------------------
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  canvas.style.overflowAnchor = "none";
  viewport.appendChild(canvas);
  let lastViewportWidth = viewport.clientWidth;
  let lastViewportHeight = viewport.clientHeight;
  // The position last observed through a scroll event or a commit: what the
  // viewport stood on BEFORE a resize the engine may already have clamped.
  let lastObservedTop = viewport.scrollTop;
  // A viewport size change during a phase: its commit waits for the
  // settle, carrying the stance decided when it arrived (I5) — a glide's
  // destination in flight, else the pre-resize position; the engine's
  // clamp has moved the viewport off the pin by the settle.
  let resizeHeld: "pin" | "viewport" | null = null;
  // The measurer's width comes from the viewport observer, not a layout
  // read per measurement.
  const measurer: ItemMeasurer = createItemMeasurer({
    viewport,
    viewportWidth: () => lastViewportWidth,
  });

  let disposed = false;
  let inTransaction = false;
  // The OPEN transaction's queue. Every top-level transaction owns a fresh
  // scope: what its callbacks queue drains after it commits, each entry as
  // its own transaction with its own scope — so a failing queued entry
  // discards only the work it created, never its siblings.
  let afterCommit: Scope = [];
  // Every scope with undrained entries, outermost first: a parent scope
  // mid-drain still holds its remaining siblings while a child transaction
  // runs, so disposal from that child must be able to discard them all.
  const liveScopes: Scope[] = [];
  let glide: Glide | null = null;
  let followGlide = false;
  // The in-flight command glide's destination is an align:"start" pin.
  let glideToPin = false;
  /** Smooth end-follow survives the quiet gap between consecutive glide legs. */
  let smoothFollowArmed = false;
  /**
   * A host-driven measurement owns the next measurement commit's anchor.
   * Registering this before the DOM changes prevents ResizeObserver from
   * racing ahead with the default end-follow policy.
   */
  const remeasureRequests = new Map<string, AnchorPolicy>();
  /** A host remeasure has claimed the next measurement commit's anchor. */
  const remeasureOwnsNextCommit = (): boolean => remeasurePolicy !== undefined;
  let remeasureFrame = 0;
  let remeasurePolicy: AnchorPolicy | undefined;
  let booting = true;
  // A landed glide resolves only once its phase settles and held work has
  // committed, revalidated against the final geometry.
  let awaitingSettle: {
    done: (completed: boolean) => void;
    landed: () => boolean;
    /** A command to the end: explicit follow intent under smooth follow. */
    followsEnd: boolean;
  } | null = null;
  // Replaced by the boot commit's publish before the list is handed out.
  let lastState: VirtualListState = EMPTY_STATE;
  let lastPublishedEpoch = -1;
  let reachStartArmed = true;
  let reachEndArmed = true;
  const reachAborts: Record<Edge, Set<AbortController>> = {
    start: new Set(),
    end: new Set(),
  };

  function viewportState(): GeometryViewport {
    return { scrollTop: viewport.scrollTop, height: viewport.clientHeight };
  }

  function idle(): boolean {
    return !controller.isScrollPhaseActive();
  }

  function writeScrollTop(top: number): void {
    controller.recordProgrammaticScrollTop(top);
    viewport.scrollTop = top;
  }

  // --- Reentrancy (I4): API calls from host callbacks queue behind the commit
  function enqueueDuringTransaction(
    work: () => void,
    discard?: () => void,
  ): boolean {
    if (!inTransaction) return false;
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

  function discardScope(scope: Scope): void {
    for (const entry of scope) entry.discard?.();
    scope.length = 0;
  }

  function guarded(work: () => void): void {
    if (inTransaction) {
      work();
      return;
    }
    const scope: Scope = [];
    const outer = afterCommit;
    afterCommit = scope;
    liveScopes.push(scope);
    inTransaction = true;
    try {
      try {
        work();
      } catch (error) {
        inTransaction = false;
        // A genuine failure: what THIS transaction's callbacks queued would
        // run against a state that was never reached. Discard exactly that
        // scope — settling every queued command's promise (false) so nothing
        // hangs — and nothing outside it.
        discardScope(scope);
        const deferred = takeDeferredTeardown();
        if (deferred.length === 0) throw error;
        throw new AggregateError([error, ...deferred], "transaction failed");
      }
      inTransaction = false;
      const failures = takeDeferredTeardown();
      // Drain this scope; each entry runs as its own top-level transaction
      // (with its own scope), and any failure it surfaces joins the report
      // instead of stranding the entries behind it. Disposal from a child
      // empties this scope in place (see dispose), which ends the drain.
      while (!disposed && scope.length > 0) {
        const entry = scope.shift();
        try {
          entry?.run();
        } catch (error) {
          failures.push(...failuresOf(error));
        }
      }
      throwFailures(
        failures,
        "committed with failures in teardown or queued work",
      );
    } finally {
      liveScopes.pop();
      afterCommit = outer;
    }
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

  /** Wrap an element into a retained row; fresh rows carry a provisional height until the batch measurement. */
  function retain(
    key: string,
    item: T,
    element: HTMLElement,
    height: number,
  ): Row<T> {
    const slot = createSlot();
    slot.appendChild(element);
    const quantized = quantizeHeight(height);
    slot.style.height = `${quantized}px`;
    return {
      key,
      item,
      renderedItem: item,
      renderUnknown: false,
      element,
      slot,
      height: quantized,
      offset: Number.NaN,
      mounted: false,
      dirty: false,
      destroyed: false,
    };
  }

  /** Destroy exactly once; safe to call from any path, host included. */
  function destroyRow(row: Row<T>): void {
    if (row.destroyed) return;
    row.destroyed = true;
    if (row.mounted) unmountRow(row);
    dirtyRows.delete(row);
    row.slot.remove();
    if (!row.edge) options.onDestroy?.(row.element, row.item);
  }

  /** A slot row: the host's element at the declared height, no measurement. */
  function retainEdgeSlot(edge: Edge, slot: EdgeSlot): Row<T> {
    // Never measured, so positioned here the way the measurer positions
    // every other row.
    const element = positionRowElement(slot.render());
    const row = retain(
      slotKey(edge, slot.key),
      undefined as T,
      element,
      slot.height,
    );
    row.edge = edge;
    row.edgeSlot = slot;
    return row;
  }

  /**
   * Destroy every row, attempting all of them even when a host teardown
   * throws. Failures are RETURNED, never thrown here: the enclosing
   * operation first reaches its consistent terminal state (the commit
   * completes, the snapshot is handed off, the rollback finishes) and
   * only then surfaces them — a commit or preparation defers them to the
   * outermost transaction's report, dispose throws them directly.
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

  function throwFailures(failures: readonly unknown[], message: string): void {
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError([...failures], message);
  }

  function throwTeardown(failures: readonly unknown[]): void {
    throwFailures(failures, "row teardown failed");
  }

  /** Flatten a caught error into its constituent failures. */
  function failuresOf(error: unknown): unknown[] {
    return error instanceof AggregateError ? [...error.errors] : [error];
  }

  /** Unmounted rows (fresh or retained) are measured detached, all in one layout. */
  function measureDetached(detached: readonly Row<T>[]): number[] {
    if (detached.length === 0) return [];
    try {
      return measurer.measureMany(detached.map((row) => row.element));
    } finally {
      // The measurer detaches every element on success and failure. Restore
      // ownership before returning or surfacing an error; a row destroyed
      // reentrantly during measurement must stay destroyed.
      for (const row of detached) {
        if (!row.destroyed) row.slot.appendChild(row.element);
      }
    }
  }

  function measureInPlace(row: Row<T>): number {
    const height = row.element.getBoundingClientRect().height;
    // A mounted row that reads 0 is hidden (display: none, a collapsed
    // ancestor), not resized: its committed height stands.
    return Number.isFinite(height) && height > 0 ? height : row.height;
  }

  // --- Measurements: ResizeObserver marks mounted rows dirty ----------------
  // Observing from inside the observer's own delivery schedules
  // undeliverable notifications ("loop completed with undelivered
  // notifications"); registrations made during a delivery wait a frame.
  // The observer's INITIAL delivery for a newly observed element is also
  // the freshness check of a retained row that changed while detached (a
  // decoded image): it arrives after layout, before the mount's first
  // paint, and queues any difference like any other size change.
  let inMeasurementDelivery = false;
  const pendingObserves: HTMLElement[] = [];
  let observeFlushFrame = 0;
  const keyByElement = new WeakMap<HTMLElement, string>();

  function observeRow(row: Row<T>): void {
    if (row.edge) return; // Declared height; the box clips.
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

  /** Committed rows join the dirty set; pending rows are remeasured at commit anyway. */
  function markDirty(row: Row<T>): void {
    if (row.edge) return; // Declared height stands.
    row.dirty = true;
    if (rows.get(row.key) === row) dirtyRows.add(row);
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
      if (quantizeHeight(height) === row.height) continue;
      markDirty(row);
      changed = true;
    }
    if (!changed) return;
    // Idle: commit in the same frame as the delivery (after layout, before
    // paint — I6). Scrolling: the commit waits for settle — except what
    // "live" can commit without a scroll write, which commits now.
    inMeasurementDelivery = true;
    try {
      // A discrete host interaction registered its anchor before changing
      // the DOM. Its rAF (or settle) owns this measurement, so an earlier RO
      // delivery must not accidentally resolve it with the default policy.
      if (remeasureOwnsNextCommit()) {
        publish();
      } else if (idle()) commit(null);
      else if (!liveCommit()) publish();
    } finally {
      inMeasurementDelivery = false;
    }
  });

  // A width change invalidates every held measurement: mounted rows are
  // re-read in place, retained rows re-premeasured, all at the next commit.
  // A height change while the viewport stands on a pin keeps the pinned row
  // at the top and sizes the reserve to the new height (I5): a taller
  // viewport shrinks the scroll range, and the engine clamps the position
  // in layout, reporting it before or after this delivery — so the
  // pre-resize position decides (a viewport that had left the pin keeps
  // its anchor), and a glide in flight decides by its destination.
  const viewportObserver = new ResizeObserver(() => {
    if (disposed) return;
    const width = viewport.clientWidth;
    const widthChanged =
      Math.abs(width - lastViewportWidth) > MEASURE_EPSILON_PX;
    lastViewportWidth = width;
    const height = viewport.clientHeight;
    const heightChanged =
      Math.abs(height - lastViewportHeight) > MEASURE_EPSILON_PX;
    // The observer's first delivery, and any later size-neutral one, is
    // not a resize: nothing to commit.
    if (!widthChanged && !heightChanged) return;
    if (widthChanged) {
      // Pending rows need no marking: a retained row that waits for a
      // settle is dirty by construction and re-measured at its commit.
      for (const row of rows.values()) markDirty(row);
    }
    const pinTop = geometry.pinTop;
    // In flight, a glide's destination decides: a command onto the pin
    // stands on it in intent, one leaving it does not even while its first
    // frames are still within a pixel of it.
    const stoodOnPin =
      pinTop !== null &&
      (glide !== null
        ? glideToPin
        : Math.abs(lastObservedTop - pinTop) <= AT_EDGE_EPSILON_PX);
    if (idle()) {
      commit(null, stoodOnPin ? "pin" : "viewport", "allowed", "keep");
      // The commit's write is where the viewport stands now; the next
      // delivery must not compare against the pre-resize position.
      if (!disposed) lastObservedTop = viewport.scrollTop;
    } else {
      // The reserve (I5) is sized to the viewport by a commit: a size
      // change during a phase with nothing else held still needs one at
      // the settle, or a pinned landing keeps a stale strip below it. A
      // pin stance holds for the phase: the engine's clamp moves the
      // observed position off the pin before the next delivery (an
      // animating composer delivers several).
      if (resizeHeld !== "pin") resizeHeld = stoodOnPin ? "pin" : "viewport";
      publish();
    }
    // Adopted only now: this delivery's own publish must not take the
    // clamped position for where the viewport stood — the clamp's scroll
    // event may still be on its way (an in-page composer resize clamps in
    // the frame's layout and reports in the next one).
    lastViewportHeight = height;
  });
  viewportObserver.observe(viewport);

  // A glide cannot survive a hidden document: its animation frames pause
  // while the controller's timers keep running and settle the phase, and on
  // return the glide would resume writing under a runtime that believes it
  // is idle — every commit then lands under a moving glide. Cancel it; the
  // command resolves false (interrupted), like any other interruption.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden" && glide !== null) {
      glide.cancel(); // Its completion callback guards itself.
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // --- Preparation (off-scroller, failure-atomic) ---------------------------
  function emptyPrepared(
    keys: readonly string[],
    anchor: AnchorPolicy,
  ): Prepared<T> {
    return { keys, newRows: new Map(), anchor };
  }

  function prepare(
    next: readonly T[],
    explicitAnchor: AnchorPolicy | undefined,
  ): { prepared: Prepared<T>; teardownFailures: unknown[] } {
    // An omitted anchor INHERITS the pending snapshot's policy: a held page
    // load that asked for "viewport" must not be turned into "auto" (and
    // an end-follow) by an unrelated same-key update landing before
    // settle. Only an explicit anchor replaces it.
    const anchor: AnchorPolicy = explicitAnchor ?? pending?.anchor ?? "auto";
    const itemKeys = next.map(keyOf);
    const itemByKey = new Map<string, T>();
    for (let index = 0; index < next.length; index++) {
      const key = itemKeys[index] as string;
      if (isSlotKey(key)) {
        throw new Error(`item key "${key}" uses the reserved edge-slot prefix`);
      }
      if (itemByKey.has(key)) throw new Error(`duplicate key "${key}"`);
      itemByKey.set(key, next[index] as T);
    }
    // Edge slots bracket the items in the key order.
    const startSlot = edgeSlots.start;
    const endSlot = edgeSlots.end;
    const keys: string[] = [
      ...(startSlot ? [slotKey("start", startSlot.key)] : []),
      ...itemKeys,
      ...(endSlot ? [slotKey("end", endSlot.key)] : []),
    ];

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
    /** Equal-height phase-time updates: swapped into committed slots in phase 2. */
    const promotions: { row: Row<T>; fresh: Row<T> }[] = [];
    const promotionCandidates: { row: Row<T>; fresh: Row<T> }[] = [];
    /** Fresh renders measured together after every render succeeds. */
    const freshRows: Row<T>[] = [];
    const adopted = new Set<string>();
    /** Teardown failures of what a mid-preparation dispose destroyed. */
    const disposeFailures: unknown[] = [];

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

    /** Retain a fresh render for the preparation's single measurement pass. */
    const retainFresh = (
      key: string,
      item: T,
      element: HTMLElement,
    ): Row<T> => {
      if (disposed) {
        try {
          options.onDestroy?.(element, item);
        } catch (error) {
          disposeFailures.push(error);
        }
        throw new DisposedDuringPreparation();
      }
      // The provisional height is never observable: phase 1 owns this row
      // until every fresh element has been measured below.
      const row = retain(key, item, element, 1);
      built.push(row);
      freshRows.push(row);
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
      return retainFresh(row.key, item, rendered);
    };

    /** A key with a prepared-but-uncommitted row: adopt or advance it. */
    const prepareAdopted = (
      key: string,
      item: T,
      preparedBefore: Row<T>,
    ): void => {
      adopted.add(key);
      if (
        preparedBefore.renderedItem === item &&
        !preparedBefore.renderUnknown
      ) {
        newRows.set(key, preparedBefore);
        return;
      }
      const replacement = renderInPlaceOrReplace(preparedBefore, item);
      if (replacement === null) {
        newRows.set(key, preparedBefore);
      } else {
        newRows.set(key, replacement); // preparedBefore dies in phase 2.
        adopted.delete(key);
      }
    };

    /** A committed key whose item changed. */
    const prepareChanged = (key: string, item: T, committed: Row<T>): void => {
      if (idle() || liveUpdates) {
        // In place (a "live" phase-time render mutates the mounted
        // element; liveCommit then commits its height at once when no
        // scroll write is needed for it).
        const replacement = renderInPlaceOrReplace(committed, item);
        if (replacement !== null) newRows.set(key, replacement);
        return;
      }
      // A scroll phase is active: committed elements are frozen — content
      // as much as geometry, mounted or not (an unmounted row may mount
      // mid-phase at its committed height). The update is rendered FRESH
      // and premeasured off-scroller. Under "same-height", an equal
      // whole-pixel height on a clean committed row is PROMOTED — swapped
      // into the committed slot in phase 2 with geometry untouched, so
      // streaming keeps flowing under a scroll until a wrap changes the
      // height. Otherwise ("freeze" always) it is retained and swapped in
      // atomically at settle with its height; later updates in the same
      // phase advance that replacement in place (it is off-scroller)
      // through adoption.
      const fresh = retainFresh(key, item, render(item));
      newRows.set(key, fresh);
      if (promoteSameHeight && !committed.dirty) {
        promotionCandidates.push({ row: committed, fresh });
      }
    };

    /** An edge slot key: adopt, keep, or build the host's slot element. */
    const prepareSlot = (key: string): void => {
      const edge: Edge =
        key === slotKey("start", startSlot?.key ?? "") ? "start" : "end";
      const slot = edge === "start" ? startSlot : endSlot;
      if (!slot) return;
      const preparedBefore = previous?.newRows.get(key);
      if (preparedBefore) {
        adopted.add(key);
        if (preparedBefore.edgeSlot === slot) {
          newRows.set(key, preparedBefore);
          return;
        }
        adopted.delete(key); // Superseded: dies in phase 2.
      } else if (rows.get(key)?.edgeSlot === slot) {
        return;
      }
      const row = retainEdgeSlot(edge, slot);
      built.push(row);
      newRows.set(key, row);
    };

    try {
      for (const key of keys) {
        if (isSlotKey(key)) {
          prepareSlot(key);
          if (disposed) throw new DisposedDuringPreparation();
          continue;
        }
        const item = itemByKey.get(key) as T;
        const preparedBefore = previous?.newRows.get(key);
        if (preparedBefore) {
          prepareAdopted(key, item, preparedBefore);
        } else {
          const committed = rows.get(key);
          if (committed === undefined) {
            newRows.set(key, retainFresh(key, item, render(item)));
          } else if (
            committed.renderUnknown ||
            committed.renderedItem !== item
          ) {
            prepareChanged(key, item, committed);
          }
        }
        if (disposed) throw new DisposedDuringPreparation();
      }

      // Render first, then measure every fresh node together. One layout
      // serves the whole preparation instead of one forced layout per row.
      if (freshRows.length > 0) {
        const heights = measureDetached(freshRows);
        freshRows.forEach((row, index) => {
          const height = quantizeHeight(heights[index] as number);
          row.height = height;
          row.slot.style.height = `${height}px`;
        });
      }

      for (const candidate of promotionCandidates) {
        if (candidate.fresh.height !== candidate.row.height) continue;
        newRows.delete(candidate.row.key);
        promotions.push(candidate);
      }
      if (disposed) throw new DisposedDuringPreparation();
    } catch (error) {
      // DOM restoration and local cleanup complete first; teardown
      // failures then surface together with the original error.
      const failures = [...disposeFailures, ...rollBack()];
      if (error instanceof DisposedDuringPreparation) {
        return {
          prepared: emptyPrepared(keys, anchor),
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
    // superseded pending snapshot prepared and this one did not adopt, and
    // of elements displaced by promotions; a host disposing from one of
    // them must not leak what was built here, so preparation keeps cleanup
    // ownership until the hand-off returns.
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
    }
    teardownFailures.push(...applyPromotions(promotions));
    if (disposed) {
      teardownFailures.push(...destroyAll(built));
      return { prepared: emptyPrepared(keys, anchor), teardownFailures };
    }
    return { prepared: { keys, newRows, anchor }, teardownFailures };
  }

  /**
   * Promotions: the fresh element moves into the committed row's slot
   * (same height, same offset — no geometry change) and the displaced
   * element is destroyed. The fresh row object is retired so `built` can
   * never destroy that element a second time; a host disposing from a
   * destruction stops the loop and the caller tears down the rest.
   */
  function applyPromotions(
    promotions: readonly { row: Row<T>; fresh: Row<T> }[],
  ): unknown[] {
    const failures: unknown[] = [];
    for (const { row, fresh } of promotions) {
      if (disposed || row.destroyed) break;
      const displaced = row.element;
      const displacedItem = row.item;
      if (row.mounted) rowObserver.unobserve(displaced);
      fresh.element.remove();
      displaced.replaceWith(fresh.element);
      row.element = fresh.element;
      row.item = fresh.item;
      row.renderedItem = fresh.item;
      row.renderUnknown = false;
      fresh.destroyed = true;
      if (row.mounted) observeRow(row);
      try {
        options.onDestroy?.(displaced, displacedItem);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  /** The prepared key order is the committed one: no structural change. */
  function sameKeysAsCommitted(keys: readonly string[]): boolean {
    if (keys.length !== geometry.count) return false;
    for (let index = 0; index < keys.length; index++) {
      if (geometry.keyAt(index) !== keys[index]) return false;
    }
    return true;
  }

  // --- The atomic commit ----------------------------------------------------
  function commitHeight(row: Row<T>, measured: number): void {
    const height = quantizeHeight(measured);
    row.dirty = false;
    dirtyRows.delete(row);
    row.height = height;
    row.slot.style.height = `${height}px`;
    geometry.measure(row.key, height);
  }

  /**
   * Commit the heights of these rows: every read (mounted rows in place,
   * detached rows in one measurement layout) happens before any slot
   * write, so a commit never thrashes layout row by row.
   */
  function commitMeasured(toMeasure: Iterable<Row<T>>): void {
    const mounted: Row<T>[] = [];
    const detached: Row<T>[] = [];
    for (const row of toMeasure) (row.mounted ? mounted : detached).push(row);
    const mountedHeights = mounted.map(measureInPlace);
    const detachedHeights = measureDetached(detached);
    mounted.forEach((row, index) => {
      commitHeight(row, mountedHeights[index] as number);
    });
    detached.forEach((row, index) => {
      commitHeight(row, detachedHeights[index] as number);
    });
  }

  /**
   * "live": commit the dirty heights that need NO anchor-preserving scroll
   * write — rows at or below the viewport's anchor row — right now,
   * mid-phase. The anchor keeps its coordinate by construction (nothing
   * above it changed), so nothing on screen moves except the changed row
   * and what lies below it; the canvas grows or shrinks at the bottom. A
   * shrink may still make the browser clamp to a smaller maximum. Rows
   * strictly above the anchor are entirely off-screen and stay dirty for
   * settle — or for the scroll event that makes one of them the anchor,
   * which commits it before that frame paints. A structural snapshot is
   * live too when it changes nothing above the anchor (see
   * confinedBelowAnchor); any other waits for the settle.
   * Returns whether it published (it did whenever it committed).
   */
  function liveCommit(): boolean {
    if (
      !liveUpdates ||
      disposed ||
      dirtyRows.size === 0 ||
      remeasureOwnsNextCommit()
    ) {
      return false;
    }
    let published = false;
    guarded(() => {
      const vp = viewportState();
      const anchor = geometry.anchorAt(vp);
      const anchorIndex = anchor === null ? 0 : geometry.indexOf(anchor.key);
      const committable: Row<T>[] = [];
      for (const row of dirtyRows) {
        if (geometry.indexOf(row.key) >= anchorIndex) committable.push(row);
      }
      if (committable.length === 0) return;
      const capture = geometry.capture(vp, "none");
      commitMeasured(committable);
      geometryEpoch += 1;
      const result = geometry.resolve(capture);
      canvas.style.height = `${result.totalSize}px`;
      repositionMounted();
      // There is no explicit scroll write, but shrinking the scroll range
      // can make the browser clamp scrollTop. Re-read after the canvas write
      // and reconcile that real position before this frame paints.
      reconcileAndPublish();
      if (smoothFollowArmed) followIfBehindEnd();
      published = true;
    });
    return published;
  }

  /**
   * `follow`: "derive" re-reads the smooth follow intent from where the
   * commit resolved — the policy was a host's or a settle's, so its
   * resolution IS the intent; "keep" leaves it as found — a resize's
   * viewport/pin, a mid-phase live commit.
   */
  function commit(
    snapshot: Prepared<T> | null,
    policyOverride?: CapturePolicy,
    scrollWrite: "allowed" | "never" = "allowed",
    follow: "derive" | "keep" = "derive",
  ): void {
    if (disposed) return;
    guarded(() => {
      const applying = snapshot ?? pending;
      pending = null;
      committing = applying;
      try {
        commitBody(applying, policyOverride, scrollWrite, follow);
      } finally {
        committing = null;
      }
    });
  }

  function commitBody(
    applying: Prepared<T> | null,
    policyOverride: CapturePolicy | undefined,
    scrollWrite: "allowed" | "never",
    follow: "derive" | "keep",
  ): void {
    // Teardown failures are collected here and surfaced only after the
    // commit has reached its consistent terminal state.
    const teardownFailures: unknown[] = [];
    try {
      const policy = policyOverride ?? applying?.anchor ?? "auto";
      const before = viewportState();
      const capture = geometry.capture(before, policy);
      const toMeasure = new Set<Row<T>>();

      if (applying) {
        // Keys and rows: drop removed, swap replaced, adopt new. A row is
        // removed from the map BEFORE its destruction so a host disposing
        // from onDestroy can never destroy it twice. A same-key snapshot
        // (every streaming token) skips the removal scan and the key
        // rebuild entirely.
        const keysChanged = !sameKeysAsCommitted(applying.keys);
        const doomed: Row<T>[] = [];
        if (keysChanged) {
          const nextKeys = new Set(applying.keys);
          for (const [key, row] of [...rows]) {
            if (nextKeys.has(key)) continue;
            rows.delete(key);
            doomed.push(row);
          }
        }
        for (const [key, row] of applying.newRows) {
          const old = rows.get(key);
          rows.set(key, row);
          if (old) doomed.push(old);
        }
        teardownFailures.push(...destroyAll(doomed));
        if (disposed) return;
        if (keysChanged) geometry.setKeys(applying.keys);
        // Latest heights, exactly once. A row prepared in this very
        // transaction was measured moments ago; one that waited for a
        // settle (dirty) is measured again — a detached image may have
        // decoded since. Replacements ALWAYS reach the kernel: the key was
        // measured before, but with the old element.
        for (const row of applying.newRows.values()) {
          if (row.dirty) toMeasure.add(row);
          else commitHeight(row, row.height);
        }
      }

      // Build this set only after removals and replacements: destroying a
      // row drops it from dirtyRows, so a replaced key's old row can never
      // be measured over its replacement.
      for (const row of dirtyRows) toMeasure.add(row);

      commitMeasured(toMeasure);
      geometryEpoch += 1;

      const result = geometry.resolve(capture);
      canvas.style.height = `${result.totalSize}px`;
      repositionMounted();
      // Engines quantize scroll positions differently: Chromium rounds a
      // fractional write, WebKit floors it (the anchor then lands up to a
      // full pixel short). Writing a whole pixel bounds the anchor's
      // landing error to half a pixel everywhere.
      const target = Math.round(result.scrollTop);
      const smoothFollow =
        !booting &&
        options.followBehavior === "smooth" &&
        result.mode === "end" &&
        // A command's takeover settles the phase it interrupts, and the
        // command owns the motion from there: a held end-compatible
        // snapshot lands by write, never by a glide the command would
        // orphan (a smooth command to the start could then never settle).
        !takingOver &&
        Math.abs(target - before.scrollTop) > SCROLL_WRITE_EPSILON_PX;
      // Follow intent, re-derived by a commit whose policy a host or a
      // settle chose: standing at the end after a commit that could have
      // followed it ("auto", "end" — boot included) is following, whether
      // by an end resolution or by scrollback landing above a followed
      // end. An explicit "viewport"/"none" is a statement about the
      // viewport, never follow intent: a bottom page load, an opened tool
      // panel — even a collapsed one whose shrink leaves the viewport
      // clamped at the end. A takeover's settle commit is the command's;
      // it leaves the intent the command already cleared.
      if (
        options.followBehavior === "smooth" &&
        follow === "derive" &&
        !takingOver
      ) {
        smoothFollowArmed =
          (policy === "auto" || policy === "end") &&
          geometry.maxScrollTop(viewport.clientHeight) - target <=
            AT_EDGE_EPSILON_PX;
      }
      // A mid-phase commit never writes: its target equals the position by
      // construction, except where the engine holds the viewport outside
      // the range (an iOS rubber-band bounce) and the clamp would fight it.
      if (
        !smoothFollow &&
        scrollWrite === "allowed" &&
        Math.abs(target - before.scrollTop) > SCROLL_WRITE_EPSILON_PX
      ) {
        writeScrollTop(target);
      }
      // Read once after the write: the engine may have clamped it.
      reconcileAndPublish();
      if (disposed) return;
      if (smoothFollow) startFollowGlide();
      // A kept intent whose commit resolved elsewhere — a shorter viewport
      // uncovered the end, a live append landed in the gap between two
      // follow legs — catches up (a glide is a phase of its own, never a
      // write into a gesture; genuine input already cleared the intent).
      else if (follow === "keep" && smoothFollowArmed) followIfBehindEnd();
    } finally {
      deferTeardown(teardownFailures);
    }
  }

  // --- Window reconciliation (allowed during scrolling) ---------------------
  /**
   * Move every mounted slot to its committed offset — BEFORE any read or
   * write that forces layout. WebKit computes a scroller's range at layout
   * and does not recompute it for a transform-only move: a scrollTop write
   * (or read) between the canvas write and the slot moves froze the range
   * with a row at its old offset in its new height, and a touch scroll then
   * reached that stale end — a blank gap below the last row after an iPad
   * rotation, gone at the next layout.
   */
  function repositionMounted(): void {
    for (const row of mountedRows) placeRow(row);
  }

  /** Move a row's slot to its committed offset (a no-op when unchanged). */
  function placeRow(row: Row<T>): void {
    const offset = geometry.offsetOf(row.key);
    if (offset < 0 || row.offset === offset) return;
    row.offset = offset;
    row.slot.style.transform = `translateY(${offset}px)`;
  }

  function mountRow(row: Row<T>): void {
    row.mounted = true;
    mountedRows.add(row);
    canvas.appendChild(row.slot);
    observeRow(row);
  }

  function unmountRow(row: Row<T>): void {
    row.mounted = false;
    mountedRows.delete(row);
    rowObserver.unobserve(row.element);
    row.slot.remove();
  }

  let lastReconcile = { scrollTop: Number.NaN, height: Number.NaN, epoch: -1 };
  let lastRange = { start: 0, end: 0 };

  function reconcileWindow(vp: GeometryViewport): {
    start: number;
    end: number;
  } {
    // A glide write and the scroll event it produces both reconcile; the
    // second pass finds nothing to do.
    if (
      lastReconcile.scrollTop === vp.scrollTop &&
      lastReconcile.height === vp.height &&
      lastReconcile.epoch === geometryEpoch
    ) {
      return lastRange;
    }
    const geometryChanged = lastReconcile.epoch !== geometryEpoch;
    lastReconcile = {
      scrollTop: vp.scrollTop,
      height: vp.height,
      epoch: geometryEpoch,
    };
    const range = geometry.window(vp, overscanPx);
    lastRange = range;
    // Deleting the current entry while iterating a Set is defined and does
    // not skip its successor; avoid allocating an array on every scroll.
    for (const row of mountedRows) {
      const index = geometry.indexOf(row.key);
      if (index < range.start || index >= range.end) unmountRow(row);
    }
    for (let index = range.start; index < range.end; index++) {
      const key = geometry.keyAt(index);
      const row = key === undefined ? undefined : rows.get(key);
      if (!row) continue;
      const entering = !row.mounted;
      if (entering) mountRow(row);
      // Offsets cannot change during a plain scroll. Read the Fenwick tree
      // only for rows entering the window or after a geometry commit.
      if (entering || geometryChanged) placeRow(row);
    }
    return range;
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
    // Only abortEdge aborts these, and it clears the whole set as it does.
    const abort = new AbortController();
    reachAborts[edge].add(abort);
    callback({ signal: abort.signal });
  }

  function publish(
    vp: GeometryViewport = viewportState(),
    reconciledRange?: { start: number; end: number },
  ): void {
    if (disposed) return;
    // Until a resize has been adopted, a position at the new height is the
    // engine's clamp (its scroll event, or the observer's own publish), not
    // where the viewport stood.
    if (Math.abs(vp.height - lastViewportHeight) <= MEASURE_EPSILON_PX) {
      lastObservedTop = vp.scrollTop;
    }
    const range = reconciledRange ?? geometry.window(vp, overscanPx);
    const maxTop = geometry.maxScrollTop(vp.height);
    // Host-facing indexes count items only; edge slots are the runtime's.
    const leading =
      geometry.count > 0 && isSlotKey(geometry.keyAt(0) ?? "") ? 1 : 0;
    const trailing =
      geometry.count > leading &&
      isSlotKey(geometry.keyAt(geometry.count - 1) ?? "")
        ? 1
        : 0;
    const count = geometry.count - leading - trailing;
    const start = Math.min(count, Math.max(0, range.start - leading));
    const end = Math.min(count, Math.max(0, range.end - leading));
    const atStart = vp.scrollTop <= AT_EDGE_EPSILON_PX;
    const atEnd = maxTop - vp.scrollTop <= AT_EDGE_EPSILON_PX;
    const totalSize = geometry.totalSize;
    const held = pending !== null || dirtyRows.size > 0;
    // Most scroll events remain inside the same mounted range. Avoid a
    // short-lived public-state object unless a host-observable field
    // changed — or geometry did: a commit can move committed positions
    // while every field stays the same, and a host reading positionOf
    // must hear about it.
    if (
      lastPublishedEpoch !== geometryEpoch ||
      lastState.count !== count ||
      lastState.start !== start ||
      lastState.end !== end ||
      lastState.atStart !== atStart ||
      lastState.atEnd !== atEnd ||
      lastState.following !== smoothFollowArmed ||
      lastState.totalSize !== totalSize ||
      lastState.held !== held
    ) {
      lastPublishedEpoch = geometryEpoch;
      lastState = {
        count,
        start,
        end,
        atStart,
        atEnd,
        following: smoothFollowArmed,
        totalSize,
        held,
      };
      options.onState?.(lastState);
    }
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

  /** Window reconciliation plus ("live") what commits without a write. */
  function onScrolled(): void {
    // The window moves first (a row the scroll exposed may be the one a live
    // commit needs), then either the live commit or the plain publish.
    const vp = viewportState();
    // A genuine gesture that leaves the pin owns the viewport: a held pin
    // stance (I5) is dropped — unless the move is the engine's: a clamp
    // pulls a position past the stale range's end back onto it, a
    // rubber-band bounce pushes beyond it. A hand landing on that end from
    // below is the user's.
    if (resizeHeld === "pin" && glide === null) {
      const max = geometry.maxScrollTop(vp.height);
      const beyondEnd = vp.scrollTop > max + AT_EDGE_EPSILON_PX;
      const clamped =
        lastObservedTop > max + AT_EDGE_EPSILON_PX &&
        Math.abs(vp.scrollTop - max) <= AT_EDGE_EPSILON_PX;
      if (!beyondEnd && !clamped) resizeHeld = "viewport";
    }
    const range = reconcileWindow(vp);
    if (!liveCommit()) publish(vp, range);
  }

  /** Reconcile the window against the real position and publish it. */
  function reconcileAndPublish(): void {
    const vp = viewportState();
    const range = reconcileWindow(vp);
    publish(vp, range);
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
      const wasFollowing = smoothFollowArmed;
      smoothFollowArmed = false;
      // Input that stops a glide onto the pin short (a tap, a scrollbar
      // press) owns the viewport where it stopped; no scroll event follows
      // to say so.
      if (glide !== null && resizeHeld === "pin") resizeHeld = "viewport";
      glide?.cancel();
      settleParked(() => false);
      // The host hears the interruption now, not at the first scroll event.
      if (wasFollowing) publish();
    },
    // The glide's own completion is the ONLY authority that ends its phase.
    // Safari emits a scrollend after every programmatic write; judging
    // "reached" by proximity (within 2px) ended the phase while the glide
    // still had 1px frames to write, and a commit could land under it.
    noSmoothScrollInFlight: () => glide === null,
    onGestureStarted: () => {},
    onGestureSettled: () => {
      // The phase reached idle: everything held commits, once — and only
      // then does a landed command learn whether it is still on target.
      const remeasureReady =
        remeasureRequests.size === 0 && remeasurePolicy !== undefined;
      const explicitPolicy = remeasurePolicy;
      if (remeasureReady) remeasurePolicy = undefined;
      if (pending !== null || dirtyRows.size > 0) {
        // Rows grown under a pinned landing (the reply streaming below the
        // pinned prompt) commit on the pin's stance, not on a guess.
        // A live structural commit may have removed the pinned row since
        // the stance was held; a pending snapshot must keep it.
        const pinnedKey = geometry.pinned;
        const onPin =
          explicitPolicy === undefined &&
          resizeHeld === "pin" &&
          pinnedKey !== null &&
          (pending === null ||
            (pending.anchor === "auto" && pending.keys.includes(pinnedKey)));
        if (onPin) commit(null, "pin", "allowed", "keep");
        else commit(null, explicitPolicy);
      } else if (resizeHeld !== null) {
        commit(null, resizeHeld, "allowed", "keep");
      } else {
        publish();
      }
      resizeHeld = null;
      // A completed command to the end is explicit follow intent: growth
      // that outran its glide (fast streaming) must not read as "the user
      // is not at the end" — a genuine interruption resolved it before this.
      const endCommand = awaitingSettle?.followsEnd === true;
      settleParked((landed) => !disposed && landed());
      // A scheduled interaction owns the next frame/settle. Do not infer a
      // fresh end-follow intent in the gap after cancelling its old glide.
      if (options.followBehavior === "smooth" && !remeasureOwnsNextCommit()) {
        const following =
          !takingOver && (lastState.atEnd || endCommand || followGlide);
        if (smoothFollowArmed !== following) {
          smoothFollowArmed = following;
          publish();
        }
        // Following but not there: the end moved during the phase.
        if (following) followIfBehindEnd();
      }
    },
    onGestureReset: () => {},
    onScrollEventObserved: () => {
      // Browsers dispatch scroll events asynchronously, so one cannot land
      // inside a transaction; a host dispatching one synchronously from a
      // callback is dropped — the transaction's own reconcile follows.
      if (disposed || inTransaction) return;
      // The window moves; under "live", what needs no scroll write may
      // commit too (see onScrolled).
      guarded(onScrolled);
    },
  });

  /**
   * Take the command parked for its settle, if any, and resolve it:
   * `verdict` receives its landing check (interrupted → `() => false`).
   */
  function settleParked(verdict: (landed: () => boolean) => boolean): void {
    const awaiting = awaitingSettle;
    if (!awaiting) return;
    awaitingSettle = null;
    awaiting.done(verdict(awaiting.landed));
  }

  // A command is settling the phase it interrupts: that settle must not
  // infer follow intent from the position the command is leaving.
  let takingOver = false;

  /**
   * An explicit command takes the viewport over: genuinely stop the
   * browser-owned animation (a write plus an overflow toggle through a
   * forced reflow — merely clearing timers would leave momentum alive),
   * then settle the phase so held work commits before the command.
   */
  function interruptNativeScroll(): void {
    if (!controller.isScrollPhaseActive()) return;
    // Write the CURRENT position back untouched and unrounded: a fractional
    // native position must survive the takeover exactly; the engine clamps
    // its own writes.
    const currentTop = viewport.scrollTop;
    writeScrollTop(currentTop);
    const previousOverflowY = viewport.style.overflowY;
    viewport.style.overflowY = "hidden";
    void viewport.offsetHeight;
    viewport.style.overflowY = previousOverflowY;
    writeScrollTop(currentTop);
    takingOver = true;
    try {
      controller.finishGesture();
    } finally {
      takingOver = false;
    }
  }

  // --- Data -----------------------------------------------------------------
  function setItems(
    next: readonly T[],
    setOptions: { anchor?: AnchorPolicy } = {},
  ): void {
    if (disposed) return;
    const snapshot = [...next];
    const anchor = setOptions.anchor;
    if (enqueueDuringTransaction(() => applyItems(snapshot, anchor))) return;
    applyItems(snapshot, anchor);
  }

  function applyItems(
    snapshot: readonly T[],
    anchor: AnchorPolicy | undefined,
  ): void {
    if (disposed) return;
    lastItems = snapshot;
    // Always prepared now (off-scroller, inside the reentrancy guard since
    // render() is a host callback); committed now when idle, or mid-phase
    // when the change needs no scroll write ("live"), else at the settle.
    guarded(() => {
      const { prepared, teardownFailures } = prepare(snapshot, anchor);
      // Hand-off happens regardless of supersession teardown failures;
      // they are deferred to the outermost guard, which surfaces them only
      // after the snapshot is pending or committed AND queued work drained.
      deferTeardown(teardownFailures);
      if (disposed) return;
      if (idle()) {
        // A click-driven remeasure may be waiting for its post-activation
        // frame. Any snapshot that happens to arrive first must preserve
        // that newer viewport intent too; the measurement frame still owns
        // and later consumes the policy.
        commit(prepared, remeasurePolicy);
        return;
      }
      if (prepared.newRows.size === 0 && sameKeysAsCommitted(prepared.keys)) {
        // No structural change and no retained replacement: the snapshot
        // was fully applied — promoted, rendered in place ("live"; those
        // rows wait in dirtyRows, not as a snapshot), or unchanged — and it
        // supersedes whatever did wait.
        pending = null;
      } else if (
        liveUpdates &&
        prepared.anchor !== "end" &&
        confinedBelowAnchor(prepared)
      ) {
        // "live": a structural change that leaves everything above the
        // anchor untouched needs no scroll write (the anchor keeps its
        // coordinate by construction) — commit it now, mid-phase: a
        // version switch, an appended message. Holding it for a settle
        // that momentum can postpone by seconds reads as a dead click.
        commit(prepared, "none", "never", "keep");
        return;
      } else {
        // These rows will wait: their heights are re-read at the settle
        // (edge slots keep their declared height).
        for (const row of prepared.newRows.values()) {
          if (!row.edge) row.dirty = true;
        }
        pending = prepared;
      }
      if (!liveCommit()) publish();
    });
  }

  /**
   * Whether a snapshot (plus every dirty measurement it would commit with)
   * changes nothing above the viewport's anchor: the committed keys up to
   * the anchor are an unchanged, unreplaced prefix of the new keys, dirty
   * rows sit at or below the anchor, and the anchor key did not move to
   * another index. Such a commit needs no scroll write.
   */
  function confinedBelowAnchor(prepared: Prepared<T>): boolean {
    const anchor = geometry.anchorAt(viewportState());
    if (anchor === null) return true;
    const anchorIndex = geometry.indexOf(anchor.key);
    for (let index = 0; index < anchorIndex; index++) {
      const key = geometry.keyAt(index);
      if (key === undefined || prepared.keys[index] !== key) return false;
      if (prepared.newRows.has(key)) return false;
    }
    // The anchor row itself may change in place — re-rendered, replaced by
    // another row at its index, or removed: its offset is unchanged, and the
    // new content simply renders at the position the viewport already
    // holds (a shorter row lets the engine clamp). An anchor that merely
    // moved (a prepend, a reorder) needs the write.
    if (prepared.keys[anchorIndex] !== anchor.key) {
      const nextKeys = new Set(prepared.keys);
      if (nextKeys.has(anchor.key)) return false;
    }
    for (const row of dirtyRows) {
      if (geometry.indexOf(row.key) < anchorIndex) return false;
    }
    return true;
  }

  // --- Commands -------------------------------------------------------------
  function scrollTo(
    target: ScrollTarget,
    scrollOptions: ScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const owned: ScrollOptions = {
      align: scrollOptions.align,
      behavior: scrollOptions.behavior,
      duration:
        scrollOptions.duration !== undefined &&
        Number.isFinite(scrollOptions.duration) &&
        scrollOptions.duration > 0
          ? scrollOptions.duration
          : undefined,
      offset:
        scrollOptions.offset !== undefined &&
        Number.isFinite(scrollOptions.offset) &&
        scrollOptions.offset > 0
          ? scrollOptions.offset
          : undefined,
    };
    return new Promise((resolve) => {
      if (
        enqueueDuringTransaction(
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

  /** The command's target scrollTop under current geometry; null once a keyed target is gone. */
  function targetTop(target: ScrollTarget, below = 0): number | null {
    const maxTop = geometry.maxScrollTop(viewport.clientHeight);
    if (target === "start") return 0;
    if (target === "end") return maxTop;
    const offset = geometry.offsetOf(target);
    return offset < 0 ? null : Math.max(0, Math.min(offset - below, maxTop));
  }

  /** Whether the viewport is on the command's target under current geometry. */
  function landedOn(target: ScrollTarget, below = 0): boolean {
    const top = targetTop(target, below);
    return (
      top !== null && Math.abs(viewport.scrollTop - top) <= AT_EDGE_EPSILON_PX
    );
  }

  function performScrollTo(
    target: ScrollTarget,
    scrollOptions: ScrollOptions,
    done: (completed: boolean) => void,
  ): void {
    smoothFollowArmed = false;
    const keyed = target !== "start" && target !== "end";
    const below = Math.max(0, scrollOptions.offset ?? 0);
    // A newer command supersedes the previous one whatever its state: a
    // parked landed command resolves false BEFORE its phase is finished
    // (finishing it would otherwise resolve it true), an in-flight glide
    // is cancelled. Then: explicit command > gesture — take the viewport
    // over, settling held work first so the command sees committed
    // geometry.
    settleParked(() => false);
    glide?.cancel();
    interruptNativeScroll();
    if (disposed || (keyed && geometry.indexOf(target) < 0)) {
      done(false);
      return;
    }
    // A keyed target with align:"start" reserves the shortfall (I5) — a
    // geometry change, committed now (the phase is idle).
    if (keyed && scrollOptions.align === "start") {
      geometry.pin(target, below);
      commit(null, "none");
    }

    // A keyed target that disappears mid-glide holds position; the landing
    // revalidation then fails.
    const destination = (): number =>
      targetTop(target, below) ?? viewport.scrollTop;

    if (scrollOptions.behavior !== "smooth") {
      const top = Math.round(destination());
      if (Math.abs(top - viewport.scrollTop) > SCROLL_WRITE_EPSILON_PX) {
        writeScrollTop(top);
      }
      // An instant command to the end has no settle to arm following at.
      if (target === "end" && options.followBehavior === "smooth") {
        smoothFollowArmed = true;
      }
      reconcileAndPublish();
      done(!disposed && landedOn(target, below));
      return;
    }

    // A glide is a programmatic scroll phase: held work waits for its
    // landing settle, exactly like a native gesture — and so does the
    // command's own result.
    controller.beginProgrammaticGesture();
    glide = startGlide(
      glideHost(destination),
      glidePace(viewport.clientHeight, scrollOptions.duration),
      (completed) =>
        guarded(() => {
          glide = null;
          glideToPin = false;
          if (!completed || disposed) {
            done(false);
            return;
          }
          awaitingSettle = {
            done,
            landed: () => landedOn(target, below),
            followsEnd: target === "end",
          };
          controller.markSettlePending();
        }),
    );
    glideToPin = keyed && scrollOptions.align === "start";
  }

  /**
   * A glide's view of the viewport. Each write is pre-announced to the
   * controller and reconciled before the frame paints: mount what the write
   * exposed, and ("live") commit any dirty row the viewport just reached.
   */
  function glideHost(target: () => number): GlideHost {
    return {
      read: () => viewport.scrollTop,
      write: (top) =>
        guarded(() => {
          writeScrollTop(top);
          onScrolled();
        }),
      target,
    };
  }

  /** Start a follow glide when the viewport is not already at the end. */
  function followIfBehindEnd(): void {
    // The same band as atEnd: a viewport within a pixel of the end is
    // there, and never starts a glide phase to move under a pixel.
    const behind =
      Math.abs(
        geometry.maxScrollTop(viewport.clientHeight) - viewport.scrollTop,
      ) > AT_EDGE_EPSILON_PX;
    if (behind) startFollowGlide();
  }

  /** Automatic end-follow: one glide whose destination tracks live growth. */
  function startFollowGlide(): void {
    if (disposed || glide !== null) return;
    controller.beginProgrammaticGesture();
    glide = startGlide(
      glideHost(() => geometry.maxScrollTop(viewport.clientHeight)),
      // Follow legs are short and frequent: a quicker landing than a
      // command's, so the end keeps up with the stream.
      glidePace(viewport.clientHeight, FOLLOW_LANDING_MS),
      () =>
        guarded(() => {
          glide = null;
          followGlide = false;
          if (!disposed) controller.markSettlePending();
        }),
    );
    followGlide = true;
  }

  /** Commit a host-driven measurement once its post-activation frame arrives. */
  function flushRemeasures(): void {
    remeasureFrame = 0;
    if (disposed) return;
    guarded(() => {
      // The last valid request's anchor wins.
      let requestedPolicy: AnchorPolicy | null = null;
      for (const [key, anchor] of remeasureRequests) {
        const row = rows.get(key);
        if (!row?.mounted || row.edge) continue;
        markDirty(row);
        requestedPolicy = anchor;
      }
      remeasureRequests.clear();

      if (requestedPolicy === null) {
        remeasurePolicy = undefined;
        publish();
        return;
      }
      remeasurePolicy = requestedPolicy;
      if (!idle()) {
        publish();
        return;
      }

      remeasurePolicy = undefined;
      commit(null, requestedPolicy);
    });
  }

  function scheduleRemeasure(key: string, anchor: AnchorPolicy): void {
    if (disposed) return;
    const current = rows.get(key);
    if (!current?.mounted || current.edge) return;
    // Delete first so repeated requests retain latest-request ordering.
    remeasureRequests.delete(key);
    remeasureRequests.set(key, anchor);
    remeasurePolicy = anchor;

    if (anchor === "viewport") {
      const automaticPhase =
        controller.isScrollPhaseActive() && smoothFollowArmed;
      smoothFollowArmed = false;
      if (followGlide) glide?.cancel();
      // End only the programmatic phase we just cancelled. Genuine input
      // clears the follow intent in cancelActiveSmoothScroll before this
      // API can run, so a native gesture is never finished here.
      if (automaticPhase) controller.finishGesture();
      publish();
    }

    if (remeasureFrame === 0) {
      remeasureFrame = requestAnimationFrame(flushRemeasures);
    }
  }

  function remeasure(
    key: string,
    remeasureOptions: RemeasureOptions = {},
  ): void {
    if (disposed) return;
    const anchor = remeasureOptions.anchor ?? "viewport";
    if (enqueueDuringTransaction(() => remeasure(key, { anchor }))) return;
    guarded(() => scheduleRemeasure(key, anchor));
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Every queued command in EVERY live scope settles (false): the open
    // transaction's, and each parent scope still holding undrained
    // siblings behind the child that is disposing.
    for (const scope of liveScopes) discardScope(scope);
    glide?.cancel();
    settleParked(() => false);
    abortEdge("start");
    abortEdge("end");
    controller.dispose();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (observeFlushFrame !== 0) cancelAnimationFrame(observeFlushFrame);
    if (remeasureFrame !== 0) cancelAnimationFrame(remeasureFrame);
    remeasureRequests.clear();
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
  }

  // --- Boot -----------------------------------------------------------------
  commit(prepare(lastItems, "end").prepared);
  booting = false;

  function setEdgeSlot(edge: Edge, slot: EdgeSlot | null): void {
    if (disposed) return;
    const owned = ownEdgeSlot(slot);
    if (enqueueDuringTransaction(() => setEdgeSlot(edge, owned))) return;
    edgeSlots[edge] = owned;
    setItems(lastItems);
  }

  function positionOf(key: string): { top: number; height: number } | null {
    if (geometry.indexOf(key) < 0) return null;
    return { top: geometry.offsetOf(key), height: geometry.heightOf(key) };
  }

  function elementOf(key: string): HTMLElement | null {
    const row = rows.get(key);
    return row?.mounted ? row.element : null;
  }

  return {
    setItems,
    scrollTo,
    remeasure,
    get state(): VirtualListState {
      return lastState;
    },
    setEdgeSlot,
    positionOf,
    elementOf,
    dispose,
  };
}
