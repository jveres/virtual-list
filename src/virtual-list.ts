import { FenwickTree } from "./fenwick";
import { createFollowBottomController } from "./follow-bottom";
import {
  clamp,
  nonNegativeInteger,
  nonNegativeSize,
  planRenderRange,
  positiveSize,
  slotCoverageVisible,
} from "./layout-kernel";
import { createMeasurementQueue } from "./measurement-queue";
import {
  createPlaceholderModeController,
  DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD,
} from "./placeholder-mode";

export {
  planVirtualListPixelWindowFromEnd,
  planVirtualListPixelWindowFromStart,
  type VirtualListPixelWindowConfig,
  type VirtualListPixelWindowFromEndConfig,
  type VirtualListPixelWindowFromStartConfig,
  type VirtualListPixelWindowPlan,
} from "./layout-kernel";

import {
  createScrollSettleController,
  detectScrollSettleStrategy,
  type VirtualListScrollSettleStrategy,
} from "./scroll-settle";

export {
  detectScrollSettleStrategy,
  type VirtualListScrollSettleStrategy,
} from "./scroll-settle";

const STYLE_ID = "virtual-list-styles";
const DEFAULT_OVERSCAN_PX = 900;
const DEFAULT_MEASURE_EPSILON = 0.5;
const DEFAULT_RECYCLE_POOL_FLOOR = 8;
const SCROLL_SNAP_THRESHOLD = 1;
const DEFAULT_BOUNDARY_SENTINEL_HEIGHT = 1;
const BOUNDARY_INTERSECTION_THRESHOLD = 0.01;
const DEFAULT_SMOOTH_SCROLL_DURATION = 300;
// Float-noise threshold for rewriting a rendered style value (heights, slot
// tops) or re-emitting state: differences at or below this are the same pixel.
const RENDER_EPSILON_PX = 0.01;
// scrollTop writes smaller than this are invisible; skip the forced layout.
const SCROLL_WRITE_EPSILON_PX = 0.5;
// state.atTop / state.atBottom tolerance in logical scroll space.
const AT_EDGE_EPSILON_PX = 1;
// Native scroll-space edge tolerance: engines may leave a fractional gap (up
// to ~1px, more under zoom) between a pinned scroll position and the exact
// limit, so native-edge checks are looser than the logical-space
// AT_EDGE_EPSILON_PX.
const NATIVE_EDGE_EPSILON_PX = 2;
const SCROLL_TOP_RESIDUAL_EPSILON = 0.01;
const MAX_SCROLL_TOP_RESIDUAL = 2;
const MAX_DEFERRED_REFRESH_ATTEMPTS = 2;
const MAX_DEFERRED_INTERNAL_PASSES = 4;
const CSS = `
.vl-viewport {
  overflow-y: auto;
  overscroll-behavior-y: contain;
  overflow-anchor: none;
  -webkit-overflow-scrolling: touch;
}
.vl-scrollbar {
  isolation: isolate;
  scrollbar-gutter: stable both-edges;
  scrollbar-width: thin;
}
.vl-content {
  position: relative;
  width: 100%;
  min-height: 100%;
  overflow-anchor: none;
}
.vl-item {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  contain: layout paint;
  overflow-anchor: none;
}
.vl-boundary-slot {
  position: absolute;
  left: 0;
  right: 0;
  overflow-anchor: none;
}
.vl-placeholder-slot {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  overflow-anchor: none;
}
`;

export type VirtualListAlign = "top" | "center" | "bottom" | number;
export type VirtualListBoundary = "top" | "bottom";
export type VirtualListRenderMode = "virtual" | "full";
export type VirtualListNumberOption = number | (() => number);

export interface VirtualListConfig {
  viewport: HTMLElement;
  canvasClassName?: string;
  getCount: () => number;
  getItemHeight: (index: number) => number;
  buildItem: (index: number) => HTMLElement;
  /**
   * Called when an element previously produced by `buildItem` is permanently
   * detached by the virtual list — on unmount, refresh-swap, window reindex,
   * count shrink, measurement teardown, and `dispose`. Use it to destroy
   * per-row stateful resources (event listeners, observers, embedded
   * components). Not called for `buildPlaceholder` elements.
   */
  destroyItem?: (index: number, element: HTMLElement) => void;
  /**
   * Re-binds a previously pooled element (originally from `buildItem`) to
   * represent `index`, mutating it in place. Providing this enables element
   * recycling: rows scrolled out of view are pooled and re-bound instead of
   * discarded, so `buildItem` runs only when the pool is empty and
   * `destroyItem` only on eviction (pool over capacity) or `dispose`. Intended
   * for homogeneous rows.
   */
  recycleItem?: (index: number, element: HTMLElement) => void;
  buildPlaceholder?: (index: number) => HTMLElement;
  placeholderVelocityThreshold?: VirtualListNumberOption;
  overscanPx?: VirtualListNumberOption;
  renderMode?: VirtualListRenderMode;
  /**
   * Override the user-agent-detected scroll-settle strategy — the per-engine
   * heuristics for deciding when a user scroll gesture has finished (wheel
   * idle windows, scrollend timing quirks). Detected from
   * `navigator.userAgent` when unset. Intended for tests and unusual
   * embeddings (e.g. webviews with mismatched user agents).
   */
  scrollSettleStrategy?: VirtualListScrollSettleStrategy;
  measureEpsilon?: number;
  /**
   * Maximum number of idle elements retained for recycling. Defaults to about
   * one viewport's worth of rows. Ignored unless `recycleItem` is set.
   */
  recyclePoolSize?: number;
  onRangeChange?: (state: VirtualListState) => void;
  onReachTop?: (state: VirtualListState) => void;
  onReachBottom?: (state: VirtualListState) => void;
  onScrollStart?: (state: VirtualListState) => void;
  onScrollEnd?: (state: VirtualListState) => void;
}

export interface VirtualListItemMeasurerConfig {
  viewport: HTMLElement;
  canvasClassName?: string;
  buildItem: (index: number) => HTMLElement;
  /**
   * Called with each element after it has been measured and detached, so
   * transient per-row resources built for measurement can be destroyed.
   * Mirrors `buildItem`'s lifecycle counterpart in the virtual list config.
   */
  destroyItem?: (index: number, element: HTMLElement) => void;
}

export interface VirtualListMeasureItemConfig
  extends VirtualListItemMeasurerConfig {
  index: number;
}

export interface VirtualListItemMeasurer {
  measure(index: number): number;
  dispose(): void;
}

export interface VirtualListScrollOptions {
  behavior?: ScrollBehavior;
  duration?: number;
  signal?: AbortSignal;
  snapThreshold?: number;
}

export interface VirtualListSetCountOptions {
  addedBefore?: number;
  removedBefore?: number;
}

export interface VirtualListBoundarySlot {
  key: string;
  height: number;
  build: () => HTMLElement;
}

export interface VirtualListPlaceholderSlot {
  key: string;
  build: () => HTMLElement;
}

export interface VirtualListLayoutUpdate extends VirtualListSetCountOptions {
  topSlot?: VirtualListBoundarySlot | null;
  bottomSlot?: VirtualListBoundarySlot | null;
  placeholderSlot?: VirtualListPlaceholderSlot | null;
  apply?: () => boolean | undefined;
  after?: () => void;
}

export interface VirtualListState {
  count: number;
  range: { start: number; end: number };
  mountedCount: number;
  measuredCount: number;
  scrollTop: number;
  scrollHeight: number;
  scrollMax: number;
  totalSize: number;
  atTop: boolean;
  atBottom: boolean;
}

interface ScrollTopWriteOptions {
  allowDuringScroll?: boolean;
  preserveLogicalOffset?: boolean;
}

const ALLOW_DURING_SCROLL: ScrollTopWriteOptions = {
  allowDuringScroll: true,
};

const PRESERVE_LOGICAL_SCROLL_OFFSET: ScrollTopWriteOptions = {
  allowDuringScroll: true,
  preserveLogicalOffset: true,
};

const DEFER_MEASUREMENT_RENDER = { deferRender: true } as const;

interface MountedBoundarySlot {
  key: string | null;
  build: (() => HTMLElement) | null;
  element: HTMLElement;
  height: number;
  renderedHeight: number;
  renderedTop: number;
}

interface MountedPlaceholderSlot extends VirtualListPlaceholderSlot {
  element: HTMLElement | null;
  renderedHeight: number;
  building: boolean;
}

interface ItemRecord {
  index: number;
  element: HTMLElement;
}

type PostCommitTask =
  | { type: "destroy"; index: number; element: HTMLElement }
  | { type: "callback"; run: () => void };

type RefreshOutcome = "refreshed" | "measured" | "stale";

interface MountCandidate extends ItemRecord {
  placeholder: boolean;
}

export interface VirtualList {
  readonly state: VirtualListState;

  invalidateMeasurements(): void;
  /**
   * Stop an active native or programmatic scroll and synchronously commit work
   * that was waiting for it to settle. Use before a discrete interaction that
   * must replace list geometry immediately, such as switching a message branch.
   */
  interruptScroll(): void;
  setCount(options?: VirtualListSetCountOptions): void;
  syncLayout(update?: VirtualListLayoutUpdate): void;
  setBoundarySlot(
    boundary: VirtualListBoundary,
    slot: VirtualListBoundarySlot | null,
  ): void;
  getBoundaryElement(boundary: VirtualListBoundary): HTMLElement | null;
  setPlaceholderSlot(slot: VirtualListPlaceholderSlot | null): void;
  getPlaceholderElement(): HTMLElement | null;
  scrollToIndex(
    index: number,
    align?: VirtualListAlign,
    options?: VirtualListScrollOptions,
  ): Promise<boolean>;
  scrollToOffset(
    offset: number,
    options?: VirtualListScrollOptions,
  ): Promise<boolean>;
  scrollToTop(options?: VirtualListScrollOptions): Promise<boolean>;
  scrollToBottom(options?: VirtualListScrollOptions): Promise<boolean>;
  followBottom(options?: VirtualListScrollOptions): void;
  stopFollowBottom(): void;
  setStickyIndex(index: number | null): void;
  getMountedElement(index: number): HTMLElement | null;
  /** Top of an item in content (scroll) space; `index === count` is the bottom. */
  getItemOffset(index: number): number;
  refreshIndex(index: number): void;
  refreshMounted(): void;
  /**
   * Rebuild every mounted item at or after `index`, leaving earlier items'
   * DOM untouched. Use it to swap the tail of the list — e.g. switching a
   * message version or regenerating a response — without repainting the stable
   * prefix above the change point.
   */
  refreshFrom(index: number): void;
  dispose(): void;
}

export { FenwickTree } from "./fenwick";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// Ease-out quint: a quick launch into a long, very soft deceleration tail, so
// the scroll settles in gently rather than braking hard at the end. Resembles
// native browser smooth-scroll feel (notably Firefox) better than an
// ease-in-out, whose slow start reads as sluggish.
function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

// Glide duration caps the peak *speed*, not the distance: the scroll covers the
// whole real distance (no teleport), so a longer list genuinely takes longer and
// visibly travels farther, while never exceeding a comfortable reading speed.
//
//   duration = clamp(distance / speed, MIN, MAX)
//
// The speed cap is expressed in viewport-heights per second, so tall and short
// windows feel alike. The MIN floor keeps short hops from finishing too abruptly
// (ease-out-quint launches fast, and its soft tail needs a few frames of time to
// read as a gentle landing). The MAX ceiling bounds even a million-row jump so it
// never drags — past it, every long jump shares one duration but still differs by
// its on-screen velocity, which the eye reads as distance. ease-out-quint lands
// the arrival at zero velocity regardless. Override per call via
// `options.duration`.
const SMOOTH_SCROLL_MIN_DURATION = 320;
const SMOOTH_SCROLL_MAX_DURATION = 1400;
const SMOOTH_SCROLL_VIEWPORTS_PER_SECOND = 7;
function smoothScrollDuration(
  distance: number,
  viewportHeight: number,
): number {
  const speed =
    Math.max(1, viewportHeight) * SMOOTH_SCROLL_VIEWPORTS_PER_SECOND;
  return clamp(
    (Math.abs(distance) / speed) * 1000,
    SMOOTH_SCROLL_MIN_DURATION,
    SMOOTH_SCROLL_MAX_DURATION,
  );
}

function toNumberGetter(
  option: VirtualListNumberOption | undefined,
  fallback: number,
): () => number {
  if (typeof option === "function") return option;
  const value = option ?? fallback;
  return () => value;
}

function px(value: number): string {
  return `${nonNegativeSize(value).toFixed(3)}px`;
}

function signedPx(value: number): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(3)}px`;
}

function addClassNames(
  element: HTMLElement,
  classNames: string | undefined,
): void {
  if (!classNames) return;
  for (const className of classNames.split(/\s+/)) {
    if (className) element.classList.add(className);
  }
}

function resizeEntryHeight(entry: ResizeObserverEntry): number | null {
  const box = entry.borderBoxSize as
    | ResizeObserverSize
    | readonly ResizeObserverSize[]
    | undefined;
  const borderBox = Array.isArray(box) ? box[0] : box;
  const blockSize = borderBox?.blockSize;
  if (blockSize !== undefined && blockSize > 0) return blockSize;
  const contentHeight = entry.contentRect.height;
  return contentHeight > 0 ? contentHeight : null;
}

function translateYTransform(top: number): string {
  const safe = nonNegativeSize(top);
  const rounded = Math.round(safe);
  if (Math.abs(safe - rounded) <= 0.001) {
    return `translateY(${rounded}px)`;
  }
  return `translateY(${safe.toFixed(3)}px)`;
}

function prepareMeasuredItem(element: HTMLElement): HTMLElement {
  element.classList.remove("vl-item");
  element.style.position = "absolute";
  element.style.transform = "none";
  element.style.top = "0";
  element.style.left = "0";
  element.style.right = "0";
  return element;
}

function createMeasurementRoot(
  viewport: HTMLElement,
  canvasClassName: string | undefined,
): HTMLDivElement {
  const measureRoot = document.createElement("div");
  measureRoot.className = "vl-content";
  addClassNames(measureRoot, canvasClassName);
  Object.assign(measureRoot.style, {
    position: "fixed",
    inset: "0 auto auto 0",
    minHeight: "0",
    height: "0",
    overflow: "visible",
    visibility: "hidden",
    pointerEvents: "none",
  });
  syncMeasurementRootWidth(measureRoot, viewport);
  document.body.appendChild(measureRoot);
  return measureRoot;
}

function syncMeasurementRootWidth(
  measureRoot: HTMLDivElement,
  viewport: HTMLElement,
): void {
  const viewportWidth =
    viewport.clientWidth || viewport.getBoundingClientRect().width;
  measureRoot.style.width = viewportWidth > 0 ? `${viewportWidth}px` : "100%";
}

export function createVirtualListItemMeasurer(
  config: VirtualListItemMeasurerConfig,
): VirtualListItemMeasurer {
  injectStyles();
  const { viewport, canvasClassName, buildItem, destroyItem } = config;
  const measureRoot = createMeasurementRoot(viewport, canvasClassName);

  let disposed = false;

  return {
    measure(index) {
      if (disposed) {
        throw new Error("cannot measure with a disposed item measurer");
      }

      syncMeasurementRootWidth(measureRoot, viewport);
      measureRoot.replaceChildren();
      let element: HTMLElement | null = null;
      let height = 0;
      let measurementFailed = false;
      let measurementError: unknown;
      try {
        element = prepareMeasuredItem(buildItem(index));
        measureRoot.appendChild(element);
        height = positiveSize(element.getBoundingClientRect().height);
      } catch (error) {
        measurementFailed = true;
        measurementError = error;
      }

      measureRoot.replaceChildren();
      if (element && destroyItem) {
        try {
          destroyItem(index, element);
        } catch (teardownError) {
          if (measurementFailed) {
            throw new AggregateError(
              [measurementError, teardownError],
              "item measurement and teardown failed",
            );
          }
          throw teardownError;
        }
      }
      if (measurementFailed) throw measurementError;
      return height;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      measureRoot.remove();
    },
  };
}

export function measureVirtualListItem(
  config: VirtualListMeasureItemConfig,
): number {
  const { index, ...measurerConfig } = config;
  const measurer = createVirtualListItemMeasurer(measurerConfig);
  try {
    return measurer.measure(index);
  } finally {
    measurer.dispose();
  }
}

export function createVirtualList(config: VirtualListConfig): VirtualList {
  injectStyles();

  const {
    viewport,
    canvasClassName,
    buildItem,
    destroyItem,
    recycleItem,
    buildPlaceholder,
    getCount,
    getItemHeight,
    onRangeChange,
    onReachTop,
    onReachBottom,
    onScrollStart,
    onScrollEnd,
  } = config;

  const getOverscanPx = toNumberGetter(config.overscanPx, DEFAULT_OVERSCAN_PX);
  const needsBoundaryRender = Boolean(onReachTop || onReachBottom);
  const getPlaceholderVelocityThreshold = toNumberGetter(
    config.placeholderVelocityThreshold,
    DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD,
  );
  const renderMode = config.renderMode ?? "virtual";
  const measureEpsilon = config.measureEpsilon ?? DEFAULT_MEASURE_EPSILON;
  let count = 0;
  // Heights live solely in the Fenwick tree (valueAt/toValues recover
  // individual values on cold paths); `measured` tracks which are real.
  let measured = new Uint8Array(0);
  let sizeTree = new FenwickTree(new Float64Array(0));
  let measuredCount = 0;
  let mounted = new Map<number, HTMLElement>();
  let mountedPlaceholders = new Set<number>();
  const recyclePool: HTMLElement[] = [];
  let rangeStart = 0;
  let rangeEnd = 0;
  let renderFrame = 0;
  let scrollTopResidual = 0;
  // First item index whose mounted position may be stale (Infinity = clean).
  // An item's top is topSlotHeight() + prefix(index), so a size or slot change
  // at `index` can only move items at or after it; earlier items keep their
  // transforms. Unmounted items never hold stale transforms — they are
  // positioned fresh on mount — so a completed render pass clears this fully.
  let firstDirtyIndex = Number.POSITIVE_INFINITY;
  let renderedTotalSize = -1;
  let emittedRangeStart = -1;
  let emittedRangeEnd = -1;
  let emittedMountedCount = -1;
  let emittedMeasuredCount = -1;
  let emittedTotalSize = -1;
  let emittedAtTop = false;
  let emittedAtBottom = false;
  let lastViewportWidth = viewport.clientWidth;
  let lastViewportHeight = viewport.clientHeight;
  let stickyIndex: number | null = null;
  let tailGap = 0;
  let topSlot: MountedBoundarySlot | null = null;
  let bottomSlot: MountedBoundarySlot | null = null;
  let placeholderSlot: MountedPlaceholderSlot | null = null;
  let reachTopArmed = false;
  let reachBottomArmed = false;
  let topReachConsumed = false;
  let bottomReachConsumed = false;
  let activeSmoothScrollCancel: (() => void) | null = null;
  let activeSmoothScrollTarget: number | null = null;
  let activeSmoothScrollSnapThreshold = SCROLL_SNAP_THRESHOLD;
  let programmaticReachBoundary: VirtualListBoundary | null = null;
  let reachCallbacksEnabled = false;
  let emittingChangeCallback = false;
  let emittingReachCallback = false;
  let pendingBoundaryArm = false;
  let itemMeasurer: VirtualListItemMeasurer | null = null;
  // A numeric index has no stable identity across host data mutations. Any
  // synchronous host callback that starts another item/layout transaction
  // invalidates work captured by the older transaction.
  let itemIdentityGeneration = 0;
  let itemDataGeneration = 0;
  const pendingPostCommitTasks: PostCommitTask[] = [];
  const pendingExplicitMeasurementDataGenerations = new Map<number, number>();
  const pendingItemBuilds = new Set<number>();
  const deferredRefreshIndexes = new Set<number>();
  const deferredRefreshIndexDataGenerations = new Map<number, number>();
  const consumedRefreshIndexes = new Set<number>();
  const deferredRefreshAttempts = new Map<number, number>();
  let deferredRefreshFrom: number | null = null;
  let deferredRefreshFromDataGeneration: number | null = null;
  let activeDeferredRefreshIndex: number | null = null;
  let activeDeferredRefreshFrom: number | null = null;
  let deferredRefreshPasses = 0;
  let drainingDeferredInternalWork = false;
  let drainingDeferredRefreshes = false;
  let drainingPostCommitTasks = false;
  let layoutTransactionDepth = 0;
  let deferredMeasurementInvalidation = false;
  let renderDepth = 0;
  let renderInterruptedByInternalWork = false;
  let disposed = false;

  const deferredLayoutUpdates: VirtualListLayoutUpdate[] = [];
  const content = document.createElement("div");
  const computedRange = { start: 0, end: 0 };

  const itemResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      const index = Number(entry.target.dataset.index);
      if (!Number.isInteger(index)) continue;
      if (mounted.get(index) !== entry.target) continue;
      const height = resizeEntryHeight(entry);
      if (height !== null) {
        pendingExplicitMeasurementDataGenerations.delete(index);
        measurementQueue.queue(index, height);
      }
    }
  });

  const viewportResizeObserver = new ResizeObserver(() => {
    handleViewportResize();
  });

  content.className = "vl-content";
  addClassNames(content, canvasClassName);
  viewport.classList.add("vl-viewport", "vl-scrollbar");
  viewport.appendChild(content);

  function markLayoutDirtyFrom(index: number): void {
    if (index < firstDirtyIndex) firstDirtyIndex = index;
  }

  function nativeMaxScrollTop(): number {
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function topSlotHeight(): number {
    return topSlot?.height ?? 0;
  }

  function bottomSlotHeight(): number {
    return bottomSlot?.height ?? 0;
  }

  // Native-space stick-to-bottom check for measurement corrections; distinct
  // from state.atBottom, which reports the logical position with a tighter
  // tolerance.
  function nearNativeBottom(): boolean {
    return nativeMaxScrollTop() - logicalScrollTop() <= NATIVE_EDGE_EPSILON_PX;
  }

  function modeledItemHeight(index: number): number {
    return positiveSize(getItemHeight(index));
  }

  function normalizedCountShift(
    value: number | undefined,
    nextCount: number,
  ): number {
    if (value === undefined || !Number.isFinite(value)) return 0;
    return clamp(Math.floor(value), 0, nextCount);
  }

  function itemTotalSize(): number {
    return sizeTree.total();
  }

  function contentTotalSize(): number {
    const itemSize =
      topSlotHeight() + itemTotalSize() + bottomSlotHeight() + tailGap;
    return count === 0 && placeholderSlot
      ? Math.max(itemSize, viewport.clientHeight)
      : itemSize;
  }

  function logicalScrollTop(): number {
    return viewport.scrollTop + scrollTopResidual;
  }

  function getState(
    totalSize = contentTotalSize(),
    scrollTop = logicalScrollTop(),
    viewportHeight = lastViewportHeight,
  ): VirtualListState {
    const scrollHeight = Math.max(viewportHeight, totalSize);
    const scrollMax = Math.max(0, scrollHeight - viewportHeight);
    return {
      count,
      range: { start: rangeStart, end: rangeEnd },
      mountedCount: Math.max(0, rangeEnd - rangeStart),
      measuredCount,
      scrollTop,
      scrollHeight,
      scrollMax,
      totalSize,
      atTop: scrollTop <= AT_EDGE_EPSILON_PX,
      atBottom: scrollMax - scrollTop <= AT_EDGE_EPSILON_PX,
    };
  }

  function callReachCallback(
    callback: ((state: VirtualListState) => void) | undefined,
    state: VirtualListState,
  ): void {
    if (!callback) return;
    emittingReachCallback = true;
    try {
      callback(state);
    } finally {
      emittingReachCallback = false;
    }
  }

  function shouldEmitRangeChange(
    totalSize: number,
    atTop: boolean,
    atBottom: boolean,
  ): boolean {
    if (!onRangeChange) return false;
    const mountedCount = Math.max(0, rangeEnd - rangeStart);
    return (
      rangeStart !== emittedRangeStart ||
      rangeEnd !== emittedRangeEnd ||
      mountedCount !== emittedMountedCount ||
      measuredCount !== emittedMeasuredCount ||
      Math.abs(totalSize - emittedTotalSize) > RENDER_EPSILON_PX ||
      atTop !== emittedAtTop ||
      atBottom !== emittedAtBottom
    );
  }

  function rememberEmittedRange(state: VirtualListState): void {
    emittedRangeStart = state.range.start;
    emittedRangeEnd = state.range.end;
    emittedMountedCount = state.mountedCount;
    emittedMeasuredCount = state.measuredCount;
    emittedTotalSize = state.totalSize;
    emittedAtTop = state.atTop;
    emittedAtBottom = state.atBottom;
  }

  function emitViewportChange(
    totalSize = contentTotalSize(),
    scrollTop = logicalScrollTop(),
    viewportHeight = lastViewportHeight,
  ): void {
    if (!onRangeChange) return;

    const scrollMax = Math.max(0, totalSize - viewportHeight);
    const atTop = scrollTop <= AT_EDGE_EPSILON_PX;
    const atBottom = scrollMax - scrollTop <= AT_EDGE_EPSILON_PX;
    const emitRange = shouldEmitRangeChange(totalSize, atTop, atBottom);

    if (!emitRange) return;

    const state = getState(totalSize, scrollTop, viewportHeight);
    emittingChangeCallback = true;
    try {
      rememberEmittedRange(state);
      onRangeChange?.(state);
    } finally {
      emittingChangeCallback = false;
    }
  }

  function canEmitBoundaryReach(boundary: VirtualListBoundary): boolean {
    return (
      !disposed &&
      reachCallbacksEnabled &&
      !emittingReachCallback &&
      count > 0 &&
      (boundary === "top" ? Boolean(onReachTop) : Boolean(onReachBottom))
    );
  }

  function armedForBoundary(boundary: VirtualListBoundary): boolean {
    return boundary === "top" ? reachTopArmed : reachBottomArmed;
  }

  function reachConsumedForBoundary(boundary: VirtualListBoundary): boolean {
    return boundary === "top" ? topReachConsumed : bottomReachConsumed;
  }

  function setReachConsumed(
    boundary: VirtualListBoundary,
    consumed: boolean,
  ): void {
    if (boundary === "top") {
      topReachConsumed = consumed;
    } else {
      bottomReachConsumed = consumed;
    }
  }

  function setBoundaryArmed(
    boundary: VirtualListBoundary,
    armed: boolean,
  ): void {
    const wasArmed = armedForBoundary(boundary);
    if (wasArmed === armed) return;
    if (boundary === "top") {
      reachTopArmed = armed;
    } else {
      reachBottomArmed = armed;
    }
  }

  function armProgrammaticBoundaryReach(boundary: VirtualListBoundary): void {
    programmaticReachBoundary = boundary;
    setBoundaryArmed(boundary, true);
  }

  function clearProgrammaticBoundaryReach(
    boundary: VirtualListBoundary | null = null,
  ): void {
    if (boundary === null || programmaticReachBoundary === boundary) {
      programmaticReachBoundary = null;
    }
  }

  function emitBoundaryReach(boundary: VirtualListBoundary): void {
    if (!canEmitBoundaryReach(boundary)) return;
    if (!armedForBoundary(boundary)) return;

    setBoundaryArmed(boundary, false);
    setReachConsumed(boundary, true);
    clearProgrammaticBoundaryReach(boundary);
    emittingChangeCallback = true;
    try {
      callReachCallback(
        boundary === "top" ? onReachTop : onReachBottom,
        getState(),
      );
    } finally {
      emittingChangeCallback = false;
    }
  }

  function syncContentHeight(): number {
    const totalSize = contentTotalSize();
    if (Math.abs(totalSize - renderedTotalSize) > RENDER_EPSILON_PX) {
      content.style.height = px(totalSize);
      renderedTotalSize = totalSize;
      bottomFollow.wake();
    }
    return totalSize;
  }

  function normalizePlaceholderSlot(
    slot: VirtualListPlaceholderSlot,
  ): MountedPlaceholderSlot {
    return {
      key: String(slot.key),
      build: slot.build,
      element: null,
      renderedHeight: -1,
      building: false,
    };
  }

  function currentBoundarySlot(
    boundary: VirtualListBoundary,
  ): MountedBoundarySlot | null {
    return boundary === "top" ? topSlot : bottomSlot;
  }

  function setCurrentBoundarySlot(
    boundary: VirtualListBoundary,
    slot: MountedBoundarySlot | null,
  ): void {
    if (boundary === "top") {
      topSlot = slot;
    } else {
      bottomSlot = slot;
    }
  }

  function shouldKeepBoundarySlot(boundary: VirtualListBoundary): boolean {
    return boundary === "top" ? Boolean(onReachTop) : Boolean(onReachBottom);
  }

  function emptyBoundarySlotHeight(boundary: VirtualListBoundary): number {
    return shouldKeepBoundarySlot(boundary)
      ? DEFAULT_BOUNDARY_SENTINEL_HEIGHT
      : 0;
  }

  function createBoundarySlot(
    boundary: VirtualListBoundary,
  ): MountedBoundarySlot {
    const element = document.createElement("div");
    element.classList.add("vl-boundary-slot", `vl-boundary-${boundary}`);

    return {
      key: null,
      build: null,
      element,
      height: emptyBoundarySlotHeight(boundary),
      renderedHeight: -1,
      renderedTop: -1,
    };
  }

  function ensureBoundarySlot(
    boundary: VirtualListBoundary,
  ): MountedBoundarySlot {
    const current = currentBoundarySlot(boundary);
    if (current) return current;

    const next = createBoundarySlot(boundary);
    setCurrentBoundarySlot(boundary, next);
    markLayoutDirtyFrom(boundary === "top" ? 0 : count);
    return next;
  }

  function removeBoundarySlot(boundary: VirtualListBoundary): void {
    const current = currentBoundarySlot(boundary);
    if (!current) return;
    current.element.remove();
    setCurrentBoundarySlot(boundary, null);
    markLayoutDirtyFrom(boundary === "top" ? 0 : count);
  }

  function applyBoundarySlotUpdate(
    boundary: VirtualListBoundary,
    slot: VirtualListBoundarySlot | null | undefined,
    generation: number,
  ): boolean {
    if (slot === undefined) return false;

    if (slot === null) {
      const current = currentBoundarySlot(boundary);
      if (!current) return false;
      current.key = null;
      current.build = null;
      current.element.replaceChildren();
      const nextHeight = emptyBoundarySlotHeight(boundary);
      if (nextHeight <= 0 && !shouldKeepBoundarySlot(boundary)) {
        removeBoundarySlot(boundary);
        return true;
      }
      if (Math.abs(current.height - nextHeight) <= RENDER_EPSILON_PX)
        return false;
      current.height = nextHeight;
      markLayoutDirtyFrom(boundary === "top" ? 0 : count);
      return true;
    }

    const existing = currentBoundarySlot(boundary);
    const current = existing ?? createBoundarySlot(boundary);
    const isNew = existing === null;
    const nextKey = String(slot.key);
    const nextHeight = positiveSize(slot.height);
    if (current.key !== nextKey || !current.element.firstChild) {
      const child = slot.build();
      if (
        !itemTransactionIsCurrent(generation) ||
        (existing !== null && currentBoundarySlot(boundary) !== current)
      ) {
        child.remove();
        return false;
      }
      current.element.replaceChildren(child);
    }
    current.key = nextKey;
    current.build = slot.build;
    if (isNew) {
      setCurrentBoundarySlot(boundary, current);
      markLayoutDirtyFrom(boundary === "top" ? 0 : count);
    }

    if (Math.abs(current.height - nextHeight) <= RENDER_EPSILON_PX)
      return isNew;
    current.height = nextHeight;
    markLayoutDirtyFrom(boundary === "top" ? 0 : count);
    return true;
  }

  function applyPlaceholderSlotUpdate(
    slot: VirtualListPlaceholderSlot | null | undefined,
  ): boolean {
    if (slot === undefined) return false;

    if (slot === null) {
      placeholderSlot?.element?.remove();
      if (!placeholderSlot) return false;
      placeholderSlot = null;
      markLayoutDirtyFrom(count);
      return true;
    }

    const next = normalizePlaceholderSlot(slot);
    if (placeholderSlot && placeholderSlot.key === next.key) {
      placeholderSlot.build = next.build;
      return false;
    }

    placeholderSlot?.element?.remove();
    placeholderSlot = next;
    markLayoutDirtyFrom(count);
    return true;
  }

  function boundarySlotTop(boundary: VirtualListBoundary): number {
    return boundary === "top" ? 0 : topSlotHeight() + itemTotalSize();
  }

  function renderBoundarySlot(boundary: VirtualListBoundary): void {
    const slot = currentBoundarySlot(boundary);
    if (!slot) return;

    const { element } = slot;
    if (!element.isConnected) {
      content.appendChild(element);
    }
    const top = boundarySlotTop(boundary);
    if (Math.abs(slot.renderedTop - top) > RENDER_EPSILON_PX) {
      element.style.top = px(top);
      slot.renderedTop = top;
    }
    if (Math.abs(slot.renderedHeight - slot.height) > RENDER_EPSILON_PX) {
      element.style.height = px(slot.height);
      slot.renderedHeight = slot.height;
    }
  }

  function ensureReachBoundarySlots(): void {
    if (count <= 0) return;
    if (shouldKeepBoundarySlot("top")) ensureBoundarySlot("top");
    if (shouldKeepBoundarySlot("bottom")) ensureBoundarySlot("bottom");
  }

  function renderBoundarySlots(): void {
    renderBoundarySlot("top");
    renderBoundarySlot("bottom");
  }

  // Slot visibility from the library's own geometry, in logical scroll space —
  // the same signal an IntersectionObserver at BOUNDARY_INTERSECTION_THRESHOLD
  // would deliver, computed synchronously and without forcing layout. Every
  // event that can change the answer (scroll, viewport resize, content growth,
  // slot changes) already funnels through render().
  function boundarySlotVisible(boundary: VirtualListBoundary): boolean {
    const slot = currentBoundarySlot(boundary);
    if (!slot?.element.isConnected || slot.height <= 0) return false;

    return slotCoverageVisible(
      boundarySlotTop(boundary),
      slot.height,
      logicalScrollTop(),
      lastViewportHeight,
      BOUNDARY_INTERSECTION_THRESHOLD,
    );
  }

  function emitVisibleBoundaryReach(
    boundary: VirtualListBoundary | null,
  ): void {
    if (!boundary) return;
    const visible = boundarySlotVisible(boundary);
    if (!visible) return;
    emitBoundaryReach(boundary);
  }

  function armCoveredBoundaryForScroll(boundary: VirtualListBoundary): void {
    if (boundarySlotVisible(boundary)) return;
    setReachConsumed(boundary, false);
    setBoundaryArmed(boundary, true);
  }

  // Advance the reach state machine from slot visibility after each render
  // pass: a covered slot re-arms (during a user scroll, or while unconsumed),
  // a visible armed slot fires its reach callback. emitBoundaryReach's guards
  // make this idempotent across the many renders between transitions.
  function syncBoundaryReach(): void {
    if (count <= 0 || !needsBoundaryRender) return;
    for (const boundary of ["top", "bottom"] as const) {
      if (!currentBoundarySlot(boundary)) continue;
      if (boundarySlotVisible(boundary)) {
        emitBoundaryReach(boundary);
        continue;
      }
      const canRearm =
        scrollSettle.isUserScrollActive() ||
        !reachConsumedForBoundary(boundary);
      if (canRearm) {
        setReachConsumed(boundary, false);
        setBoundaryArmed(boundary, true);
      }
    }
  }

  function preparePlaceholderSlot(slot: MountedPlaceholderSlot): HTMLElement {
    const element = slot.build();
    element.classList.add("vl-placeholder-slot");
    return element;
  }

  function renderPlaceholderSlot(generation: number): void {
    const slot = placeholderSlot;
    if (!slot) return;

    if (count > 0) {
      slot.element?.remove();
      slot.element = null;
      slot.renderedHeight = -1;
      return;
    }

    let element = slot.element;
    if (!element) {
      if (slot.building) return;
      slot.building = true;
      try {
        element = preparePlaceholderSlot(slot);
      } finally {
        slot.building = false;
      }
      if (!itemTransactionIsCurrent(generation) || placeholderSlot !== slot) {
        element.remove();
        if (!disposed && placeholderSlot === slot) scheduleRender();
        return;
      }
      slot.element = element;
      content.appendChild(element);
    }

    const height = Math.max(viewport.clientHeight, contentTotalSize());
    if (Math.abs(slot.renderedHeight - height) > RENDER_EPSILON_PX) {
      element.style.height = px(height);
      slot.renderedHeight = height;
    }
  }

  function recomputeTailGap(): void {
    if (stickyIndex === null || stickyIndex < 0 || stickyIndex >= count) {
      stickyIndex = null;
      tailGap = 0;
      return;
    }

    const baseTotalSize =
      topSlotHeight() + itemTotalSize() + bottomSlotHeight();
    const stickyTop = topSlotHeight() + sizeTree.prefix(stickyIndex);
    if (stickyTop <= 0.5) {
      stickyIndex = null;
      tailGap = 0;
      return;
    }

    const nextTailGap = Math.max(
      0,
      viewport.clientHeight + stickyTop - baseTotalSize,
    );

    if (nextTailGap <= 0.5) {
      stickyIndex = null;
      tailGap = 0;
    } else {
      tailGap = nextTailGap;
    }
  }

  function setScrollTopResidual(value: number): void {
    const nextResidual =
      Number.isFinite(value) && Math.abs(value) <= MAX_SCROLL_TOP_RESIDUAL
        ? value
        : 0;
    if (
      Math.abs(scrollTopResidual - nextResidual) <= SCROLL_TOP_RESIDUAL_EPSILON
    ) {
      return;
    }

    scrollTopResidual =
      Math.abs(nextResidual) > SCROLL_TOP_RESIDUAL_EPSILON ? nextResidual : 0;
    content.style.transform =
      scrollTopResidual === 0
        ? ""
        : `translateY(${signedPx(-scrollTopResidual)})`;
  }

  function clearScrollTopResidual(): void {
    setScrollTopResidual(0);
  }

  function setScrollTop(
    value: number,
    options?: ScrollTopWriteOptions,
  ): boolean {
    if (disposed) return false;
    if (
      scrollSettle.isUserScrollActive() &&
      options?.allowDuringScroll !== true
    )
      return false;
    const target = clamp(value, 0, nativeMaxScrollTop());
    const shouldWrite =
      Math.abs(viewport.scrollTop - target) > SCROLL_WRITE_EPSILON_PX;
    if (shouldWrite) {
      scrollSettle.recordProgrammaticScrollTop(target);
      viewport.scrollTop = target;
    }
    if (options?.preserveLogicalOffset) {
      setScrollTopResidual(target - viewport.scrollTop);
      if (scrollSettle.isUserScrollActive()) {
        scrollSettle.resetVelocity(viewport.scrollTop);
      }
    } else {
      clearScrollTopResidual();
    }
    return shouldWrite;
  }

  // Extend the size structures for a pure append of [previousCount, nextCount).
  // Spare-capacity appends are amortized O(1); when full, the arrays regrow with
  // doubling headroom and rebuild once, linearly, so one-row-at-a-time
  // streaming stays amortized O(1) per row.
  function appendModeledSizes(
    previousCount: number,
    nextCount: number,
    generation: number,
  ): boolean {
    if (nextCount > sizeTree.capacity) {
      const capacity = Math.max(nextCount, previousCount * 2);
      const nextSizes = new Float64Array(nextCount);
      nextSizes.set(sizeTree.toValues());
      const nextMeasured = new Uint8Array(capacity);
      nextMeasured.set(measured.subarray(0, previousCount));
      for (let index = previousCount; index < nextCount; index++) {
        nextSizes[index] = modeledItemHeight(index);
        if (!itemTransactionIsCurrent(generation)) return false;
      }
      measured = nextMeasured;
      sizeTree = new FenwickTree(nextSizes, capacity);
      return true;
    }

    const appendedCount = nextCount - previousCount;
    if (appendedCount === 1) {
      const height = modeledItemHeight(previousCount);
      if (!itemTransactionIsCurrent(generation)) return false;
      sizeTree.append(height);
      return true;
    }

    const appendedSizes = new Float64Array(appendedCount);
    for (let offset = 0; offset < appendedCount; offset++) {
      appendedSizes[offset] = modeledItemHeight(previousCount + offset);
      if (!itemTransactionIsCurrent(generation)) return false;
    }
    for (const height of appendedSizes) sizeTree.append(height);
    return true;
  }

  // NOTE: `measured` may carry spare capacity beyond `count` (append
  // headroom, kept equal to the tree's capacity); only `[0, count)` is
  // meaningful. Use `count`, never `measured.length`, as the logical length.
  function fillSizes(
    nextCount: number,
    addedBefore: number,
    removedBefore: number,
    generation: number,
  ): number | null {
    const previousCount = count;

    // Pure append (or no-op): nothing prepended or removed, so the existing
    // prefix — sizes, measured flags, tree — is kept in place as-is.
    if (
      addedBefore === 0 &&
      removedBefore === 0 &&
      nextCount >= previousCount
    ) {
      if (nextCount === previousCount) return 0;
      if (!appendModeledSizes(previousCount, nextCount, generation))
        return null;
      markLayoutDirtyFrom(previousCount);
      return 0;
    }

    const previousSizes = sizeTree.toValues();
    const previousMeasured = measured;
    const nextSizes = new Float64Array(nextCount);
    const nextMeasured = new Uint8Array(nextCount);
    const previousStart = Math.min(removedBefore, previousCount);
    const preserved = Math.min(
      Math.max(0, previousCount - previousStart),
      Math.max(0, nextCount - addedBefore),
    );

    let nextMeasuredCount = 0;
    if (preserved > 0) {
      nextSizes.set(
        previousSizes.subarray(previousStart, previousStart + preserved),
        addedBefore,
      );
      nextMeasured.set(
        previousMeasured.subarray(previousStart, previousStart + preserved),
        addedBefore,
      );
      // Everything outside the preserved slice is freshly modeled (unmeasured),
      // so the surviving flags are the whole measured count.
      for (
        let index = previousStart;
        index < previousStart + preserved;
        index++
      ) {
        if (previousMeasured[index]) nextMeasuredCount++;
      }
    }

    let beforeHeightDelta = 0;
    for (let index = 0; index < previousStart; index++) {
      beforeHeightDelta -= previousSizes[index] ?? 0;
    }

    for (let index = 0; index < addedBefore; index++) {
      const height = modeledItemHeight(index);
      if (!itemTransactionIsCurrent(generation)) return null;
      nextSizes[index] = height;
      beforeHeightDelta += height;
    }

    for (let index = addedBefore + preserved; index < nextCount; index++) {
      nextSizes[index] = modeledItemHeight(index);
      if (!itemTransactionIsCurrent(generation)) return null;
    }

    measured = nextMeasured;
    measuredCount = nextMeasuredCount;
    sizeTree = new FenwickTree(nextSizes);
    markLayoutDirtyFrom(0);
    return beforeHeightDelta;
  }

  function clearPendingMeasurements(): void {
    measurementQueue.clear();
    pendingExplicitMeasurementDataGenerations.clear();
  }

  function deletePendingMeasurement(index: number): void {
    measurementQueue.delete(index);
    pendingExplicitMeasurementDataGenerations.delete(index);
  }

  function removePendingMeasurementsAtOrBeyond(index: number): void {
    measurementQueue.removeAtOrBeyond(index);
    for (const pendingIndex of pendingExplicitMeasurementDataGenerations.keys()) {
      if (pendingIndex >= index) {
        pendingExplicitMeasurementDataGenerations.delete(pendingIndex);
      }
    }
  }

  function refillModeledSizes(generation: number): boolean {
    const nextSizes = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      nextSizes[index] = modeledItemHeight(index);
      if (!itemTransactionIsCurrent(generation)) return false;
    }

    measurementQueue.cancelFlush();
    clearPendingMeasurements();
    measured = new Uint8Array(count);
    measuredCount = 0;
    sizeTree = new FenwickTree(nextSizes);
    markLayoutDirtyFrom(0);
    return true;
  }

  function computeRange(
    scrollTop: number,
    viewportHeight = lastViewportHeight,
    overscanPx = Math.max(0, getOverscanPx()),
  ): void {
    planRenderRange(
      computedRange,
      sizeTree,
      renderMode === "full",
      scrollTop - topSlotHeight(),
      viewportHeight,
      overscanPx,
    );
  }

  function needsAuxiliaryChrome(): boolean {
    return (
      needsBoundaryRender ||
      topSlot !== null ||
      bottomSlot !== null ||
      placeholderSlot !== null
    );
  }

  function positionItem(
    index: number,
    element: HTMLElement,
    offset = topSlotHeight(),
  ): void {
    const top = offset + sizeTree.prefix(index);
    element.style.transform = translateYTransform(top);
  }

  function prepareItem(
    index: number,
    element: HTMLElement,
    offset = topSlotHeight(),
  ): HTMLElement {
    element.dataset.index = String(index);
    element.classList.add("vl-item");
    positionItem(index, element, offset);
    return element;
  }

  function itemTransactionIsCurrent(generation: number): boolean {
    return !disposed && itemIdentityGeneration === generation;
  }

  function buildMountCandidate(
    index: number,
    usePlaceholder: boolean,
    offset: number,
    generation: number,
  ): MountCandidate | null {
    if (pendingItemBuilds.has(index)) return null;
    pendingItemBuilds.add(index);
    let keepReservation = false;
    let retry = false;
    try {
      const placeholder = usePlaceholder && buildPlaceholder !== undefined;
      const element = placeholder
        ? buildPlaceholder(index)
        : acquireElement(index, generation);
      if (!element) {
        retry = !disposed;
        return null;
      }

      if (!itemTransactionIsCurrent(generation)) {
        if (placeholder) {
          element.remove();
        } else {
          releaseItems([{ index, element }]);
        }
        retry = !disposed;
        return null;
      }

      prepareItem(index, element, offset);
      if (placeholder) {
        element.dataset.placeholder = "true";
      }
      keepReservation = true;
      return { index, element, placeholder };
    } finally {
      if (!keepReservation) {
        pendingItemBuilds.delete(index);
        if (retry) scheduleRender();
      }
    }
  }

  function discardMountCandidates(candidates: readonly MountCandidate[]): void {
    const realItems: ItemRecord[] = [];
    for (const candidate of candidates) {
      pendingItemBuilds.delete(candidate.index);
      if (candidate.placeholder) {
        candidate.element.remove();
      } else {
        realItems.push(candidate);
      }
    }
    releaseItems(realItems);
  }

  function refreshMountedPlaceholder(
    index: number,
    generation = itemIdentityGeneration,
  ): boolean {
    const previous = mounted.get(index);
    if (!previous) {
      mountedPlaceholders.delete(index);
      return false;
    }
    if (pendingItemBuilds.has(index)) return false;

    pendingItemBuilds.add(index);
    let retry = false;
    try {
      const next = acquireElement(index, generation);
      if (!next) {
        retry = !disposed;
        return false;
      }
      prepareItem(index, next);
      if (
        !itemTransactionIsCurrent(generation) ||
        mounted.get(index) !== previous ||
        !mountedPlaceholders.has(index)
      ) {
        releaseItems([{ index, element: next }]);
        retry = !disposed;
        return false;
      }

      itemResizeObserver.observe(next);
      previous.replaceWith(next);
      itemResizeObserver.unobserve(previous);
      mounted.set(index, next);
      mountedPlaceholders.delete(index);
      return true;
    } finally {
      pendingItemBuilds.delete(index);
      if (retry) scheduleRender();
    }
  }

  function refreshMountedPlaceholders(): boolean {
    if (mountedPlaceholders.size === 0) return false;

    const generation = itemIdentityGeneration;
    let refreshed = false;
    for (const index of Array.from(mountedPlaceholders)) {
      if (!itemTransactionIsCurrent(generation)) break;
      if (refreshMountedPlaceholder(index, generation)) {
        refreshed = true;
      }
    }
    return refreshed;
  }

  function syncRenderChrome(generation: number): number {
    if (needsAuxiliaryChrome()) {
      if (needsBoundaryRender) ensureReachBoundarySlots();
      const totalSize = syncContentHeight();
      renderBoundarySlots();
      renderPlaceholderSlot(generation);
      return totalSize;
    }
    return syncContentHeight();
  }

  function queueItemDestruction(index: number, element: HTMLElement): void {
    if (!destroyItem || element.dataset.placeholder === "true") return;
    pendingPostCommitTasks.push({
      type: "destroy",
      index,
      element,
    });
  }

  function queuePostCommitCallback(run: () => void): void {
    pendingPostCommitTasks.push({ type: "callback", run });
  }

  function throwCollectedErrors(
    errors: readonly unknown[],
    message: string,
  ): void {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
  }

  function appendCollectedError(
    errors: unknown[] | null,
    error: unknown,
  ): unknown[] {
    if (!errors) return [error];
    errors.push(error);
    return errors;
  }

  // Host callbacks are delivered only after internal ownership has committed.
  // Reentrant work appends to the same FIFO and is drained by the outermost
  // caller, preserving teardown-before-after order without recursive delivery.
  function drainPostCommitTasks(): boolean {
    if (pendingPostCommitTasks.length === 0) return true;
    if (drainingPostCommitTasks) return false;

    drainingPostCommitTasks = true;
    let errors: unknown[] | null = null;
    try {
      for (let cursor = 0; cursor < pendingPostCommitTasks.length; cursor++) {
        const task = pendingPostCommitTasks[cursor];
        if (!task) continue;
        try {
          if (task.type === "destroy") {
            destroyItem?.(task.index, task.element);
          } else {
            task.run();
          }
        } catch (error) {
          errors = appendCollectedError(errors, error);
        }
      }
    } finally {
      pendingPostCommitTasks.length = 0;
      drainingPostCommitTasks = false;
    }

    if (errors) {
      throwCollectedErrors(errors, "multiple virtual-list callbacks failed");
    }
    return true;
  }

  function runWithPostCommitDrain<T>(operation: () => T): T {
    let result!: T;
    let errors: unknown[] | null = null;
    try {
      result = operation();
    } catch (error) {
      errors = appendCollectedError(errors, error);
    }
    const ownsPostCommitDrain = !drainingPostCommitTasks;
    try {
      drainPostCommitTasks();
    } catch (error) {
      errors = appendCollectedError(errors, error);
    }
    if (ownsPostCommitDrain) {
      try {
        drainDeferredInternalWork();
      } catch (error) {
        errors = appendCollectedError(errors, error);
      }
    }
    if (errors) {
      throwCollectedErrors(
        errors,
        "virtual-list operation and callbacks failed",
      );
    }
    return result;
  }

  function runLayoutTransaction(operation: () => void): void {
    layoutTransactionDepth++;
    let errors: unknown[] | null = null;
    try {
      runWithPostCommitDrain(operation);
    } catch (error) {
      errors = appendCollectedError(errors, error);
    } finally {
      layoutTransactionDepth--;
    }
    if (layoutTransactionDepth === 0) {
      try {
        drainDeferredInternalWork();
      } catch (error) {
        errors = appendCollectedError(errors, error);
      }
    }
    if (errors) {
      throwCollectedErrors(errors, "virtual-list layout transaction failed");
    }
  }

  function detachItems(items: readonly ItemRecord[]): void {
    for (const { element } of items) {
      itemResizeObserver.unobserve(element);
      element.remove();
    }
  }

  function discardItems(items: readonly ItemRecord[]): void {
    detachItems(items);
    for (const { index, element } of items) {
      queueItemDestruction(index, element);
    }
  }

  function recyclePoolCapacity(): number {
    const configured = config.recyclePoolSize;
    if (configured !== undefined) return Math.max(0, Math.floor(configured));
    return Math.max(DEFAULT_RECYCLE_POOL_FLOOR, rangeEnd - rangeStart);
  }

  function trimRecyclePool(): void {
    const capacity = recyclePoolCapacity();
    const overflow = recyclePool.length - capacity;
    if (overflow <= 0) return;

    for (const evicted of recyclePool.splice(0, overflow)) {
      queueItemDestruction(Number(evicted.dataset.index), evicted);
    }
  }

  // Relinquish list ownership as one batch, then either pool real rows or queue
  // their permanent teardown. Placeholders have no host lifecycle counterpart.
  function releaseItems(items: readonly ItemRecord[]): void {
    if (items.length === 0) return;
    detachItems(items);

    for (const { index, element } of items) {
      if (!disposed && recycleItem && element.dataset.placeholder !== "true") {
        recyclePool.push(element);
      } else {
        queueItemDestruction(index, element);
      }
    }
    trimRecyclePool();
  }

  function releaseItem(index: number, element: HTMLElement): void {
    itemResizeObserver.unobserve(element);
    element.remove();
    if (!disposed && recycleItem && element.dataset.placeholder !== "true") {
      recyclePool.push(element);
      trimRecyclePool();
    } else {
      queueItemDestruction(index, element);
    }
  }

  // Reuse a pooled element (re-bound via recycleItem) or build a fresh one.
  function acquireElement(
    index: number,
    generation: number,
  ): HTMLElement | null {
    if (recycleItem) {
      const pooled = recyclePool.pop();
      if (pooled) {
        try {
          recycleItem(index, pooled);
        } catch (error) {
          discardItems([{ index, element: pooled }]);
          throw error;
        }
        pooled.dataset.index = String(index);
        if (!itemTransactionIsCurrent(generation)) {
          releaseItems([{ index, element: pooled }]);
          return null;
        }
        return pooled;
      }
    }

    const element = buildItem(index);
    element.dataset.index = String(index);
    if (!itemTransactionIsCurrent(generation)) {
      releaseItems([{ index, element }]);
      return null;
    }
    return element;
  }

  function unmountIndex(index: number): void {
    const element = mounted.get(index);
    if (!element) return;
    mounted.delete(index);
    mountedPlaceholders.delete(index);
    releaseItem(index, element);
  }

  function rangeFullyMounted(start: number, end: number): boolean {
    if (end <= start) return mounted.size === 0;
    if (mounted.size !== end - start) return false;
    for (let index = start; index < end; index++) {
      if (!mounted.has(index)) return false;
    }
    return true;
  }

  function renderOperation(
    explicitScrollTop: number,
    generation: number,
  ): void {
    if (disposed) return;
    renderPass(explicitScrollTop, generation);
    if (!drainPostCommitTasks()) {
      if (renderTransactionCanContinue(generation)) {
        queuePostCommitCallback(() => {
          if (itemTransactionIsCurrent(generation)) syncBoundaryReach();
        });
      }
      return;
    }
    drainDeferredInternalWork();
    if (!renderTransactionCanContinue(generation)) return;
    // After the pass, so reach callbacks observe settled chrome and any layout
    // they trigger re-enters via scheduleRender instead of recursing (the
    // emittingChangeCallback guard in applyLayoutUpdate).
    syncBoundaryReach();
  }

  function render(explicitScrollTop = logicalScrollTop()): void {
    renderDepth++;
    const generation = itemIdentityGeneration;
    let errors: unknown[] | null = null;
    try {
      renderOperation(explicitScrollTop, generation);
    } catch (error) {
      errors = appendCollectedError(errors, error);
    }
    const ownsPostCommitDrain = !drainingPostCommitTasks;
    try {
      drainPostCommitTasks();
    } catch (error) {
      errors = appendCollectedError(errors, error);
    }
    if (ownsPostCommitDrain) {
      try {
        drainDeferredInternalWork();
      } catch (error) {
        errors = appendCollectedError(errors, error);
      }
    }
    renderDepth--;
    if (renderDepth === 0) {
      try {
        reconcileInterruptedRender();
      } catch (error) {
        errors = appendCollectedError(errors, error);
      }
    }
    if (errors) {
      throwCollectedErrors(errors, "virtual-list render and callbacks failed");
    }
  }

  function renderPass(explicitScrollTop: number, generation: number): void {
    if (pendingBoundaryArm && needsBoundaryRender) {
      pendingBoundaryArm = false;
      armCoveredBoundaryForScroll("top");
      armCoveredBoundaryForScroll("bottom");
    }

    const totalSize = syncRenderChrome(generation);
    if (!itemTransactionIsCurrent(generation)) return;
    const viewportHeight = lastViewportHeight;
    const actualScrollTop = logicalScrollTop();
    const itemOffset = topSlotHeight();

    const previousStart = rangeStart;
    const previousEnd = rangeEnd;
    computeRange(explicitScrollTop, viewportHeight);
    const { start, end } = computedRange;
    // An item's top is topSlotHeight() + prefix(index) — absolute in content
    // space, independent of the mounted range. Every input that moves it (size
    // measurements, count changes, slot heights) marks firstDirtyIndex, so
    // kept items only need repositioning from that index on — never on plain
    // range shifts.
    const dirtyFrom = firstDirtyIndex;
    const layoutDirty = dirtyFrom < end;
    const mountPlaceholders = placeholderMode.update();
    if (!itemTransactionIsCurrent(generation)) return;
    rangeStart = start;
    rangeEnd = end;

    if (
      start === previousStart &&
      end === previousEnd &&
      rangeFullyMounted(start, end)
    ) {
      // Entering fast mode does NOT placeholderize items already on screen —
      // that caused a visible flash. Newly mounted items below already build as
      // placeholders via buildMountCandidate(). On exit, hydrate
      // any placeholders that survived back into real items.
      const refreshedMountedItems =
        !mountPlaceholders &&
        !placeholderMode.isHydrationBlocked() &&
        refreshMountedPlaceholders();
      drainDeferredInternalWork();
      if (!renderTransactionCanContinue(generation)) return;
      if (!layoutDirty && !refreshedMountedItems) {
        firstDirtyIndex = Number.POSITIVE_INFINITY;
        emitViewportChange(totalSize, actualScrollTop, viewportHeight);
        return;
      }

      let complete = true;
      for (let index = start; index < end; index++) {
        const element = mounted.get(index);
        if (!element) {
          complete = false;
          break;
        }
        if (index >= dirtyFrom) {
          positionItem(index, element, itemOffset);
        }
      }
      if (complete) {
        firstDirtyIndex = Number.POSITIVE_INFINITY;
        emitViewportChange(totalSize, actualScrollTop, viewportHeight);
        return;
      }
    }

    for (const [index] of mounted) {
      if (index >= start && index < end) continue;
      unmountIndex(index);
    }

    if (!mountPlaceholders && !placeholderMode.isHydrationBlocked()) {
      refreshMountedPlaceholders();
      drainDeferredInternalWork();
      if (!renderTransactionCanContinue(generation)) return;
    }

    const candidates: MountCandidate[] = [];
    let candidatesCommitted = false;
    try {
      let newItems: DocumentFragment | null = null;
      for (let index = start; index < end; index++) {
        const element = mounted.get(index);
        if (!element) {
          if (pendingItemBuilds.has(index)) {
            scheduleRender();
            return;
          }
          const candidate = buildMountCandidate(
            index,
            mountPlaceholders,
            itemOffset,
            generation,
          );
          if (!candidate) return;
          candidates.push(candidate);
          newItems ??= document.createDocumentFragment();
          newItems.appendChild(candidate.element);
        } else if (index >= dirtyFrom) {
          positionItem(index, element, itemOffset);
        }
      }
      if (!itemTransactionIsCurrent(generation)) return;

      if (newItems) content.appendChild(newItems);
      let mountedAnyPlaceholder = false;
      for (const candidate of candidates) {
        mounted.set(candidate.index, candidate.element);
        pendingItemBuilds.delete(candidate.index);
        if (candidate.placeholder) {
          mountedPlaceholders.add(candidate.index);
          mountedAnyPlaceholder = true;
        } else {
          mountedPlaceholders.delete(candidate.index);
          itemResizeObserver.observe(candidate.element);
        }
      }
      if (mountedAnyPlaceholder) placeholderMode.scheduleHydrationCheck();
      candidatesCommitted = true;
    } finally {
      if (!candidatesCommitted) discardMountCandidates(candidates);
    }

    firstDirtyIndex = Number.POSITIVE_INFINITY;
    drainDeferredInternalWork();
    if (!renderTransactionCanContinue(generation)) return;
    emitViewportChange(totalSize, actualScrollTop, viewportHeight);
  }

  function scheduleRender(): void {
    if (renderFrame || disposed) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      render();
    });
  }

  function renderNow(explicitScrollTop = logicalScrollTop()): void {
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
    render(explicitScrollTop);
  }

  function syncScrollSurface(): boolean {
    const generation = itemIdentityGeneration;
    ensureReachBoundarySlots();
    syncContentHeight();
    renderBoundarySlots();
    renderPlaceholderSlot(generation);
    return itemTransactionIsCurrent(generation);
  }

  function commitMeasurement(
    index: number,
    height: number,
    anchorIndex: number,
  ): number | null {
    if (index < 0 || index >= count) return null;
    const previous = sizeTree.valueAt(index);

    if (!measured[index]) {
      measured[index] = 1;
      measuredCount++;
    }

    const delta = height - previous;
    if (Math.abs(delta) <= measureEpsilon) return null;

    sizeTree.add(index, delta);
    markLayoutDirtyFrom(index + 1);

    return index < anchorIndex ? delta : 0;
  }

  // Shared tail of a committed height change: re-sync the content height and
  // keep the viewport anchored (stick to the bottom, or offset by the height
  // change above the anchor). The caller owns the eventual render so the
  // measurement queue can combine it with bottom-follow's scroll write.
  function applyMeasurementCorrection(
    wasAtBottom: boolean,
    hadStickyTail: boolean,
    correction: number,
  ): void {
    const scrollTopBeforeSync = viewport.scrollTop;
    recomputeTailGap();
    syncContentHeight();
    const maxTop = nativeMaxScrollTop();
    // If content shrank below the current scroll position, the browser clamps
    // scrollTop down to maxTop and emits a scroll event we never initiated.
    // Pre-record the expected landing so it isn't misread as a user scroll —
    // which would cancel an active auto-follow mid-stream (content shrinks as
    // streamed markdown heals/re-parses, e.g. a partial fence reflowing shorter).
    // Use the pre-shrink scrollTop: reading viewport.scrollTop after the height
    // write forces layout and already reflects the clamp.
    if (scrollTopBeforeSync > maxTop + measureEpsilon) {
      scrollSettle.recordProgrammaticScrollTop(maxTop);
    }
    const userScrolling = scrollSettle.isUserScrollActive();
    if (!hadStickyTail && wasAtBottom && !userScrolling && count > 0) {
      setScrollTop(maxTop);
    } else if (!userScrolling && Math.abs(correction) > measureEpsilon) {
      setScrollTop(
        logicalScrollTop() + correction,
        PRESERVE_LOGICAL_SCROLL_OFFSET,
      );
    }
  }

  // The measurement queue's drain: commit every queued height against the
  // current scroll anchor, then correct the viewport in one pass.
  function drainPendingMeasurements(
    pending: ReadonlyMap<number, number>,
  ): boolean {
    const wasAtBottom = nearNativeBottom();
    const hadStickyTail = stickyIndex !== null || tailGap > 0;
    const anchorIndex = sizeTree.indexAt(
      Math.max(0, logicalScrollTop() - topSlotHeight()),
    );
    let changed = false;
    let correction = 0;

    for (const [index, height] of pending) {
      const explicitDataGeneration =
        pendingExplicitMeasurementDataGenerations.get(index);
      const hasExplicitDataGeneration =
        pendingExplicitMeasurementDataGenerations.delete(index);
      if (
        hasExplicitDataGeneration &&
        explicitDataGeneration !== itemDataGeneration
      ) {
        continue;
      }
      const correctionDelta = commitMeasurement(index, height, anchorIndex);
      if (correctionDelta === null) continue;
      changed = true;
      correction += correctionDelta;
    }

    if (!changed) {
      emitViewportChange();
      return false;
    }

    applyMeasurementCorrection(wasAtBottom, hadStickyTail, correction);
    return true;
  }

  function commitExplicitMeasurement(
    index: number,
    height: number,
    dataGeneration = itemDataGeneration,
  ): void {
    if (
      disposed ||
      !Number.isFinite(height) ||
      height <= 0 ||
      index < 0 ||
      index >= count
    ) {
      return;
    }

    const wasAtBottom = nearNativeBottom();
    const hadStickyTail = stickyIndex !== null || tailGap > 0;
    const anchorIndex = sizeTree.indexAt(
      Math.max(0, logicalScrollTop() - topSlotHeight()),
    );
    if (scrollSettle.isUserScrollActive() && index < anchorIndex) {
      pendingExplicitMeasurementDataGenerations.set(index, dataGeneration);
      measurementQueue.queue(index, height);
      return;
    }

    deletePendingMeasurement(index);
    const correction = commitMeasurement(index, height, anchorIndex);
    if (correction === null) {
      emitViewportChange();
      return;
    }

    applyMeasurementCorrection(wasAtBottom, hadStickyTail, correction);
    renderNow();
  }

  function scrollTopForIndex(
    index: number,
    align: VirtualListAlign = "top",
  ): number {
    const itemTop = topSlotHeight() + sizeTree.prefix(index);
    const itemHeight = sizeTree.valueAt(index);
    if (typeof align === "number") return itemTop - align;
    if (align === "bottom") return itemTop + itemHeight - viewport.clientHeight;
    if (align === "center") {
      const viewportHeight = viewport.clientHeight;
      // An item taller than the viewport can't be centered usefully — centering
      // would push its top above the fold and reveal only its middle. Pin its
      // top instead so it reads from the start.
      if (itemHeight > viewportHeight) return itemTop;
      return itemTop + itemHeight / 2 - viewportHeight / 2;
    }
    return itemTop;
  }

  function flushDeferredLayoutBeforeProgrammaticOperation(): void {
    if (deferredLayoutUpdates.length === 0) return;
    flushDeferredLayoutUpdates();
  }

  function interruptNativeScrollMomentum(): void {
    if (!scrollSettle.isUserScrollActive()) return;

    const currentTop = clamp(viewport.scrollTop, 0, nativeMaxScrollTop());
    const previousOverflowY = viewport.style.overflowY;
    viewport.scrollTo({ top: currentTop, behavior: "auto" });
    viewport.style.overflowY = "hidden";
    // Force the overflow change to apply so native touch momentum is cancelled.
    void viewport.offsetHeight;
    viewport.style.overflowY = previousOverflowY;
    viewport.scrollTop = currentTop;
  }

  function interruptScroll(): void {
    if (disposed) return;
    activeSmoothScrollCancel?.();
    bottomFollow.stop();
    if (!scrollSettle.isUserScrollActive()) return;

    // Stop the browser-owned animation before applying any queued geometry.
    // Merely clearing settle timers would leave both APZ momentum and the
    // controller's active-gesture state alive.
    interruptNativeScrollMomentum();
    scrollSettle.finishGesture();
  }

  function activeSmoothScrollReachedTarget(): boolean {
    if (activeSmoothScrollTarget === null) return true;
    const target = clamp(activeSmoothScrollTarget, 0, nativeMaxScrollTop());
    return (
      Math.abs(viewport.scrollTop - target) <= activeSmoothScrollSnapThreshold
    );
  }

  function clearActiveSmoothScrollTarget(cancel: () => void): void {
    if (activeSmoothScrollCancel !== cancel) return;
    activeSmoothScrollCancel = null;
    activeSmoothScrollTarget = null;
    activeSmoothScrollSnapThreshold = SCROLL_SNAP_THRESHOLD;
  }

  function scrollToNativeTop(
    top: number,
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    activeSmoothScrollCancel?.();
    const hydratedPlaceholders = runWithPostCommitDrain(() =>
      placeholderMode.forceHydrate(),
    );
    if (disposed) {
      drainPostCommitTasks();
      return Promise.resolve(false);
    }
    interruptNativeScrollMomentum();
    scrollSettle.cancelGesture();
    const target = clamp(top, 0, nativeMaxScrollTop());
    const snapThreshold = options.snapThreshold ?? SCROLL_SNAP_THRESHOLD;
    if (options.signal?.aborted) {
      return Promise.resolve(false);
    }

    if (Math.abs(viewport.scrollTop - target) <= snapThreshold) {
      setScrollTop(target, ALLOW_DURING_SCROLL);
      if (hydratedPlaceholders) renderNow(viewport.scrollTop);
      return Promise.resolve(true);
    }

    scrollSettle.beginProgrammaticGesture();
    if (disposed) return Promise.resolve(false);

    if (options.behavior !== "smooth") {
      setScrollTop(target, ALLOW_DURING_SCROLL);
      scrollSettle.markSettlePending();
      return Promise.resolve(true);
    }

    return animateScrollTop(target, options, snapThreshold);
  }

  // One-shot smooth scroll, driven by rAF instead of the browser's native
  // `scrollTo({ behavior: "smooth" })`. The native animator owns the easing curve
  // and re-segments differently per engine — Firefox fires `scrollend` before
  // settling into our target, so the old `scrollend`-retargeting path re-issued
  // multiple native segments (visible "steps"/speed changes). A self-driven loop
  // is identical across engines and honors `duration`.
  //
  // It runs WITH the user-scroll gesture already active (set by the caller's
  // `beginProgrammaticGesture()`), exactly like the old native path: that keeps
  // the scroll handler from misreading our own programmatic writes as a user
  // scroll (Firefox coalesces/rounds large per-frame jumps, so value-matching
  // alone is unreliable), and lets the normal settle apply deferred measurements
  // at the end. The target is a fixed snapshot, so reaching a boundary mid-scroll
  // fires its `onReach` (the loading slot shows during the scroll) without the
  // scroll then chasing the content the load appends. A user gesture (or
  // superseding scroll) calls `cancel`.
  function animateScrollTop(
    target: number,
    options: VirtualListScrollOptions,
    snapThreshold: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finalTarget = clamp(target, 0, nativeMaxScrollTop());
      const startTop = viewport.scrollTop;
      // The glide travels the full real distance (no teleport): duration follows
      // that distance at a capped speed, so short hops are quick, long ones take
      // longer and visibly fly the whole way, and even huge jumps stay bounded.
      const duration = Math.max(
        1,
        options.duration ??
          smoothScrollDuration(finalTarget - startTop, viewport.clientHeight),
      );
      let startTime = 0;
      let frame = 0;
      let finished = false;

      const finish = (completed: boolean): void => {
        if (finished) return;
        finished = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        clearActiveSmoothScrollTarget(cancel);
        options.signal?.removeEventListener("abort", onAbort);
        if (completed) {
          setScrollTop(
            clamp(target, 0, nativeMaxScrollTop()),
            ALLOW_DURING_SCROLL,
          );
          scrollSettle.finishGesture();
        } else if (!disposed) {
          scrollSettle.markSettlePending();
        }
        resolve(completed);
      };
      const cancel = (): void => finish(false);
      const onAbort = (): void => finish(false);

      const tick = (now: number): void => {
        frame = 0;
        if (finished) return;
        if (disposed || count <= 0 || options.signal?.aborted) {
          finish(false);
          return;
        }
        if (startTime === 0) startTime = now;

        const clampedTarget = clamp(target, 0, nativeMaxScrollTop());
        activeSmoothScrollTarget = clampedTarget;
        const t = clamp((now - startTime) / duration, 0, 1);
        const nextTop = clamp(
          startTop + (clampedTarget - startTop) * easeOutQuint(t),
          0,
          nativeMaxScrollTop(),
        );
        if (setScrollTop(nextTop, ALLOW_DURING_SCROLL)) {
          renderNow(viewport.scrollTop);
        }
        if (finished || disposed) return;
        if (
          t >= 1 ||
          Math.abs(viewport.scrollTop - clampedTarget) <= snapThreshold
        ) {
          finish(true);
          return;
        }
        frame = requestAnimationFrame(tick);
      };

      activeSmoothScrollCancel = cancel;
      activeSmoothScrollTarget = clamp(target, 0, nativeMaxScrollTop());
      activeSmoothScrollSnapThreshold = snapThreshold;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      frame = requestAnimationFrame(tick);
    });
  }

  async function scrollToIndex(
    index: number,
    align: VirtualListAlign = "top",
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return false;
    flushDeferredLayoutBeforeProgrammaticOperation();
    bottomFollow.stop();
    if (count <= 0 || options.signal?.aborted) return false;
    const targetIndex = clamp(Math.floor(index), 0, count - 1);
    if (!syncScrollSurface()) return false;
    const target = scrollTopForIndex(targetIndex, align);
    const boundary =
      targetIndex === 0 && align === "top"
        ? "top"
        : targetIndex === count - 1 && align === "bottom"
          ? "bottom"
          : null;
    if (boundary) armProgrammaticBoundaryReach(boundary);
    else clearProgrammaticBoundaryReach();
    const ok = await scrollToNativeTop(target, options);
    if (disposed) return false;
    renderNow(viewport.scrollTop);
    emitVisibleBoundaryReach(boundary);
    clearProgrammaticBoundaryReach(boundary);
    return ok;
  }

  async function scrollToOffset(
    offset: number,
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return false;
    flushDeferredLayoutBeforeProgrammaticOperation();
    bottomFollow.stop();
    if (options.signal?.aborted) return false;
    clearProgrammaticBoundaryReach();
    if (!syncScrollSurface()) return false;
    const ok = await scrollToNativeTop(offset, options);
    if (disposed) return false;
    renderNow(viewport.scrollTop);
    return ok;
  }

  async function scrollToTop(
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return false;
    flushDeferredLayoutBeforeProgrammaticOperation();
    bottomFollow.stop();
    if (options.signal?.aborted) return false;
    if (!syncScrollSurface()) return false;
    armProgrammaticBoundaryReach("top");
    const ok = await scrollToNativeTop(0, options);
    if (disposed) return false;
    renderNow(viewport.scrollTop);
    emitVisibleBoundaryReach("top");
    clearProgrammaticBoundaryReach("top");
    return ok;
  }

  async function scrollToBottom(
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    if (disposed) return false;
    flushDeferredLayoutBeforeProgrammaticOperation();
    bottomFollow.stop();
    // Commit any settled-but-unflushed row heights so the target is the true
    // content bottom. Without this, a streaming row that just swapped from the
    // (throttled, lagging) live viewer to its taller final static render can
    // leave its measurement queued, and we'd scroll to the shorter old height.
    measurementQueue.flushNow();
    if (options.signal?.aborted) return false;
    if (!syncScrollSurface()) return false;
    armProgrammaticBoundaryReach("bottom");
    const ok = await scrollToNativeTop(nativeMaxScrollTop(), options);
    if (disposed) return false;
    renderNow(viewport.scrollTop);
    emitVisibleBoundaryReach("bottom");
    clearProgrammaticBoundaryReach("bottom");
    return ok;
  }

  function setStickyIndex(index: number | null): void {
    if (disposed) return;
    flushDeferredLayoutBeforeProgrammaticOperation();
    if (index === null || count === 0 || !Number.isFinite(index)) {
      stickyIndex = null;
      tailGap = 0;
    } else {
      stickyIndex = clamp(Math.floor(index), 0, count - 1);
      recomputeTailGap();
    }
    renderNow();
  }

  function getMountedElement(index: number): HTMLElement | null {
    return mounted.get(index) ?? null;
  }

  // Top of an item in content (scroll) space: the position its mounted element
  // is transform-translated to. `index === count` returns the content bottom.
  // Useful for overlays that track item positions (e.g. sticky group headers).
  function getItemOffset(index: number): number {
    const clamped = clamp(Math.floor(index), 0, Math.max(0, count));
    return topSlotHeight() + sizeTree.prefix(clamped);
  }

  function measureUnmountedItem(index: number): number {
    itemMeasurer ??= createVirtualListItemMeasurer({
      viewport,
      canvasClassName,
      buildItem,
      destroyItem: queueItemDestruction,
    });
    return itemMeasurer.measure(index);
  }

  function queueDeferredRefreshIndex(index: number): void {
    if (drainingDeferredRefreshes) {
      if (activeDeferredRefreshIndex === index && !drainingPostCommitTasks) {
        return;
      }
      if (
        (deferredRefreshAttempts.get(index) ?? 0) >=
        MAX_DEFERRED_REFRESH_ATTEMPTS
      ) {
        return;
      }
    }
    deferredRefreshIndexes.add(index);
    deferredRefreshIndexDataGenerations.set(index, itemDataGeneration);
  }

  function queueDeferredRefreshFrom(from: number): void {
    if (
      drainingDeferredRefreshes &&
      (deferredRefreshPasses >= MAX_DEFERRED_REFRESH_ATTEMPTS ||
        (activeDeferredRefreshFrom !== null &&
          activeDeferredRefreshIndex !== null &&
          from >= activeDeferredRefreshIndex))
    ) {
      return;
    }

    if (
      deferredRefreshFrom === null ||
      deferredRefreshFromDataGeneration !== itemDataGeneration
    ) {
      deferredRefreshFrom = from;
      deferredRefreshFromDataGeneration = itemDataGeneration;
    } else {
      deferredRefreshFrom = Math.min(deferredRefreshFrom, from);
    }
    // refreshFrom rebuilds mounted rows only. Preserve an exact retry for every
    // colliding construction so an offscreen measurement is sampled again too.
    for (const pendingIndex of pendingItemBuilds) {
      if (
        pendingIndex >= from &&
        pendingIndex < count &&
        pendingIndex !== activeDeferredRefreshIndex &&
        (deferredRefreshAttempts.get(pendingIndex) ?? 0) <
          MAX_DEFERRED_REFRESH_ATTEMPTS
      ) {
        queueDeferredRefreshIndex(pendingIndex);
      }
    }
  }

  function retagDeferredRefreshes(
    previousDataGeneration: number,
    nextDataGeneration: number,
  ): void {
    for (const [index, dataGeneration] of deferredRefreshIndexDataGenerations) {
      if (dataGeneration === previousDataGeneration) {
        deferredRefreshIndexDataGenerations.set(index, nextDataGeneration);
      }
    }
    if (deferredRefreshFromDataGeneration === previousDataGeneration) {
      deferredRefreshFromDataGeneration = nextDataGeneration;
    }
  }

  function hasDeferredRefreshes(): boolean {
    return deferredRefreshFrom !== null || deferredRefreshIndexes.size > 0;
  }

  function hasDeferredInternalWork(): boolean {
    return deferredMeasurementInvalidation || hasDeferredRefreshes();
  }

  function drainDeferredInternalWork(): void {
    if (
      drainingDeferredInternalWork ||
      drainingPostCommitTasks ||
      drainingDeferredRefreshes ||
      layoutTransactionDepth > 0 ||
      disposed ||
      pendingItemBuilds.size > 0 ||
      !hasDeferredInternalWork()
    ) {
      return;
    }

    drainingDeferredInternalWork = true;
    let errors: unknown[] | null = null;
    try {
      for (
        let pass = 0;
        pass < MAX_DEFERRED_INTERNAL_PASSES && hasDeferredInternalWork();
        pass++
      ) {
        if (deferredMeasurementInvalidation) {
          deferredMeasurementInvalidation = false;
          try {
            if (!performMeasurementInvalidation() && !disposed) {
              deferredMeasurementInvalidation = true;
            }
          } catch (error) {
            errors = appendCollectedError(errors, error);
          }
        }
        if (hasDeferredRefreshes()) {
          try {
            drainDeferredRefreshes();
          } catch (error) {
            errors = appendCollectedError(errors, error);
          }
        }
      }
      // A host that requests new invalidation work from every replay cannot
      // converge. Bound the barrier and discard only the non-converging tail.
      if (hasDeferredInternalWork()) {
        deferredMeasurementInvalidation = false;
        deferredRefreshFrom = null;
        deferredRefreshFromDataGeneration = null;
        deferredRefreshIndexes.clear();
        deferredRefreshIndexDataGenerations.clear();
      }
    } finally {
      drainingDeferredInternalWork = false;
    }
    try {
      reconcileInterruptedRender();
    } catch (error) {
      errors = appendCollectedError(errors, error);
    }
    if (errors) {
      throwCollectedErrors(errors, "deferred virtual-list work failed");
    }
  }

  function renderTransactionCanContinue(generation: number): boolean {
    if (hasDeferredInternalWork() || !itemTransactionIsCurrent(generation)) {
      renderInterruptedByInternalWork = true;
      return false;
    }
    return true;
  }

  function reconcileInterruptedRender(): void {
    if (!renderInterruptedByInternalWork) return;
    if (disposed) {
      renderInterruptedByInternalWork = false;
      return;
    }
    if (
      renderDepth > 0 ||
      layoutTransactionDepth > 0 ||
      drainingPostCommitTasks ||
      drainingDeferredInternalWork ||
      drainingDeferredRefreshes ||
      pendingItemBuilds.size > 0 ||
      hasDeferredInternalWork()
    ) {
      scheduleRender();
      return;
    }
    renderInterruptedByInternalWork = false;
    renderNow(logicalScrollTop());
  }

  function beginDeferredRefreshAttempt(index: number): boolean {
    const attempts = deferredRefreshAttempts.get(index) ?? 0;
    if (attempts >= MAX_DEFERRED_REFRESH_ATTEMPTS) return false;
    deferredRefreshAttempts.set(index, attempts + 1);
    activeDeferredRefreshIndex = index;
    return true;
  }

  function endDeferredRefreshAttempt(): void {
    activeDeferredRefreshIndex = null;
  }

  function drainDeferredRefreshes(): void {
    if (
      drainingDeferredRefreshes ||
      drainingPostCommitTasks ||
      layoutTransactionDepth > 0 ||
      disposed ||
      pendingItemBuilds.size > 0 ||
      !hasDeferredRefreshes()
    ) {
      return;
    }

    drainingDeferredRefreshes = true;
    consumedRefreshIndexes.clear();
    deferredRefreshAttempts.clear();
    activeDeferredRefreshIndex = null;
    activeDeferredRefreshFrom = null;
    deferredRefreshPasses = 0;
    const replayCountLimit = count;
    let errors: unknown[] | null = null;
    try {
      while (
        !disposed &&
        pendingItemBuilds.size === 0 &&
        (deferredRefreshFrom !== null || deferredRefreshIndexes.size > 0)
      ) {
        consumedRefreshIndexes.clear();
        const from = deferredRefreshFrom;
        deferredRefreshFrom = null;
        const fromDataGeneration = deferredRefreshFromDataGeneration;
        deferredRefreshFromDataGeneration = null;
        const indexes = Array.from(deferredRefreshIndexes, (index) => ({
          dataGeneration:
            deferredRefreshIndexDataGenerations.get(index) ??
            itemDataGeneration,
          index,
        })).sort((left, right) => left.index - right.index);
        deferredRefreshIndexes.clear();
        deferredRefreshIndexDataGenerations.clear();

        let requiresNewCountSnapshot = false;
        if (from !== null && fromDataGeneration === itemDataGeneration) {
          if (from < replayCountLimit) {
            deferredRefreshPasses++;
            activeDeferredRefreshFrom = from;
            let completed = true;
            try {
              completed = performRefreshFrom(from, replayCountLimit);
            } catch (error) {
              errors = appendCollectedError(errors, error);
            } finally {
              activeDeferredRefreshFrom = null;
            }
            if (!completed && !disposed && from < count) {
              queueDeferredRefreshFrom(from);
            }
          } else if (from < count) {
            queueDeferredRefreshFrom(from);
            requiresNewCountSnapshot = true;
          }
        }

        for (const { dataGeneration, index } of indexes) {
          if (dataGeneration !== itemDataGeneration || index < 0) continue;
          if (index >= replayCountLimit) {
            if (index < count) {
              queueDeferredRefreshIndex(index);
              requiresNewCountSnapshot = true;
            }
            continue;
          }
          if (index >= count) continue;
          if (consumedRefreshIndexes.has(index)) continue;
          consumedRefreshIndexes.add(index);
          if (!beginDeferredRefreshAttempt(index)) continue;
          let outcome: RefreshOutcome | null = null;
          try {
            outcome = performRefreshIndex(index);
          } catch (error) {
            errors = appendCollectedError(errors, error);
          } finally {
            endDeferredRefreshAttempt();
          }
          if (
            outcome === "stale" &&
            !disposed &&
            index < count &&
            (deferredRefreshAttempts.get(index) ?? 0) <
              MAX_DEFERRED_REFRESH_ATTEMPTS
          ) {
            queueDeferredRefreshIndex(index);
          }
        }
        if (requiresNewCountSnapshot) break;
      }
    } finally {
      consumedRefreshIndexes.clear();
      deferredRefreshAttempts.clear();
      activeDeferredRefreshIndex = null;
      activeDeferredRefreshFrom = null;
      deferredRefreshPasses = 0;
      drainingDeferredRefreshes = false;
    }
    try {
      reconcileInterruptedRender();
    } catch (error) {
      errors = appendCollectedError(errors, error);
    }
    if (errors) {
      throwCollectedErrors(errors, "multiple deferred refreshes failed");
    }
  }

  function refreshIndexInTransaction(
    index: number,
    generation: number,
  ): RefreshOutcome {
    const targetIndex = Math.floor(index);
    if (
      !itemTransactionIsCurrent(generation) ||
      !Number.isFinite(targetIndex) ||
      targetIndex < 0 ||
      targetIndex >= count
    ) {
      return "stale";
    }
    if (pendingItemBuilds.has(targetIndex)) return "stale";

    pendingItemBuilds.add(targetIndex);
    try {
      const previous = mounted.get(targetIndex);
      if (!previous) {
        const height = measureUnmountedItem(targetIndex);
        // Measurement teardown may itself update or dispose the host. Deliver it
        // before accepting the sampled height, then validate numeric-index
        // identity again because the API intentionally has no stable item key.
        const teardownDelivered = drainPostCommitTasks();
        if (
          !teardownDelivered ||
          !itemTransactionIsCurrent(generation) ||
          targetIndex >= count ||
          mounted.has(targetIndex) ||
          deferredRefreshIndexes.has(targetIndex)
        ) {
          return "stale";
        }
        commitExplicitMeasurement(targetIndex, height);
        return "measured";
      }

      const next = buildItem(targetIndex);
      next.dataset.index = String(targetIndex);
      if (
        !itemTransactionIsCurrent(generation) ||
        mounted.get(targetIndex) !== previous
      ) {
        releaseItems([{ index: targetIndex, element: next }]);
        return "stale";
      }

      prepareItem(targetIndex, next);
      deletePendingMeasurement(targetIndex);
      itemResizeObserver.observe(next);
      previous.replaceWith(next);
      itemResizeObserver.unobserve(previous);
      mounted.set(targetIndex, next);
      mountedPlaceholders.delete(targetIndex);
      discardItems([{ index: targetIndex, element: previous }]);
      return "refreshed";
    } finally {
      pendingItemBuilds.delete(targetIndex);
    }
  }

  function performRefreshIndex(
    targetIndex: number,
    queueDirectRetry = false,
  ): RefreshOutcome {
    if (disposed || targetIndex < 0 || targetIndex >= count) return "stale";
    const generation = ++itemIdentityGeneration;
    const dataGeneration = itemDataGeneration;
    return runWithPostCommitDrain(() => {
      const outcome = refreshIndexInTransaction(targetIndex, generation);
      if (
        outcome === "stale" &&
        queueDirectRetry &&
        itemDataGeneration === dataGeneration &&
        !hasDeferredRefreshes()
      ) {
        queueDeferredRefreshIndex(targetIndex);
      }
      if (outcome === "refreshed" && !hasDeferredRefreshes()) {
        queuePostCommitCallback(() => {
          if (itemTransactionIsCurrent(generation)) emitViewportChange();
        });
      }
      return outcome;
    });
  }

  function refreshIndex(index: number): void {
    if (disposed) return;
    const targetIndex = Math.floor(index);
    if (
      !Number.isFinite(targetIndex) ||
      targetIndex < 0 ||
      targetIndex >= count
    ) {
      return;
    }
    if (
      drainingDeferredInternalWork ||
      drainingDeferredRefreshes ||
      drainingPostCommitTasks ||
      layoutTransactionDepth > 0 ||
      pendingItemBuilds.size > 0
    ) {
      queueDeferredRefreshIndex(targetIndex);
      return;
    }
    performRefreshIndex(targetIndex, true);
  }

  function performRefreshFrom(
    from: number,
    endExclusive = count,
    queueDirectRetry = false,
  ): boolean {
    if (disposed || from < 0 || from >= count) return true;
    const generation = ++itemIdentityGeneration;
    const dataGeneration = itemDataGeneration;
    removePendingMeasurementsAtOrBeyond(from);
    // Snapshot the keys: each refresh replaces a mounted element in place
    // (same key), so iterating a copy is safe and only the suffix is rebuilt.
    return runWithPostCommitDrain(() => {
      let refreshed = false;
      let stale = false;
      const mountedIndexes = Array.from(mounted.keys()).sort(
        (left, right) => left - right,
      );
      for (const mountedIndex of mountedIndexes) {
        if (!itemTransactionIsCurrent(generation)) break;
        if (mountedIndex >= from && mountedIndex < endExclusive) {
          let replayAttempt = false;
          let deferredExact = false;
          let rowRefreshed = false;
          let rowCompleted = false;
          if (drainingDeferredRefreshes) {
            const deferredExactDataGeneration =
              deferredRefreshIndexDataGenerations.get(mountedIndex);
            deferredExact =
              deferredRefreshIndexes.delete(mountedIndex) &&
              deferredExactDataGeneration === itemDataGeneration;
            deferredRefreshIndexDataGenerations.delete(mountedIndex);
            replayAttempt = beginDeferredRefreshAttempt(mountedIndex);
            if (!replayAttempt) continue;
          }
          try {
            const outcome = refreshIndexInTransaction(mountedIndex, generation);
            rowRefreshed = outcome === "refreshed";
            rowCompleted = outcome !== "stale";
            stale = !rowCompleted || stale;
            refreshed = rowRefreshed || refreshed;
            if (rowCompleted && drainingDeferredRefreshes) {
              consumedRefreshIndexes.add(mountedIndex);
            }
          } finally {
            if (replayAttempt) endDeferredRefreshAttempt();
            if (
              deferredExact &&
              !rowCompleted &&
              !disposed &&
              mountedIndex < count &&
              (deferredRefreshAttempts.get(mountedIndex) ?? 0) <
                MAX_DEFERRED_REFRESH_ATTEMPTS
            ) {
              queueDeferredRefreshIndex(mountedIndex);
            }
          }
        }
      }
      if (refreshed && !hasDeferredRefreshes()) {
        queuePostCommitCallback(() => {
          if (itemTransactionIsCurrent(generation)) emitViewportChange();
        });
      }
      const completed = !stale && itemTransactionIsCurrent(generation);
      if (
        !completed &&
        queueDirectRetry &&
        itemDataGeneration === dataGeneration &&
        !hasDeferredRefreshes()
      ) {
        queueDeferredRefreshFrom(from);
      }
      return completed;
    });
  }

  function refreshFrom(index: number): void {
    if (disposed) return;
    const requestedFrom = Math.floor(index);
    if (!Number.isFinite(requestedFrom)) return;
    const from = Math.max(0, requestedFrom);
    if (from >= count) return;
    if (
      drainingDeferredInternalWork ||
      drainingDeferredRefreshes ||
      drainingPostCommitTasks ||
      layoutTransactionDepth > 0 ||
      pendingItemBuilds.size > 0
    ) {
      queueDeferredRefreshFrom(from);
      return;
    }
    performRefreshFrom(from, count, true);
  }

  function refreshMounted(): void {
    refreshFrom(0);
  }

  function reindexMounted(addedBefore: number, removedBefore: number): void {
    if (mounted.size === 0) return;

    const nextMounted = new Map<number, HTMLElement>();
    const nextMountedPlaceholders = new Set<number>();
    const removedItems: ItemRecord[] = [];
    for (const [index, element] of mounted) {
      if (index < removedBefore) {
        removedItems.push({ index, element });
        continue;
      }

      const nextIndex = index - removedBefore + addedBefore;
      if (nextIndex < 0 || nextIndex >= count) {
        removedItems.push({ index, element });
        continue;
      }

      if (mountedPlaceholders.has(index)) {
        nextMountedPlaceholders.add(nextIndex);
      }
      element.dataset.index = String(nextIndex);
      positionItem(nextIndex, element);
      nextMounted.set(nextIndex, element);
    }

    mounted = nextMounted;
    mountedPlaceholders = nextMountedPlaceholders;
    releaseItems(removedItems);
  }

  function flushDeferredLayoutUpdates(): boolean {
    if (disposed || deferredLayoutUpdates.length === 0) return false;

    const errors: unknown[] = [];
    let flushed = false;
    while (!disposed && deferredLayoutUpdates.length > 0) {
      const update = deferredLayoutUpdates.shift();
      if (!update) continue;
      flushed = true;
      try {
        applyLayoutUpdate(update);
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectedErrors(errors, "multiple deferred layout updates failed");
    return flushed;
  }

  function shouldDeferLayoutUpdate(update: VirtualListLayoutUpdate): boolean {
    if (!scrollSettle.isUserScrollActive()) return false;
    if (update.apply) return true;
    if (
      normalizedCountShift(update.addedBefore, Number.MAX_SAFE_INTEGER) > 0 ||
      normalizedCountShift(update.removedBefore, count) > 0
    ) {
      return true;
    }
    return nonNegativeInteger(getCount()) !== count;
  }

  function applyLayoutUpdate(update: VirtualListLayoutUpdate = {}): void {
    if (disposed) return;
    const generation = ++itemIdentityGeneration;
    const hasHostMutation = update.apply !== undefined;
    runLayoutTransaction(() => {
      if (update.apply) {
        const previousDataGeneration = itemDataGeneration;
        const previousDeferredRefreshFrom =
          deferredRefreshFromDataGeneration === previousDataGeneration
            ? deferredRefreshFrom
            : null;
        const mutationDataGeneration = previousDataGeneration + 1;
        itemDataGeneration = mutationDataGeneration;
        if (update.apply() === false) {
          if (itemDataGeneration === mutationDataGeneration) {
            itemDataGeneration = previousDataGeneration;
            retagDeferredRefreshes(
              mutationDataGeneration,
              previousDataGeneration,
            );
            if (previousDeferredRefreshFrom !== null) {
              deferredRefreshFrom =
                deferredRefreshFrom === null
                  ? previousDeferredRefreshFrom
                  : Math.min(deferredRefreshFrom, previousDeferredRefreshFrom);
              deferredRefreshFromDataGeneration = previousDataGeneration;
            }
          }
          return;
        }
      }
      if (!itemTransactionIsCurrent(generation)) return;

      ensureReachBoundarySlots();
      const previousCount = count;
      const nextCount = nonNegativeInteger(getCount());
      if (!itemTransactionIsCurrent(generation)) return;
      const addedBefore = normalizedCountShift(update.addedBefore, nextCount);
      const removedBefore = normalizedCountShift(update.removedBefore, count);
      const previousScrollTop = logicalScrollTop();
      const previousTopSlotHeight = topSlotHeight();
      const hasSlotUpdate =
        update.topSlot !== undefined ||
        update.bottomSlot !== undefined ||
        update.placeholderSlot !== undefined;
      const shouldRefreshSizes =
        !hasSlotUpdate ||
        nextCount !== count ||
        addedBefore > 0 ||
        removedBefore > 0;
      const isWindowShift = addedBefore > 0 || removedBefore > 0;
      applyBoundarySlotUpdate("top", update.topSlot, generation);
      if (!itemTransactionIsCurrent(generation)) return;
      applyBoundarySlotUpdate("bottom", update.bottomSlot, generation);
      if (!itemTransactionIsCurrent(generation)) return;
      applyPlaceholderSlotUpdate(update.placeholderSlot);
      if (!itemTransactionIsCurrent(generation)) return;
      const beforeHeightDelta = shouldRefreshSizes
        ? fillSizes(nextCount, addedBefore, removedBefore, generation)
        : 0;
      if (beforeHeightDelta === null || !itemTransactionIsCurrent(generation)) {
        return;
      }
      count = nextCount;

      if (isWindowShift || (hasHostMutation && nextCount === previousCount)) {
        clearPendingMeasurements();
        if (isWindowShift && stickyIndex !== null) {
          const nextStickyIndex = stickyIndex + addedBefore - removedBefore;
          stickyIndex =
            count > 0 && nextStickyIndex >= 0 && nextStickyIndex < count
              ? nextStickyIndex
              : null;
        }
      } else {
        removePendingMeasurementsAtOrBeyond(count);
      }

      recomputeTailGap();
      syncContentHeight();
      const topSlotDelta =
        addedBefore > 0 || removedBefore > 0
          ? topSlotHeight() - previousTopSlotHeight
          : 0;
      const nextScrollTop =
        previousScrollTop + beforeHeightDelta + topSlotDelta;
      const hasScrollTarget =
        Math.abs(nextScrollTop - previousScrollTop) > measureEpsilon;

      if (isWindowShift) {
        reindexMounted(addedBefore, removedBefore);
      } else {
        const removedItems: ItemRecord[] = [];
        for (const [index, element] of mounted) {
          if (index < count) continue;
          mounted.delete(index);
          mountedPlaceholders.delete(index);
          removedItems.push({ index, element });
        }
        releaseItems(removedItems);
      }
      if (hasScrollTarget) {
        setScrollTop(nextScrollTop, PRESERVE_LOGICAL_SCROLL_OFFSET);
      }
      // Defer the render when re-entering from a change callback (no synchronous
      // render inside the app's handler) or after a scroll write, whose scroll
      // event lands next frame anyway; otherwise render in place.
      if (hasScrollTarget || emittingChangeCallback) {
        scheduleRender();
      } else {
        renderNow(logicalScrollTop());
      }

      // A reentrant update starts a newer generation, so the older transaction's
      // completion callback becomes a no-op when the post-commit FIFO reaches it.
      if (update.after) {
        queuePostCommitCallback(() => {
          if (itemTransactionIsCurrent(generation)) update.after?.();
        });
      }
    });
  }

  function syncLayout(update: VirtualListLayoutUpdate = {}): void {
    if (disposed) return;
    if (shouldDeferLayoutUpdate(update)) {
      deferredLayoutUpdates.push(update);
      return;
    }
    applyLayoutUpdate(update);
  }

  function setCount(options?: VirtualListSetCountOptions): void {
    syncLayout({ ...options, apply: () => true });
  }

  function setBoundarySlot(
    boundary: VirtualListBoundary,
    slot: VirtualListBoundarySlot | null,
  ): void {
    const update =
      boundary === "top" ? { topSlot: slot } : { bottomSlot: slot };
    syncLayout(update);
  }

  function getBoundaryElement(
    boundary: VirtualListBoundary,
  ): HTMLElement | null {
    if (disposed) return null;
    return currentBoundarySlot(boundary)?.element ?? null;
  }

  function setPlaceholderSlot(slot: VirtualListPlaceholderSlot | null): void {
    syncLayout({ placeholderSlot: slot });
  }

  function getPlaceholderElement(): HTMLElement | null {
    if (disposed) return null;
    return placeholderSlot?.element ?? null;
  }

  function performMeasurementInvalidation(): boolean {
    const generation = ++itemIdentityGeneration;
    lastViewportWidth = viewport.clientWidth;
    lastViewportHeight = viewport.clientHeight;
    const previousNativeScrollTop = viewport.scrollTop;
    const previousScrollTop = logicalScrollTop();
    const previousItemOffset = Math.max(0, previousScrollTop - topSlotHeight());
    const anchorIndex =
      count > 0 ? clamp(sizeTree.indexAt(previousItemOffset), 0, count - 1) : 0;
    const anchorOffset =
      count > 0
        ? Math.max(0, previousItemOffset - sizeTree.prefix(anchorIndex))
        : 0;
    const wasAtBottom = nearNativeBottom();

    if (!refillModeledSizes(generation)) return false;
    recomputeTailGap();
    const nextTotalSize = contentTotalSize();
    const nextMaxScrollTop = Math.max(0, nextTotalSize - lastViewportHeight);
    // Shrinking the modeled content can clamp scrollTop as soon as the height
    // style changes. Record that landing before the browser queues its scroll
    // echo, or the settle controller mistakes this library-owned clamp for a
    // user gesture and defers the next interactive layout update indefinitely.
    if (previousNativeScrollTop > nextMaxScrollTop + measureEpsilon) {
      scrollSettle.recordProgrammaticScrollTop(nextMaxScrollTop);
    }
    const totalSize = syncContentHeight();

    if (count > 0) {
      const nextScrollTop = wasAtBottom
        ? Math.max(0, totalSize - lastViewportHeight)
        : topSlotHeight() + sizeTree.prefix(anchorIndex) + anchorOffset;
      setScrollTop(nextScrollTop, PRESERVE_LOGICAL_SCROLL_OFFSET);
    }

    renderNow(logicalScrollTop());
    return true;
  }

  function invalidateMeasurements(): void {
    if (disposed) return;
    deferredMeasurementInvalidation = true;
    if (renderDepth === 0) drainDeferredInternalWork();
  }

  function isAtNativeScrollBoundary(scrollTop = viewport.scrollTop): boolean {
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop <= NATIVE_EDGE_EPSILON_PX ||
      maxScrollTop - scrollTop <= NATIVE_EDGE_EPSILON_PX
    );
  }

  function handleViewportResize(): void {
    if (disposed) return;
    const nextWidth = viewport.clientWidth;
    const nextHeight = viewport.clientHeight;
    if (
      Math.abs(nextWidth - lastViewportWidth) <= 0.5 &&
      Math.abs(nextHeight - lastViewportHeight) <= 0.5
    ) {
      return;
    }
    lastViewportWidth = nextWidth;
    lastViewportHeight = nextHeight;
    recomputeTailGap();
    syncContentHeight();
    setScrollTop(viewport.scrollTop);
    scheduleRender();
  }

  const measurementQueue = createMeasurementQueue({
    isDisposed: () => disposed,
    isUserScrollActive: () => scrollSettle.isUserScrollActive(),
    itemCount: () => count,
    followLoopDrains: () =>
      bottomFollow.isActive() && !scrollSettle.isUserScrollActive(),
    wakeFollowLoop: () => bottomFollow.wake(),
    drain: drainPendingMeasurements,
    render: () => renderNow(),
  });

  const placeholderMode = createPlaceholderModeController({
    canMountPlaceholders: () =>
      renderMode !== "full" && buildPlaceholder !== undefined,
    velocityThreshold: getPlaceholderVelocityThreshold,
    currentVelocity: () => scrollSettle.currentVelocity(),
    lastSampleDelta: () => scrollSettle.lastSampleDelta(),
    sampleEpsilon: measureEpsilon,
    isDisposed: () => disposed,
    atNativeScrollBoundary: () => isAtNativeScrollBoundary(),
    hasPlaceholderMounts: () => mountedPlaceholders.size > 0,
    refreshMountedPlaceholders,
    renderNow: () => renderNow(logicalScrollTop()),
  });

  const bottomFollow = createFollowBottomController({
    viewport,
    defaultSmoothDuration: DEFAULT_SMOOTH_SCROLL_DURATION,
    defaultSnapThreshold: SCROLL_SNAP_THRESHOLD,
    isDisposed: () => disposed,
    isUserScrollActive: () => scrollSettle.isUserScrollActive(),
    hasContent: () => count > 0,
    syncContentHeight: () => {
      syncContentHeight();
    },
    flushMeasurementsNow: () =>
      measurementQueue.flushNow(DEFER_MEASUREMENT_RENDER).needsRender,
    writeScrollTop: (top) => setScrollTop(top, ALLOW_DURING_SCROLL),
    renderNow: () => renderNow(viewport.scrollTop),
    onStopped: () => {
      // Drain measurements deferred to the follow loop while it ran.
      if (measurementQueue.hasPending()) measurementQueue.scheduleFlush();
    },
  });

  const scrollSettle = createScrollSettleController({
    viewport,
    strategy: config.scrollSettleStrategy ?? detectScrollSettleStrategy(),
    measureEpsilon,
    isDisposed: () => disposed,
    canLoadAtBoundary: (boundary) =>
      boundary === "top"
        ? onReachTop !== undefined
        : onReachBottom !== undefined,
    cancelActiveSmoothScroll: () => {
      activeSmoothScrollCancel?.();
    },
    smoothScrollReachedTarget: activeSmoothScrollReachedTarget,
    onGestureActivity: () => {
      bottomFollow.stop();
      clearScrollTopResidual();
    },
    onGestureStarted: () => {
      if (disposed) return;
      pendingBoundaryArm = needsBoundaryRender;
      onScrollStart?.(getState());
    },
    onGestureSettled: () => {
      if (disposed) return;
      let errors: unknown[] | null = null;
      let flushedLayout = false;
      let flushedMeasurements = false;
      let refreshedPlaceholders = false;
      try {
        flushedLayout = flushDeferredLayoutUpdates();
      } catch (error) {
        errors = appendCollectedError(errors, error);
      }
      if (!disposed) {
        try {
          flushedMeasurements = measurementQueue.flushNow().flushed;
        } catch (error) {
          errors = appendCollectedError(errors, error);
        }
      }
      if (!disposed) {
        try {
          refreshedPlaceholders = runWithPostCommitDrain(
            refreshMountedPlaceholders,
          );
        } catch (error) {
          errors = appendCollectedError(errors, error);
        }
      }
      if (!disposed) {
        try {
          if (
            renderFrame ||
            refreshedPlaceholders ||
            (!flushedLayout && !flushedMeasurements)
          ) {
            renderNow();
          }
        } catch (error) {
          errors = appendCollectedError(errors, error);
        }
      }
      if (!disposed) {
        try {
          onScrollEnd?.(getState());
        } catch (error) {
          errors = appendCollectedError(errors, error);
        }
      }
      if (errors) {
        throwCollectedErrors(errors, "scroll-settle completion failed");
      }
    },
    onGestureReset: () => placeholderMode.clear(),
    onScrollEventObserved: scheduleRender,
    onNativeScrollEndIdle: () => {
      if (mountedPlaceholders.size === 0) return;
      const hydrated = runWithPostCommitDrain(() =>
        placeholderMode.forceHydrate(),
      );
      if (disposed) {
        drainPostCommitTasks();
        return;
      }
      if (hydrated) renderNow(logicalScrollTop());
    },
  });

  viewportResizeObserver.observe(viewport);

  setCount();
  reachCallbacksEnabled = true;

  return {
    get state() {
      return getState();
    },
    invalidateMeasurements,
    interruptScroll,
    setCount,
    syncLayout,
    setBoundarySlot,
    getBoundaryElement,
    setPlaceholderSlot,
    getPlaceholderElement,
    scrollToIndex,
    scrollToOffset,
    scrollToTop,
    scrollToBottom,
    followBottom: (options) => {
      if (!disposed) bottomFollow.follow(options);
    },
    stopFollowBottom: () => bottomFollow.stop(),
    setStickyIndex,
    getMountedElement,
    getItemOffset,
    refreshIndex,
    refreshMounted,
    refreshFrom,
    dispose() {
      if (disposed) return;
      runWithPostCommitDrain(() => {
        disposed = true;
        itemIdentityGeneration++;
        activeSmoothScrollCancel?.();
        activeSmoothScrollCancel = null;
        activeSmoothScrollTarget = null;
        if (renderFrame) {
          cancelAnimationFrame(renderFrame);
          renderFrame = 0;
        }
        measurementQueue.cancelFlush();
        clearPendingMeasurements();
        placeholderMode.dispose();
        bottomFollow.stop();
        scrollSettle.dispose();
        deferredLayoutUpdates.length = 0;
        itemResizeObserver.disconnect();
        viewportResizeObserver.disconnect();
        itemMeasurer?.dispose();
        itemMeasurer = null;

        const ownedItems: ItemRecord[] = Array.from(
          mounted,
          ([index, element]) => ({ index, element }),
        );
        for (const element of recyclePool) {
          ownedItems.push({
            index: Number(element.dataset.index),
            element,
          });
        }
        mounted = new Map();
        mountedPlaceholders = new Set();
        pendingItemBuilds.clear();
        deferredRefreshIndexes.clear();
        deferredRefreshIndexDataGenerations.clear();
        deferredRefreshFrom = null;
        deferredRefreshFromDataGeneration = null;
        deferredMeasurementInvalidation = false;
        renderInterruptedByInternalWork = false;
        recyclePool.length = 0;
        rangeStart = 0;
        rangeEnd = 0;

        viewport.classList.remove("vl-viewport", "vl-scrollbar");
        content.remove();
        discardItems(ownedItems);
      });
    },
  };
}
