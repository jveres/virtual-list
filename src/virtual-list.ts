import { DeclaredItems } from "./declared-items";
import { FollowController } from "./follow";
import {
  type AnchorPolicy,
  type CapturePolicy,
  type ExplicitAnchor,
  Geometry,
  type GeometryViewport,
} from "./geometry";
import { KeyIndex, KeyTable } from "./key-index";
import { type Glide, startNativeGlide, stopNativeScroll } from "./native-glide";
import { type GeometryWindow, PositionedGeometry } from "./positioned-geometry";
import { type Edge, ReachController } from "./reach";
import {
  createScrollSettleController,
  detectScrollSettleStrategy,
} from "./scroll-settle";
import type {
  AnchorRequest,
  EdgeSlot,
  FollowMode,
  ScrollOptions,
  ScrollTarget,
  VirtualList,
  VirtualListOptions,
  VirtualListState,
  WindowUpdate,
  WindowUpdateContext,
} from "./types";
import { scheduleReplacementRepaint } from "./viewport-repaint";

export type * from "./types";

// The core contract of docs/core-contract.md (I0–I6). Three ideas carry the
// engine (docs/architecture.md):
//
// 1. One commit rule. Everything the host submits becomes the DESIRED state:
//    the latest key order, rows already rendered and measured, and an anchor
//    intent. It lands at once when that needs no scroll write — the list is
//    idle, or every change sits at or below the viewport's anchor row — and
//    otherwise at the settle. There are no update modes.
// 2. Rows are measured where they mount. A new or replacing row is rendered
//    into its own clip slot inside the canvas, hidden and zero-height, and
//    measured there with the page's real styles. Mounting reveals the slot
//    in place: no detached measurement root, no second layout, no reparent.
// 3. One pass. Every entry point (an API call, a scroll event, an observer
//    delivery, a settle, a glide frame) runs inside `pass`. API calls made
//    from host callbacks queue behind it; host callback failures surface
//    after the runtime has reached a consistent state.
//
// Where the engine anchors natively (F5), rows sit in flow between spacers
// and the engine keeps the reader still. The physics lives in its own
// modules: the geometry kernel, the settle sensor, the glide, follow
// intent, and reach hysteresis.

const HEIGHT_NOISE = 1e-6;
/** Measurement and scroll-write noise. */
const EPSILON_PX = 0.5;
const AT_EDGE_PX = 1;
const MIN_OVERSCAN_PX = 300;
const IDLE_SLICE_MIN_MS = 4;
/** A width this long unchanged is settled: rows it left detached are read. */
const WIDTH_QUIET_MS = 150;
/** Bound background reflow; explicit commands still drain exact geometry. */
const WIDTH_DRAIN_ROWS = 32;
/** A window update adding more fresh rows prepares them across frames. */
const JOB_MIN_ROWS = 8;
/** At rest, amortize preparation while retaining the render-time budget. */
const JOB_REST_ROWS = 32;
const SLOT_PREFIX = "\u0000edge:";
const SLOT_BASE = "position:absolute;top:0;left:0;right:0;";
/** Where hidden slots wait: above the scroll origin, out of every rect query. */
const PARKED_TOP = "-100000px";
/** Native flow parks the row instead: its slot must never change position. */
const PARKED_TRANSLATE = "0 -100000px";
/** How far a mounting slot looks ahead for a connected successor. */
const INSERTION_SCAN = 64;
const MAX_POOLED_SLOTS = 128;

const slotKey = (edge: Edge, key: string): string =>
  `${SLOT_PREFIX}${edge}:${key}`;
const isSlotKey = (key: string): boolean =>
  key.charCodeAt(0) === 0 && key.startsWith(SLOT_PREFIX);

function pixelRatio(): number {
  const ratio = globalThis.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** A reading-anchor write lands on the device grid (I0). */
function toDevicePixel(value: number, ratio = pixelRatio()): number {
  return Math.round(value * ratio) / ratio;
}

/** A positioned origin that survives engines rounding writes to CSS pixels. */
function positionedOrigin(top: number, ratio = pixelRatio()): number {
  for (let step = 1; step <= 32; step++) {
    if (Math.abs(step * ratio - Math.round(step * ratio)) <= HEIGHT_NOISE)
      return Math.floor(top / step) * step;
  }
  return Math.floor(top * ratio) / ratio;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function ownSlot(slot: EdgeSlot | null | undefined): EdgeSlot | null {
  if (slot == null) return null;
  if (!Number.isFinite(slot.height) || slot.height <= 0)
    throw new Error(
      `edge slot "${slot.key}" height must be finite and > 0, got ${slot.height}`,
    );
  return { key: slot.key, height: slot.height, render: slot.render };
}

function ownAnchor(
  anchor: AnchorRequest | undefined,
): AnchorRequest | undefined {
  if (anchor === undefined || typeof anchor === "string") return anchor;
  if (anchor === null || typeof anchor.key !== "string")
    throw new TypeError("anchor key must be a string");
  if (!Number.isFinite(anchor.offset))
    throw new RangeError("anchor offset must be finite");
  if (
    anchor.visibilityInset !== undefined &&
    (!Number.isFinite(anchor.visibilityInset) || anchor.visibilityInset < 0)
  )
    throw new RangeError(
      "anchor visibilityInset must be finite and nonnegative",
    );
  return {
    key: anchor.key,
    offset: anchor.offset,
    ...(anchor.visibilityInset === undefined
      ? {}
      : { visibilityInset: anchor.visibilityInset }),
  };
}

function flatten(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

function throwAll(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError([...failures], message);
}

/** The host disposed the list from inside a render: abandon the update. */
class Abort extends Error {}

interface Row<T> {
  key: string;
  /** The item this row stands for. */
  item: T;
  /** The item its DOM reflects. */
  shown: T;
  /** A render threw on this element: re-render whatever the item. */
  broken: boolean;
  element: HTMLElement;
  /** Clip box; the element itself for positioned cards. */
  slot: HTMLElement;
  slotStyled: "none" | "hidden" | "mounted";
  slotHeight: number;
  slotAnchor: boolean;
  committedIndex: number;
  committedEpoch: number;
  height: number;
  /** Measured follow limit within this row; null means no limit yet. */
  followStart: number | null;
  /** The offset last written to the slot (NaN: none). */
  offset: number;
  /** Hidden: connected to the canvas, laid out, not painted. */
  place: "detached" | "hidden" | "mounted";
  /** Its size may differ from `height`; re-read at the next commit. */
  dirty: boolean;
  dead: boolean;
  /** An edge slot's host spec; rows of items have none. */
  spec?: EdgeSlot;
}

/** The desired state: what the next commit makes true. */
interface Pending<T> {
  index: KeyIndex;
  keys: readonly string[];
  /** New and replacing rows, rendered and measured, not yet committed. */
  staged: Map<string, Row<T>>;
  /** Declared rows re-rendered inside the commit that changes their height. */
  deferred: Map<string, T>;
  declared: DeclaredItems<T> | null;
  /** `declared` holds only updated keys, over the committed entries. */
  patch: boolean;
  positioned: PositionedGeometry | null;
  positionedMeta?: { ratio: number; origin: number; shift: number };
  positionedPatch?: { at: number; top: number; height: number };
  anchor: AnchorPolicy;
  target: ExplicitAnchor | null;
  pinKey?: string | null;
  pinOffset?: number;
}

interface CommitOptions {
  policy?: CapturePolicy;
  /** Internal reflow preserves reading position only within the natural range. */
  retainViewportReserve?: boolean;
  /** False: never write the scroll position (a mid-phase commit). */
  write?: boolean;
  /** Leave follow intent as found instead of deriving it. */
  keepFollow?: boolean;
  instant?: boolean;
}

/** Internal reflow: keep the reading position, leave follow intent as found. */
const reflow = (policy: CapturePolicy = "viewport"): CommitOptions => ({
  policy,
  keepFollow: true,
  instant: true,
  retainViewportReserve: false,
});

type Task = { run: () => void; discard?: () => void };

const EMPTY_STATE: VirtualListState = {
  count: 0,
  start: 0,
  end: 0,
  atStart: true,
  atEnd: true,
  following: false,
  followingEnd: false,
  totalSize: 0,
  held: false,
};

const disposedViewports = new WeakSet<HTMLElement>();

export function createVirtualList<T>(
  viewport: HTMLElement,
  { items: initialItems, ...options }: VirtualListOptions<T>,
): VirtualList<T> {
  const { key: keyOf, render, anchorable } = options;
  const heightOf = options.height;
  if (heightOf && options.followStart)
    throw new Error("followStart requires measured rows (omit height)");
  const declared = heightOf !== undefined;
  const place = options.position;
  if (place && !declared)
    throw new Error("positioned layouts require declared heights");
  const pinning = options.pinning !== false;
  const pinPolicy =
    typeof options.pinning === "object" ? options.pinning : null;
  const smoothFollow = options.followBehavior === "smooth";
  const requestedOverscan = options.overscanPx;
  const overscanPx =
    requestedOverscan !== undefined &&
    Number.isFinite(requestedOverscan) &&
    requestedOverscan >= 0
      ? requestedOverscan
      : Math.max(MIN_OVERSCAN_PX, viewport.clientHeight);

  let passRatio = 0;
  let scope: Task[] | null = null;
  const currentRatio = (): number => {
    if (passRatio !== 0) return passRatio;
    const ratio = pixelRatio();
    if (scope !== null) passRatio = ratio;
    return ratio;
  };

  /** I0: whole CSS pixels at integral ratios, the device grid otherwise. */
  function quantize(height: number, ratio = currentRatio()): number {
    if (!place && Number.isInteger(ratio))
      return Math.max(1, Math.ceil(height - HEIGHT_NOISE));
    return Math.max(
      1 / ratio,
      Math.ceil(height * ratio - HEIGHT_NOISE) / ratio,
    );
  }

  function declaredHeight(item: T): number {
    const height = heightOf?.(item);
    if (height === undefined || !Number.isFinite(height) || height <= 0)
      throw new RangeError(`item height must be finite and > 0, got ${height}`);
    return quantize(height);
  }

  // --- Committed state ------------------------------------------------------
  const geometry = new Geometry(1);
  const rows = new Map<string, Row<T>>();
  let declaredItems = new DeclaredItems<T>();
  geometry.setAnchorExclusion((key) => {
    if (isSlotKey(key)) return true;
    if (anchorable === undefined) return false;
    const entry = declaredItems.get(key) ?? rows.get(key);
    return entry !== undefined && !anchorable(entry.item);
  }, anchorable === undefined);
  const mountedRows = new Set<Row<T>>();
  const hiddenRows = new Set<Row<T>>();
  const dirtyRows = new Set<Row<T>>();
  const brokenRows = new Set<Row<T>>();
  /** Detached at a width change: their heights are of the old width. */
  const staleRows = new Set<Row<T>>();
  let staleTimer = 0;
  let staleFrame = 0;
  /** A stale row joined the window: the next reconciliation commits it. */
  let staleMounted = false;
  let committedKeys = geometry.keyIndex.keys;
  let committedPinOffset = 0;
  let positionedNow = false;
  let committedPositioned: PositionedGeometry | null = null;
  let positionedRatio = 0;
  let positionedOriginPx = 0;
  let positionedShift = 0;
  /** Advances on every commit; reconciliation and publication key on it. */
  let epoch = 0;
  /** Advances when committed keys or staged row instances change. */
  let structureEpoch = 0;
  /** One committed offscreen row kept laid out between its updates. */
  let resident: Row<T> | null = null;

  // --- Desired state --------------------------------------------------------
  let pending: Pending<T> | null = null;
  /** The pending state mid-commit: dispose must reach its rows too. */
  let committing: Pending<T> | null = null;
  // Initial source ownership ends with this copy. Callbacks retain options,
  // so keeping its input array would pin the first snapshot after replacement.
  let lastItems: T[] = initialItems.slice();
  let lastItemsShared = false;
  let desiredIndex = geometry.keyIndex;
  let desiredLeading = 0;
  let revision = 0;
  /** Advances when the host's key order changes; window jobs stage against it. */
  let structure = 0;
  const edgeSlots: Record<Edge, EdgeSlot | null> = {
    start: ownSlot(options.edgeSlots?.start),
    end: ownSlot(options.edgeSlots?.end),
  };

  // --- Surface --------------------------------------------------------------
  // F5: where the engine anchors natively, rows sit in normal flow between
  // two spacers, and the engine keeps the reading position still when
  // content above it changes. Positioned layouts, engines without CSS
  // scroll anchoring, and scrollers the host turned it off for use the
  // runtime instead; only an explicit "native" overrides the host.
  const requested = options.anchoring ?? "auto";
  const native =
    !place &&
    requested !== "runtime" &&
    (requested === "native" ||
      (globalThis.CSS?.supports?.("overflow-anchor", "auto") === true &&
        getComputedStyle(viewport).overflowAnchor !== "none"));
  let viewportAnchor: string | null = null;
  if (requested === "native" && native) {
    viewportAnchor = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "auto";
  }
  const webkitCompositing =
    globalThis.CSS?.supports?.("-webkit-nbsp-mode", "space") === true;
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  if (!native) {
    canvas.style.overflowAnchor = "none";
    if (!webkitCompositing) canvas.style.contain = "layout style";
  }
  canvas.dataset.anchoring = native ? "native" : "runtime";
  // One stable compositing surface while rows enter and leave (Safari).
  canvas.style.transform = "translateZ(0)";
  if (webkitCompositing) canvas.style.transformStyle = "preserve-3d";
  const spacer = (): HTMLElement => {
    const element = document.createElement("div");
    element.style.cssText = "overflow-anchor:none;height:0px";
    canvas.appendChild(element);
    return element;
  };
  /** Native flow: the unmounted rows above and below the window. */
  const topSpacer = native ? spacer() : null;
  const bottomSpacer = native ? spacer() : null;
  let lastTopSpacerPx = 0;
  let lastBottomSpacerPx = 0;
  viewport.appendChild(canvas);
  // `overflow: clip` where supported: a clip that is no scroll container.
  const clipProbe = document.createElement("div").style;
  clipProbe.overflow = "clip";
  const clip = clipProbe.overflow === "clip" ? "clip" : "hidden";
  let viewportWidth = viewport.clientWidth;
  let viewportHeight = viewport.clientHeight;
  /** Where the viewport stood before a resize the engine may have clamped. */
  let lastObservedTop = viewport.scrollTop;
  /** Native commits defer ancestor sizing until the gesture has settled. */
  let canvasFloorPending = false;
  let lastCanvasHeightPx = Number.NaN;
  let lastCanvasMinHeight = "";
  /** A resize during a phase commits at the settle with this stance (I5). */
  let resizeHeld: "pin" | "viewport" | null = null;

  /** The exact height memo for the open pass. */
  let heightMemo: number | null = null;
  let cachedRoundedHeight = -1;
  let cachedExactHeight = 0;
  /**
   * The viewport's exact inner height. `clientHeight` rounds, and a rounded-up
   * height puts the computed end short of the engine's fractional maximum:
   * landing there leaves the content a device pixel off the bottom. The rect
   * is exact; it matches the inner height within rounding only without
   * borders, a scrollbar, or a scaling transform, so otherwise keep rounding.
   *
   * One transaction (I4) sees one viewport height: re-reading it after the
   * commit's DOM writes would force a synchronous layout per read. Outside a
   * pass — and at the next pass, which a scroll event can start before the
   * resize delivery — the height is always read fresh.
   */
  function clientHeight(): number {
    if (heightMemo !== null && scope !== null) return heightMemo;
    const rounded = viewport.clientHeight;
    let height: number;
    if (rounded === cachedRoundedHeight) {
      height = cachedExactHeight;
    } else {
      const exact = viewport.getBoundingClientRect().height;
      height = Math.abs(exact - rounded) < 1 ? exact : rounded;
      cachedRoundedHeight = rounded;
      cachedExactHeight = height;
    }
    if (scope !== null) heightMemo = height;
    return height;
  }

  function viewportState(): GeometryViewport {
    return { scrollTop: viewport.scrollTop, height: clientHeight() };
  }

  /**
   * `floor`: also refresh the pin's viewport-relative floor. A native commit
   * mid-gesture must not: any size change on an ancestor of the engine's
   * anchor node suppresses anchoring for that layout.
   */
  function syncCanvasHeight(totalSize: number, floor: boolean): void {
    // A native canvas takes its height from its flow, for the same reason.
    if (!native && lastCanvasHeightPx !== totalSize) {
      lastCanvasHeightPx = totalSize;
      canvas.style.height = `${totalSize}px`;
    }
    // The pin's shortfall grows in the same layout as its viewport.
    const pinTop = geometry.pinTop;
    const minHeight =
      pinTop === null || pinTop === 0
        ? ""
        : `calc(100% + ${Math.ceil(pinTop)}px)`;
    canvasFloorPending = lastCanvasMinHeight !== minHeight;
    if (!floor) return;
    if (canvasFloorPending) {
      lastCanvasMinHeight = minHeight;
      canvas.style.minHeight = minHeight;
    }
    canvasFloorPending = false;
  }

  function recordScrollAdjustment(top: number): void {
    controller.recordProgrammaticScrollTop(top);
  }

  function writeScrollTop(top: number): void {
    recordScrollAdjustment(top);
    viewport.scrollTop = top;
  }

  // --- The pass (I4) --------------------------------------------------------
  let disposed = false;
  let booting = true;
  const openScopes: Task[][] = [];
  const scopePool: Task[][] = [];
  /** Host failures of committed work, surfaced by the outermost pass. */
  const failures: unknown[] = [];

  function discard(tasks: Task[]): void {
    for (const task of tasks.splice(0)) task.discard?.();
  }

  /**
   * Run `work` as one transaction. Nested calls join the open pass unless
   * `independent` (a window job keeps its own failure boundary). Work queued
   * by host callbacks drains after it, each entry its own pass.
   */
  function pass(work: () => void, independent = false): void {
    const outer = scope;
    if (outer !== null && !independent) {
      work();
      return;
    }
    const mark = outer === null ? 0 : failures.length;
    if (outer === null) {
      heightMemo = null;
      passRatio = 0;
    }
    const own = scopePool.pop() ?? [];
    scope = own;
    openScopes.push(own);
    try {
      try {
        work();
      } catch (error) {
        discard(own);
        if (failures.length === mark) throw error;
        const collected = failures.splice(mark);
        throw new AggregateError([error, ...collected], "update failed");
      }
      let collected = failures.length > mark ? failures.splice(mark) : null;
      // Nested, its queued work drains once the enclosing pass has finished.
      if (outer !== null) {
        if (own.length > 0) outer.push(...own);
      } else {
        scope = null;
        passRatio = 0;
        while (!disposed && own.length > 0) {
          const task = own.shift() as Task;
          try {
            task.run();
          } catch (error) {
            collected ??= [];
            collected.push(...flatten(error));
          }
        }
      }
      if (collected !== null) {
        throwAll(collected, "committed with failures in host callbacks");
      }
    } finally {
      openScopes.pop();
      own.length = 0;
      scopePool.push(own);
      scope = outer;
      if (outer === null) {
        heightMemo = null;
        passRatio = 0;
      }
    }
  }

  /** Queue an API call made from inside a pass; false outside one. */
  function defer(run: () => void, onDiscard?: () => void): boolean {
    if (scope === null) return false;
    scope.push({ run, discard: onDiscard });
    return true;
  }

  /** A host callback: its failure never interrupts the runtime's own work. */
  function host(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      failures.push(...flatten(error));
    }
  }

  // --- Rows -----------------------------------------------------------------
  const rowOf = new WeakMap<Element, Row<T>>();
  const slotPool: { slot: HTMLElement; height: number; anchor: boolean }[] = [];
  let mountBeforeHint: Node | null | undefined;
  let lanesScratch = new Float64Array(0);
  let topsScratch = new Float64Array(0);

  function committedIndexOf(row: Row<T>): number {
    if (row.committedEpoch === structureEpoch) return row.committedIndex;
    const index = geometry.indexOf(row.key);
    if (index >= 0 && rows.get(row.key) === row) {
      row.committedIndex = index;
      row.committedEpoch = structureEpoch;
    }
    return index;
  }

  function createRow(
    key: string,
    item: T,
    element: HTMLElement,
    height: number,
    spec?: EdgeSlot,
    preQuantized = false,
  ): Row<T> {
    const style = element.style;
    let slot = element;
    let slotStyled: "none" | "hidden" | "mounted" = "none";
    let slotHeight = -1;
    let slotAnchor = false;
    if (place) {
      // Positioned cards are their own slot; the host owns width and left.
      style.position = "absolute";
      style.top = "0";
      if (spec) {
        style.left = "0";
        style.right = "0";
      } else if (!style.contain) {
        style.contain = "layout style";
      }
      const rawHint = style.willChange;
      if (!rawHint) {
        style.willChange = "transform";
      } else if (rawHint !== "transform") {
        const hint = rawHint.trim();
        if (!hint.split(",").some((value) => value.trim() === "transform")) {
          const automatic =
            !hint ||
            /^(auto|initial|inherit|unset|revert(-layer)?)$/.test(hint);
          style.setProperty(
            "will-change",
            automatic ? "transform" : `${hint}, transform`,
            style.getPropertyPriority("will-change"),
          );
        }
      }
    } else {
      style.position = "absolute";
      style.transform = "none";
      style.top = "0";
      style.left = "0";
      style.right = "0";
      // Native anchoring picks the slot, never a node inside the row: a
      // re-render replaces those, and the engine would lose its anchor.
      if (native) style.overflowAnchor = "none";
      const pooled = !spec ? slotPool.pop() : undefined;
      if (pooled) {
        slot = pooled.slot;
        slotStyled = "mounted";
        slotHeight = pooled.height;
        slotAnchor = pooled.anchor;
      } else {
        slot = document.createElement("div");
      }
      slot.appendChild(element);
    }
    const qHeight = preQuantized ? height : quantize(height);
    const row: Row<T> = {
      key,
      item,
      shown: item,
      broken: false,
      element,
      slot,
      slotStyled,
      slotHeight,
      slotAnchor,
      committedIndex: -1,
      committedEpoch: -1,
      height: qHeight,
      followStart: 0,
      offset: Number.NaN,
      place: "detached",
      dirty: false,
      dead: false,
      spec,
    };
    if (slot === element) style.height = `${qHeight}px`;
    if (!declared && !spec) rowOf.set(element, row);
    return row;
  }

  /**
   * Where the slot at `index` joins the canvas so DOM order stays list order
   * (the reading and Tab order): after its connected predecessor, else
   * before the nearest connected successor, else at the end.
   */
  function insertionPoint(
    order: readonly string[],
    index: number,
    staged?: ReadonlyMap<string, Row<T>>,
  ): Node | null {
    if (mountedRows.size === 0 && hiddenRows.size === 0) return bottomSpacer;
    const previous = rowIn(order, index - 1, staged);
    if (previous && connected(previous)) return previous.slot.nextSibling;
    return successor(order, index, connected, staged)?.slot ?? bottomSpacer;
  }

  /** The row of `order[at]`: a staged one first, else the committed one. */
  function rowIn(
    order: readonly string[],
    at: number,
    staged?: ReadonlyMap<string, Row<T>>,
  ): Row<T> | undefined {
    const key = order[at];
    return key === undefined ? undefined : (staged?.get(key) ?? rows.get(key));
  }

  /** The nearest row after `index` that `joined` accepts, within the scan. */
  function successor(
    order: readonly string[],
    index: number,
    joined: (row: Row<T>) => boolean,
    staged?: ReadonlyMap<string, Row<T>>,
  ): Row<T> | undefined {
    if (
      mountedRows.size === 0 &&
      (joined === mounted || hiddenRows.size === 0)
    ) {
      return undefined;
    }
    const limit = Math.min(order.length, index + 1 + INSERTION_SCAN);
    for (let at = index + 1; at < limit; at++) {
      const row = rowIn(order, at, staged);
      if (row && joined(row)) return row;
    }
    return undefined;
  }

  const connected = (row: Row<T>): boolean => row.place !== "detached";
  const mounted = (row: Row<T>): boolean => row.place === "mounted";
  const committedPoint = (
    key: string,
    index = geometry.indexOf(key),
  ): Node | null => insertionPoint(committedKeys, index);

  /**
   * Connect a measured row to the canvas: laid out, never painted, hit,
   * focused, found, or announced (descendants can override visibility).
   */
  function hideRow(row: Row<T>, before = committedPoint(row.key)): void {
    if (row.place !== "detached" || row.slot === row.element) return;
    // Parked far above the scroll origin: unreachable, outside the scroll
    // range, and never intersecting the viewport for a host's rect query.
    // Native flow keeps the slot in flow at zero height and parks the row:
    // revealing it must not change `position`, which suppresses anchoring.
    if (native) {
      if (row.slotStyled === "mounted") {
        const s = row.slot.style;
        if (row.slotHeight !== 0) s.height = "0px";
        s.visibility = "hidden";
        if (row.slotAnchor) s.overflowAnchor = "none";
      } else {
        row.slot.style.cssText = `position:relative;overflow:${clip};height:0px;visibility:hidden;overflow-anchor:none`;
      }
      row.element.style.translate = PARKED_TRANSLATE;
    } else
      row.slot.style.cssText = `${SLOT_BASE}overflow:${clip};contain:layout style;max-height:0;visibility:hidden;top:${PARKED_TOP};overflow-anchor:none`;
    row.slotStyled = "hidden";
    row.slotHeight = 0;
    row.slotAnchor = false;
    row.slot.inert = true;
    row.slot.setAttribute("aria-hidden", "true");
    row.offset = Number.NaN;
    canvas.insertBefore(row.slot, before);
    row.place = "hidden";
    hiddenRows.add(row);
  }

  /** Leave the hidden state: interactive again, the row unparked. */
  function unhide(row: Row<T>): void {
    row.slot.inert = false;
    row.slot.removeAttribute("aria-hidden");
    if (native) row.element.style.translate = "";
    hiddenRows.delete(row);
    if (resident === row) resident = null;
  }

  function detachRow(row: Row<T>): void {
    if (row.place !== "hidden") return;
    row.slot.remove();
    unhide(row);
    row.place = "detached";
  }

  /** Move a slot to its committed offset (a no-op when unchanged). */
  function placeRow(row: Row<T>, index?: number): void {
    if (native) return; // The flow places it.
    const idx = index === undefined ? committedIndexOf(row) : index;
    const offset = idx < 0 ? -1 : geometry.offsetAt(idx);
    if (offset < 0 || row.offset === offset) return;
    row.offset = offset;
    if (row.slot === row.element) row.slot.style.translate = `0 ${offset}px`;
    else row.slot.style.transform = `translateY(${offset}px)`;
  }

  function mountRow(row: Row<T>): void {
    const hidden = row.place === "hidden";
    const beforeHint = mountBeforeHint;
    mountBeforeHint = undefined;
    if (row.slot !== row.element) {
      const shouldAnchor = native && anchors(row);
      if (row.slotStyled === "mounted") {
        if (row.slotHeight !== row.height) {
          row.slot.style.height = `${row.height}px`;
          row.slotHeight = row.height;
        }
        if (native && row.slotAnchor !== shouldAnchor) {
          row.slot.style.overflowAnchor = shouldAnchor ? "" : "none";
          row.slotAnchor = shouldAnchor;
        }
      } else if (native && row.slotStyled === "hidden") {
        const s = row.slot.style;
        s.visibility = "";
        if (row.slotHeight !== row.height) s.height = `${row.height}px`;
        if (shouldAnchor) s.overflowAnchor = "";
        row.slotStyled = "mounted";
        row.slotHeight = row.height;
        row.slotAnchor = shouldAnchor;
        row.offset = Number.NaN;
      } else {
        row.slot.style.cssText = native
          ? `position:relative;overflow:${clip};height:${row.height}px${shouldAnchor ? "" : ";overflow-anchor:none"}`
          : `${SLOT_BASE}overflow:${clip};contain:strict;will-change:transform;height:${row.height}px`;
        row.slotStyled = "mounted";
        row.slotHeight = row.height;
        row.slotAnchor = shouldAnchor;
        row.offset = Number.NaN;
      }
    }
    if (hidden) unhide(row);
    const index = committedIndexOf(row);
    // Placed before it connects: a mount hook never sees a provisional zero.
    placeRow(row, index);
    if (native) flowInsert(row, index, beforeHint);
    else if (!hidden) {
      canvas.insertBefore(
        row.slot,
        beforeHint !== undefined ? beforeHint : committedPoint(row.key, index),
      );
    }
    row.place = "mounted";
    mountedRows.add(row);
    // The viewport never keeps a height of the old width.
    if (!declared && staleRows.size > 0 && staleRows.delete(row)) {
      markDirty(row);
      staleMounted = true;
    }
    if (!declared && !row.spec) observeRow(row);
    if (!row.spec) invokeRowHook(options.onMount, row.element, row.item);
  }

  /** Whether the engine may anchor on this row (never loaders or separators). */
  function anchors(row: Row<T>): boolean {
    return !row.spec && (anchorable === undefined || anchorable(row.item));
  }

  /**
   * In native flow, DOM order is layout order: a mounting slot must sit
   * after its mounted predecessor and before its mounted successor. A slot
   * staged elsewhere moves (a relayout) only when it is out of place.
   */
  function flowInsert(
    row: Row<T>,
    index = committedIndexOf(row),
    hintBefore?: Node | null,
  ): void {
    const previous = rowIn(committedKeys, index - 1);
    if (previous && mounted(previous)) {
      const next = previous.slot.nextSibling;
      if (next === row.slot) return;
      if (!row.slot.isConnected) {
        canvas.insertBefore(row.slot, next);
        return;
      }
    }
    if (!row.slot.isConnected && hintBefore !== undefined) {
      canvas.insertBefore(row.slot, hintBefore);
      return;
    }
    const after =
      previous && mounted(previous) ? previous.slot : (topSpacer as Node);
    const before =
      hintBefore !== undefined
        ? (hintBefore ?? (bottomSpacer as Node))
        : (successor(committedKeys, index, mounted)?.slot ??
          (bottomSpacer as Node));
    const placed =
      row.slot.isConnected &&
      after.compareDocumentPosition(row.slot) &
        Node.DOCUMENT_POSITION_FOLLOWING &&
      row.slot.compareDocumentPosition(before) &
        Node.DOCUMENT_POSITION_FOLLOWING;
    if (!placed) canvas.insertBefore(row.slot, before);
  }

  /**
   * Native flow: size the spacers around the mounted window from committed
   * geometry, so every row's flow position equals its committed offset.
   */
  function layoutFlow(): void {
    if (!topSpacer || !bottomSpacer) return;
    const [first, last] = mountedSpan();
    let top = 0;
    let bottom = geometry.totalSize;
    if (last >= 0) {
      top = geometry.offsetAt(first);
      bottom =
        geometry.totalSize - geometry.offsetAt(last) - geometry.heightAt(last);
    }
    const clampedBottom = Math.max(0, bottom);
    if (lastTopSpacerPx !== top) {
      lastTopSpacerPx = top;
      topSpacer.style.height = `${top}px`;
    }
    if (lastBottomSpacerPx !== clampedBottom) {
      lastBottomSpacerPx = clampedBottom;
      bottomSpacer.style.height = `${clampedBottom}px`;
    }
  }

  /** The first and last list index of the mounted rows (last -1: none). */
  function mountedSpan(): [number, number] {
    if (mountedRows.size === 0) return [Number.POSITIVE_INFINITY, -1];
    if (
      !heldRetirements &&
      lastReconcile.structure === structureEpoch &&
      !lastRange.indices
    ) {
      return lastRange.end > lastRange.start
        ? [lastRange.start, lastRange.end - 1]
        : [Number.POSITIVE_INFINITY, -1];
    }
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    for (const row of mountedRows) {
      const index = committedIndexOf(row);
      if (index < 0) continue;
      if (index < first) first = index;
      if (index > last) last = index;
    }
    return [first, last];
  }

  /**
   * Host hooks raised while the native flow is being rebuilt wait until it
   * is consistent again, so a hook reading layout never sees a half-moved
   * window (and the engine never anchors on one).
   */
  let hookQueue: (() => void)[] | null = null;
  function invokeRowHook(
    cb: ((element: HTMLElement, item: T) => void) | undefined,
    element: HTMLElement,
    item: T,
  ): void {
    if (!cb) return;
    if (hookQueue !== null) {
      hookQueue.push(() => cb(element, item));
      return;
    }
    try {
      cb(element, item);
    } catch (error) {
      failures.push(...flatten(error));
    }
  }
  function holdHooks<R>(work: () => R): R {
    if (!native || hookQueue !== null) return work();
    const queued: (() => void)[] = [];
    hookQueue = queued;
    try {
      return work();
    } finally {
      hookQueue = null;
      for (const callback of queued) host(callback);
    }
  }

  function unmountRow(row: Row<T>): void {
    row.place = "detached";
    mountedRows.delete(row);
    if (!row.spec && !declared) rowObserver.unobserve(row.element);
    if (!row.spec) invokeRowHook(options.onUnmount, row.element, row.item);
    row.slot.remove();
    row.offset = Number.NaN;
  }

  /** Exactly once, from any path. */
  function destroyRow(row: Row<T>): void {
    if (row.dead) return;
    row.dead = true;
    // Retained host elements must not keep retired row data through this index.
    if (!declared && !row.spec && rowOf.get(row.element) === row)
      rowOf.delete(row.element);
    if (row.place === "mounted") unmountRow(row);
    else if (row.place === "hidden") detachRow(row);
    if (dirtyRows.size > 0) dirtyRows.delete(row);
    if (brokenRows.size > 0) brokenRows.delete(row);
    if (staleRows.size > 0) staleRows.delete(row);
    if (row.slot !== row.element) {
      row.element.remove();
      if (
        !disposed &&
        !row.spec &&
        row.slotStyled === "mounted" &&
        slotPool.length < MAX_POOLED_SLOTS
      ) {
        slotPool.push({
          slot: row.slot,
          height: row.slotHeight,
          anchor: row.slotAnchor,
        });
      }
    }
    if (!row.spec) invokeRowHook(options.onDestroy, row.element, row.item);
  }

  function markDirty(row: Row<T>): void {
    if (row.spec) return;
    row.dirty = true;
    if (rows.get(row.key) === row) dirtyRows.add(row);
  }

  /** The next commit reads the rows a width change left detached. */
  function flushStale(): void {
    cancelAnimationFrame(staleFrame);
    staleFrame = 0;
    for (const row of staleRows) markDirty(row);
    staleRows.clear();
  }

  /**
   * Read the stale rows in one pass. They are out of the window, so the
   * viewport's anchor keeps everything on screen where it is.
   */
  function drainStale(): void {
    clearTimeout(staleTimer);
    staleTimer = 0;
    flushStale();
    if (dirtyRows.size > 0 && idle()) commit(null, reflow());
  }

  /** Drain once the width has been quiet; a newer change restarts the wait. */
  function awaitQuietWidth(): void {
    clearTimeout(staleTimer);
    cancelAnimationFrame(staleFrame);
    staleFrame = 0;
    staleTimer = window.setTimeout(() => {
      staleTimer = 0;
      drainStaleBatch();
    }, WIDTH_QUIET_MS);
  }

  /** Each background commit preserves the anchor before yielding to input. */
  function drainStaleBatch(): void {
    staleFrame = 0;
    if (disposed || staleRows.size === 0) return;
    // A phase or a remeasure owns the next commit: look again after it.
    if (!idle() || remeasurePolicy !== undefined) {
      awaitQuietWidth();
      return;
    }
    // Animation frames can stop in a hidden document. Finish from the timer
    // there; no visible frame needs the work spread across paint opportunities.
    if (document.visibilityState === "hidden") {
      pass(drainStale);
      return;
    }
    try {
      pass(() => {
        let count = 0;
        for (const row of staleRows) {
          staleRows.delete(row);
          markDirty(row);
          if (++count === WIDTH_DRAIN_ROWS) break;
        }
        commit(null, reflow());
      });
    } finally {
      // A host callback can dispose, drain, or start a newer width's wait.
      if (!disposed && staleRows.size > 0 && staleTimer === 0)
        staleFrame = requestAnimationFrame(drainStaleBatch);
    }
  }

  /** A row the window took in stale commits under the one commit rule. */
  function commitMounted(): boolean {
    if (!staleMounted || remeasurePolicy !== undefined) return false;
    staleMounted = false;
    if (dirtyRows.size === 0) return false;
    if (!idle()) return liveCommit();
    commit(null, reflow());
    return true;
  }

  /** Render into the row; a replacement element leaves `shown` as it was. */
  function renderInto(row: Row<T>, item: T): HTMLElement {
    const shown = row.shown;
    row.shown = item;
    try {
      const element = render(item, row.element);
      if (row.broken) {
        row.broken = false;
        brokenRows.delete(row);
      }
      if (element !== row.element) row.shown = shown;
      return element;
    } catch (error) {
      row.broken = true;
      brokenRows.add(row);
      throw error;
    }
  }

  function commitHeight(row: Row<T>, measured: number): void {
    const height = quantize(measured);
    row.dirty = false;
    dirtyRows.delete(row);
    staleRows.delete(row);
    // A shown slot always carries `row.height`: an unchanged height writes nothing.
    if (
      height !== row.height &&
      (row.place === "mounted" || row.slot === row.element)
    ) {
      row.slot.style.height = `${height}px`;
      row.slotHeight = height;
    }
    row.height = height;
    geometry.measure(row.key, height);
  }

  /**
   * Read the heights of these rows in one layout, before any write. Detached
   * rows are hidden in the canvas first, so they lay out with real styles.
   */
  function readHeights(list: readonly Row<T>[]): number[] {
    if (list.length === 0) return [];
    let connected: Row<T> | null = null;
    let connections = 0;
    if (!declared) {
      for (const row of list) {
        if (row.place !== "detached") continue;
        hideRow(row);
        connected = row;
        connections += 1;
      }
      if (connections > 0) sweep = true;
    }
    let heights: number[];
    try {
      heights = list.map((row) => {
        if (declared) return declaredHeight(row.item);
        const rect = row.element.getBoundingClientRect();
        const height = rect.height;
        if (!row.spec && options.followStart) {
          const start = options.followStart(row.item, row.element);
          row.followStart =
            start === null
              ? null
              : start !== row.element && row.element.contains(start)
                ? Math.max(0, start.getBoundingClientRect().top - rect.top)
                : 0;
        }
        // A mounted row reading 0 is hidden (display: none), not resized.
        if (row.place === "mounted")
          return Number.isFinite(height) && height > 0 ? height : row.height;
        return positive(height);
      });
    } catch (error) {
      // Leave no committed row connected by a read that failed.
      for (const row of list) if (rows.get(row.key) === row) detachRow(row);
      throw error;
    }
    // A lone offscreen update (a streaming row out of view) stays laid out.
    if (connections === 1 && connected !== null) resident = connected;
    return heights;
  }

  function measureRows(list: readonly Row<T>[]): void {
    const heights = readHeights(list);
    for (let index = 0; index < list.length; index++) {
      commitHeight(list[index] as Row<T>, heights[index] as number);
    }
  }

  /** Detach hidden committed rows the window did not reveal. */
  let sweep = false;
  function sweepHidden(): void {
    sweep = false;
    for (const row of hiddenRows) {
      if (row !== resident && rows.get(row.key) === row) detachRow(row);
    }
  }

  // --- Observers ------------------------------------------------------------
  // Registrations made inside a delivery wait a frame (undeliverable loop).
  let inDelivery = false;
  const pendingObserves: Row<T>[] = [];
  let observeFrame = 0;

  function observeRow(row: Row<T>): void {
    if (row.spec || declared) return;
    if (!inDelivery) {
      rowObserver.observe(row.element);
      return;
    }
    pendingObserves.push(row);
    if (observeFrame !== 0) return;
    observeFrame = requestAnimationFrame(() => {
      observeFrame = 0;
      for (const waiting of pendingObserves.splice(0)) {
        if (waiting.place === "mounted" && !waiting.dead)
          rowObserver.observe(waiting.element);
      }
    });
  }

  const rowObserver = new ResizeObserver((entries) => {
    if (disposed) return;
    let changed = false;
    for (const entry of entries) {
      const row = rowOf.get(entry.target);
      if (row?.place !== "mounted" || row.element !== entry.target) continue;
      const height =
        entry.borderBoxSize?.[0]?.blockSize ??
        entry.target.getBoundingClientRect().height;
      if (quantize(height) === row.height) continue;
      markDirty(row);
      changed = true;
    }
    if (!changed) return;
    // A width reflow belongs to the viewport observer's takeover.
    if (Math.abs(viewport.clientWidth - viewportWidth) > EPSILON_PX) return;
    inDelivery = true;
    try {
      pass(() => {
        // I6: idle commits in this delivery (after layout, before paint);
        // a phase commits what needs no scroll write.
        if (remeasurePolicy !== undefined) publish();
        else if (idle()) commit(null);
        else if (!liveCommit()) publish();
      });
    } finally {
      inDelivery = false;
    }
  });

  const viewportObserver = new ResizeObserver(() => {
    if (disposed) return;
    cachedRoundedHeight = -1;
    const width = viewport.clientWidth;
    const widthChanged = Math.abs(width - viewportWidth) > EPSILON_PX;
    viewportWidth = width;
    const height = viewport.clientHeight;
    const heightChanged = Math.abs(height - viewportHeight) > EPSILON_PX;
    if (!widthChanged && !heightChanged) return;
    pass(() => {
      // The layout a gesture was scrolling no longer exists: a width change
      // ends the phase, and held work commits at the new width. Idle, only
      // connected rows are read now: the engine has laid them out already.
      // Detached rows wait until the width is quiet, or until they mount.
      if (widthChanged) {
        if (!declared) invalidateHeights();
        settleParked(false);
        glide?.cancel();
        interruptNativeScroll("resize");
      }
      const pinTop = geometry.pinTop;
      const stoodOnPin =
        pinTop !== null &&
        (glide !== null
          ? glideToPin
          : Math.abs(lastObservedTop - pinTop) <= AT_EDGE_PX);
      if (idle()) {
        commit(null, reflow(stoodOnPin ? "pin" : "viewport"));
        if (!disposed) lastObservedTop = viewport.scrollTop;
      } else {
        if (resizeHeld !== "pin") resizeHeld = stoodOnPin ? "pin" : "viewport";
        publish();
      }
      viewportHeight = height;
      if (widthChanged && follow.armed && idle()) followIfBehindEnd();
    });
  });
  viewportObserver.observe(viewport);

  /** Connected rows are read by the next commit; detached rows wait until
   * the change is quiet, or until they mount. */
  function invalidateHeights(): void {
    for (const row of rows.values()) {
      if (row.place === "detached" && !row.spec) staleRows.add(row);
      else markDirty(row);
    }
    if (staleRows.size > 0) awaitQuietWidth();
  }

  // Heights sit on the device grid (I0). A pixel-ratio change (the window
  // moved to a display with another scale) keeps every layout size, so no
  // observer reports it, and the heights stay on the old grid.
  let ratioQuery: MediaQueryList | null = null;
  function watchPixelRatio(): void {
    ratioQuery?.removeEventListener("change", onPixelRatioChange);
    ratioQuery =
      typeof matchMedia === "function"
        ? matchMedia(`(resolution: ${pixelRatio()}dppx)`)
        : null;
    ratioQuery?.addEventListener("change", onPixelRatioChange);
  }
  function onPixelRatioChange(): void {
    watchPixelRatio();
    // A zoom also changes the width: the viewport observer re-reads then.
    if (
      disposed ||
      declared ||
      Math.abs(viewport.clientWidth - viewportWidth) > EPSILON_PX
    )
      return;
    pass(() => {
      invalidateHeights();
      if (idle()) commit(null, reflow());
      else if (!liveCommit()) publish();
    });
  }
  watchPixelRatio();

  // A hidden document follows by write; the return cancels a leftover glide.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      glide?.cancel();
      if (!disposed && staleFrame !== 0) awaitQuietWidth();
    }
    if (document.visibilityState !== "visible") return;
    follow.resume();
    glide?.cancel();
    if (follow.armed && !disposed) followIfBehindEnd();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // --- Staging: the desired state -------------------------------------------
  function indexItems(
    items: readonly T[],
    withHeights: boolean,
    startKey?: string,
    endKey?: string,
  ) {
    const leadingSlot = startKey !== undefined ? 1 : 0;
    const trailingSlot = endKey !== undefined ? 1 : 0;
    const totalLen = items.length + leadingSlot + trailingSlot;
    const heights =
      withHeights && declared ? new Float64Array(items.length) : null;
    const ratio = heights !== null ? currentRatio() : 1;
    const integralStack = !place && Number.isInteger(ratio);
    const invRatio = integralStack ? 1 : 1 / ratio;
    const prior = desiredIndex;
    const priorKeys = prior.keys;
    const priorLeading = desiredLeading;
    const priorTrailing =
      priorKeys.length > priorLeading &&
      isSlotKey(priorKeys[priorKeys.length - 1] as string)
        ? 1
        : 0;
    const priorContentLen = priorKeys.length - priorLeading - priorTrailing;
    const canMatchExact =
      items.length === priorContentLen &&
      leadingSlot === priorLeading &&
      trailingSlot === priorTrailing &&
      (!leadingSlot || startKey === priorKeys[0]) &&
      (!trailingSlot || endKey === priorKeys[priorKeys.length - 1]);
    const allocateKeys = (copyPrefix: number): string[] => {
      const next = new Array<string>(totalLen);
      if (startKey !== undefined) next[0] = startKey;
      if (endKey !== undefined) next[items.length + leadingSlot] = endKey;
      for (let k = 0; k < copyPrefix; k++) {
        next[k + leadingSlot] = priorKeys[k + leadingSlot] as string;
      }
      return next;
    };
    let keys: string[] | null = canMatchExact ? null : allocateKeys(0);
    const canExtendPrior =
      priorContentLen > 0 &&
      priorTrailing === 0 &&
      leadingSlot === priorLeading &&
      (!leadingSlot || startKey === priorKeys[0]);
    /** Appended tail validation when extending `prior` in place. */
    let seen: Set<string> | null = null;
    /** Full owned index table built directly on boot or non-append divergence. */
    let positions: KeyTable | null = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as T;
      const key = keyOf(item);
      // A matching prefix of the owned key order is already valid and unique.
      if (positions !== null) {
        if (isSlotKey(key))
          throw new Error(
            `item key "${key}" uses the reserved edge-slot prefix`,
          );
        const pos = i + leadingSlot;
        (keys as string[])[pos] = key;
        if (!positions.insertUnique(key, pos))
          throw new Error(`duplicate key "${key}"`);
      } else if (seen !== null) {
        if (isSlotKey(key))
          throw new Error(
            `item key "${key}" uses the reserved edge-slot prefix`,
          );
        const before = prior.get(key);
        const size = seen.size;
        if (
          (before !== undefined &&
            before >= priorLeading &&
            before < priorLeading + priorContentLen) ||
          seen.add(key).size === size
        )
          throw new Error(`duplicate key "${key}"`);
        (keys as string[])[i + leadingSlot] = key;
      } else if (i >= priorContentLen || priorKeys[i + priorLeading] !== key) {
        if (isSlotKey(key))
          throw new Error(
            `item key "${key}" uses the reserved edge-slot prefix`,
          );
        if (keys === null) keys = allocateKeys(i);
        const targetKeys = keys;
        const pos = i + leadingSlot;
        targetKeys[pos] = key;
        if (i >= priorContentLen && canExtendPrior) {
          seen = new Set();
          const before = prior.get(key);
          if (
            before !== undefined &&
            before >= priorLeading &&
            before < priorLeading + priorContentLen
          )
            throw new Error(`duplicate key "${key}"`);
          seen.add(key);
        } else {
          positions = new KeyTable(targetKeys, totalLen);
          if (startKey !== undefined) positions.insertUnique(startKey, 0);
          for (let k = 0; k < i; k++)
            positions.insertUnique(
              targetKeys[k + leadingSlot] as string,
              k + leadingSlot,
            );
          if (!positions.insertUnique(key, pos))
            throw new Error(`duplicate key "${key}"`);
        }
      } else if (keys !== null) {
        keys[i + leadingSlot] = key;
      }
      if (heights !== null) {
        const raw = heightOf?.(item);
        if (raw === undefined || !Number.isFinite(raw) || raw <= 0)
          throw new RangeError(
            `item height must be finite and > 0, got ${raw}`,
          );
        heights[i] = integralStack
          ? Math.max(1, Math.ceil(raw - HEIGHT_NOISE))
          : Math.max(
              invRatio,
              Math.ceil(raw * ratio - HEIGHT_NOISE) * invRatio,
            );
      }
    }
    if (positions !== null && endKey !== undefined) {
      positions.insertUnique(endKey, items.length + leadingSlot);
    }
    const exactPrior = keys === null;
    return {
      keys: exactPrior ? priorKeys : (keys as string[]),
      heights,
      positions,
      ownedKeys: !exactPrior,
      extendedPrior: seen !== null ? prior : null,
    };
  }

  /** Omitted anchors inherit the held intent; explicit ones replace it. */
  function newPending(
    keys: readonly string[],
    requested: AnchorRequest | undefined,
    previous: Pending<T> | null,
    positions: KeyTable | null = null,
    ownedKeys = false,
    extendedPrior: KeyIndex | null = null,
  ): Pending<T> {
    const named = typeof requested === "object" ? requested : null;
    let index: KeyIndex;
    if (keys === geometry.keyIndex.keys) {
      index = geometry.keyIndex;
    } else if (keys === desiredIndex.keys) {
      index = desiredIndex;
    } else if (extendedPrior !== null) {
      index = extendedPrior.extendTrusted(keys, ownedKeys);
    } else if (geometry.keyIndex.matches(keys)) {
      index = geometry.keyIndex;
    } else if (positions !== null) {
      index = KeyIndex.fromOwned(keys, positions);
    } else if (desiredIndex.matches(keys)) {
      index = desiredIndex;
    } else {
      index =
        desiredIndex.extend(keys, ownedKeys) ??
        geometry.keyIndex.extend(keys, ownedKeys) ??
        desiredIndex.truncate(keys, ownedKeys) ??
        geometry.keyIndex.truncate(keys, ownedKeys) ??
        new KeyIndex(keys, undefined, ownedKeys);
    }
    return {
      index,
      keys: index.keys,
      staged: new Map(),
      deferred: new Map(),
      declared: null,
      patch: false,
      positioned: null,
      anchor:
        typeof requested === "string"
          ? requested
          : named !== null
            ? "viewport"
            : (previous?.anchor ?? "auto"),
      target:
        named ?? (requested === undefined ? (previous?.target ?? null) : null),
    };
  }

  /** Declarative pinning: the last matching item, chosen while staging. */
  function selectPin(
    p: Pending<T>,
    items: readonly T[],
    replacement?: { index: number; item: T },
  ) {
    if (!pinPolicy) return;
    const offset = pinPolicy.offset ?? 0;
    p.pinOffset = Number.isFinite(offset) ? offset : 0;
    p.pinKey = null;
    const leading = isSlotKey(p.keys[0] ?? "") ? 1 : 0;
    for (let index = items.length - 1; index >= 0; index--) {
      const item =
        replacement?.index === index ? replacement.item : items[index];
      if (item !== undefined && pinPolicy.match(item)) {
        p.pinKey = p.keys[index + leading] as string;
        return;
      }
    }
  }

  function scratchLanes(totalCount: number): Float64Array {
    if (totalCount > 16_384) return new Float64Array(totalCount);
    if (lanesScratch.length < totalCount) {
      lanesScratch = new Float64Array(Math.max(totalCount, 256));
    }
    return lanesScratch.length === totalCount
      ? lanesScratch
      : lanesScratch.subarray(0, totalCount);
  }

  function finalizePositionedColumns(
    tops: Float64Array,
    heightsBuf: Float64Array,
    lanes: Float64Array,
    count: number,
    placedCount: number,
    rawOrigin: number,
    ratio: number,
    start: EdgeSlot | null,
    end: EdgeSlot | null,
    target?: Pending<T>,
  ): PositionedGeometry | null {
    if (placedCount === 0) return null;
    if (placedCount !== count)
      throw new Error("a positioned snapshot must place every item or none");
    const origin = positionedOrigin(rawOrigin, ratio);
    const leading = start ? quantize(start.height) : 0;
    const shift = leading - origin;
    let bottom = leading;
    const leadingSlot = start ? 1 : 0;
    const endPlaced = leadingSlot + placedCount;
    if (shift !== 0 || end) {
      for (let at = leadingSlot; at < endPlaced; at++) {
        const top = (tops[at] as number) + shift;
        tops[at] = top;
        const itemBottom = top + (heightsBuf[at] as number);
        if (itemBottom > bottom) bottom = itemBottom;
      }
    }
    if (start) {
      tops[0] = 0;
      heightsBuf[0] = leading;
      lanes[0] = 0;
    }
    if (end) {
      const last = tops.length - 1;
      tops[last] = bottom;
      heightsBuf[last] = quantize(end.height);
      lanes[last] = 0;
    }
    if (target) target.positionedMeta = { ratio, origin, shift };
    return PositionedGeometry.fromColumns(tops, heightsBuf, lanes);
  }

  function preparePositioned(
    entries: DeclaredItems<T> | null,
    target?: Pending<T>,
  ): PositionedGeometry | null {
    const count = entries?.size ?? 0;
    if (!place || count === 0 || !entries) return null;
    const ratio = currentRatio();
    const start = edgeSlots.start;
    const end = edgeSlots.end;
    const leadingSlot = start ? 1 : 0;
    const totalCount = count + leadingSlot + (end ? 1 : 0);
    const tops = new Float64Array(totalCount);
    const heightsBuf = new Float64Array(totalCount);
    const lanes = scratchLanes(totalCount);
    let placedCount = 0;
    let origin = Number.POSITIVE_INFINITY;
    const cols = entries.columns();
    if (cols) {
      const { items, heights } = cols;
      for (let i = 0; i < count; i++) {
        const position = place(items[i] as T);
        if (position === null) continue;
        if (!Number.isFinite(position.top))
          throw new RangeError("item top must be finite");
        // Snap in the shared coordinate system, before rebasing (I0).
        const top = toDevicePixel(position.top, ratio);
        if (top < origin) origin = top;
        const at = leadingSlot + placedCount;
        tops[at] = top;
        heightsBuf[at] = heights[i] as number;
        lanes[at] =
          typeof position.lane === "number" ? position.lane : Number.NaN;
        placedCount += 1;
      }
    } else {
      entries.forEach((item, height) => {
        const position = place(item);
        if (position === null) return;
        if (!Number.isFinite(position.top))
          throw new RangeError("item top must be finite");
        const top = toDevicePixel(position.top, ratio);
        if (top < origin) origin = top;
        const at = leadingSlot + placedCount;
        tops[at] = top;
        heightsBuf[at] = height;
        lanes[at] =
          typeof position.lane === "number" ? position.lane : Number.NaN;
        placedCount += 1;
      });
    }
    return finalizePositionedColumns(
      tops,
      heightsBuf,
      lanes,
      count,
      placedCount,
      origin,
      ratio,
      start,
      end,
      target,
    );
  }

  /**
   * Render and measure `stageKeys` into `p`. Committed rows are updated in
   * place when that is safe; new and replacing rows are staged hidden in the
   * canvas. On failure, fresh rows are destroyed and in-place renders are
   * restored (best effort). False: the host disposed the list meanwhile.
   */
  function prepare(
    p: Pending<T>,
    stageKeys: Iterable<string>,
    itemAt: (index: number) => T,
    previous: Pending<T> | null,
    full: boolean,
    jobRows?: Map<string, Row<T>>,
  ): boolean {
    const built: Row<T>[] = [];
    const fresh: Row<T>[] = [];
    const touched: Row<T>[] = [];
    const inPlace: Row<T>[] = [];
    const adopted =
      previous && previous.staged.size > 0 ? new Set<string>() : null;
    /** `nativeFree()`, read once: it reads layout, and renders write it. */
    let freeOnce: boolean | undefined;
    const free = (): boolean => {
      if (freeOnce === undefined) freeOnce = nativeFree();
      return freeOnce;
    };
    /** The staged key's index in the desired order. */
    let at = -1;
    const contiguous = stageKeys === p.keys;

    const create = (key: string, item: T, element: HTMLElement): Row<T> => {
      if (disposed) {
        host(() => options.onDestroy?.(element, item));
        throw new Abort();
      }
      const height = declared
        ? (p.declared?.heightOf(key) ?? declaredHeight(item))
        : 1;
      const row = createRow(key, item, element, height);
      built.push(row);
      if (!declared) {
        hideRow(row, insertionPoint(p.keys, at, p.staged));
        fresh.push(row);
      }
      return row;
    };
    /** Null: updated in place; otherwise its replacement. */
    const rerender = (row: Row<T>, item: T): Row<T> | null => {
      touched.push(row);
      const element = renderInto(row, item);
      if (element === row.element) {
        inPlace.push(row);
        return null;
      }
      return create(row.key, item, element);
    };
    const stageSlot = (key: string): void => {
      const edge: Edge =
        key === slotKey("start", edgeSlots.start?.key ?? "") ? "start" : "end";
      const spec = edgeSlots[edge];
      if (!spec) return;
      const before = previous?.staged.get(key);
      if (before?.spec === spec) {
        adopted?.add(key);
        p.staged.set(key, before);
        return;
      }
      if (!before && rows.get(key)?.spec === spec) return;
      const row = createRow(
        key,
        undefined as T,
        spec.render(),
        spec.height,
        spec,
      );
      built.push(row);
      p.staged.set(key, row);
    };

    try {
      for (const key of stageKeys) {
        at = contiguous ? at + 1 : (p.index.get(key) ?? -1);
        if (isSlotKey(key)) {
          stageSlot(key);
        } else {
          const item = itemAt(at);
          const before = previous?.staged.get(key);
          const committed = rows.get(key);
          if (before) {
            adopted?.add(key);
            if (before.shown === item && !before.broken) {
              p.staged.set(key, before);
            } else {
              const replacement = rerender(before, item);
              if (replacement) adopted?.delete(key);
              p.staged.set(key, replacement ?? before);
            }
          } else if (!committed) {
            if (!declared) {
              const job = jobRows?.get(key);
              if (job && job.item === item && !job.dead) {
                jobRows?.delete(key);
                built.push(job);
                fresh.push(job);
                p.staged.set(key, job);
              } else p.staged.set(key, create(key, item, render(item)));
            }
          } else if (committed.broken || committed.shown !== item) {
            // Mid-phase, a declared row whose box changes renders inside
            // the settle commit — a positioned card may move or resize.
            if (
              declared &&
              !idle() &&
              (place !== undefined ||
                (p.declared?.heightOf(key) !== committed.height && !free()))
            ) {
              p.deferred.set(key, item);
            } else {
              const replacement = rerender(committed, item);
              if (replacement) p.staged.set(key, replacement);
            }
          }
        }
        if (disposed) throw new Abort();
      }
      // Every render first, then one layout for every read.
      const heights = readHeights(fresh);
      for (let index = 0; index < fresh.length; index++) {
        (fresh[index] as Row<T>).height = quantize(heights[index] as number);
      }
      if (disposed) throw new Abort();
    } catch (error) {
      for (const row of built) destroyRow(row);
      for (const row of touched) {
        if (row.dead) continue;
        try {
          const restored = render(row.item, row.element);
          if (restored === row.element) {
            row.shown = row.item;
            row.broken = false;
            brokenRows.delete(row);
          } else {
            row.broken = true;
            brokenRows.add(row);
            host(() => options.onDestroy?.(restored, row.item));
          }
        } catch {
          row.broken = true;
          brokenRows.add(row);
        }
        markDirty(row);
      }
      if (error instanceof Abort) return false;
      throw error;
    }
    for (const row of inPlace) {
      row.item = row.shown;
      // A declared height lands with the snapshot; a measured one is re-read.
      if (!declared) markDirty(row);
    }
    if (previous && previous.staged.size > 0) {
      const keys = full ? [...previous.staged.keys()] : stageKeys;
      for (const key of keys) {
        const row = previous.staged.get(key);
        if (row && !adopted?.has(key)) destroyRow(row);
      }
    }
    return !disposed;
  }

  function stageSnapshot(
    items: readonly T[],
    requested: AnchorRequest | undefined,
    jobRows?: Map<string, Row<T>>,
    ownedItems = false,
  ): Pending<T> | null {
    const previous = pending;
    const start = edgeSlots.start;
    const end = edgeSlots.end;
    const leading = start ? 1 : 0;
    const startKey = start ? slotKey("start", start.key) : undefined;
    const endKey = end ? slotKey("end", end.key) : undefined;
    const { keys, heights, positions, ownedKeys, extendedPrior } = indexItems(
      items,
      true,
      startKey,
      endKey,
    );
    const p = newPending(
      keys,
      requested,
      previous,
      positions,
      ownedKeys,
      extendedPrior,
    );
    p.declared = heights
      ? new DeclaredItems(p.index, leading, items, heights, ownedItems)
      : null;
    p.positioned = preparePositioned(p.declared, p);
    selectPin(p, items);
    let stageKeys: readonly string[] = p.keys;
    if (declared) {
      // Unrendered declared items need geometry only. Prepare retained rows
      // and slots in source order so host render calls keep their ordering.
      const positions = p.index;
      const toStage: [number, string][] = [];
      for (const [key, row] of rows) {
        if (isSlotKey(key) || previous?.staged.has(key)) continue;
        const pos = positions.get(key);
        if (pos === undefined) continue;
        if (row.broken || row.shown !== items[pos - leading]) {
          toStage.push([pos, key]);
        }
      }
      if (previous && previous.staged.size > 0) {
        for (const key of previous.staged.keys()) {
          if (isSlotKey(key)) continue;
          const pos = positions.get(key);
          if (pos !== undefined) toStage.push([pos, key]);
        }
      }
      if (toStage.length > 1) toStage.sort((a, b) => a[0] - b[0]);
      const ordered: string[] = [];
      if (start) ordered.push(p.keys[0] as string);
      for (let i = 0; i < toStage.length; i++)
        ordered.push(toStage[i]?.[1] as string);
      if (end) ordered.push(p.keys[p.keys.length - 1] as string);
      stageKeys = ordered;
    } else if (
      previous === null &&
      !jobRows?.size &&
      brokenRows.size === 0 &&
      items !== lastItems &&
      p.keys === committedKeys &&
      desiredIndex === geometry.keyIndex &&
      items.length === lastItems.length &&
      rows.size === committedKeys.length
    ) {
      const ordered: string[] = [];
      if (start && rows.get(p.keys[0] as string)?.spec !== start) {
        ordered.push(p.keys[0] as string);
      }
      for (let i = 0; i < items.length; i++) {
        if (items[i] !== lastItems[i]) {
          ordered.push(p.keys[i + leading] as string);
        }
      }
      if (end && rows.get(p.keys[p.keys.length - 1] as string)?.spec !== end) {
        ordered.push(p.keys[p.keys.length - 1] as string);
      }
      stageKeys = ordered;
    }
    const ok = prepare(
      p,
      stageKeys,
      (index) => items[index - leading] as T,
      previous,
      true,
      jobRows,
    );
    return ok ? p : null;
  }

  /**
   * Whether landing `p` (with every dirty measurement) changes nothing above
   * the viewport's anchor row: then it needs no scroll write (I1 by
   * construction) and may land mid-phase.
   */
  function confined(p: Pending<T>): boolean {
    if (positionedNow || p.positioned) return false;
    const anchorIndex = geometry.anchorIndexAt(viewportState());
    if (anchorIndex < 0) return true;
    const anchorKey = geometry.keyAt(anchorIndex) as string;
    for (const row of dirtyRows) {
      if (committedIndexOf(row) < anchorIndex) return false;
    }
    if (p.keys === committedKeys) {
      for (const key of p.staged.keys()) {
        if (geometry.indexOf(key) < anchorIndex) return false;
      }
      return !(p.declared?.shiftsBefore(anchorIndex, geometry) ?? false);
    }
    for (let index = 0; index < anchorIndex; index++) {
      const key = geometry.keyAt(index);
      if (key === undefined || p.keys[index] !== key || p.staged.has(key))
        return false;
      if (p.declared?.heightOf(key) !== declaredItems.heightOf(key))
        return false;
    }
    // The anchor row may change in place, be replaced at its index, or be
    // removed — unless its surviving successor moves down (a prepend).
    if (p.keys[anchorIndex] !== anchorKey) {
      const nextIndex = p.index;
      if (nextIndex.has(anchorKey)) return false;
      for (let index = anchorIndex + 1; index < geometry.count; index++) {
        const moved = nextIndex.get(geometry.keyAt(index) as string);
        if (moved === undefined) continue;
        if (moved > index) return false;
        break;
      }
    }
    return true;
  }

  /** Land `p` now when legal; otherwise hold it for the settle. */
  function apply(p: Pending<T>, updatedKey?: string): void {
    if (disposed) return;
    if (idle()) {
      commit(p, { policy: remeasurePolicy });
      return;
    }
    const noop =
      p.target === null &&
      p.staged.size === 0 &&
      p.deferred.size === 0 &&
      p.declared === null &&
      (!pinPolicy ||
        (p.pinKey === geometry.pinned && p.pinOffset === committedPinOffset)) &&
      geometry.keyIndex.matches(p.keys);
    if (noop) {
      // In-place renders wait as dirty rows; nothing structural is held.
      pending = null;
    } else if (
      p.target === null &&
      p.anchor !== "end" &&
      (confined(p) || nativeFree())
    ) {
      // No scroll write: nothing above the anchor changes, or the engine
      // anchors natively (F5).
      commit(p, {
        policy: native ? "viewport" : "none",
        write: false,
        keepFollow: true,
      });
      return;
    } else {
      const waiting =
        updatedKey === undefined
          ? p.staged.values()
          : [p.staged.get(updatedKey)];
      for (const row of waiting) if (row && !row.spec) row.dirty = true;
      pending = p;
    }
    if (!liveCommit()) publish();
  }

  // --- The commit -----------------------------------------------------------
  function commit(p: Pending<T> | null, o: CommitOptions = {}): void {
    if (disposed) return;
    pass(() => {
      const applying = p ?? pending;
      pending = null;
      committing = applying;
      try {
        commitBody(applying, o);
      } finally {
        committing = null;
      }
    });
  }

  function renderDeferred(p: Pending<T>): void {
    for (const [key, item] of p.deferred) {
      const row = rows.get(key);
      if (!row || row.dead) continue;
      const height = p.declared?.heightOf(key) ?? declaredHeight(item);
      let element: HTMLElement;
      try {
        element = renderInto(row, item);
      } catch (error) {
        failures.push(error);
        // Geometry still commits; the row re-renders at its next update.
        if (p.positioned) row.item = item;
        else {
          const old = declaredItems.get(key);
          if (old) p.declared?.set(key, old);
        }
        continue;
      }
      if (disposed) {
        if (element !== row.element)
          host(() => options.onDestroy?.(element, item));
        return;
      }
      if (element === row.element) {
        row.item = item;
        commitHeight(row, height);
      } else p.staged.set(key, createRow(key, item, element, height));
    }
  }

  function commitBody(p: Pending<T> | null, o: CommitOptions): void {
    const policy = o.policy ?? p?.anchor ?? "auto";
    const before = viewportState();
    // Follow intent survives a pause at its limit. Leading content can move
    // that limit even while the viewport is short of the end; the updated
    // follow target below bounds the landing and never moves it backwards.
    const capture = geometry.capture(
      before,
      policy === "auto" && (followGlide || follow.followingContent)
        ? "end"
        : policy,
      policy === "viewport" ? (p?.target ?? null) : null,
      o.retainViewportReserve ?? true,
    );
    // Adopt the staged rows; a key removed or replaced dies after it left
    // the map, so a host disposing from onDestroy cannot destroy it twice.
    const keysChanged = p !== null && !geometry.keyIndex.matches(p.keys);
    const doomed: Row<T>[] = [];
    if (p) {
      if (p.deferred.size > 0) renderDeferred(p);
      // An append removes no row.
      if (keysChanged && !geometry.keyIndex.precedes(p.index)) {
        const next = p.index;
        for (const [key, row] of rows) {
          if (next.has(key)) continue;
          rows.delete(key);
          dirtyRows.delete(row);
          doomed.push(row);
        }
      }
      for (const [key, row] of p.staged) {
        const old = rows.get(key);
        rows.set(key, row);
        if (old && old !== row) {
          dirtyRows.delete(old);
          doomed.push(old);
        }
        if (row.dirty && !row.spec) dirtyRows.add(row);
      }
      if (p.staged.size > 0) sweep = true;
    }
    // Every height this commit lands is read before its first DOM write.
    // Rows that waited for a settle are read again (an image decoded).
    const measured = dirtyRows.size > 0 ? [...dirtyRows] : [];
    const heights = readHeights(measured);
    const structural = keysChanged || (p?.staged.size ?? 0) > 0;
    const hadDeferred = (p?.deferred.size ?? 0) > 0;
    let glideFollow = false;
    let steadyViewport = false;
    // Native flow: host hooks wait until the window is whole again (F5).
    holdHooks(() => {
      for (const row of doomed) destroyRow(row);
      if (disposed) return;
      if (p) {
        const snapshotColumns =
          keysChanged && p.declared && !p.patch ? p.declared.columns() : null;
        if (snapshotColumns && p.declared) {
          const shareHeights =
            snapshotColumns.leading === 0 &&
            snapshotColumns.heights.length === p.index.keys.length;
          if (shareHeights) p.declared.markHeightsShared();
          geometry.setKeysWithDeclared(
            p.index,
            snapshotColumns.heights,
            snapshotColumns.leading,
            p.target,
            Boolean(place && p.positioned !== null),
            shareHeights,
          );
          committedKeys = p.keys;
        } else if (keysChanged) {
          geometry.setKeys(p.index, p.target);
          committedKeys = p.keys;
        }
        if (pinPolicy) {
          committedPinOffset = p.pinOffset ?? 0;
          geometry.pin(p.pinKey ?? null, committedPinOffset);
        }
        if (p.declared && p.patch) {
          p.declared.forEach((item, height, key) => {
            const row = rows.get(key);
            if (row && row.item === item) commitHeight(row, height);
            else geometry.measure(key, height);
            declaredItems.set(key, { item, height });
          });
        } else if (p.declared) {
          // A snapshot lands its heights by position, in one pass, and
          // replaces its columns: removed keys drop out.
          declaredItems = p.declared;
          if (!snapshotColumns) declaredItems.land(geometry);
          const order = geometry.keyIndex;
          for (const row of rows.values()) {
            if (row.spec) continue;
            const idx = committedIndexOf(row);
            if (
              idx < 0 ||
              declaredItems.itemAtIndex(idx, order, row.key) !== row.item
            )
              continue;
            const height = declaredItems.heightAtIndex(
              idx,
              order,
              row.key,
            ) as number;
            if (height !== row.height) commitHeight(row, height);
          }
        }
        for (const row of p.staged.values()) {
          if (!row.dirty) commitHeight(row, row.height);
        }
        if (place) {
          if (p.positionedPatch && committedPositioned) {
            committedPositioned.applyUpdateInPlace(
              p.positionedPatch.at,
              p.positionedPatch.top,
              p.positionedPatch.height,
            );
          } else {
            geometry.setPositioned(p.positioned);
            positionedNow = p.positioned !== null;
            committedPositioned = p.positioned;
            if (p.positioned && p.positionedMeta) {
              positionedRatio = p.positionedMeta.ratio;
              positionedOriginPx = p.positionedMeta.origin;
              positionedShift = p.positionedMeta.shift;
            } else {
              positionedRatio = 0;
              positionedOriginPx = 0;
              positionedShift = 0;
            }
          }
        }
      }
      for (let i = 0; i < measured.length; i++) {
        commitHeight(measured[i] as Row<T>, heights[i] as number);
      }
      epoch += 1;
      if (structural) structureEpoch += 1;

      const result = geometry.resolve(capture);
      syncCanvasHeight(result.totalSize, !native || o.write !== false);
      // A derived end-follow goes only as far as the follow mode allows.
      const derivedFollow =
        !booting && result.mode === "end" && policy === "auto";
      const resolvedTop = derivedFollow
        ? follow.target(before.scrollTop, result.scrollTop)
        : result.scrollTop;
      const target =
        result.mode === "end"
          ? Math.ceil(resolvedTop)
          : toDevicePixel(resolvedTop, currentRatio());
      const moves = Math.abs(target - before.scrollTop) > EPSILON_PX;
      // Growth entirely above the reading position (a slot or row inserted
      // at the top) moves the end by exactly the anchor row's shift. Landing
      // there at once keeps the screen still; a glide would scroll visibly.
      const anchor = capture.anchor;
      glideFollow =
        !o.instant &&
        !booting &&
        !follow.catchingUp &&
        smoothFollow &&
        result.mode === "end" &&
        takingOver === null &&
        moves &&
        !(
          anchor !== null &&
          (() => {
            const anchorIndex = geometry.indexOf(anchor.key);
            return (
              anchorIndex >= 0 &&
              // The end target rounds up to a whole pixel; the engine clamps it.
              Math.abs(
                geometry.offsetAt(anchorIndex) + anchor.offset - target,
              ) < 1
            );
          })()
        );
      // Native flow: the rows on screen stay mounted in the new geometry, so
      // the engine can measure how far its anchor node moved and follow it.
      // Restore the flow before follow policy reads the viewport height: an
      // interim layout with the old tail removed can clamp the scroll offset
      // and its later scroll event would cancel follow as apparent input.
      if (native) holdWindow(structural);
      else repositionMounted();
      if (smoothFollow && !o.keepFollow && takingOver === null)
        follow.resolveCommit(policy, target);
      // Engine anchoring can move the viewport during the edit itself:
      // Chromium prefers a focused control as its anchor, and replacing that
      // control's row shifts the offset. The landing owns the position, so
      // a writable commit corrects it even when the target did not move.
      const engineMoved =
        !moves &&
        native &&
        o.write !== false &&
        !glideFollow &&
        Math.abs(viewport.scrollTop - target) > EPSILON_PX;
      let wroteScroll = false;
      if (!glideFollow && (moves || engineMoved)) {
        if (o.write !== false) {
          writeScrollTop(target);
          wroteScroll = true;
        }
        // Mid-phase, the engine moves the viewport: expect it, so the settle
        // sensor never reads the adjustment as user input.
        else if (native) recordScrollAdjustment(target);
      }
      steadyViewport =
        !native &&
        !wroteScroll &&
        !moves &&
        before.scrollTop >= 0 &&
        before.scrollTop <= geometry.maxScrollTop(before.height) &&
        doomed.length === 0 &&
        !hadDeferred &&
        (measured.length === 0 || !options.followStart);
    });
    if (disposed) return;
    reconcileAndPublish(steadyViewport ? before : undefined);
    if (disposed) return;
    if (glideFollow) startFollowGlide();
    else if (o.keepFollow && follow.armed)
      followIfBehindEnd(o.instant ? "instant" : "smooth");
  }

  /**
   * Mid-phase: commit the dirty heights at or below the anchor row. Nothing
   * above the anchor changes, so nothing on screen moves but those rows.
   * Under native anchoring, rows above it commit too, away from the edges:
   * the engine keeps the reading position still.
   */
  function liveCommit(): boolean {
    if (disposed || dirtyRows.size === 0 || remeasurePolicy !== undefined)
      return false;
    let published = false;
    pass(() => {
      let vp = viewportState();
      let committed = false;
      try {
        while (dirtyRows.size > 0) {
          const anchorIndex = Math.max(0, geometry.anchorIndexAt(vp));
          const everything = nativeFree();
          const ready: Row<T>[] = [];
          for (const row of dirtyRows) {
            if (everything || committedIndexOf(row) >= anchorIndex)
              ready.push(row);
          }
          if (ready.length === 0) break;
          const capture = geometry.capture(
            vp,
            native ? "viewport" : "none",
            null,
            false,
          );
          measureRows(ready);
          epoch += 1;
          const result = geometry.resolve(capture);
          syncCanvasHeight(result.totalSize, !native);
          repositionMounted();
          if (native) {
            const expected = toDevicePixel(result.scrollTop);
            if (Math.abs(expected - vp.scrollTop) > EPSILON_PX)
              recordScrollAdjustment(expected);
          }
          committed = true;
          // A shrink can clamp the engine upward onto another dirty row.
          const previousTop = vp.scrollTop;
          vp = viewportState();
          if (vp.scrollTop >= previousTop) break;
        }
      } catch (error) {
        if (!committed) throw error;
        failures.push(...flatten(error));
      }
      if (!committed) return;
      publish(vp, reconcileWindow(vp));
      if (follow.armed) followIfBehindEnd();
      published = true;
    });
    return published;
  }

  // --- The window -----------------------------------------------------------
  /** I6: every mounted slot moves before any layout-forcing access. */
  function repositionMounted(): void {
    if (native) layoutFlow();
    else for (const row of mountedRows) placeRow(row);
  }

  const lastReconcile = {
    top: Number.NaN,
    height: Number.NaN,
    epoch: -1,
    structure: -1,
  };
  let lastRange: GeometryWindow = { start: 0, end: 0 };
  /** Native commands keep departing rows until settle (Safari paint stability). */
  let holdLanding = false;
  let heldRetirements = false;

  function reconcileWindow(vp: GeometryViewport): GeometryWindow {
    if (glide !== null)
      holdLanding = !native && !declared && !followGlide && glide.active;
    if (
      !heldRetirements &&
      !sweep &&
      lastReconcile.top === vp.scrollTop &&
      lastReconcile.height === vp.height &&
      lastReconcile.epoch === epoch
    )
      return lastRange;
    const unchanged =
      !heldRetirements && lastReconcile.structure === structureEpoch;
    const range = geometry.window(vp, overscanPx);
    const previous = lastRange;
    const stacked = !range.indices && !previous.indices;
    if (
      unchanged &&
      !sweep &&
      (range === previous ||
        (stacked &&
          range.start === previous.start &&
          range.end === previous.end))
    ) {
      lastReconcile.top = vp.scrollTop;
      lastReconcile.height = vp.height;
      lastReconcile.epoch = epoch;
      return range;
    }
    const delta =
      unchanged && range.delta?.from === previous.indices
        ? range.delta
        : undefined;
    const kept = unchanged && stacked ? previous : undefined;
    lastRange = range;
    heldRetirements = false;
    lastReconcile.top = vp.scrollTop;
    lastReconcile.height = vp.height;
    lastReconcile.epoch = -1;
    lastReconcile.structure = -1;
    if (!native) return mountWindow(vp, range, delta, kept);
    // Native flow: rebuild the window and its spacers before any hook runs.
    return holdHooks(() => {
      try {
        return mountWindow(vp, range, delta, kept);
      } finally {
        layoutFlow();
      }
    });
  }

  /**
   * Native flow, inside a commit: keep the mounted rows mounted at their new
   * offsets, so the engine's anchor node survives the layout. `fill` mounts
   * the rows inserted or replaced between them (only a key change or a
   * staged row opens a gap), keeping the flow contiguous.
   */
  function holdWindow(fill: boolean): void {
    if (fill) {
      const [first, last] = mountedSpan();
      for (let index = first; index <= last; index++) {
        const row = materialize(index);
        if (row && row.place !== "mounted") mountRow(row);
        if (disposed) return;
      }
    }
    layoutFlow();
  }

  /** The row at `index`, rendering a declared one; null if it can't render. */
  function materialize(index: number): Row<T> | null {
    const key = committedKeys[index];
    if (key === undefined) return null;
    const existing = rows.get(key);
    if (existing) {
      existing.committedIndex = index;
      existing.committedEpoch = structureEpoch;
      return existing;
    }
    const order = geometry.keyIndex;
    const height = declaredItems.heightAtIndex(index, order, key);
    if (height === undefined) return null;
    const item = declaredItems.itemAtIndex(index, order, key) as T;
    let element: HTMLElement;
    try {
      element = render(item);
    } catch (error) {
      // Geometry stands; this row retries at the next reconciliation.
      failures.push(error);
      return null;
    }
    if (disposed) {
      if (options.onDestroy) {
        try {
          options.onDestroy(element, item);
        } catch (error) {
          failures.push(...flatten(error));
        }
      }
      return null;
    }
    const row = createRow(key, item, element, height, undefined, true);
    row.committedIndex = index;
    row.committedEpoch = structureEpoch;
    rows.set(key, row);
    return row;
  }

  function mountWindow(
    vp: GeometryViewport,
    range: GeometryWindow,
    delta: GeometryWindow["delta"],
    kept: GeometryWindow | undefined,
  ): GeometryWindow {
    const retire = (row: Row<T>): void => {
      if (holdLanding && committedIndexOf(row) >= 0) {
        heldRetirements = true;
        return;
      }
      if (declared && !row.spec) {
        rows.delete(row.key);
        destroyRow(row);
      } else unmountRow(row);
    };
    if (delta) {
      for (const index of delta.leaving) {
        const row = rows.get(geometry.keyAt(index) ?? "");
        if (row) retire(row);
      }
    } else if (kept) {
      const topEnd = Math.min(kept.end, range.start);
      for (let index = kept.start; index < topEnd; index++) {
        const row = rows.get(geometry.keyAt(index) ?? "");
        if (row?.place === "mounted") retire(row);
      }
      const bottomStart = Math.max(kept.start, range.end);
      for (let index = bottomStart; index < kept.end; index++) {
        const row = rows.get(geometry.keyAt(index) ?? "");
        if (row?.place === "mounted") retire(row);
      }
    } else {
      const visible = range.indices ? new Set(range.indices) : null;
      const leaving: [number, Row<T>][] = [];
      for (const row of mountedRows) {
        const index = committedIndexOf(row);
        if (
          visible
            ? !visible.has(index)
            : index < range.start || index >= range.end
        )
          leaving.push([index, row]);
      }
      // In list order, like the DOM they leave.
      leaving.sort((a, b) => a[0] - b[0]);
      for (const [, row] of leaving) retire(row);
    }
    let complete = true;
    const entering = delta?.entering ?? range.indices;
    const length = entering?.length ?? range.end - range.start;
    const firstKeptRow =
      kept && kept.start < range.end && range.start < kept.start
        ? rows.get(committedKeys[kept.start] ?? "")
        : undefined;
    let nextBeforeKeptSlot =
      firstKeptRow && firstKeptRow.place === "mounted" && hiddenRows.size === 0
        ? firstKeptRow.slot
        : undefined;
    for (let n = 0; n < length; n++) {
      let index = entering?.[n] ?? range.start + n;
      // An unchanged stack already owns the overlap: skip it.
      if (kept && index >= kept.start && index < kept.end) {
        nextBeforeKeptSlot = undefined;
        n += kept.end - index;
        if (n >= length) break;
        index = range.start + n;
      }
      const row = materialize(index);
      if (disposed) return range;
      if (!row) {
        // A declared row whose render failed retries next time.
        if (declaredItems.has(geometry.keyAt(index) ?? "")) complete = false;
        continue;
      }
      if (row.place !== "mounted") {
        if (nextBeforeKeptSlot !== undefined && kept && index < kept.start) {
          mountBeforeHint = nextBeforeKeptSlot;
          nextBeforeKeptSlot = undefined;
        }
        mountRow(row);
      }
    }
    if (sweep) sweepHidden();
    if (complete) {
      lastReconcile.top = vp.scrollTop;
      lastReconcile.height = vp.height;
      lastReconcile.epoch = epoch;
      lastReconcile.structure = structureEpoch;
    } else {
      lastReconcile.epoch = -1;
      lastReconcile.structure = -1;
    }
    return range;
  }

  let lastState: VirtualListState = EMPTY_STATE;
  let lastPublishedEpoch = -1;
  let lastPublishedIndices: readonly number[] | undefined;
  let lastPublishedViewport = { scrollTop: Number.NaN, height: Number.NaN };
  const reach = new ReachController({
    start: options.onReachStart,
    end: options.onReachEnd,
  });

  function publish(
    vp: GeometryViewport = viewportState(),
    range: GeometryWindow = geometry.window(vp, overscanPx),
  ): void {
    if (disposed) return;
    // Until a resize is adopted, a position at the new height is a clamp.
    if (Math.abs(vp.height - viewportHeight) <= EPSILON_PX)
      lastObservedTop = vp.scrollTop;
    const maxTop = geometry.maxScrollTop(vp.height);
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
    const atStart = vp.scrollTop <= AT_EDGE_PX;
    const atEnd = maxTop - vp.scrollTop <= AT_EDGE_PX;
    const totalSize = geometry.totalSize;
    const followingEnd =
      follow.armed &&
      (follow.followingEnd ||
        maxTop - follow.target(vp.scrollTop, maxTop) <= AT_EDGE_PX);
    const held =
      pending !== null ||
      dirtyRows.size > 0 ||
      staleRows.size > 0 ||
      windowJobs.size > 0;
    const state = lastState;
    // Most scroll events keep every field; a commit can still move positions.
    if (
      lastPublishedEpoch !== epoch ||
      lastPublishedIndices !== range.indices ||
      state.count !== count ||
      state.start !== start ||
      state.end !== end ||
      state.atStart !== atStart ||
      state.atEnd !== atEnd ||
      state.following !== follow.armed ||
      state.followingEnd !== followingEnd ||
      state.totalSize !== totalSize ||
      state.held !== held
    ) {
      lastPublishedEpoch = epoch;
      lastPublishedIndices = range.indices;
      const next: VirtualListState = {
        count,
        start,
        end,
        atStart,
        atEnd,
        following: follow.armed,
        followingEnd,
        totalSize,
        held,
      };
      lastState = next;
      if (options.onState) {
        try {
          options.onState(next, vp);
        } catch (error) {
          failures.push(...flatten(error));
        }
      }
      if (disposed) return;
    }
    if (
      lastPublishedViewport.scrollTop !== vp.scrollTop ||
      lastPublishedViewport.height !== vp.height
    ) {
      lastPublishedViewport = vp;
      if (options.onViewport) {
        try {
          options.onViewport(vp);
        } catch (error) {
          failures.push(...flatten(error));
        }
      }
      if (disposed) return;
    }
    if (options.onReachStart || options.onReachEnd) {
      try {
        reach.update(vp.scrollTop, maxTop);
      } catch (error) {
        failures.push(...flatten(error));
      }
    }
  }

  function reconcileAndPublish(vp: GeometryViewport = viewportState()): void {
    const range = reconcileWindow(vp);
    if (!commitMounted()) publish(vp, range);
  }

  function onScrolled(): void {
    const vp = viewportState();
    // Genuine input leaving the pin drops a held pin stance; the engine's
    // own moves (a clamp onto the end, a bounce past it) keep it.
    if (resizeHeld === "pin" && glide === null) {
      const max = geometry.maxScrollTop(vp.height);
      const beyond = vp.scrollTop > max + AT_EDGE_PX;
      const clamped =
        lastObservedTop > max + AT_EDGE_PX &&
        Math.abs(vp.scrollTop - max) <= AT_EDGE_PX;
      if (!beyond && !clamped) resizeHeld = "viewport";
    }
    const range = reconcileWindow(vp);
    if (commitMounted() || liveCommit()) return;
    publish(vp, range);
    // Retired reading space must not become a new end when input reverses
    // before settling. Drop it only once it is wholly beyond the viewport;
    // no measurement or pending transaction may be forced by this cleanup.
    if (
      geometry.reserve > 0 &&
      glide === null &&
      pending === null &&
      remeasurePolicy === undefined &&
      dirtyRows.size === 0 &&
      staleRows.size === 0 &&
      vp.scrollTop >= 0 &&
      vp.scrollTop <= contentEnd(vp.height)
    )
      trimUnusedReserve(vp);
  }

  /** Content and pin define end intent; retained reading space does not. */
  function contentEnd(height: number): number {
    return Math.max(0, geometry.contentSize - height, geometry.pinTop ?? 0);
  }

  /** Release trailing space that no longer supports the reading position. */
  function trimUnusedReserve(position?: GeometryViewport): void {
    if (disposed || geometry.reserve === 0) return;
    const vp = position ?? viewportState();
    const needed = Math.max(
      0,
      Math.max(vp.scrollTop, geometry.pinTop ?? 0) +
        vp.height -
        geometry.contentSize,
    );
    if (geometry.reserve > needed + EPSILON_PX)
      commit(null, { policy: "none", keepFollow: true });
  }

  // --- Phase: the settle sensor ---------------------------------------------
  let glide: Glide | null = null;
  let followGlide = false;
  let glideToPin = false;
  let inputEpoch = 0;
  let commandEpoch = 0;
  /** A landed command resolves at its settle, against final geometry. */
  let parked: {
    done: (completed: boolean) => void;
    landed: () => boolean;
    followsEnd: boolean;
  } | null = null;
  /** A command or resize is settling the phase it interrupts. */
  let takingOver: "command" | "resize" | null = null;
  const windowJobs = new Set<() => void>();
  const cancelJobs = new Set<() => void>();

  const idle = (): boolean => !controller.isScrollPhaseActive();
  const settleStrategy = options.settleStrategy ?? detectScrollSettleStrategy();

  /**
   * F5: under native anchoring, a change above the reading position lands
   * mid-gesture. Edges keep the settle: a bounce, Firefox's scroll limit,
   * and an early scrollend all live there. So does a glide: it heads for a
   * target in the committed snapshot, and held work waits for its landing.
   * WebKit gestures also wait through momentum: CSS anchoring support
   * does not guarantee that a prepend adjusts the native scroller. The
   * settle commit preserves the reading position with an explicit write.
   */
  const nativeFree = (): boolean =>
    native &&
    glide === null &&
    settleStrategy !== "safari-wheel" &&
    !controller.isNearScrollEdge();

  const follow = new FollowController(
    {
      maxScrollTop: () => geometry.maxScrollTop(clientHeight()),
      lastItemTop: (content) => {
        const key = lastItemKey();
        if (key === null) return null;
        const start = content ? rows.get(key)?.followStart : 0;
        return start === null ? null : geometry.offsetOf(key) + (start ?? 0);
      },
      lastItemKey,
      hidden: () => document.visibilityState === "hidden",
      now: () => performance.now(),
    },
    options.followMode,
    options.followInset,
  );

  function lastItemKey(): string | null {
    let index = geometry.count - 1;
    while (index >= 0 && isSlotKey(geometry.keyAt(index) as string)) index--;
    return geometry.keyAt(index) ?? null;
  }

  const controller = createScrollSettleController({
    viewport,
    strategy: settleStrategy,
    measureEpsilon: EPSILON_PX,
    isDisposed: () => disposed,
    canLoadAtBoundary: (boundary) =>
      reach.canLoad(boundary === "top" ? "start" : "end"),
    lowerBoundMaxScrollTop: () => {
      if (cachedRoundedHeight < 0 || resizeHeld !== null) return null;
      if (!native) {
        if (!Number.isFinite(lastCanvasHeightPx)) return null;
        const bound = lastCanvasHeightPx - cachedExactHeight - 32;
        return bound > 4 ? bound : null;
      }
      if (
        dirtyRows.size > 0 ||
        staleRows.size > 0 ||
        lastReconcile.epoch !== epoch
      ) {
        return null;
      }
      const bound = geometry.totalSize - cachedExactHeight - 32;
      return bound > 4 ? bound : null;
    },
    // Genuine input owns the viewport from here.
    cancelActiveSmoothScroll: () =>
      pass(() => {
        inputEpoch += 1;
        holdLanding = false;
        const wasFollowing = follow.stop();
        if (glide !== null && resizeHeld === "pin") resizeHeld = "viewport";
        glide?.cancel();
        settleParked(false);
        if (wasFollowing) publish();
      }),
    // Only the glide's own completion ends its phase.
    noSmoothScrollInFlight: () => glide === null,
    onGestureSettled: () => {
      holdLanding = false;
      for (const run of [...windowJobs]) run();
      if (disposed || !idle()) return;
      pass(() => {
        try {
          settleGesture();
        } catch (error) {
          settleParked(false);
          throw error;
        }
      });
    },
    onScrollEventObserved: () => {
      if (disposed || scope !== null) return;
      pass(onScrolled);
    },
  });

  /** The phase reached idle: everything held lands, once. */
  function settleGesture(): void {
    flushStale();
    const explicit = remeasurePolicy;
    if (remeasureRequests.size === 0) remeasurePolicy = undefined;
    if (pending !== null || dirtyRows.size > 0 || canvasFloorPending) {
      // Rows grown under a pinned landing commit on the pin's stance.
      const pinned = geometry.pinned;
      const onPin =
        explicit === undefined &&
        resizeHeld === "pin" &&
        pinned !== null &&
        (pending === null ||
          (pending.anchor === "auto" && pending.keys.includes(pinned)));
      if (onPin)
        commit(null, { policy: "pin", keepFollow: true, instant: true });
      else commit(null, { policy: explicit });
    } else if (resizeHeld !== null) {
      commit(null, reflow(resizeHeld));
    } else if (heldRetirements) reconcileAndPublish();
    else publish();
    resizeHeld = null;
    trimUnusedReserve();
    const endCommand = parked?.followsEnd === true;
    settleParked();
    if (
      smoothFollow &&
      takingOver !== "resize" &&
      remeasurePolicy === undefined
    ) {
      const changed = follow.resolveSettle({
        takingOver: takingOver !== null,
        atEnd: lastState.atEnd,
        endCommand,
        gliding: followGlide,
        position: viewport.scrollTop,
      });
      if (changed) publish();
      if (follow.armed) followIfBehindEnd();
    }
  }

  /** Resolve the parked command: interrupted (false) or its landing check. */
  function settleParked(verdict?: boolean): void {
    const command = parked;
    if (!command) return;
    parked = null;
    command.done(verdict ?? (!disposed && command.landed()));
  }

  /**
   * Stop browser motion without rebuilding its scrolling layer, then settle
   * the phase so held work commits before the command.
   */
  function interruptNativeScroll(
    reason: "command" | "resize" = "command",
    nativeMotion = true,
  ): void {
    if (!controller.isScrollPhaseActive()) return;
    if (nativeMotion) {
      const top = viewport.scrollTop;
      recordScrollAdjustment(top > 0 ? top - 1 : top + 1);
      recordScrollAdjustment(top);
      stopNativeScroll(viewport);
    }
    takingOver = reason;
    try {
      controller.finishGesture();
    } finally {
      takingOver = null;
    }
  }

  function takeover(): void {
    commandEpoch += 1;
    follow.stop();
    settleParked(false);
    const wasGliding = glide !== null;
    glide?.cancel();
    // Cancelling an owned glide already stops it. Rebuilding the scrolling
    // layer here can strand the next native Safari animation.
    interruptNativeScroll("command", !wasGliding);
    // The command resolves against geometry read at the current width.
    if (staleRows.size > 0) drainStale();
  }

  // --- Data -----------------------------------------------------------------
  function adoptItems(
    snapshot: T[],
    index: KeyIndex,
    sharedWithDeclared = false,
  ): void {
    if (index !== desiredIndex) {
      const leading = isSlotKey(index.keys[0] ?? "") ? 1 : 0;
      // An edge slot coming or going leaves the host's order as it was.
      let reordered = snapshot.length !== lastItems.length;
      if (!reordered) {
        const nextKeys = index.keys;
        const prevKeys = desiredIndex.keys;
        for (let at = 0; at < snapshot.length; at++) {
          if (nextKeys[at + leading] !== prevKeys[at + desiredLeading]) {
            reordered = true;
            break;
          }
        }
      }
      if (reordered) structure += 1;
      desiredIndex = index;
      desiredLeading = leading;
    }
    lastItems = snapshot;
    lastItemsShared = sharedWithDeclared && declared;
  }

  function applyItems(
    snapshot: T[],
    anchor: AnchorRequest | undefined,
    interrupt: boolean,
    slots: Record<Edge, EdgeSlot | null> | null = null,
    jobRows?: Map<string, Row<T>>,
  ): void {
    if (disposed) return;
    pass(() => {
      if (interrupt) {
        takeover();
        if (disposed) return;
      }
      const previousSlots = slots ? { ...edgeSlots } : null;
      if (slots) Object.assign(edgeSlots, slots);
      let p: Pending<T> | null;
      try {
        p = stageSnapshot(snapshot, anchor, jobRows, true);
      } catch (error) {
        if (previousSlots) Object.assign(edgeSlots, previousSlots);
        throw error;
      }
      if (!p || disposed) return;
      adoptItems(snapshot, p.index, true);
      apply(p);
    });
  }

  function setItems(
    items: readonly T[],
    o: { anchor?: AnchorRequest; interrupt?: boolean } = {},
  ): void {
    if (disposed) return;
    const snapshot = items.slice();
    const anchor = ownAnchor(o.anchor);
    const interrupt = o.interrupt === true;
    if (defer(() => applyItems(snapshot, anchor, interrupt))) return;
    applyItems(snapshot, anchor, interrupt);
  }

  function updateItem(
    key: string,
    item: T,
    o: { anchor?: AnchorRequest } = {},
  ): void {
    if (disposed) return;
    const anchor = ownAnchor(o.anchor);
    if (defer(() => updateItem(key, item, { anchor }))) return;
    if (isSlotKey(key)) return;
    const position = desiredIndex.get(key);
    if (position === undefined) return;
    const index = position - desiredLeading;
    if (keyOf(item) !== key)
      throw new Error("updateItem cannot change an item's key");
    if (place) {
      let fastHandled = false;
      pass(() => {
        if (pending !== null || !idle() || committedPositioned === null) {
          return;
        }
        fastHandled = true;
        const height = declaredHeight(item);
        const ratio = currentRatio();
        const start = edgeSlots.start;
        const end = edgeSlots.end;
        const leadingSlot = start ? 1 : 0;
        const count = lastItems.length;
        const totalCount = count + leadingSlot + (end ? 1 : 0);
        let rawTops: Float64Array;
        let usesTopsScratch = false;
        if (totalCount <= 16_384) {
          if (topsScratch.length < totalCount) {
            topsScratch = new Float64Array(Math.max(totalCount, 256));
          }
          rawTops =
            topsScratch.length === totalCount
              ? topsScratch
              : topsScratch.subarray(0, totalCount);
          usesTopsScratch = true;
        } else {
          rawTops = new Float64Array(totalCount);
        }
        const lanes = scratchLanes(totalCount);
        let placedCount = 0;
        let rawOrigin = Number.POSITIVE_INFINITY;
        for (let i = 0; i < count; i++) {
          const placed = place(i === index ? item : (lastItems[i] as T));
          if (placed === null) continue;
          if (!Number.isFinite(placed.top))
            throw new RangeError("item top must be finite");
          const top = toDevicePixel(placed.top, ratio);
          if (top < rawOrigin) rawOrigin = top;
          const at = leadingSlot + placedCount;
          rawTops[at] = top;
          lanes[at] =
            typeof placed.lane === "number" ? placed.lane : Number.NaN;
          placedCount += 1;
        }
        const p = newPending(committedKeys, anchor, null);
        p.declared = new DeclaredItems<T>();
        p.declared.set(key, { item, height });
        p.patch = true;
        if (placedCount === count && count > 0) {
          const origin = positionedOrigin(rawOrigin, ratio);
          const leading = start ? quantize(start.height) : 0;
          const shift = leading - origin;
          const nextTop = (rawTops[position] as number) + shift;
          const laneNum = lanes[position] as number;
          if (
            end === null &&
            ratio === positionedRatio &&
            origin === positionedOriginPx &&
            shift === positionedShift &&
            committedPositioned.canUpdateInPlace(
              position,
              nextTop,
              height,
              laneNum,
            ) &&
            committedPositioned.matchesExcept(position, rawTops, shift, lanes)
          ) {
            p.positionedPatch = { at: position, top: nextTop, height };
          } else {
            const tops = usesTopsScratch ? rawTops.slice() : rawTops;
            const heightsBuf = new Float64Array(totalCount);
            for (let k = leadingSlot; k < leadingSlot + count; k++) {
              heightsBuf[k] = k === position ? height : geometry.heightAt(k);
            }
            p.positioned = finalizePositionedColumns(
              tops,
              heightsBuf,
              lanes,
              count,
              placedCount,
              rawOrigin,
              ratio,
              start,
              end,
              p,
            );
          }
        } else {
          p.positioned = finalizePositionedColumns(
            usesTopsScratch ? rawTops.slice() : rawTops,
            new Float64Array(totalCount),
            lanes,
            count,
            placedCount,
            rawOrigin,
            ratio,
            start,
            end,
            p,
          );
        }
        selectPin(p, lastItems, { index, item });
        if (!prepare(p, [key], () => item, null, false)) return;
        if (lastItemsShared) {
          lastItems = lastItems.slice();
          lastItemsShared = false;
        }
        lastItems[index] = item;
        revision += 1;
        apply(p, key);
      });
      if (fastHandled) return;
      // Held snapshot or unplaced list: stage through full snapshot replacement.
      const next = lastItems.slice();
      next[index] = item;
      applyItems(next, anchor, false);
      return;
    }
    pass(() => {
      // Only this key is prepared; a held snapshot is patched in place.
      const previous = pending;
      const p = newPending(previous?.keys ?? committedKeys, anchor, previous);
      const entry = declared ? { item, height: declaredHeight(item) } : null;
      // The touched entry alone: no copy of the declared entries.
      if (entry) {
        p.declared = new DeclaredItems<T>();
        p.declared.set(key, entry);
        p.patch = true;
      }
      selectPin(p, lastItems, { index, item });
      if (!prepare(p, [key], () => item, previous, false)) return;
      if (lastItemsShared) {
        lastItems = lastItems.slice();
        lastItemsShared = false;
      }
      lastItems[index] = item;
      revision += 1;
      if (previous) {
        previous.staged.delete(key);
        previous.deferred.delete(key);
        const row = p.staged.get(key);
        if (row) previous.staged.set(key, row);
        const deferred = p.deferred.get(key);
        if (deferred !== undefined) previous.deferred.set(key, deferred);
        if (entry) previous.declared?.set(key, entry);
        apply(
          {
            ...previous,
            anchor: p.anchor,
            target: p.target,
            pinKey: p.pinKey,
            pinOffset: p.pinOffset,
          },
          key,
        );
      } else apply(p, key);
    });
  }

  function protectedContext(protectPin = true): WindowUpdateContext<T> {
    const range = geometry.window(viewportState(), overscanPx);
    const keys = new Set(
      range.indices
        ? range.indices.map((index) => committedKeys[index] as string)
        : committedKeys.slice(range.start, range.end),
    );
    if (protectPin && geometry.pinned !== null) keys.add(geometry.pinned);
    if (pending?.target) keys.add(pending.target.key);
    const protectedItems: T[] = [];
    for (const key of keys) {
      if (isSlotKey(key)) continue;
      const item = declaredItems.itemOf(key) ?? rows.get(key)?.item;
      if (item !== undefined) protectedItems.push(item);
    }
    return { items: lastItems.slice(), protectedItems };
  }

  /**
   * Evaluate `update` at idle against the protected window and land its
   * snapshot in one commit. Large additions render in idle slices (during a
   * phase too) and frames, hidden in the canvas; the commit waits for idle.
   */
  function updateWindow(
    update: (context: WindowUpdateContext<T>) => WindowUpdate<T> | null,
    signal?: AbortSignal,
    o: NonNullable<Parameters<VirtualList<T>["updateWindow"]>[2]> = {},
  ): Promise<boolean> {
    if (o.scroll) return navigateWindow(update, signal, o);
    const interrupt = o.interrupt === true || o.interrupt === "commit";
    const interruptAtCommit = o.interrupt === "commit";
    const protectPin = o.protectPin !== false;
    return new Promise((resolve, reject) => {
      if (disposed || signal?.aborted) {
        resolve(false);
        return;
      }
      interface Job {
        next: WindowUpdate<T>;
        snapshot: T[];
        slots: Record<Edge, EdgeSlot | null> | null;
        source: readonly T[];
        /** The list's key order the job was staged against. */
        structure: number;
        width: number;
        input: number;
        protectedKeys: Set<string>;
        /** The snapshot's key order, to place staged rows in list order. */
        order: readonly string[];
        index: KeyIndex;
        fresh: [string, T][];
        cursor: number;
        rows: Map<string, Row<T>>;
        partial: { row: Row<T>; steps: Iterator<void, void> } | null;
        ready: boolean;
      }
      let job: Job | null = null;
      let finished = false;
      let working = false;
      let cancelRequested = false;
      let frame = 0;
      let idleHandle = 0;
      const canIdle = !interrupt && typeof requestIdleCallback === "function";

      const discard = (abandoned: Job): void => {
        const partial = abandoned.partial;
        abandoned.partial = null;
        if (partial) host(() => partial.steps.return?.());
        for (const row of abandoned.rows.values()) destroyRow(row);
      };

      const cleanup = (): void => {
        windowJobs.delete(run);
        cancelJobs.delete(cancel);
        signal?.removeEventListener("abort", cancel);
        if (frame !== 0) cancelAnimationFrame(frame);
        if (idleHandle !== 0) cancelIdleCallback(idleHandle);
        frame = 0;
        idleHandle = 0;
      };
      const finish = (applied: boolean, error?: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        const mark = failures.length;
        const errors = error === undefined ? [] : flatten(error);
        const abandoned = job;
        job = null;
        if (abandoned) discard(abandoned);
        errors.push(...failures.splice(mark));
        try {
          if (!disposed && !defer(() => pass(publish))) pass(publish);
        } catch (failure) {
          errors.push(...flatten(failure));
        }
        if (errors.length === 0) resolve(applied);
        else
          reject(
            errors.length === 1
              ? errors[0]
              : new AggregateError(errors, "window preparation failed"),
          );
      };
      const cancel = (): void => {
        // Let an active host callback return first.
        if (working) cancelRequested = true;
        else finish(false);
      };
      let checkedItems: readonly T[] | null = null;
      let checkedRevision = -1;
      const sourceCurrent = (j: Job): boolean => {
        if (checkedItems === lastItems && checkedRevision === revision)
          return true;
        if (
          j.source.length !== lastItems.length ||
          !j.source.every((item, index) => item === lastItems[index])
        )
          return false;
        checkedItems = lastItems;
        checkedRevision = revision;
        return true;
      };
      /**
       * Staging goes on while items are replaced in place (a streamed
       * token): rows staged for new keys stay valid. A key-order change ends
       * the job; an in-place change is resolved at the commit (`run`).
       */
      const alive = (): boolean =>
        !finished &&
        !cancelRequested &&
        !disposed &&
        !signal?.aborted &&
        (!job ||
          (job.structure === structure &&
            (!interrupt || job.input === inputEpoch)));
      /** Stop when the job no longer lives; true when it did. */
      const ended = (): boolean => {
        if (alive()) return false;
        cancel();
        return true;
      };

      /** Render one bounded slice, hidden in the canvas; one warm read. */
      const slice = (j: Job, deadline?: IdleDeadline): void => {
        pass(() => {
          const started = performance.now();
          let last: Row<T> | null = null;
          let count = 0;
          const budgetMs = interrupt ? 50 : 3;
          const limit = interrupt
            ? j.fresh.length
            : !deadline && idle()
              ? JOB_REST_ROWS
              : JOB_MIN_ROWS;
          while (j.cursor < j.fresh.length && count < limit) {
            if (deadline && deadline.timeRemaining() < IDLE_SLICE_MIN_MS) break;
            if (j.partial) {
              const partial = j.partial;
              last = partial.row;
              do {
                if (partial.steps.next().done) {
                  j.partial = null;
                  j.cursor += 1;
                  count += 1;
                  break;
                }
              } while (interrupt && performance.now() - started < budgetMs);
              // The browser lays out this chunk before the next one arrives.
              if (!interrupt || j.partial) break;
              continue;
            }
            const [key, item] = j.fresh[j.cursor] as [string, T];
            const row = createRow(key, item, render(item), 1);
            j.rows.set(key, row);
            if (!alive()) {
              cancel();
              return;
            }
            const steps = options.stage?.(item, row.element);
            if (steps) j.partial = { row, steps };
            if (!alive()) {
              cancel();
              return;
            }
            hideRow(
              row,
              insertionPoint(j.order, j.index.get(key) as number, j.rows),
            );
            if (!steps) {
              j.cursor += 1;
              count += 1;
            }
            last = row;
            if (
              (steps && !interrupt) ||
              (!deadline && performance.now() - started >= budgetMs)
            )
              break;
          }
          last?.element.getBoundingClientRect();
          if (ended()) return;
          j.ready = j.cursor === j.fresh.length;
        });
      };
      const work = (step: () => void): void => {
        working = true;
        try {
          step();
        } catch (error) {
          finish(false, error);
        } finally {
          working = false;
        }
      };
      const stageFrame = (): void => {
        frame = 0;
        if (ended()) return;
        if (job && job.width !== viewportWidth) {
          run();
          return;
        }
        // The settle resumes this job, unless native anchoring lands it now.
        if ((!idle() && !nativeFree() && !interruptAtCommit) || !job) return;
        const j = job;
        work(() => {
          slice(j);
          if (!alive()) finish(false);
          else frame = requestAnimationFrame(j.ready ? runFrame : stageFrame);
        });
      };
      const stageIdle = (deadline: IdleDeadline): void => {
        idleHandle = 0;
        if (ended()) return;
        if (job && job.width !== viewportWidth) {
          run(!idle());
          return;
        }
        if (idle() || !job) return; // The settle owns it now.
        const j = job;
        if (!j.ready) {
          work(() => {
            slice(j, deadline);
            if (!alive()) finish(false);
            else if (!j.ready) idleHandle = requestIdleCallback(stageIdle);
          });
        }
        if (j.ready && !finished && (nativeFree() || interruptAtCommit)) run();
      };
      const runFrame = (): void => {
        frame = 0;
        run();
      };
      function run(prepareOnly = false): void {
        if (working || finished || ended()) return;
        if (!idle() && !prepareOnly && !nativeFree() && !interruptAtCommit)
          return;
        const staging = (): void => {
          if (prepareOnly || (!idle() && canIdle)) {
            if (idleHandle === 0) idleHandle = requestIdleCallback(stageIdle);
          } else if (frame === 0) frame = requestAnimationFrame(stageFrame);
        };
        try {
          let applied = false;
          /** Evaluated mid-phase but left for the settle (a scroll write). */
          let waiting = false;
          pass(() => {
            // Width-dependent rendering is stale after a rotation or resize,
            // but the source request still belongs to this update. Rebuild
            // its proposal at the new width instead of dropping the page.
            if (job && job.width !== viewportWidth) {
              const abandoned = job;
              job = null;
              if (frame !== 0) cancelAnimationFrame(frame);
              if (idleHandle !== 0) cancelIdleCallback(idleHandle);
              frame = 0;
              idleHandle = 0;
              checkedItems = null;
              checkedRevision = -1;
              discard(abandoned);
              if (ended()) return;
            }
            const j = job;
            if (j && !j.ready) {
              staging();
              return;
            }
            // Nothing lands mid-phase: a ready job waits for the settle.
            if (prepareOnly && j) return;
            const context = protectedContext(protectPin);
            const exposed =
              j !== null &&
              interruptAtCommit &&
              j.protectedKeys.size > 0 &&
              [...j.protectedKeys].every((key) => j.index.has(key)) &&
              context.protectedItems.some((item) => !j.index.has(keyOf(item)));
            // Items replaced in place since staging (a streamed token): ask
            // the updater again. Its rows stay adoptable by item identity.
            const stale = j !== null && (!sourceCurrent(j) || exposed);
            const next = j && !stale ? j.next : update(context);
            if (!next) {
              if (j) cancel();
              return;
            }
            if (ended()) return;
            const snapshot = j && !stale ? j.snapshot : [...next.items];
            if (
              stale &&
              (exposed
                ? !declared &&
                  snapshot.some((item) => {
                    const key = keyOf(item);
                    return !rows.has(key) && !j.rows.has(key);
                  })
                : snapshot.length !== j.order.length ||
                  snapshot.some(
                    (item, index) => keyOf(item) !== j.order[index],
                  ))
            ) {
              cancel();
              return;
            }
            if (!protectPin) {
              // Opt-in trimming releases only the pin's extra protection.
              const keys =
                j && !exposed ? j.index : new Set(snapshot.map(keyOf));
              const target =
                typeof next.anchor === "object" ? next.anchor : null;
              if (
                context.protectedItems.some((item) => !keys.has(keyOf(item))) ||
                (target !== null && !keys.has(target.key))
              ) {
                cancel();
                return;
              }
            }
            const slots = next.edgeSlots
              ? {
                  start: ownSlot(next.edgeSlots.start),
                  end: ownSlot(next.edgeSlots.end),
                }
              : null;
            if (stale) {
              j.next = {
                ...next,
                anchor: ownAnchor(next.anchor ?? "viewport"),
              };
              j.snapshot = snapshot;
              j.slots = slots;
              j.source = context.items;
            }
            if (!j && !declared && pending === null) {
              const { keys, positions, ownedKeys } = indexItems(
                snapshot,
                false,
              );
              const fresh: [string, T][] = [];
              for (let i = 0; i < keys.length; i++) {
                const key = keys[i] as string;
                if (!rows.has(key)) fresh.push([key, snapshot[i] as T]);
              }
              if (ended()) return;
              if (
                fresh.length > JOB_MIN_ROWS ||
                (options.stage && fresh.length > 0)
              ) {
                const indexMap =
                  positions !== null
                    ? KeyIndex.fromOwned(keys, positions)
                    : keys === desiredIndex.keys || desiredIndex.matches(keys)
                      ? desiredIndex
                      : (desiredIndex.extend(keys, ownedKeys) ??
                        desiredIndex.truncate(keys, ownedKeys) ??
                        new KeyIndex(keys, undefined, ownedKeys));
                job = {
                  next: {
                    ...next,
                    anchor: ownAnchor(next.anchor ?? "viewport"),
                  },
                  snapshot,
                  slots,
                  source: context.items,
                  structure,
                  width: viewportWidth,
                  input: inputEpoch,
                  protectedKeys: new Set(context.protectedItems.map(keyOf)),
                  order: keys,
                  index: indexMap,
                  fresh,
                  cursor: 0,
                  rows: new Map(),
                  partial: null,
                  ready: false,
                };
                staging();
                publish();
                return;
              }
            }
            if (prepareOnly) return;
            // A gesture may have exposed rows the updater was allowed to trim.
            if (
              j &&
              !interruptAtCommit &&
              context.protectedItems.some((item) => {
                const key = keyOf(item);
                return !j.protectedKeys.has(key) && !j.index.has(key);
              })
            ) {
              cancel();
              return;
            }
            if (ended()) return;
            // An updater can synchronously resize through a host callback.
            // Rebuild on the next opportunity before publishing old-width rows.
            if (j && j.width !== viewportWidth) {
              if (frame === 0) frame = requestAnimationFrame(runFrame);
              return;
            }
            // Mid-phase (native anchoring), only a snapshot that needs no
            // scroll write lands; a named or end anchor waits for the settle.
            const anchor = next.anchor ?? "viewport";
            if (
              !idle() &&
              !interruptAtCommit &&
              (!nativeFree() || typeof anchor === "object" || anchor === "end")
            ) {
              waiting = true;
              return;
            }
            cleanup();
            if (interruptAtCommit) {
              takeover();
              if (ended()) return;
            }
            flushStale();
            applyItems(
              snapshot,
              ownAnchor(next.anchor ?? "viewport"),
              false,
              j ? j.slots : slots,
              j?.rows,
            );
            if (disposed) return;
            host(() => next.onCommit?.());
            applied = true;
          }, true);
          if (waiting || (prepareOnly && !disposed)) return;
          if (applied || !job || disposed) finish(applied);
        } catch (error) {
          finish(false, error);
        }
      }
      const schedule = (): void => {
        if (disposed || signal?.aborted) {
          cancel();
          return;
        }
        if (interrupt && !interruptAtCommit) {
          try {
            pass(takeover);
          } catch (error) {
            finish(false, error);
            return;
          }
        }
        windowJobs.add(run);
        if (idle() || nativeFree() || interruptAtCommit) {
          run();
          return;
        }
        if (canIdle)
          idleHandle = requestIdleCallback(() => {
            idleHandle = 0;
            run(true);
          });
        try {
          pass(publish);
        } catch (error) {
          finish(false, error);
        }
      };
      cancelJobs.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (
        !defer(schedule, () => {
          cleanup();
          resolve(false);
        })
      )
        schedule();
    });
  }

  async function navigateWindow(
    update: (context: WindowUpdateContext<T>) => WindowUpdate<T> | null,
    signal: AbortSignal | undefined,
    o: NonNullable<Parameters<VirtualList<T>["updateWindow"]>[2]>,
  ): Promise<boolean> {
    if (options.position)
      throw new TypeError("window navigation requires ordered rows");
    const { target, behavior = "smooth" } = o.scroll!;
    let destinationKeys = new Set<string>();
    let committedStructure = -1;
    let committedInput = -1;
    let committedCommand = -1;
    const committed = await updateWindow(
      (context) => {
        const next = update(context);
        if (!next) return null;
        destinationKeys = new Set(next.items.map(keyOf));
        const visibleRange = geometry.window(viewportState(), 0);
        const visibleKeys = new Set(
          visibleRange.indices
            ? visibleRange.indices.map(
                (index) => committedKeys[index] as string,
              )
            : committedKeys.slice(visibleRange.start, visibleRange.end),
        );
        const retainedKeys =
          visibleKeys.size > 0
            ? visibleKeys
            : new Set(context.protectedItems.map(keyOf));
        const outgoing = context.items.filter((item) => {
          const key = keyOf(item);
          return retainedKeys.has(key) && !destinationKeys.has(key);
        });
        return {
          ...next,
          items:
            target === "end"
              ? [...outgoing, ...next.items]
              : [...next.items, ...outgoing],
          anchor: "viewport",
          onCommit: () => {
            committedStructure = structure;
            committedInput = inputEpoch;
            committedCommand = commandEpoch;
            next.onCommit?.();
          },
        };
      },
      signal,
      { ...o, scroll: undefined, interrupt: o.interrupt ?? "commit" },
    );
    if (
      !committed ||
      disposed ||
      signal?.aborted ||
      structure !== committedStructure ||
      inputEpoch !== committedInput ||
      commandEpoch !== committedCommand
    )
      return false;
    let ownedCommand = commandEpoch;
    const abort = (): void => {
      if (!disposed && commandEpoch === ownedCommand) pass(takeover);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const navigation = scrollTo(target, { behavior });
      ownedCommand = commandEpoch;
      const landed = await navigation;
      // A newer snapshot owns the list. Never restore stale destination data
      // over it, or remove the reader's rows after an interrupted glide.
      if (
        !landed ||
        disposed ||
        signal?.aborted ||
        structure !== committedStructure ||
        inputEpoch !== committedInput ||
        commandEpoch !== ownedCommand
      )
        return false;
      // Read current objects so tokens received during the glide survive.
      pass(() => {
        const snapshot = lastItems.filter((item) =>
          destinationKeys.has(keyOf(item)),
        );
        const p = stageSnapshot(snapshot, "viewport", undefined, true);
        if (!p || disposed) return;
        adoptItems(snapshot, p.index, true);
        commit(p, { keepFollow: true });
      });
      return true;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  // --- Commands -------------------------------------------------------------
  function scrollTo(
    target: ScrollTarget,
    o: ScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const pin = o.pin;
    if (pin !== undefined) {
      if (target !== "end")
        return Promise.reject(new TypeError("pin requires an end target"));
      if (pin === null || typeof pin.key !== "string")
        return Promise.reject(new TypeError("pin key must be a string"));
    }
    const finite = (value: number | undefined): number | undefined =>
      value !== undefined && Number.isFinite(value) ? value : undefined;
    const owned: ScrollOptions = {
      align: o.align,
      behavior: o.behavior,
      offset: finite(o.offset),
      pin: pin && { key: pin.key, offset: finite(pin.offset) ?? 0 },
    };
    return new Promise((resolve, reject) => {
      const run = (): void => {
        void scrollTo(target, owned).then(resolve, reject);
      };
      if (defer(run, () => resolve(false))) return;
      pass(() => performScrollTo(target, owned, resolve));
    });
  }

  /** The command's destination under current geometry; null once gone. */
  function targetTop(target: ScrollTarget, below = 0): number | null {
    // Without pinning, commands target content, not retained reserve.
    const height = clientHeight();
    const maxTop = pinning
      ? geometry.maxScrollTop(height)
      : Math.max(0, geometry.contentSize - height);
    if (target === "start") return 0;
    if (target === "end") {
      // End intent targets content or the current pin, never temporary space
      // retained for a prior reading anchor. That space drains after landing.
      return Math.ceil(contentEnd(height));
    }
    const offset = geometry.offsetOf(target);
    // Land past a fractional boundary: engines can floor the write.
    return offset < 0
      ? null
      : Math.ceil(Math.max(0, Math.min(offset - below, maxTop)));
  }

  function landedOn(target: ScrollTarget, below = 0) {
    const top = targetTop(target, below);
    return top !== null && Math.abs(viewport.scrollTop - top) <= AT_EDGE_PX;
  }

  function performScrollTo(
    target: ScrollTarget,
    o: ScrollOptions,
    done: (completed: boolean) => void,
  ): void {
    // A newer command supersedes the last; then it takes the viewport over,
    // so held work commits first and the command sees final geometry.
    takeover();
    // Intermediate navigation can consume a reach while its host is busy.
    // A fresh edge command is new intent even without crossing the exit zone.
    if (target === "start" || target === "end") reach.request(target);
    const keyed = target !== "start" && target !== "end";
    const below = o.offset ?? 0;
    const pin = pinning && !pinPolicy ? o.pin : undefined;
    if (
      disposed ||
      (keyed && geometry.indexOf(target) < 0) ||
      (pin !== undefined && geometry.indexOf(pin.key) < 0)
    ) {
      done(false);
      return;
    }
    // A pin reserves its shortfall (I5), committed now: the phase is idle.
    if (
      pinning &&
      !pinPolicy &&
      (pin !== undefined || (keyed && o.align === "start"))
    ) {
      geometry.pin(pin?.key ?? target, pin?.offset ?? below);
      commit(null, { policy: "none" });
    }
    const destination = (): number =>
      targetTop(target, below) ?? viewport.scrollTop;
    if (o.behavior !== "smooth") {
      const top = Math.round(destination());
      if (Math.abs(top - viewport.scrollTop) > EPSILON_PX) writeScrollTop(top);
      // An instant command to the end has no settle to arm following at.
      if (target === "end" && smoothFollow) follow.start();
      reconcileAndPublish();
      trimUnusedReserve();
      done(!disposed && landedOn(target, below));
      return;
    }
    // A glide is a phase of its own: held work waits for its landing.
    controller.beginProgrammaticGesture();
    const complete = (completed: boolean): void =>
      pass(() => {
        glide = null;
        glideToPin = false;
        if (!completed || disposed) {
          done(false);
          if (!disposed) controller.markSettlePending();
          return;
        }
        parked = {
          done,
          landed: () => landedOn(target, below),
          followsEnd: target === "end",
        };
        controller.markSettlePending();
      });
    glide = startNativeGlide(viewport, destination, complete);
    glideToPin =
      pinning &&
      keyed &&
      o.align === "start" &&
      (!pinPolicy || target === geometry.pinned);
  }

  function followIfBehindEnd(motion: "smooth" | "instant" = "smooth"): void {
    const current = viewport.scrollTop;
    if (!follow.needsMotion(current)) return;
    if (motion === "instant" || follow.catchingUp) {
      pass(() => {
        writeScrollTop(Math.ceil(follow.target(current)));
        reconcileAndPublish();
      });
      return;
    }
    startFollowGlide();
  }

  /** Automatic end-follow: one glide whose destination tracks growth. */
  function startFollowGlide(): void {
    if (disposed || glide !== null) return;
    controller.beginProgrammaticGesture();
    const destination = (): number =>
      Math.ceil(follow.target(viewport.scrollTop));
    const complete = (): void =>
      pass(() => {
        glide = null;
        followGlide = false;
        if (!disposed) controller.markSettlePending();
      });
    glide = startNativeGlide(viewport, destination, complete, {
      trackTarget: true,
    });
    followGlide = true;
  }

  function setFollowMode(mode: FollowMode, inset = 0): void {
    if (disposed) return;
    follow.setMode(mode, inset);
    if (follow.armed && idle()) followIfBehindEnd();
  }

  // --- Remeasure: a discrete host interaction owns the next commit ----------
  const remeasureRequests = new Map<string, AnchorPolicy>();
  let remeasurePolicy: AnchorPolicy | undefined;
  let remeasureFrame = 0;

  function flushRemeasures(): void {
    remeasureFrame = 0;
    if (disposed) return;
    pass(() => {
      let policy: AnchorPolicy | null = null;
      for (const [key, anchor] of remeasureRequests) {
        const row = rows.get(key);
        if (row?.place !== "mounted" || row.spec) continue;
        markDirty(row);
        policy = anchor;
      }
      remeasureRequests.clear();
      if (policy === null) {
        remeasurePolicy = undefined;
        publish();
        return;
      }
      remeasurePolicy = policy;
      if (!idle()) {
        publish();
        return;
      }
      remeasurePolicy = undefined;
      commit(null, { policy });
    });
  }

  function remeasure(key: string, o: { anchor?: AnchorPolicy } = {}): void {
    if (disposed || declared) return;
    const anchor = o.anchor ?? "viewport";
    if (defer(() => remeasure(key, { anchor }))) return;
    pass(() => {
      const row = rows.get(key);
      if (row?.place !== "mounted" || row.spec) return;
      remeasureRequests.delete(key);
      remeasureRequests.set(key, anchor);
      remeasurePolicy = anchor;
      if (anchor === "viewport") {
        // A user expansion never re-engages automatic end-follow.
        const automatic = controller.isScrollPhaseActive() && follow.armed;
        follow.stop();
        if (followGlide) glide?.cancel();
        if (automatic) controller.finishGesture();
        publish();
      }
      if (remeasureFrame === 0)
        remeasureFrame = requestAnimationFrame(flushRemeasures);
    });
  }

  function setEdgeSlot(edge: Edge, slot: EdgeSlot | null): void {
    if (disposed) return;
    const owned = ownSlot(slot);
    if (defer(() => setEdgeSlot(edge, owned))) return;
    applyItems(lastItems.slice(), undefined, false, {
      ...edgeSlots,
      [edge]: owned,
    });
  }

  // --- Lifecycle ------------------------------------------------------------
  let cancelRepaint: (() => void) | undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const mark = failures.length;
    cancelRepaint?.();
    for (const cancel of [...cancelJobs]) cancel();
    for (const tasks of openScopes) discard(tasks);
    // A failed native stop must not strand observers, rows, or queued work.
    host(() => glide?.cancel());
    settleParked(false);
    reach.dispose();
    controller.dispose();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (observeFrame !== 0) cancelAnimationFrame(observeFrame);
    pendingObserves.length = 0;
    if (remeasureFrame !== 0) cancelAnimationFrame(remeasureFrame);
    clearTimeout(staleTimer);
    cancelAnimationFrame(staleFrame);
    staleRows.clear();
    remeasureRequests.clear();
    rowObserver.disconnect();
    viewportObserver.disconnect();
    ratioQuery?.removeEventListener("change", onPixelRatioChange);
    canvas.remove();
    if (viewportAnchor !== null) viewport.style.overflowAnchor = viewportAnchor;
    if (!booting) disposedViewports.add(viewport);
    const doomed = [
      ...rows.values(),
      ...(pending?.staged.values() ?? []),
      ...(committing?.staged.values() ?? []),
    ];
    rows.clear();
    brokenRows.clear();
    slotPool.length = 0;
    lanesScratch = new Float64Array(0);
    topsScratch = new Float64Array(0);
    declaredItems.clear();
    committedPositioned = null;
    lastItems = [];
    lastItemsShared = false;
    pending = null;
    committing = null;
    for (const row of doomed) destroyRow(row);
    throwAll(failures.splice(mark), "row teardown failed");
  }

  try {
    pass(() => {
      const p = stageSnapshot(
        lastItems,
        options.boot === "start" ? "none" : "end",
        undefined,
        true,
      );
      if (!p) return;
      adoptItems(lastItems, p.index, true);
      commit(p);
    });
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, ...flatten(cleanupError)],
        "initialization and cleanup failed",
      );
    }
    throw error;
  }
  booting = false;
  // A replacement on the same WebKit viewport can inherit a stale layer.
  if (
    !disposed &&
    disposedViewports.delete(viewport) &&
    detectScrollSettleStrategy() === "safari-wheel"
  ) {
    const epochAtBoot = inputEpoch;
    cancelRepaint = scheduleReplacementRepaint(
      viewport,
      () =>
        !disposed &&
        inputEpoch === epochAtBoot &&
        !controller.isScrollPhaseActive(),
    );
  }

  return {
    setItems,
    updateItem,
    updateWindow,
    scrollTo,
    remeasure,
    setEdgeSlot,
    setFollowMode,
    positionOf(key) {
      const index = geometry.indexOf(key);
      if (index < 0) return null;
      return {
        top: geometry.offsetAt(index),
        height: geometry.heightAt(index),
      };
    },
    elementOf(key) {
      const row = rows.get(key);
      return row?.place === "mounted" ? row.element : null;
    },
    get state() {
      return lastState;
    },
    dispose,
  };
}
