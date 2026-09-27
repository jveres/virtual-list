import { FollowController } from "./follow";
import {
  type AnchorPolicy,
  type CapturePolicy,
  type ExplicitAnchor,
  Geometry,
  type GeometryViewport,
} from "./geometry";
import { type Glide, startNativeGlide, stopNativeScroll } from "./native-glide";
import {
  type GeometryWindow,
  PositionedGeometry,
  type PositionedItem,
} from "./positioned-geometry";
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
/** A window update adding more fresh rows prepares them across frames. */
const JOB_MIN_ROWS = 8;
const SLOT_PREFIX = "\u0000edge:";
const SLOT_BASE = "position:absolute;top:0;left:0;right:0;";
/** Where hidden slots wait: above the scroll origin, out of every rect query. */
const PARKED_TOP = "-100000px";
/** Native flow parks the row instead: its slot must never change position. */
const PARKED_TRANSLATE = "0 -100000px";
/** How far a mounting slot looks ahead for a connected successor. */
const INSERTION_SCAN = 64;

const slotKey = (edge: Edge, key: string): string =>
  `${SLOT_PREFIX}${edge}:${key}`;
const isSlotKey = (key: string): boolean => key.startsWith(SLOT_PREFIX);

function pixelRatio(): number {
  const ratio = globalThis.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** A reading-anchor write lands on the device grid (I0). */
function toDevicePixel(value: number): number {
  const ratio = pixelRatio();
  return Math.round(value * ratio) / ratio;
}

/** A positioned origin that survives engines rounding writes to CSS pixels. */
function positionedOrigin(top: number): number {
  const ratio = pixelRatio();
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
  return { key: anchor.key, offset: anchor.offset };
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
  height: number;
  /** Last measured content width, reused by the optional skeleton. */
  width: number;
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

interface Declared<T> {
  item: T;
  height: number;
}

/** The desired state: what the next commit makes true. */
interface Pending<T> {
  keys: readonly string[];
  /** New and replacing rows, rendered and measured, not yet committed. */
  staged: Map<string, Row<T>>;
  /** Declared rows re-rendered inside the commit that changes their height. */
  deferred: Map<string, T>;
  declared: Map<string, Declared<T>> | null;
  positioned: PositionedGeometry | null;
  anchor: AnchorPolicy;
  target: ExplicitAnchor | null;
  pinKey?: string | null;
  pinOffset?: number;
}

interface CommitOptions {
  policy?: CapturePolicy;
  /** False: never write the scroll position (a mid-phase commit). */
  write?: boolean;
  /** Leave follow intent as found instead of deriving it. */
  keepFollow?: boolean;
  instant?: boolean;
}

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
  options: VirtualListOptions<T>,
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

  /** I0: whole CSS pixels at integral ratios, the device grid otherwise. */
  function quantize(height: number): number {
    const ratio = pixelRatio();
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
  let declaredItems = new Map<string, Declared<T>>();
  geometry.setAnchorExclusion((key) => {
    if (isSlotKey(key)) return true;
    if (anchorable === undefined) return false;
    const entry = declaredItems.get(key) ?? rows.get(key);
    return entry !== undefined && !anchorable(entry.item);
  }, anchorable === undefined);
  const mountedRows = new Set<Row<T>>();
  const hiddenRows = new Set<Row<T>>();
  const dirtyRows = new Set<Row<T>>();
  let placeholdersEnabled = options.scrollPlaceholders === true;
  let fastScrolling = false;
  let placeholderSample: { top: number; time: number } | null = null;
  const placeholderRows = new Map<Row<T>, () => void>();
  const skeletons = new Map<string, HTMLElement>();
  const skeletonItems = new Map<string, T>();
  let skeletonSurface: HTMLElement | null = null;
  let skeletonEpoch = -1;
  let placeholderIdleTimer = 0;
  let placeholderLastMovement = 0;
  const placeholderIdleMs = 120;
  const placeholderSlowMs = 80;
  let placeholderSlowSince: number | null = null;
  let placeholderLastInput = 0;
  let placeholderTouchActive = false;

  function placeholderInput(): void {
    if (!placeholdersEnabled || !fastScrolling) return;
    placeholderLastInput = performance.now();
    schedulePlaceholderIdle();
  }
  function placeholderTouchStart(): void {
    placeholderTouchActive = true;
    placeholderSlowSince = null;
    placeholderInput();
  }
  function placeholderTouchEnd(event: TouchEvent): void {
    placeholderTouchActive = event.touches.length > 0;
    placeholderInput();
  }
  viewport.addEventListener("wheel", placeholderInput, { passive: true });
  viewport.addEventListener("touchstart", placeholderTouchStart, {
    passive: true,
  });
  viewport.addEventListener("touchend", placeholderTouchEnd, { passive: true });
  viewport.addEventListener("touchcancel", placeholderTouchEnd, {
    passive: true,
  });

  function schedulePlaceholderIdle(): void {
    if (placeholderIdleTimer || !fastScrolling) return;
    placeholderIdleTimer = window.setTimeout(
      () => {
        placeholderIdleTimer = 0;
        if (disposed || !fastScrolling || placeholderTouchActive) return;
        if (
          performance.now() -
            Math.max(placeholderLastMovement, placeholderLastInput) >=
          placeholderIdleMs
        ) {
          placeholderSample = null;
          showScrollPlaceholders(false);
        } else schedulePlaceholderIdle();
      },
      Math.max(
        1,
        placeholderIdleMs -
          (performance.now() -
            Math.max(placeholderLastMovement, placeholderLastInput)),
      ),
    );
  }

  function clearRowPlaceholder(row: Row<T>): void {
    placeholderRows.get(row)?.();
    placeholderRows.delete(row);
  }

  function showRowPlaceholder(row: Row<T>): void {
    if (
      !placeholdersEnabled ||
      !fastScrolling ||
      row.spec ||
      row.slot === row.element ||
      placeholderRows.has(row)
    )
      return;
    const opacity = row.element.style.getPropertyValue("opacity");
    const priority = row.element.style.getPropertyPriority("opacity");
    const inert = row.element.inert;
    row.element.style.setProperty("opacity", "0", "important");
    row.element.inert = true;
    placeholderRows.set(row, () => {
      if (opacity) row.element.style.setProperty("opacity", opacity, priority);
      else row.element.style.removeProperty("opacity");
      row.element.inert = inert;
    });
  }

  function syncSkeletonSurface(): void {
    if (!placeholdersEnabled || place || skeletonEpoch === epoch) return;
    skeletonEpoch = epoch;
    if (!skeletonSurface) {
      skeletonSurface = document.createElement("div");
      skeletonSurface.dataset.scrollSkeletons = "";
      skeletonSurface.setAttribute("aria-hidden", "true");
      skeletonSurface.inert = true;
      skeletonSurface.style.cssText =
        "position:absolute;top:0;left:0;width:100%;pointer-events:none;overflow-anchor:none;visibility:hidden;z-index:1";
      canvas.prepend(skeletonSurface);
    }
    skeletonSurface.style.height = `${geometry.contentSize}px`;
    const keep = new Set<string>();
    for (const key of committedKeys) {
      if (isSlotKey(key)) continue;
      const row = rows.get(key);
      const item = row?.item ?? declaredItems.get(key)?.item;
      if (item === undefined || (anchorable && !anchorable(item))) continue;
      keep.add(key);
      let skeleton = skeletons.get(key);
      if (!skeleton) {
        skeleton = document.createElement("div");
        skeleton.dataset.scrollPlaceholder = key;
        skeleton.style.cssText =
          "position:absolute;left:0;right:0;margin-inline:auto;overflow:hidden";
        skeletonSurface.append(skeleton);
        skeletons.set(key, skeleton);
      }
      if (options.renderScrollPlaceholder && skeletonItems.get(key) !== item) {
        let content: HTMLElement | undefined;
        host(() => {
          content = options.renderScrollPlaceholder?.(
            item,
            (skeleton.firstElementChild as HTMLElement | null) ?? undefined,
          );
        });
        if (disposed) return;
        if (content) {
          if (content !== skeleton.firstElementChild)
            skeleton.replaceChildren(content);
          skeletonItems.set(key, item);
        }
      }
      if (!skeleton.firstElementChild) {
        const content = document.createElement("div");
        const shade =
          "var(--virtual-list-placeholder-color,rgba(127,127,127,.16))";
        const shape = encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160" preserveAspectRatio="none"><rect x="20" y="18" width="96" height="10" rx="5"/><rect x="20" y="52" width="530" height="12" rx="6"/><rect x="20" y="80" width="560" height="12" rx="6"/><rect x="20" y="108" width="360" height="12" rx="6"/></svg>',
        );
        content.style.cssText = `width:100%;height:100%;background:${shade};mask:url("data:image/svg+xml,${shape}") 0 0/100% 160px repeat-y`;
        skeleton.append(content);
      }
      const top = `${geometry.offsetOf(key)}px`;
      const height = `${geometry.heightOf(key)}px`;
      const width = row?.width ? `${row.width}px` : "48rem";
      if (skeleton.style.top !== top) skeleton.style.top = top;
      if (skeleton.style.height !== height) skeleton.style.height = height;
      if (skeleton.style.maxWidth !== width) skeleton.style.maxWidth = width;
    }
    for (const [key, skeleton] of skeletons) {
      if (keep.has(key)) continue;
      skeleton.remove();
      skeletons.delete(key);
      skeletonItems.delete(key);
    }
  }

  function showScrollPlaceholders(active: boolean): void {
    const changed = fastScrolling !== active;
    fastScrolling = active;
    viewport.toggleAttribute("data-scroll-placeholders-active", active);
    if (skeletonSurface) {
      skeletonSurface.style.visibility = active ? "visible" : "hidden";
      skeletonSurface.toggleAttribute("data-active", active);
    }
    placeholderSlowSince = null;
    if (active) schedulePlaceholderIdle();
    else {
      clearTimeout(placeholderIdleTimer);
      placeholderIdleTimer = 0;
    }
    if (!active || !placeholdersEnabled) {
      for (const row of placeholderRows.keys()) clearRowPlaceholder(row);
    } else {
      for (const row of mountedRows) showRowPlaceholder(row);
    }
    if (changed)
      viewport.dispatchEvent(new Event("virtual-list:scroll-placeholders"));
  }

  function setScrollPlaceholders(enabled: boolean): void {
    if (disposed) return;
    if (defer(() => setScrollPlaceholders(enabled))) return;
    pass(() => {
      placeholdersEnabled = enabled;
      if (enabled) syncSkeletonSurface();
      else {
        skeletonSurface?.remove();
        skeletonSurface = null;
        skeletons.clear();
        skeletonItems.clear();
        skeletonEpoch = -1;
      }
      placeholderSample = null;
      showScrollPlaceholders(enabled && fastScrolling);
    });
  }

  let committedKeys: readonly string[] = [];
  let committedPinOffset = 0;
  let positionedNow = false;
  /** Advances on every commit; reconciliation and publication key on it. */
  let epoch = 0;
  /** One committed offscreen row kept laid out between its updates. */
  let resident: Row<T> | null = null;

  // --- Desired state --------------------------------------------------------
  let pending: Pending<T> | null = null;
  /** The pending state mid-commit: dispose must reach its rows too. */
  let committing: Pending<T> | null = null;
  let lastItems: T[] = [...options.items];
  let indexByKey = new Map<string, number>();
  let indexedKeys: readonly string[] = [];
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
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  if (!native) canvas.style.overflowAnchor = "none";
  canvas.dataset.anchoring = native ? "native" : "runtime";
  // One stable compositing surface while rows enter and leave (Safari).
  canvas.style.transform = "translateZ(0)";
  if (globalThis.CSS?.supports?.("-webkit-nbsp-mode", "space"))
    canvas.style.transformStyle = "preserve-3d";
  const spacer = (): HTMLElement => {
    const element = document.createElement("div");
    element.style.cssText = "overflow-anchor:none;height:0px";
    canvas.appendChild(element);
    return element;
  };
  /** Native flow: the unmounted rows above and below the window. */
  const topSpacer = native ? spacer() : null;
  const bottomSpacer = native ? spacer() : null;
  viewport.appendChild(canvas);
  // `overflow: clip` where supported: a clip that is no scroll container.
  const clipProbe = document.createElement("div").style;
  clipProbe.overflow = "clip";
  const clip = clipProbe.overflow === "clip" ? "clip" : "hidden";
  let viewportWidth = viewport.clientWidth;
  let viewportHeight = viewport.clientHeight;
  /** Where the viewport stood before a resize the engine may have clamped. */
  let lastObservedTop = viewport.scrollTop;
  /** A resize during a phase commits at the settle with this stance (I5). */
  let resizeHeld: "pin" | "viewport" | null = null;

  function viewportState(): GeometryViewport {
    return { scrollTop: viewport.scrollTop, height: viewport.clientHeight };
  }

  /**
   * `floor`: also refresh the pin's viewport-relative floor. A native commit
   * mid-gesture must not: any size change on an ancestor of the engine's
   * anchor node suppresses anchoring for that layout.
   */
  function syncCanvasHeight(totalSize: number, floor: boolean): void {
    syncSkeletonSurface();
    // A native canvas takes its height from its flow, for the same reason.
    if (!native) canvas.style.height = `${totalSize}px`;
    if (!floor) return;
    // The pin's shortfall grows in the same layout as its viewport.
    const pinTop = geometry.pinTop;
    canvas.style.minHeight =
      pinTop === null || pinTop === 0
        ? ""
        : `calc(100% + ${Math.ceil(pinTop)}px)`;
  }

  function recordScrollAdjustment(top: number): void {
    controller.recordProgrammaticScrollTop(top);
    // Anchor compensation moves the coordinate system, not the content on
    // screen. Do not classify a prepend correction as fast user motion.
    if (placeholdersEnabled)
      placeholderSample = { top, time: performance.now() };
  }

  function writeScrollTop(top: number): void {
    recordScrollAdjustment(top);
    viewport.scrollTop = top;
  }

  // --- The pass (I4) --------------------------------------------------------
  let disposed = false;
  let booting = true;
  /** The open pass's queue; null outside a pass. */
  let scope: Task[] | null = null;
  const openScopes: Task[][] = [];
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
    const own: Task[] = [];
    scope = own;
    openScopes.push(own);
    try {
      try {
        work();
      } catch (error) {
        discard(own);
        const collected = failures.splice(mark);
        if (collected.length === 0) throw error;
        throw new AggregateError([error, ...collected], "update failed");
      }
      const collected = failures.splice(mark);
      // Nested, its queued work drains once the enclosing pass has finished.
      if (outer !== null) outer.push(...own);
      else {
        scope = null;
        while (!disposed && own.length > 0) {
          const task = own.shift() as Task;
          try {
            task.run();
          } catch (error) {
            collected.push(...flatten(error));
          }
        }
      }
      throwAll(collected, "committed with failures in host callbacks");
    } finally {
      openScopes.pop();
      scope = outer;
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

  function createRow(
    key: string,
    item: T,
    element: HTMLElement,
    height: number,
    spec?: EdgeSlot,
  ): Row<T> {
    const style = element.style;
    let slot = element;
    if (place) {
      // Positioned cards are their own slot; the host owns width and left.
      style.position = "absolute";
      style.top = "0";
      if (spec) {
        style.left = "0";
        style.right = "0";
      }
      const hint = style.willChange.trim();
      if (!hint.split(",").some((value) => value.trim() === "transform")) {
        const automatic =
          !hint || /^(auto|initial|inherit|unset|revert(-layer)?)$/.test(hint);
        style.setProperty(
          "will-change",
          automatic ? "transform" : `${hint}, transform`,
          style.getPropertyPriority("will-change"),
        );
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
      slot = document.createElement("div");
      slot.appendChild(element);
    }
    const row: Row<T> = {
      key,
      item,
      shown: item,
      broken: false,
      element,
      slot,
      height: quantize(height),
      width: 0,
      followStart: 0,
      offset: Number.NaN,
      place: "detached",
      dirty: false,
      dead: false,
      spec,
    };
    if (slot === element) style.height = `${row.height}px`;
    rowOf.set(element, row);
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
    const limit = Math.min(order.length, index + 1 + INSERTION_SCAN);
    for (let at = index + 1; at < limit; at++) {
      const row = rowIn(order, at, staged);
      if (row && joined(row)) return row;
    }
    return undefined;
  }

  const connected = (row: Row<T>): boolean => row.place !== "detached";
  const mounted = (row: Row<T>): boolean => row.place === "mounted";
  const committedPoint = (key: string): Node | null =>
    insertionPoint(committedKeys, geometry.indexOf(key));

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
      row.slot.style.cssText = `position:relative;overflow:${clip};height:0px;visibility:hidden;overflow-anchor:none`;
      row.element.style.translate = PARKED_TRANSLATE;
    } else
      row.slot.style.cssText = `${SLOT_BASE}overflow:${clip};max-height:0;visibility:hidden;top:${PARKED_TOP};overflow-anchor:none`;
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
  function placeRow(row: Row<T>): void {
    if (native) return; // The flow places it.
    const offset = geometry.offsetOf(row.key);
    if (offset < 0 || row.offset === offset) return;
    row.offset = offset;
    if (row.slot === row.element) row.slot.style.translate = `0 ${offset}px`;
    else row.slot.style.transform = `translateY(${offset}px)`;
  }

  function mountRow(row: Row<T>): void {
    const hidden = row.place === "hidden";
    if (row.slot !== row.element) {
      row.slot.style.cssText = native
        ? `position:relative;overflow:${clip};height:${row.height}px${anchors(row) ? "" : ";overflow-anchor:none"}`
        : `${SLOT_BASE}overflow:${clip};will-change:transform;height:${row.height}px`;
      row.offset = Number.NaN;
    }
    if (hidden) unhide(row);
    // Placed before it connects: a mount hook never sees a provisional zero.
    placeRow(row);
    if (native) flowInsert(row);
    else if (!hidden) canvas.insertBefore(row.slot, committedPoint(row.key));
    row.place = "mounted";
    mountedRows.add(row);
    showRowPlaceholder(row);
    observeRow(row);
    if (!row.spec) hook(() => options.onMount?.(row.element, row.item));
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
  function flowInsert(row: Row<T>): void {
    const index = geometry.indexOf(row.key);
    const previous = rowIn(committedKeys, index - 1);
    const after =
      previous && mounted(previous) ? previous.slot : (topSpacer as Node);
    const before =
      successor(committedKeys, index, mounted)?.slot ?? (bottomSpacer as Node);
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
      const lastKey = geometry.keyAt(last) as string;
      top = geometry.offsetOf(geometry.keyAt(first) as string);
      bottom =
        geometry.totalSize -
        geometry.offsetOf(lastKey) -
        geometry.heightOf(lastKey);
    }
    const topHeight = `${top}px`;
    const bottomHeight = `${Math.max(0, bottom)}px`;
    if (topSpacer.style.height !== topHeight)
      topSpacer.style.height = topHeight;
    if (bottomSpacer.style.height !== bottomHeight)
      bottomSpacer.style.height = bottomHeight;
  }

  /** The first and last list index of the mounted rows (last -1: none). */
  function mountedSpan(): [number, number] {
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    for (const row of mountedRows) {
      const index = geometry.indexOf(row.key);
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
  function hook(callback: () => void): void {
    if (hookQueue) hookQueue.push(callback);
    else host(callback);
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
    clearRowPlaceholder(row);
    row.place = "detached";
    mountedRows.delete(row);
    rowObserver.unobserve(row.element);
    if (!row.spec) hook(() => options.onUnmount?.(row.element, row.item));
    row.slot.remove();
    row.offset = Number.NaN;
  }

  /** Exactly once, from any path. */
  function destroyRow(row: Row<T>): void {
    if (row.dead) return;
    row.dead = true;
    if (row.place === "mounted") unmountRow(row);
    detachRow(row);
    dirtyRows.delete(row);
    row.slot.remove();
    row.element.remove();
    if (!row.spec) hook(() => options.onDestroy?.(row.element, row.item));
  }

  function markDirty(row: Row<T>): void {
    if (row.spec) return;
    row.dirty = true;
    if (rows.get(row.key) === row) dirtyRows.add(row);
  }

  /** Render into the row; a replacement element leaves `shown` as it was. */
  function renderInto(row: Row<T>, item: T): HTMLElement {
    const shown = row.shown;
    row.shown = item;
    try {
      const element = render(item, row.element);
      row.broken = false;
      if (element !== row.element) row.shown = shown;
      return element;
    } catch (error) {
      row.broken = true;
      throw error;
    }
  }

  function commitHeight(row: Row<T>, measured: number): void {
    const height = quantize(measured);
    row.dirty = false;
    dirtyRows.delete(row);
    row.height = height;
    if (row.place === "mounted" || row.slot === row.element)
      row.slot.style.height = `${height}px`;
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
        row.width = rect.width;
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

  function measureRows(toMeasure: Iterable<Row<T>>): void {
    const list = [...toMeasure];
    const heights = readHeights(list);
    list.forEach((row, index) => {
      commitHeight(row, heights[index] as number);
    });
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
    const width = viewport.clientWidth;
    const widthChanged = Math.abs(width - viewportWidth) > EPSILON_PX;
    viewportWidth = width;
    const height = viewport.clientHeight;
    const heightChanged = Math.abs(height - viewportHeight) > EPSILON_PX;
    if (!widthChanged && !heightChanged) return;
    pass(() => {
      // The layout a gesture was scrolling no longer exists: a width change
      // ends the phase, and held work commits at the new width.
      if (widthChanged) {
        if (!declared) for (const row of rows.values()) markDirty(row);
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
        commit(null, {
          policy: stoodOnPin ? "pin" : "viewport",
          keepFollow: true,
          instant: true,
        });
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

  // A hidden document follows by write; the return cancels a leftover glide.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") glide?.cancel();
    if (document.visibilityState !== "visible") return;
    follow.resume();
    glide?.cancel();
    if (follow.armed && !disposed) followIfBehindEnd();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // --- Staging: the desired state -------------------------------------------
  function indexItems(items: readonly T[], withHeights: boolean) {
    const keys: string[] = [];
    const byKey = new Map<string, T>();
    const heights =
      withHeights && declared ? new Map<string, Declared<T>>() : null;
    for (const item of items) {
      const key = keyOf(item);
      if (isSlotKey(key))
        throw new Error(`item key "${key}" uses the reserved edge-slot prefix`);
      if (byKey.has(key)) throw new Error(`duplicate key "${key}"`);
      keys.push(key);
      byKey.set(key, item);
      heights?.set(key, { item, height: declaredHeight(item) });
    }
    return { keys, byKey, heights };
  }

  /** Omitted anchors inherit the held intent; explicit ones replace it. */
  function newPending(
    keys: readonly string[],
    requested: AnchorRequest | undefined,
    previous: Pending<T> | null,
  ): Pending<T> {
    const named = typeof requested === "object" ? requested : null;
    return {
      keys,
      staged: new Map(),
      deferred: new Map(),
      declared: null,
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
  function selectPin(p: Pending<T>, itemAt: (key: string) => T | undefined) {
    if (!pinPolicy) return;
    const offset = pinPolicy.offset ?? 0;
    p.pinOffset = Number.isFinite(offset) ? offset : 0;
    p.pinKey = null;
    for (let index = p.keys.length - 1; index >= 0; index--) {
      const key = p.keys[index] as string;
      if (isSlotKey(key)) continue;
      const item = itemAt(key);
      if (item !== undefined && pinPolicy.match(item)) {
        p.pinKey = key;
        return;
      }
    }
  }

  function preparePositioned(
    entries: ReadonlyMap<string, Declared<T>> | null,
  ): PositionedGeometry | null {
    if (!place || !entries?.size) return null;
    const placed: PositionedItem[] = [];
    let origin = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      const position = place(entry.item);
      if (position === null) continue;
      if (!Number.isFinite(position.top))
        throw new RangeError("item top must be finite");
      // Snap in the shared coordinate system, before rebasing (I0).
      const top = toDevicePixel(position.top);
      origin = Math.min(origin, top);
      placed.push({ top, lane: position.lane, height: entry.height });
    }
    if (placed.length === 0) return null;
    if (placed.length !== entries.size)
      throw new Error("a positioned snapshot must place every item or none");
    origin = positionedOrigin(origin);
    const start = edgeSlots.start;
    const end = edgeSlots.end;
    const leading = start ? quantize(start.height) : 0;
    let bottom = leading;
    for (const item of placed) {
      item.top += leading - origin;
      bottom = Math.max(bottom, item.top + item.height);
    }
    if (start) placed.unshift({ top: 0, height: leading, lane: 0 });
    if (end)
      placed.push({ top: bottom, height: quantize(end.height), lane: 0 });
    return new PositionedGeometry(placed);
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
    itemAt: (key: string) => T,
    previous: Pending<T> | null,
    full: boolean,
    jobRows?: Map<string, Row<T>>,
  ): boolean {
    const built: Row<T>[] = [];
    const fresh: Row<T>[] = [];
    const touched: Row<T>[] = [];
    const inPlace: [Row<T>, T][] = [];
    const adopted = new Set<string>();
    /** `nativeFree()`, read once: it reads layout, and renders write it. */
    let freeOnce: boolean | undefined;
    const free = (): boolean => {
      if (freeOnce === undefined) freeOnce = nativeFree();
      return freeOnce;
    };
    /** The staged key's index in the desired order. */
    let at = -1;

    const create = (key: string, item: T, element: HTMLElement): Row<T> => {
      if (disposed) {
        host(() => options.onDestroy?.(element, item));
        throw new Abort();
      }
      const height = declared
        ? (p.declared?.get(key)?.height ?? declaredHeight(item))
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
        inPlace.push([row, item]);
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
        adopted.add(key);
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
        at = full
          ? at + 1
          : p.keys === committedKeys
            ? geometry.indexOf(key)
            : p.keys.indexOf(key);
        if (isSlotKey(key)) {
          stageSlot(key);
        } else {
          const item = itemAt(key);
          const before = previous?.staged.get(key);
          const committed = rows.get(key);
          if (before) {
            adopted.add(key);
            if (before.shown === item && !before.broken) {
              p.staged.set(key, before);
            } else {
              const replacement = rerender(before, item);
              if (replacement) adopted.delete(key);
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
                (p.declared?.get(key)?.height !== committed.height && !free()))
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
      fresh.forEach((row, index) => {
        row.height = quantize(heights[index] as number);
      });
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
          } else {
            row.broken = true;
            host(() => options.onDestroy?.(restored, row.item));
          }
        } catch {
          row.broken = true;
        }
        markDirty(row);
      }
      if (error instanceof Abort) return false;
      throw error;
    }
    for (const [row, item] of inPlace) {
      row.item = item;
      // A declared height lands with the snapshot; a measured one is re-read.
      if (!declared) markDirty(row);
    }
    if (previous) {
      const keys = full ? [...previous.staged.keys()] : stageKeys;
      for (const key of keys) {
        const row = previous.staged.get(key);
        if (row && !adopted.has(key)) destroyRow(row);
      }
    }
    return !disposed;
  }

  function stageSnapshot(
    items: readonly T[],
    requested: AnchorRequest | undefined,
    jobRows?: Map<string, Row<T>>,
  ): Pending<T> | null {
    const previous = pending;
    const { keys: itemKeys, byKey, heights } = indexItems(items, true);
    const start = edgeSlots.start;
    const end = edgeSlots.end;
    const keys = [
      ...(start ? [slotKey("start", start.key)] : []),
      ...itemKeys,
      ...(end ? [slotKey("end", end.key)] : []),
    ];
    const p = newPending(keys, requested, previous);
    p.declared = heights;
    p.positioned = preparePositioned(heights);
    selectPin(p, (key) => byKey.get(key));
    const ok = prepare(
      p,
      keys,
      (key) => byKey.get(key) as T,
      previous,
      true,
      jobRows,
    );
    return ok ? p : null;
  }

  function sameKeys(keys: readonly string[]): boolean {
    if (keys === committedKeys) return true;
    if (keys.length !== geometry.count) return false;
    for (let index = 0; index < keys.length; index++) {
      if (geometry.keyAt(index) !== keys[index]) return false;
    }
    return true;
  }

  /**
   * Whether landing `p` (with every dirty measurement) changes nothing above
   * the viewport's anchor row: then it needs no scroll write (I1 by
   * construction) and may land mid-phase.
   */
  function confined(p: Pending<T>): boolean {
    if (positionedNow || p.positioned) return false;
    const anchor = geometry.anchorAt(viewportState());
    if (anchor === null) return true;
    const anchorIndex = geometry.indexOf(anchor.key);
    for (const row of dirtyRows) {
      if (geometry.indexOf(row.key) < anchorIndex) return false;
    }
    if (p.keys === committedKeys) {
      for (const key of p.staged.keys()) {
        if (geometry.indexOf(key) < anchorIndex) return false;
      }
      for (const [key, entry] of p.declared ?? []) {
        const index = geometry.indexOf(key);
        if (index < anchorIndex && geometry.heightOf(key) !== entry.height)
          return false;
      }
      return true;
    }
    for (let index = 0; index < anchorIndex; index++) {
      const key = geometry.keyAt(index);
      if (key === undefined || p.keys[index] !== key || p.staged.has(key))
        return false;
      if (p.declared?.get(key)?.height !== declaredItems.get(key)?.height)
        return false;
    }
    // The anchor row may change in place, be replaced at its index, or be
    // removed — unless its surviving successor moves down (a prepend).
    if (p.keys[anchorIndex] !== anchor.key) {
      const nextIndex = new Map(p.keys.map((key, index) => [key, index]));
      if (nextIndex.has(anchor.key)) return false;
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
      sameKeys(p.keys);
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
      const height = p.declared?.get(key)?.height ?? declaredHeight(item);
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
    );
    // Adopt the staged rows; a key removed or replaced dies after it left
    // the map, so a host disposing from onDestroy cannot destroy it twice.
    const keysChanged = p !== null && !sameKeys(p.keys);
    const doomed: Row<T>[] = [];
    if (p) {
      if (p.deferred.size > 0) renderDeferred(p);
      if (keysChanged) {
        const next = new Set(p.keys);
        for (const [key, row] of rows) {
          if (next.has(key)) continue;
          rows.delete(key);
          doomed.push(row);
        }
      }
      for (const [key, row] of p.staged) {
        const old = rows.get(key);
        rows.set(key, row);
        if (old && old !== row) doomed.push(old);
      }
      if (p.staged.size > 0) sweep = true;
    }
    // Every height this commit lands is read before its first DOM write.
    // Rows that waited for a settle are read again (an image decoded).
    const gone = new Set(doomed);
    const toMeasure = new Set<Row<T>>();
    for (const row of p?.staged.values() ?? [])
      if (row.dirty) toMeasure.add(row);
    for (const row of dirtyRows) if (!gone.has(row)) toMeasure.add(row);
    const measured = [...toMeasure];
    const heights = readHeights(measured);
    let glideFollow = false;
    // Native flow: host hooks wait until the window is whole again (F5).
    holdHooks(() => {
      for (const row of doomed) destroyRow(row);
      if (disposed) return;
      if (p) {
        if (keysChanged) {
          geometry.setKeys(p.keys, p.target);
          committedKeys = p.keys;
        }
        if (pinPolicy) {
          committedPinOffset = p.pinOffset ?? 0;
          geometry.pin(p.pinKey ?? null, committedPinOffset);
        }
        if (p.declared) {
          for (const [key, entry] of p.declared) {
            const row = rows.get(key);
            if (row && row.item === entry.item) commitHeight(row, entry.height);
            else if (declaredItems.get(key)?.height !== entry.height)
              geometry.measure(key, entry.height);
          }
          declaredItems = p.declared;
        }
        for (const row of p.staged.values()) {
          if (!toMeasure.has(row)) commitHeight(row, row.height);
        }
        if (place) {
          geometry.setPositioned(p.positioned);
          positionedNow = p.positioned !== null;
        }
      }
      measured.forEach((row, index) => {
        commitHeight(row, heights[index] as number);
      });
      epoch += 1;

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
          : toDevicePixel(resolvedTop);
      const moves = Math.abs(target - before.scrollTop) > EPSILON_PX;
      glideFollow =
        !o.instant &&
        !booting &&
        !follow.catchingUp &&
        smoothFollow &&
        result.mode === "end" &&
        takingOver === null &&
        moves;
      // Native flow: the rows on screen stay mounted in the new geometry, so
      // the engine can measure how far its anchor node moved and follow it.
      // Restore the flow before follow policy reads the viewport height: an
      // interim layout with the old tail removed can clamp the scroll offset
      // and its later scroll event would cancel follow as apparent input.
      if (native) holdWindow(keysChanged || (p?.staged.size ?? 0) > 0);
      else repositionMounted();
      if (smoothFollow && !o.keepFollow && takingOver === null)
        follow.resolveCommit(policy, target);
      if (!glideFollow && moves) {
        if (o.write !== false) writeScrollTop(target);
        // Mid-phase, the engine moves the viewport: expect it, so the settle
        // sensor never reads the adjustment as user input.
        else if (native) recordScrollAdjustment(target);
      }
    });
    if (disposed) return;
    reconcileAndPublish();
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
          const anchor = geometry.anchorAt(vp);
          const anchorIndex =
            anchor === null ? 0 : geometry.indexOf(anchor.key);
          const everything = nativeFree();
          const ready: Row<T>[] = [];
          for (const row of dirtyRows) {
            if (everything || geometry.indexOf(row.key) >= anchorIndex)
              ready.push(row);
          }
          if (ready.length === 0) break;
          const capture = geometry.capture(vp, native ? "viewport" : "none");
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

  let lastReconcile = { top: Number.NaN, height: Number.NaN, epoch: -1 };
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
    const unchanged = !heldRetirements && lastReconcile.epoch === epoch;
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
      lastReconcile = { top: vp.scrollTop, height: vp.height, epoch };
      return range;
    }
    const delta =
      unchanged && range.delta?.from === previous.indices
        ? range.delta
        : undefined;
    const kept = unchanged && stacked ? previous : undefined;
    lastRange = range;
    heldRetirements = false;
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
    const key = geometry.keyAt(index);
    if (key === undefined) return null;
    const existing = rows.get(key);
    if (existing) return existing;
    const entry = declaredItems.get(key);
    if (!entry) return null;
    let element: HTMLElement;
    try {
      element = render(entry.item);
    } catch (error) {
      // Geometry stands; this row retries at the next reconciliation.
      failures.push(error);
      return null;
    }
    if (disposed) {
      host(() => options.onDestroy?.(element, entry.item));
      return null;
    }
    const row = createRow(key, entry.item, element, entry.height);
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
      if (holdLanding && geometry.indexOf(row.key) >= 0) {
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
    } else {
      const visible = range.indices ? new Set(range.indices) : null;
      const leaving: [number, Row<T>][] = [];
      for (const row of mountedRows) {
        const index = geometry.indexOf(row.key);
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
    for (let n = 0; n < length; n++) {
      let index = entering?.[n] ?? range.start + n;
      // An unchanged stack already owns the overlap: skip it.
      if (kept && index >= kept.start && index < kept.end) {
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
      if (row.place !== "mounted") mountRow(row);
    }
    if (sweep) sweepHidden();
    lastReconcile = complete
      ? { top: vp.scrollTop, height: vp.height, epoch }
      : { ...lastReconcile, epoch: -1 };
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
    const held = pending !== null || dirtyRows.size > 0 || windowJobs.size > 0;
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
      host(() => options.onState?.(next, vp));
      if (disposed) return;
    }
    if (
      lastPublishedViewport.scrollTop !== vp.scrollTop ||
      lastPublishedViewport.height !== vp.height
    ) {
      lastPublishedViewport = vp;
      host(() => options.onViewport?.(vp));
      if (disposed) return;
    }
    host(() => reach.update(vp.scrollTop, maxTop));
  }

  function reconcileAndPublish(): void {
    const vp = viewportState();
    publish(vp, reconcileWindow(vp));
  }

  function onScrolled(): void {
    const vp = viewportState();
    if (placeholdersEnabled) {
      const now = performance.now();
      const previous = placeholderSample;
      const atBoundary =
        vp.scrollTop <= AT_EDGE_PX ||
        geometry.maxScrollTop(vp.height) - vp.scrollTop <= AT_EDGE_PX;
      if (atBoundary) {
        // Momentum input can continue after the viewport hits its boundary.
        // There is no motion left to conceal, even while a touch is held.
        placeholderSample = { top: vp.scrollTop, time: now };
        if (fastScrolling) showScrollPlaceholders(false);
      } else if (!previous || vp.scrollTop !== previous.top) {
        placeholderLastMovement = now;
        if (!previous) placeholderSample = { top: vp.scrollTop, time: now };
        else if (now - previous.time >= 8) {
          // Coalesce closely spaced events instead of treating a tiny delta
          // during touchpad handoff as a sudden drop to reading speed.
          const elapsed = now - previous.time;
          const velocity = Math.abs(vp.scrollTop - previous.top) / elapsed;
          placeholderSample = { top: vp.scrollTop, time: now };
          if (!fastScrolling) {
            if (!followGlide && elapsed < 200 && velocity >= 12)
              showScrollPlaceholders(true);
          } else if (elapsed < 200 && velocity >= 6) {
            placeholderSlowSince = null;
          } else {
            placeholderSlowSince ??= now;
            if (now - placeholderSlowSince >= placeholderSlowMs)
              showScrollPlaceholders(false);
          }
        }
      }
    }
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
    if (!liveCommit()) publish(vp, range);
  }

  /** An old pin's offscreen tail drains only after the scroll has landed. */
  function trimUnusedReserve(): void {
    if (disposed || geometry.reserve === 0) return;
    const vp = viewportState();
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
   * WebKit touch phases also wait through momentum: CSS anchoring support
   * does not guarantee that a prepend adjusts the native scroller. The
   * settle commit preserves the reading position with an explicit write.
   */
  const nativeFree = (): boolean =>
    native &&
    glide === null &&
    !(settleStrategy === "safari-wheel" && controller.isTouchScrollPhase()) &&
    !controller.isNearScrollEdge();

  const follow = new FollowController(
    {
      maxScrollTop: () => geometry.maxScrollTop(viewport.clientHeight),
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
    onGestureStarted: () => {
      placeholderSample ??= { top: lastObservedTop, time: performance.now() };
    },
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
    // Gesture boundaries are not velocity boundaries: a fresh touchpad
    // contact can start while the preceding momentum is still fast.
    onGestureReset: () => {},
    onScrollEventObserved: () => {
      if (disposed || scope !== null) return;
      pass(onScrolled);
    },
  });

  /** The phase reached idle: everything held lands, once. */
  function settleGesture(): void {
    const explicit = remeasurePolicy;
    if (remeasureRequests.size === 0) remeasurePolicy = undefined;
    if (pending !== null || dirtyRows.size > 0) {
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
      commit(null, { policy: resizeHeld, keepFollow: true, instant: true });
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
    follow.stop();
    settleParked(false);
    const wasGliding = glide !== null;
    glide?.cancel();
    // Cancelling an owned glide already stops it. Rebuilding the scrolling
    // layer here can strand the next native Safari animation.
    interruptNativeScroll("command", !wasGliding);
  }

  // --- Data -----------------------------------------------------------------
  function adoptItems(snapshot: T[], keys: readonly string[]): void {
    if (
      keys.length !== indexedKeys.length ||
      keys.some((key, index) => key !== indexedKeys[index])
    ) {
      const previous = indexByKey;
      indexByKey = new Map();
      let index = 0;
      for (const key of keys) if (!isSlotKey(key)) indexByKey.set(key, index++);
      indexedKeys = keys;
      // An edge slot coming or going leaves the host's order as it was.
      if (
        indexByKey.size !== previous.size ||
        [...indexByKey].some(([key, at]) => previous.get(key) !== at)
      )
        structure += 1;
    }
    lastItems = snapshot;
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
        p = stageSnapshot(snapshot, anchor, jobRows);
      } catch (error) {
        if (previousSlots) Object.assign(edgeSlots, previousSlots);
        throw error;
      }
      if (!p || disposed) return;
      adoptItems(snapshot, p.keys);
      apply(p);
    });
  }

  function setItems(
    items: readonly T[],
    o: { anchor?: AnchorRequest; interrupt?: boolean } = {},
  ): void {
    if (disposed) return;
    const snapshot = [...items];
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
    const index = indexByKey.get(key);
    if (index === undefined) return;
    if (keyOf(item) !== key)
      throw new Error("updateItem cannot change an item's key");
    if (place) {
      // A positioned layout re-places every item.
      const next = [...lastItems];
      next[index] = item;
      applyItems(next, anchor, false);
      return;
    }
    pass(() => {
      // Only this key is prepared; a held snapshot is patched in place.
      const previous = pending;
      const p = newPending(previous?.keys ?? committedKeys, anchor, previous);
      if (declared) {
        p.declared = new Map(previous?.declared ?? declaredItems);
        p.declared.set(key, { item, height: declaredHeight(item) });
      }
      selectPin(p, (other) =>
        other === key ? item : lastItems[indexByKey.get(other) ?? -1],
      );
      if (!prepare(p, [key], () => item, previous, false)) return;
      lastItems[index] = item;
      revision += 1;
      if (previous) {
        previous.staged.delete(key);
        previous.deferred.delete(key);
        const row = p.staged.get(key);
        if (row) previous.staged.set(key, row);
        const deferred = p.deferred.get(key);
        if (deferred !== undefined) previous.deferred.set(key, deferred);
        apply(
          {
            ...previous,
            declared: p.declared,
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
      const item = declaredItems.get(key)?.item ?? rows.get(key)?.item;
      if (item !== undefined) protectedItems.push(item);
    }
    return { items: [...lastItems], protectedItems };
  }

  /**
   * Evaluate `update` at idle against the protected window and land its
   * snapshot in one commit. Large additions render in idle slices (during a
   * phase too) and frames, hidden in the canvas; the commit waits for idle.
   */
  function updateWindow(
    update: (context: WindowUpdateContext<T>) => WindowUpdate<T> | null,
    signal?: AbortSignal,
    o: { interrupt?: boolean | "commit"; protectPin?: boolean } = {},
  ): Promise<boolean> {
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
        index: Map<string, number>;
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
          while (j.cursor < j.fresh.length && count < JOB_MIN_ROWS) {
            if (deadline && deadline.timeRemaining() < IDLE_SLICE_MIN_MS) break;
            if (j.partial) {
              const partial = j.partial;
              last = partial.row;
              if (partial.steps.next().done) {
                j.partial = null;
                j.cursor += 1;
              }
              // The browser lays out this chunk before the next one arrives.
              break;
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
            if (!steps) j.cursor += 1;
            count += 1;
            last = row;
            if (steps || (!deadline && performance.now() - started >= 3)) break;
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
        if (j.ready && !finished && nativeFree()) run();
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
            // Items replaced in place since staging (a streamed token): ask
            // the updater again. Its rows stay adoptable by item identity.
            const stale = j !== null && !sourceCurrent(j);
            const next = j && !stale ? j.next : update(context);
            if (!next) {
              if (j) cancel();
              return;
            }
            if (ended()) return;
            const snapshot = j && !stale ? j.snapshot : [...next.items];
            if (
              stale &&
              (snapshot.length !== j.order.length ||
                snapshot.some((item, index) => keyOf(item) !== j.order[index]))
            ) {
              cancel();
              return;
            }
            if (!protectPin) {
              // Opt-in trimming releases only the pin's extra protection.
              const keys = j?.index ?? new Set(snapshot.map(keyOf));
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
              const { keys, byKey } = indexItems(snapshot, false);
              const fresh = [...byKey].filter(([key]) => !rows.has(key));
              if (ended()) return;
              if (
                fresh.length > JOB_MIN_ROWS ||
                (options.stage && fresh.length > 0)
              ) {
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
                  index: new Map(keys.map((key, index) => [key, index])),
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
  function targetTop(
    target: ScrollTarget,
    below = 0,
    pinnedEnd = false,
  ): number | null {
    // Without pinning, commands target content, not retained reserve.
    const maxTop = pinning
      ? geometry.maxScrollTop(viewport.clientHeight)
      : Math.max(0, geometry.contentSize - viewport.clientHeight);
    if (target === "start") return 0;
    if (target === "end") {
      // A retargeted pin's old reserve drains after landing, never before.
      return Math.ceil(
        pinnedEnd
          ? Math.max(
              0,
              geometry.contentSize - viewport.clientHeight,
              geometry.pinTop ?? 0,
            )
          : maxTop,
      );
    }
    const offset = geometry.offsetOf(target);
    // Land past a fractional boundary: engines can floor the write.
    return offset < 0
      ? null
      : Math.ceil(Math.max(0, Math.min(offset - below, maxTop)));
  }

  function landedOn(target: ScrollTarget, below = 0, pinnedEnd = false) {
    const top = targetTop(target, below, pinnedEnd);
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
    const pinnedEnd = pin !== undefined;
    const destination = (): number =>
      targetTop(target, below, pinnedEnd) ?? viewport.scrollTop;
    if (o.behavior !== "smooth") {
      const top = Math.round(destination());
      if (Math.abs(top - viewport.scrollTop) > EPSILON_PX) writeScrollTop(top);
      // An instant command to the end has no settle to arm following at.
      if (target === "end" && smoothFollow) follow.start();
      reconcileAndPublish();
      trimUnusedReserve();
      done(!disposed && landedOn(target, below, pinnedEnd));
      return;
    }
    // A glide is a phase of its own: held work waits for its landing.
    controller.beginProgrammaticGesture();
    const complete = (completed: boolean): void =>
      pass(() => {
        glide = null;
        glideToPin = false;
        if (completed) showScrollPlaceholders(false);
        if (!completed || disposed) {
          done(false);
          if (!disposed) controller.markSettlePending();
          return;
        }
        parked = {
          done,
          landed: () => landedOn(target, below, pinnedEnd),
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
    applyItems([...lastItems], undefined, false, {
      ...edgeSlots,
      [edge]: owned,
    });
  }

  // --- Lifecycle ------------------------------------------------------------
  let cancelRepaint: (() => void) | undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    showScrollPlaceholders(false);
    const mark = failures.length;
    cancelRepaint?.();
    for (const cancel of [...cancelJobs]) cancel();
    for (const tasks of openScopes) discard(tasks);
    // A failed native stop must not strand observers, rows, or queued work.
    host(() => glide?.cancel());
    settleParked(false);
    reach.dispose();
    controller.dispose();
    viewport.removeEventListener("wheel", placeholderInput);
    viewport.removeEventListener("touchstart", placeholderTouchStart);
    viewport.removeEventListener("touchend", placeholderTouchEnd);
    viewport.removeEventListener("touchcancel", placeholderTouchEnd);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (observeFrame !== 0) cancelAnimationFrame(observeFrame);
    if (remeasureFrame !== 0) cancelAnimationFrame(remeasureFrame);
    remeasureRequests.clear();
    rowObserver.disconnect();
    viewportObserver.disconnect();
    skeletons.clear();
    skeletonItems.clear();
    skeletonSurface = null;
    canvas.remove();
    if (viewportAnchor !== null) viewport.style.overflowAnchor = viewportAnchor;
    if (!booting) disposedViewports.add(viewport);
    const doomed = [
      ...rows.values(),
      ...(pending?.staged.values() ?? []),
      ...(committing?.staged.values() ?? []),
    ];
    rows.clear();
    declaredItems.clear();
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
      );
      if (!p) return;
      adoptItems(lastItems, p.keys);
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
    setScrollPlaceholders,
    positionOf(key) {
      if (geometry.indexOf(key) < 0) return null;
      return { top: geometry.offsetOf(key), height: geometry.heightOf(key) };
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
