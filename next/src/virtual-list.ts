import { FollowController } from "../../src/follow";
import {
  type AnchorPolicy,
  type CapturePolicy,
  type ExplicitAnchor,
  Geometry,
  type GeometryViewport,
} from "../../src/geometry";
import {
  type Glide,
  type GlideHost,
  glidePace,
  startGlide,
} from "../../src/glide";
import {
  type GeometryWindow,
  PositionedGeometry,
  type PositionedItem,
} from "../../src/positioned-geometry";
import { type Edge, ReachController } from "../../src/reach";
import {
  createScrollSettleController,
  detectScrollSettleStrategy,
} from "../../src/scroll-settle";
import { scheduleReplacementRepaint } from "../../src/viewport-repaint";
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

export type * from "./types";

// virtual-list-next: the core contract of docs/core-contract.md (I0–I6) on
// a smaller engine. Three ideas carry it (next/README.md):
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
// The physics stays where it was proven: the geometry kernel, the settle
// sensor, the glide, follow intent, and reach hysteresis come from src/.

const HEIGHT_NOISE = 1e-6;
/** Measurement and scroll-write noise. */
const EPSILON_PX = 0.5;
const AT_EDGE_PX = 1;
const MIN_OVERSCAN_PX = 300;
const FOLLOW_LANDING_MS = 320;
const IDLE_SLICE_MIN_MS = 4;
/** A window update adding more fresh rows prepares them across frames. */
const JOB_MIN_ROWS = 8;
const SLOT_PREFIX = "\u0000edge:";
const SLOT_BASE = "position:absolute;top:0;left:0;right:0;";
/** Where hidden slots wait: above the scroll origin, out of every rect query. */
const PARKED_TOP = "-100000px";
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
  /** The offset last written to the slot (NaN: none). */
  offset: number;
  /** Hidden: connected to the canvas, laid out, not painted. */
  place: "detached" | "hidden" | "mounted";
  /** Its size may differ from `height`; re-read at the next commit. */
  dirty: boolean;
  dead: boolean;
  edge?: Edge;
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
  const edgeSlots: Record<Edge, EdgeSlot | null> = {
    start: ownSlot(options.edgeSlots?.start),
    end: ownSlot(options.edgeSlots?.end),
  };

  // --- Surface --------------------------------------------------------------
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  canvas.style.overflowAnchor = "none";
  // One stable compositing surface while rows enter and leave (Safari).
  canvas.style.transform = "translateZ(0)";
  if (globalThis.CSS?.supports?.("-webkit-nbsp-mode", "space"))
    canvas.style.transformStyle = "preserve-3d";
  viewport.appendChild(canvas);
  let clip: "clip" | "hidden" | null = null;
  let viewportWidth = viewport.clientWidth;
  let viewportHeight = viewport.clientHeight;
  /** Where the viewport stood before a resize the engine may have clamped. */
  let lastObservedTop = viewport.scrollTop;
  /** A resize during a phase commits at the settle with this stance (I5). */
  let resizeHeld: "pin" | "viewport" | null = null;

  function viewportState(): GeometryViewport {
    return { scrollTop: viewport.scrollTop, height: viewport.clientHeight };
  }

  function syncCanvasHeight(totalSize: number): void {
    canvas.style.height = `${totalSize}px`;
    // The pin's shortfall grows in the same layout as its viewport.
    const pinTop = geometry.pinTop;
    canvas.style.minHeight =
      pinTop === null || pinTop === 0
        ? ""
        : `calc(100% + ${Math.ceil(pinTop)}px)`;
  }

  function writeScrollTop(top: number): void {
    controller.recordProgrammaticScrollTop(top);
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
      if (outer !== null) {
        // Its queued work drains once the enclosing pass has finished.
        outer.push(...own);
        throwAll(collected, "committed with failures in host callbacks");
        return;
      }
      scope = null;
      while (!disposed && own.length > 0) {
        const task = own.shift() as Task;
        try {
          task.run();
        } catch (error) {
          collected.push(...flatten(error));
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

  function newSlot(): HTMLElement {
    const slot = document.createElement("div");
    if (clip === null) {
      slot.style.overflow = "clip";
      clip = slot.style.overflow === "clip" ? "clip" : "hidden";
    }
    return slot;
  }

  function createRow(
    key: string,
    item: T,
    element: HTMLElement,
    height: number,
    edge?: Edge,
    spec?: EdgeSlot,
  ): Row<T> {
    const style = element.style;
    let slot = element;
    if (place) {
      // Positioned cards are their own slot; the host owns width and left.
      style.position = "absolute";
      style.top = "0";
      if (edge) {
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
      slot = newSlot();
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
      offset: Number.NaN,
      place: "detached",
      dirty: false,
      dead: false,
      edge,
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
    index: number,
    rowAt: (index: number) => Row<T> | undefined,
    count: number,
  ): Node | null {
    const previous = rowAt(index - 1);
    if (previous && previous.place !== "detached")
      return previous.slot.nextSibling;
    const limit = Math.min(count, index + 1 + INSERTION_SCAN);
    for (let next = index + 1; next < limit; next++) {
      const row = rowAt(next);
      if (row && row.place !== "detached") return row.slot;
    }
    return null;
  }

  const committedRowAt = (index: number): Row<T> | undefined =>
    rows.get(geometry.keyAt(index) ?? "");
  const committedPoint = (key: string): Node | null =>
    insertionPoint(geometry.indexOf(key), committedRowAt, geometry.count);

  /**
   * Connect a measured row to the canvas: laid out, never painted, hit,
   * focused, found, or announced (descendants can override visibility).
   */
  function hideRow(row: Row<T>, before = committedPoint(row.key)): void {
    if (row.place !== "detached" || row.slot === row.element) return;
    // Parked far above the scroll origin: unreachable, outside the scroll
    // range, and never intersecting the viewport for a host's rect query.
    row.slot.style.cssText = `${SLOT_BASE}overflow:${clip};max-height:0;visibility:hidden;top:${PARKED_TOP}`;
    row.slot.inert = true;
    row.slot.setAttribute("aria-hidden", "true");
    row.offset = Number.NaN;
    canvas.insertBefore(row.slot, before);
    row.place = "hidden";
    hiddenRows.add(row);
  }

  function detachRow(row: Row<T>): void {
    if (row.place !== "hidden") return;
    row.slot.remove();
    row.slot.inert = false;
    row.slot.removeAttribute("aria-hidden");
    row.place = "detached";
    hiddenRows.delete(row);
    if (resident === row) resident = null;
  }

  /** Move a slot to its committed offset (a no-op when unchanged). */
  function placeRow(row: Row<T>): void {
    const offset = geometry.offsetOf(row.key);
    if (offset < 0 || row.offset === offset) return;
    row.offset = offset;
    if (row.slot === row.element) row.slot.style.translate = `0 ${offset}px`;
    else row.slot.style.transform = `translateY(${offset}px)`;
  }

  function mountRow(row: Row<T>): void {
    const hidden = row.place === "hidden";
    if (row.slot !== row.element) {
      row.slot.style.cssText = `${SLOT_BASE}overflow:${clip};will-change:transform;height:${row.height}px`;
      row.offset = Number.NaN;
      if (hidden) {
        row.slot.inert = false;
        row.slot.removeAttribute("aria-hidden");
      }
    }
    // Placed before it connects: a mount hook never sees a provisional zero.
    placeRow(row);
    if (!hidden) canvas.insertBefore(row.slot, committedPoint(row.key));
    hiddenRows.delete(row);
    if (resident === row) resident = null;
    row.place = "mounted";
    mountedRows.add(row);
    observeRow(row);
    if (!row.edge) host(() => options.onMount?.(row.element, row.item));
  }

  function unmountRow(row: Row<T>): void {
    row.place = "detached";
    mountedRows.delete(row);
    rowObserver.unobserve(row.element);
    if (!row.edge) host(() => options.onUnmount?.(row.element, row.item));
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
    if (!row.edge) host(() => options.onDestroy?.(row.element, row.item));
  }

  function markDirty(row: Row<T>): void {
    if (row.edge) return;
    row.dirty = true;
    if (rows.get(row.key) === row) dirtyRows.add(row);
  }

  function renderInto(row: Row<T>, item: T): HTMLElement {
    row.shown = item;
    try {
      const element = render(item, row.element);
      row.broken = false;
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
   * Commit the heights of these rows. Detached rows are hidden in the canvas
   * first, so every read happens in one layout, before any write.
   */
  function measureRows(toMeasure: Iterable<Row<T>>): void {
    const list = [...toMeasure];
    if (list.length === 0) return;
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
        const height = row.element.getBoundingClientRect().height;
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
    list.forEach((row, index) => {
      commitHeight(row, heights[index] as number);
    });
    // A lone offscreen update (a streaming row out of view) stays laid out.
    if (connections === 1 && connected !== null) resident = connected;
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
    if (row.edge || declared) return;
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
      if (widthChanged && !declared)
        for (const row of rows.values()) markDirty(row);
      // The layout a gesture was scrolling no longer exists: a width change
      // ends the phase, and held work commits at the new width.
      if (widthChanged) {
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
    /** The staged key's index in the desired order. */
    let at = -1;
    const near = (key: string | undefined): Row<T> | undefined =>
      key === undefined ? undefined : (p.staged.get(key) ?? rows.get(key));

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
        hideRow(
          row,
          insertionPoint(at, (index) => near(p.keys[index]), p.keys.length),
        );
        fresh.push(row);
      }
      return row;
    };
    /** Null: updated in place; otherwise its replacement. */
    const rerender = (row: Row<T>, item: T): Row<T> | null => {
      touched.push(row);
      const shown = row.shown;
      const element = renderInto(row, item);
      if (element === row.element) {
        inPlace.push([row, item]);
        return null;
      }
      row.shown = shown;
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
        edge,
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
                p.declared?.get(key)?.height !== committed.height)
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
      const heights = fresh.map((row) =>
        positive(row.element.getBoundingClientRect().height),
      );
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
    } else if (p.target === null && p.anchor !== "end" && confined(p)) {
      commit(p, { policy: "none", write: false, keepFollow: true });
      return;
    } else {
      const waiting =
        updatedKey === undefined
          ? p.staged.values()
          : [p.staged.get(updatedKey)];
      for (const row of waiting) if (row && !row.edge) row.dirty = true;
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
      const shown = row.shown;
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
      } else {
        row.shown = shown;
        p.staged.set(key, createRow(key, item, element, height));
      }
    }
  }

  function commitBody(p: Pending<T> | null, o: CommitOptions): void {
    const policy = o.policy ?? p?.anchor ?? "auto";
    const before = viewportState();
    const capture = geometry.capture(
      before,
      policy,
      policy === "viewport" ? (p?.target ?? null) : null,
    );
    const toMeasure = new Set<Row<T>>();
    if (p) {
      if (p.deferred.size > 0) renderDeferred(p);
      // Adopt the staged rows; a key removed or replaced dies after it left
      // the map, so a host disposing from onDestroy cannot destroy it twice.
      const keysChanged = !sameKeys(p.keys);
      const doomed: Row<T>[] = [];
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
      for (const row of doomed) destroyRow(row);
      if (disposed) return;
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
      // Rows that waited for a settle are read again (an image decoded).
      for (const row of p.staged.values()) {
        if (row.dirty) toMeasure.add(row);
        else commitHeight(row, row.height);
      }
      if (place) {
        geometry.setPositioned(p.positioned);
        positionedNow = p.positioned !== null;
      }
    }
    for (const row of dirtyRows) toMeasure.add(row);
    measureRows(toMeasure);
    epoch += 1;

    const result = geometry.resolve(capture);
    syncCanvasHeight(result.totalSize);
    repositionMounted();
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
    const glideFollow =
      !o.instant &&
      !booting &&
      !follow.catchingUp &&
      smoothFollow &&
      result.mode === "end" &&
      takingOver === null &&
      moves;
    if (smoothFollow && !o.keepFollow && takingOver === null)
      follow.resolveCommit(policy, target);
    if (!glideFollow && o.write !== false && moves) writeScrollTop(target);
    reconcileAndPublish();
    if (disposed) return;
    if (glideFollow) startFollowGlide();
    else if (o.keepFollow && follow.armed)
      followIfBehindEnd(o.instant ? "instant" : "smooth");
  }

  /**
   * Mid-phase: commit the dirty heights at or below the anchor row. Nothing
   * above the anchor changes, so nothing on screen moves but those rows.
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
          const ready: Row<T>[] = [];
          for (const row of dirtyRows) {
            if (geometry.indexOf(row.key) >= anchorIndex) ready.push(row);
          }
          if (ready.length === 0) break;
          const capture = geometry.capture(vp, "none");
          measureRows(ready);
          epoch += 1;
          const result = geometry.resolve(capture);
          syncCanvasHeight(result.totalSize);
          repositionMounted();
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
    for (const row of mountedRows) placeRow(row);
  }

  let lastReconcile = { top: Number.NaN, height: Number.NaN, epoch: -1 };
  let lastRange: GeometryWindow = { start: 0, end: 0 };
  /** A command's landing keeps departing rows until the settle (Safari). */
  let holdLanding = false;
  let heldRetirements = false;

  function reconcileWindow(vp: GeometryViewport): GeometryWindow {
    if (glide !== null)
      holdLanding = !declared && !followGlide && glide.landing;
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
    const retire = (row: Row<T>): void => {
      if (holdLanding && geometry.indexOf(row.key) >= 0) {
        heldRetirements = true;
        return;
      }
      if (declared && !row.edge) {
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
      const key = geometry.keyAt(index);
      if (key === undefined) continue;
      let row = rows.get(key);
      if (!row) {
        const entry = declaredItems.get(key);
        if (!entry) continue;
        let element: HTMLElement;
        try {
          element = render(entry.item);
        } catch (error) {
          // Geometry stands; this row retries at the next reconciliation.
          failures.push(error);
          complete = false;
          continue;
        }
        if (disposed) {
          host(() => options.onDestroy?.(element, entry.item));
          return range;
        }
        row = createRow(key, entry.item, element, entry.height);
        rows.set(key, row);
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
  const windowJobs = new Set<(prepare?: boolean) => void>();
  const cancelJobs = new Set<() => void>();

  const idle = (): boolean => !controller.isScrollPhaseActive();

  const follow = new FollowController(
    {
      maxScrollTop: () => geometry.maxScrollTop(viewport.clientHeight),
      lastItemTop: () => {
        const key = lastItemKey();
        return key === null ? null : geometry.offsetOf(key);
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
    strategy: options.settleStrategy ?? detectScrollSettleStrategy(),
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
    onGestureStarted: () => {},
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
   * An explicit command stops the browser's animation (a write plus an
   * overflow toggle through a forced reflow), then settles the phase so held
   * work commits before the command.
   */
  function interruptNativeScroll(
    reason: "command" | "resize" = "command",
  ): void {
    if (!controller.isScrollPhaseActive()) return;
    const top = viewport.scrollTop;
    writeScrollTop(top);
    const overflow = viewport.style.overflowY;
    viewport.style.overflowY = "hidden";
    void viewport.offsetHeight;
    viewport.style.overflowY = overflow;
    writeScrollTop(top);
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
    glide?.cancel();
    interruptNativeScroll();
  }

  // --- Data -----------------------------------------------------------------
  function adoptItems(snapshot: T[], keys: readonly string[]): void {
    if (
      keys.length !== indexedKeys.length ||
      keys.some((key, index) => key !== indexedKeys[index])
    ) {
      indexByKey = new Map();
      let index = 0;
      for (const key of keys) if (!isSlotKey(key)) indexByKey.set(key, index++);
      indexedKeys = keys;
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
    o: { interrupt?: boolean; protectPin?: boolean } = {},
  ): Promise<boolean> {
    const interrupt = o.interrupt === true;
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
        width: number;
        input: number;
        protectedKeys: Set<string>;
        keys: Set<string>;
        /** The snapshot's key order, to place staged rows in list order. */
        order: readonly string[];
        index: Map<string, number>;
        fresh: [string, T][];
        cursor: number;
        rows: Map<string, Row<T>>;
        ready: boolean;
      }
      let job: Job | null = null;
      let finished = false;
      let working = false;
      let cancelRequested = false;
      let frame = 0;
      let idleHandle = 0;
      const canIdle = !interrupt && typeof requestIdleCallback === "function";

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
        for (const row of abandoned?.rows.values() ?? []) destroyRow(row);
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
      const current = (): boolean =>
        !finished &&
        !cancelRequested &&
        !disposed &&
        !signal?.aborted &&
        (!job ||
          (job.width === viewportWidth &&
            (!interrupt || job.input === inputEpoch) &&
            sourceCurrent(job)));

      /** Render one bounded slice, hidden in the canvas; one warm read. */
      const slice = (j: Job, deadline?: IdleDeadline): void => {
        pass(() => {
          const started = performance.now();
          let last: Row<T> | null = null;
          let count = 0;
          while (j.cursor < j.fresh.length && count < JOB_MIN_ROWS) {
            if (deadline && deadline.timeRemaining() < IDLE_SLICE_MIN_MS) break;
            const [key, item] = j.fresh[j.cursor] as [string, T];
            const row = createRow(key, item, render(item), 1);
            if (!current()) {
              destroyRow(row);
              cancel();
              return;
            }
            const near = (index: number): Row<T> | undefined => {
              const other = j.order[index];
              return other === undefined
                ? undefined
                : (j.rows.get(other) ?? rows.get(other));
            };
            hideRow(
              row,
              insertionPoint(j.index.get(key) as number, near, j.order.length),
            );
            j.rows.set(key, row);
            j.cursor += 1;
            count += 1;
            last = row;
            if (!deadline && performance.now() - started >= 3) break;
          }
          last?.element.getBoundingClientRect();
          if (!current()) {
            cancel();
            return;
          }
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
        if (!current()) {
          cancel();
          return;
        }
        if (!idle() || !job) return; // The settle resumes this job.
        const j = job;
        work(() => {
          slice(j);
          if (!current()) finish(false);
          else frame = requestAnimationFrame(j.ready ? runFrame : stageFrame);
        });
      };
      const stageIdle = (deadline: IdleDeadline): void => {
        idleHandle = 0;
        if (!current()) {
          cancel();
          return;
        }
        if (idle() || !job || job.ready) return; // The settle owns it now.
        const j = job;
        work(() => {
          slice(j, deadline);
          if (!current()) finish(false);
          else if (!j.ready) idleHandle = requestIdleCallback(stageIdle);
        });
      };
      const runFrame = (): void => {
        frame = 0;
        run();
      };
      function run(prepareOnly = false): void {
        if (working || finished) return;
        if (!current()) {
          cancel();
          return;
        }
        if (!idle() && !prepareOnly) return;
        try {
          let applied = false;
          pass(() => {
            const j = job;
            if (j && !j.ready) {
              if (prepareOnly) {
                if (idleHandle === 0)
                  idleHandle = requestIdleCallback(stageIdle);
              } else if (frame === 0) frame = requestAnimationFrame(stageFrame);
              return;
            }
            // Nothing lands mid-phase: a ready job waits for the settle.
            if (prepareOnly && j) return;
            const context = protectedContext(protectPin);
            const next = j?.next ?? update(context);
            if (!next || !current()) return;
            const snapshot = j?.snapshot ?? [...next.items];
            if (!protectPin) {
              // Opt-in trimming releases only the pin's extra protection.
              const keys = j?.keys ?? new Set(snapshot.map(keyOf));
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
            if (!j && !declared && pending === null) {
              const { keys, byKey } = indexItems(snapshot, false);
              const fresh = [...byKey].filter(([key]) => !rows.has(key));
              if (!current()) return;
              if (fresh.length > JOB_MIN_ROWS) {
                job = {
                  next: {
                    ...next,
                    anchor: ownAnchor(next.anchor ?? "viewport"),
                  },
                  snapshot,
                  slots,
                  source: context.items,
                  width: viewportWidth,
                  input: inputEpoch,
                  protectedKeys: new Set(context.protectedItems.map(keyOf)),
                  keys: new Set(keys),
                  order: keys,
                  index: new Map(keys.map((key, index) => [key, index])),
                  fresh,
                  cursor: 0,
                  rows: new Map(),
                  ready: false,
                };
                windowJobs.add(run);
                if (prepareOnly) idleHandle = requestIdleCallback(stageIdle);
                else frame = requestAnimationFrame(stageFrame);
                publish();
                return;
              }
            }
            if (prepareOnly) return;
            // A gesture may have exposed rows the updater was allowed to trim.
            if (
              j &&
              context.protectedItems.some((item) => {
                const key = keyOf(item);
                return !j.protectedKeys.has(key) && !j.keys.has(key);
              })
            ) {
              cancel();
              return;
            }
            if (!current()) {
              cancel();
              return;
            }
            cleanup();
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
          if (prepareOnly && !disposed) return;
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
        if (interrupt) {
          try {
            pass(takeover);
          } catch (error) {
            finish(false, error);
            return;
          }
        }
        if (idle()) {
          run();
          return;
        }
        windowJobs.add(run);
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
    const duration = finite(o.duration);
    const owned: ScrollOptions = {
      align: o.align,
      behavior: o.behavior,
      duration: duration !== undefined && duration > 0 ? duration : undefined,
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
    glide = startGlide(
      glideHost(destination),
      glidePace(viewport.clientHeight, o.duration),
      (completed) =>
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
            landed: () => landedOn(target, below, pinnedEnd),
            followsEnd: target === "end",
          };
          controller.markSettlePending();
        }),
    );
    glideToPin =
      pinning &&
      keyed &&
      o.align === "start" &&
      (!pinPolicy || target === geometry.pinned);
  }

  /** Each glide write is pre-announced and reconciled before paint. */
  function glideHost(target: () => number): GlideHost {
    return {
      read: () => viewport.scrollTop,
      write: (top) =>
        pass(() => {
          writeScrollTop(top);
          onScrolled();
        }),
      target,
    };
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
    glide = startGlide(
      glideHost(() => Math.ceil(follow.target(viewport.scrollTop))),
      glidePace(viewport.clientHeight, FOLLOW_LANDING_MS),
      () =>
        pass(() => {
          glide = null;
          followGlide = false;
          if (!disposed) controller.markSettlePending();
        }),
    );
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
        if (row?.place !== "mounted" || row.edge) continue;
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
      if (row?.place !== "mounted" || row.edge) return;
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
    const mark = failures.length;
    cancelRepaint?.();
    for (const cancel of [...cancelJobs]) cancel();
    for (const tasks of openScopes) discard(tasks);
    glide?.cancel();
    settleParked(false);
    reach.dispose();
    controller.dispose();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (observeFrame !== 0) cancelAnimationFrame(observeFrame);
    if (remeasureFrame !== 0) cancelAnimationFrame(remeasureFrame);
    remeasureRequests.clear();
    rowObserver.disconnect();
    viewportObserver.disconnect();
    canvas.remove();
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
