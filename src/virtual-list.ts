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
const DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD = 8;
const PLACEHOLDER_VELOCITY_EXIT_RATIO = 0.5;
const PLACEHOLDER_EXIT_SAMPLE_COUNT = 3;
// Float-noise threshold for rewriting a rendered style value (heights, slot
// tops) or re-emitting state: differences at or below this are the same pixel.
const RENDER_EPSILON_PX = 0.01;
// scrollTop writes smaller than this are invisible; skip the forced layout.
const SCROLL_WRITE_EPSILON_PX = 0.5;
// state.atTop / state.atBottom tolerance in logical scroll space.
const AT_EDGE_EPSILON_PX = 1;
// Stick-to-bottom detection tolerance in native scroll space (browsers may
// leave a subpixel-rounded gap after a clamp, so this is looser than the
// logical-space AT_EDGE_EPSILON_PX).
const NATIVE_BOTTOM_EPSILON_PX = 2;
const SCROLL_TOP_RESIDUAL_EPSILON = 0.01;
const MAX_SCROLL_TOP_RESIDUAL = 2;
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
  will-change: scroll-position;
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

export interface VirtualListPixelWindowPlan {
  start: number;
  end: number;
  count: number;
  height: number;
}

export interface VirtualListPixelWindowConfig {
  count: number;
  minimumPx: number;
  getItemHeight: (index: number) => number;
  minItems?: number;
  maxItems?: number;
}

export interface VirtualListPixelWindowFromStartConfig
  extends VirtualListPixelWindowConfig {
  start?: number;
}

export interface VirtualListPixelWindowFromEndConfig
  extends VirtualListPixelWindowConfig {
  end?: number;
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
}

export interface VirtualList {
  readonly state: VirtualListState;

  invalidateMeasurements(): void;
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

export class FenwickTree {
  private readonly tree: Float64Array;
  private logicalSize: number;
  private searchBit: number;

  /** Backing slot count; `append` may grow `size` up to this without a rebuild. */
  readonly capacity: number;

  /** Logical element count — `prefix`/`indexAt` operate on `[0, size)`. */
  get size(): number {
    return this.logicalSize;
  }

  /** Largest power of two <= size (1 when empty); `indexAt`'s first probe. */
  get maxBit(): number {
    return this.searchBit;
  }

  constructor(values: Float64Array, capacity = values.length) {
    this.logicalSize = values.length;
    this.capacity = Math.max(capacity, values.length);
    this.tree = new Float64Array(this.capacity + 1);
    // O(n) build over the full capacity (slots past values.length are zero):
    // seed each node with its value, then fold each node's partial sum into its
    // parent — same result as n add() calls, one log factor cheaper.
    for (let i = 1; i <= this.capacity; i++) {
      this.tree[i] = (this.tree[i] ?? 0) + (values[i - 1] ?? 0);
      const parent = i + (i & -i);
      if (parent <= this.capacity) {
        this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[i] ?? 0);
      }
    }
    let maxBit = 1;
    while (maxBit << 1 <= this.logicalSize) maxBit <<= 1;
    this.searchBit = maxBit;
  }

  add(index: number, delta: number): void {
    // Walk to capacity, not size, so the zero-padding slots stay consistent and
    // append() can activate them later without touching the tree.
    for (let i = index + 1; i <= this.capacity; i += i & -i) {
      this.tree[i] = (this.tree[i] ?? 0) + delta;
    }
  }

  /** Grow the logical size by one, assigning `value` to the new last index. */
  append(value: number): void {
    if (this.logicalSize >= this.capacity) {
      throw new Error("FenwickTree.append: no spare capacity");
    }
    this.logicalSize++;
    if (this.searchBit << 1 <= this.logicalSize) this.searchBit <<= 1;
    this.add(this.logicalSize - 1, value);
  }

  prefix(count: number): number {
    let sum = 0;
    const safeCount = Math.max(0, Math.min(this.logicalSize, count));
    for (let i = safeCount; i > 0; i -= i & -i) {
      sum += this.tree[i] ?? 0;
    }
    return sum;
  }

  total(): number {
    return this.prefix(this.logicalSize);
  }

  indexAt(offset: number): number {
    if (this.logicalSize === 0) return 0;

    let index = 0;
    let sum = 0;

    for (let bit = this.searchBit; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next > this.logicalSize) continue;
      const nextValue = this.tree[next] ?? 0;
      if (sum + nextValue <= offset) {
        index = next;
        sum += nextValue;
      }
    }

    return Math.max(0, Math.min(this.logicalSize - 1, index));
  }
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizedWindowItemLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function shouldCollectPixelWindowItem(
  itemCount: number,
  height: number,
  minimumPx: number,
  minItems: number,
  maxItems: number,
): boolean {
  if (itemCount >= maxItems) return false;
  return itemCount < minItems || height < minimumPx;
}

export function planVirtualListPixelWindowFromEnd(
  config: VirtualListPixelWindowFromEndConfig,
): VirtualListPixelWindowPlan {
  const count = nonNegativeInteger(config.count);
  const end = clamp(normalizedWindowItemLimit(config.end, count), 0, count);
  const minimumPx = nonNegativeSize(config.minimumPx);
  const minItems = normalizedWindowItemLimit(
    config.minItems,
    count > 0 ? 1 : 0,
  );
  const maxItems = Math.max(
    minItems,
    normalizedWindowItemLimit(config.maxItems, count),
  );
  let start = end;
  let height = 0;

  while (
    start > 0 &&
    shouldCollectPixelWindowItem(
      end - start,
      height,
      minimumPx,
      minItems,
      maxItems,
    )
  ) {
    start--;
    height += positiveSize(config.getItemHeight(start));
  }

  return { start, end, count: end - start, height };
}

export function planVirtualListPixelWindowFromStart(
  config: VirtualListPixelWindowFromStartConfig,
): VirtualListPixelWindowPlan {
  const count = nonNegativeInteger(config.count);
  const start = clamp(normalizedWindowItemLimit(config.start, 0), 0, count);
  const minimumPx = nonNegativeSize(config.minimumPx);
  const minItems = normalizedWindowItemLimit(
    config.minItems,
    count > 0 ? 1 : 0,
  );
  const maxItems = Math.max(
    minItems,
    normalizedWindowItemLimit(config.maxItems, count),
  );
  let end = start;
  let height = 0;

  while (
    end < count &&
    shouldCollectPixelWindowItem(
      end - start,
      height,
      minimumPx,
      minItems,
      maxItems,
    )
  ) {
    height += positiveSize(config.getItemHeight(end));
    end++;
  }

  return { start, end, count: end - start, height };
}

function nonNegativeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
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
      const element = prepareMeasuredItem(buildItem(index));
      measureRoot.appendChild(element);
      const height = positiveSize(element.getBoundingClientRect().height);
      measureRoot.replaceChildren();
      destroyItem?.(index, element);
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
  let sizes = new Float64Array(0);
  let measured = new Uint8Array(0);
  let sizeTree = new FenwickTree(sizes);
  let itemSizeTotal = 0;
  let measuredCount = 0;
  let mounted = new Map<number, HTMLElement>();
  let mountedPlaceholders = new Set<number>();
  const recyclePool: HTMLElement[] = [];
  let rangeStart = 0;
  let rangeEnd = 0;
  let renderFrame = 0;
  let measurementFrame = 0;
  let bottomFollowFrame = 0;
  let bottomFollowActive = false;
  let bottomFollowLastFrameAt = 0;
  let bottomFollowDuration = DEFAULT_SMOOTH_SCROLL_DURATION;
  let bottomFollowSnapThreshold = SCROLL_SNAP_THRESHOLD;
  let bottomFollowSignal: AbortSignal | null = null;
  let bottomFollowAbortHandler: (() => void) | null = null;
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
  let placeholderFastMode = false;
  let hydratePlaceholdersBlocked = false;
  let placeholderLowVelocitySamples = 0;
  let placeholderHydrationFrame = 0;
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
  let disposed = false;

  const pendingMeasurements = new Map<number, number>();
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
      if (height !== null) queueMeasurement(index, height);
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
    return (
      nativeMaxScrollTop() - logicalScrollTop() <= NATIVE_BOTTOM_EPSILON_PX
    );
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
    return itemSizeTotal;
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
      wakeBottomFollow();
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

  function ensureBoundarySlot(
    boundary: VirtualListBoundary,
  ): MountedBoundarySlot {
    const current = currentBoundarySlot(boundary);
    if (current) return current;

    const element = document.createElement("div");
    element.classList.add("vl-boundary-slot", `vl-boundary-${boundary}`);

    const next: MountedBoundarySlot = {
      key: null,
      build: null,
      element,
      height: emptyBoundarySlotHeight(boundary),
      renderedHeight: -1,
      renderedTop: -1,
    };
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

    const current = ensureBoundarySlot(boundary);
    const nextKey = String(slot.key);
    const nextHeight = positiveSize(slot.height);
    if (current.key !== nextKey || !current.element.firstChild) {
      current.element.replaceChildren(slot.build());
    }
    current.key = nextKey;
    current.build = slot.build;

    if (Math.abs(current.height - nextHeight) <= RENDER_EPSILON_PX)
      return false;
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

    const scrollTop = logicalScrollTop();
    const slotTop = boundarySlotTop(boundary);
    const visibleHeight =
      Math.min(slotTop + slot.height, scrollTop + lastViewportHeight) -
      Math.max(slotTop, scrollTop);
    if (visibleHeight <= 0) return false;

    return (
      visibleHeight / Math.max(1, slot.height) >=
      BOUNDARY_INTERSECTION_THRESHOLD
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

  function renderPlaceholderSlot(): void {
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
      element = preparePlaceholderSlot(slot);
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
  // With spare tree capacity this is O(appended · log capacity); when full, the
  // arrays regrow with doubling headroom and rebuild once, linearly, so a
  // one-row-at-a-time streaming append stays amortized O(1) per row.
  function appendModeledSizes(previousCount: number, nextCount: number): void {
    if (nextCount > sizeTree.capacity) {
      const capacity = Math.max(nextCount, previousCount * 2);
      const nextSizes = new Float64Array(capacity);
      nextSizes.set(sizes.subarray(0, previousCount));
      const nextMeasured = new Uint8Array(capacity);
      nextMeasured.set(measured.subarray(0, previousCount));
      for (let index = previousCount; index < nextCount; index++) {
        nextSizes[index] = modeledItemHeight(index);
      }
      sizes = nextSizes;
      measured = nextMeasured;
      sizeTree = new FenwickTree(nextSizes.subarray(0, nextCount), capacity);
      itemSizeTotal = sizeTree.total();
      return;
    }

    for (let index = previousCount; index < nextCount; index++) {
      const height = modeledItemHeight(index);
      sizes[index] = height;
      sizeTree.append(height);
      itemSizeTotal += height;
    }
  }

  // NOTE: `sizes`/`measured` may carry spare capacity beyond `count` (append
  // headroom); only `[0, count)` is meaningful. Use `count`, never
  // `sizes.length`, as the logical length.
  function fillSizes(
    nextCount: number,
    addedBefore: number,
    removedBefore: number,
  ): number {
    const previousCount = count;

    // Pure append (or no-op): nothing prepended or removed, so the existing
    // prefix — sizes, measured flags, tree — is kept in place as-is.
    if (
      addedBefore === 0 &&
      removedBefore === 0 &&
      nextCount >= previousCount
    ) {
      if (nextCount === previousCount) return 0;
      appendModeledSizes(previousCount, nextCount);
      markLayoutDirtyFrom(previousCount);
      return 0;
    }

    const previousSizes = sizes;
    const previousMeasured = measured;
    const nextSizes = new Float64Array(nextCount);
    const nextMeasured = new Uint8Array(nextCount);
    const previousStart = Math.min(removedBefore, previousCount);
    const preserved = Math.min(
      Math.max(0, previousCount - previousStart),
      Math.max(0, nextCount - addedBefore),
    );

    measuredCount = 0;
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
        if (previousMeasured[index]) measuredCount++;
      }
    }

    let beforeHeightDelta = 0;
    for (let index = 0; index < previousStart; index++) {
      beforeHeightDelta -= previousSizes[index] ?? 0;
    }

    for (let index = 0; index < addedBefore; index++) {
      const height = modeledItemHeight(index);
      nextSizes[index] = height;
      beforeHeightDelta += height;
    }

    for (let index = addedBefore + preserved; index < nextCount; index++) {
      nextSizes[index] = modeledItemHeight(index);
    }

    sizes = nextSizes;
    measured = nextMeasured;
    sizeTree = new FenwickTree(sizes);
    itemSizeTotal = sizeTree.total();
    markLayoutDirtyFrom(0);
    return beforeHeightDelta;
  }

  function refillModeledSizes(): void {
    const nextSizes = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      nextSizes[index] = modeledItemHeight(index);
    }

    if (measurementFrame) {
      cancelAnimationFrame(measurementFrame);
      measurementFrame = 0;
    }
    pendingMeasurements.clear();
    sizes = nextSizes;
    measured = new Uint8Array(count);
    measuredCount = 0;
    sizeTree = new FenwickTree(sizes);
    itemSizeTotal = sizeTree.total();
    markLayoutDirtyFrom(0);
  }

  function computeRange(
    scrollTop: number,
    viewportHeight = lastViewportHeight,
    overscanPx = Math.max(0, getOverscanPx()),
  ): void {
    if (count === 0) {
      computedRange.start = 0;
      computedRange.end = 0;
      return;
    }
    if (renderMode === "full") {
      computedRange.start = 0;
      computedRange.end = count;
      return;
    }

    const itemScrollTop = scrollTop - topSlotHeight();
    const startTarget = Math.max(0, itemScrollTop - overscanPx);
    const endTarget = Math.min(
      itemTotalSize(),
      itemScrollTop + viewportHeight + overscanPx,
    );
    computedRange.start = Math.max(0, sizeTree.indexAt(startTarget) - 1);
    computedRange.end = Math.min(count, sizeTree.indexAt(endTarget) + 2);
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

  function canMountPlaceholderItems(): boolean {
    return renderMode !== "full" && buildPlaceholder !== undefined;
  }

  function placeholderEnterVelocity(): number {
    const value = getPlaceholderVelocityThreshold();
    if (!Number.isFinite(value)) {
      return value === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD;
    }
    return Math.max(0, value);
  }

  function cancelPlaceholderHydrationCheck(): void {
    if (!placeholderHydrationFrame) return;
    cancelAnimationFrame(placeholderHydrationFrame);
    placeholderHydrationFrame = 0;
  }

  function needsPlaceholderHydrationCheck(): boolean {
    return (
      mountedPlaceholders.size > 0 &&
      (placeholderFastMode || hydratePlaceholdersBlocked)
    );
  }

  function schedulePlaceholderHydrationCheck(): void {
    if (placeholderHydrationFrame || disposed) return;
    if (!needsPlaceholderHydrationCheck()) return;

    placeholderHydrationFrame = requestAnimationFrame(() => {
      placeholderHydrationFrame = 0;
      if (disposed || !needsPlaceholderHydrationCheck()) return;

      renderNow(logicalScrollTop());
      if (needsPlaceholderHydrationCheck()) {
        schedulePlaceholderHydrationCheck();
      }
    });
  }

  function clearPlaceholderFastModeState(): void {
    placeholderFastMode = false;
    hydratePlaceholdersBlocked = false;
    placeholderLowVelocitySamples = 0;
  }

  function disablePlaceholderFastMode(): boolean {
    const hadPlaceholderMounts = mountedPlaceholders.size > 0;
    const wasActive =
      placeholderFastMode || hydratePlaceholdersBlocked || hadPlaceholderMounts;
    clearPlaceholderFastModeState();
    return wasActive ? refreshMountedPlaceholders() : false;
  }

  // Advances the placeholder fast-mode state machine from the current scroll
  // velocity (entering/exiting fast mode, scheduling hydration checks) and
  // returns whether newly mounted items should build as placeholders.
  function updatePlaceholderMode(): boolean {
    if (!canMountPlaceholderItems()) {
      disablePlaceholderFastMode();
      return false;
    }

    const enterVelocity = placeholderEnterVelocity();
    if (enterVelocity === Number.POSITIVE_INFINITY) {
      disablePlaceholderFastMode();
      return false;
    }

    const velocity = scrollSettle.currentVelocity();

    if (isAtNativeScrollBoundary()) {
      disablePlaceholderFastMode();
      return false;
    }

    if (velocity >= enterVelocity) {
      hydratePlaceholdersBlocked = true;
      placeholderFastMode = true;
      placeholderLowVelocitySamples = 0;
      schedulePlaceholderHydrationCheck();
    } else if (placeholderFastMode) {
      const exitVelocity = enterVelocity * PLACEHOLDER_VELOCITY_EXIT_RATIO;
      if (
        scrollSettle.lastSampleDelta() > measureEpsilon &&
        velocity <= exitVelocity
      ) {
        placeholderLowVelocitySamples++;
      } else if (scrollSettle.lastSampleDelta() > measureEpsilon) {
        placeholderLowVelocitySamples = 0;
      }
      if (placeholderLowVelocitySamples >= PLACEHOLDER_EXIT_SAMPLE_COUNT) {
        hydratePlaceholdersBlocked = false;
        placeholderFastMode = false;
        placeholderLowVelocitySamples = 0;
      } else {
        schedulePlaceholderHydrationCheck();
      }
    } else {
      placeholderFastMode = false;
    }

    return placeholderFastMode;
  }

  function mountItem(
    index: number,
    usePlaceholder: boolean,
    offset = topSlotHeight(),
  ): HTMLElement {
    const element =
      usePlaceholder && buildPlaceholder
        ? prepareItem(index, buildPlaceholder(index), offset)
        : prepareItem(index, acquireElement(index), offset);

    if (usePlaceholder && buildPlaceholder) {
      element.dataset.placeholder = "true";
      mountedPlaceholders.add(index);
      schedulePlaceholderHydrationCheck();
    } else {
      itemResizeObserver.observe(element);
      mountedPlaceholders.delete(index);
    }

    return element;
  }

  function refreshMountedPlaceholder(index: number): boolean {
    const previous = mounted.get(index);
    if (!previous) {
      mountedPlaceholders.delete(index);
      return false;
    }

    const next = prepareItem(index, acquireElement(index));
    itemResizeObserver.observe(next);
    previous.replaceWith(next);
    itemResizeObserver.unobserve(previous);
    mounted.set(index, next);
    mountedPlaceholders.delete(index);
    return true;
  }

  function refreshMountedPlaceholders(): boolean {
    if (mountedPlaceholders.size === 0) return false;

    let refreshed = false;
    for (const index of Array.from(mountedPlaceholders)) {
      if (refreshMountedPlaceholder(index)) {
        refreshed = true;
      }
    }
    return refreshed;
  }

  function forceHydratePlaceholders(): boolean {
    clearPlaceholderFastModeState();
    return refreshMountedPlaceholders();
  }

  function syncRenderChrome(): number {
    if (needsAuxiliaryChrome()) {
      if (needsBoundaryRender) ensureReachBoundarySlots();
      const totalSize = syncContentHeight();
      renderBoundarySlots();
      renderPlaceholderSlot();
      return totalSize;
    }
    return syncContentHeight();
  }

  function notifyDestroyItem(index: number, element: HTMLElement): void {
    if (!destroyItem) return;
    if (element.dataset.placeholder === "true") return;
    destroyItem(index, element);
  }

  function discardElement(index: number, element: HTMLElement): void {
    itemResizeObserver.unobserve(element);
    notifyDestroyItem(index, element);
    element.remove();
  }

  function recyclePoolCapacity(): number {
    const configured = config.recyclePoolSize;
    if (configured !== undefined) return Math.max(0, Math.floor(configured));
    return Math.max(DEFAULT_RECYCLE_POOL_FLOOR, rangeEnd - rangeStart);
  }

  function trimRecyclePool(): void {
    const capacity = recyclePoolCapacity();
    while (recyclePool.length > capacity) {
      const evicted = recyclePool.shift();
      if (!evicted) break;
      notifyDestroyItem(Number(evicted.dataset.index), evicted);
    }
  }

  // Pool a real (non-placeholder) element for reuse when recycling is enabled;
  // otherwise discard it. Mirrors discardElement's call sites so every
  // permanent-detach path participates in the pool.
  function recycleOrDiscard(index: number, element: HTMLElement): void {
    if (recycleItem && element.dataset.placeholder !== "true") {
      itemResizeObserver.unobserve(element);
      element.remove();
      recyclePool.push(element);
      trimRecyclePool();
      return;
    }
    discardElement(index, element);
  }

  // Reuse a pooled element (re-bound via recycleItem) or build a fresh one.
  function acquireElement(index: number): HTMLElement {
    if (recycleItem) {
      const pooled = recyclePool.pop();
      if (pooled) {
        recycleItem(index, pooled);
        return pooled;
      }
    }
    return buildItem(index);
  }

  function unmountIndex(index: number): void {
    const element = mounted.get(index);
    if (!element) return;
    recycleOrDiscard(index, element);
    mounted.delete(index);
    mountedPlaceholders.delete(index);
  }

  function rangeFullyMounted(start: number, end: number): boolean {
    if (end <= start) return mounted.size === 0;
    if (mounted.size !== end - start) return false;
    for (let index = start; index < end; index++) {
      if (!mounted.has(index)) return false;
    }
    return true;
  }

  function render(explicitScrollTop = logicalScrollTop()): void {
    if (disposed) return;
    renderPass(explicitScrollTop);
    // After the pass, so reach callbacks observe settled chrome and any layout
    // they trigger re-enters via scheduleRender instead of recursing (the
    // emittingChangeCallback guard in applyLayoutUpdate).
    syncBoundaryReach();
  }

  function renderPass(explicitScrollTop: number): void {
    if (pendingBoundaryArm && needsBoundaryRender) {
      pendingBoundaryArm = false;
      armCoveredBoundaryForScroll("top");
      armCoveredBoundaryForScroll("bottom");
    }

    const totalSize = syncRenderChrome();
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
    const mountPlaceholders = updatePlaceholderMode();
    rangeStart = start;
    rangeEnd = end;

    if (
      start === previousStart &&
      end === previousEnd &&
      rangeFullyMounted(start, end)
    ) {
      // Entering fast mode does NOT placeholderize items already on screen —
      // that caused a visible flash. Newly mounted items below already build as
      // placeholders via mountItem(.., mountPlaceholders, ..). On exit, hydrate
      // any placeholders that survived back into real items.
      const refreshedMountedItems =
        !mountPlaceholders &&
        !hydratePlaceholdersBlocked &&
        refreshMountedPlaceholders();
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

    if (!mountPlaceholders && !hydratePlaceholdersBlocked) {
      refreshMountedPlaceholders();
    }

    let newItems: DocumentFragment | null = null;
    for (let index = start; index < end; index++) {
      let element = mounted.get(index);
      if (!element) {
        element = mountItem(index, mountPlaceholders, itemOffset);
        newItems ??= document.createDocumentFragment();
        newItems.appendChild(element);
        mounted.set(index, element);
      } else if (index >= dirtyFrom) {
        positionItem(index, element, itemOffset);
      }
    }
    if (newItems) content.appendChild(newItems);

    firstDirtyIndex = Number.POSITIVE_INFINITY;
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

  function syncScrollSurface(): void {
    ensureReachBoundarySlots();
    syncContentHeight();
    renderBoundarySlots();
    renderPlaceholderSlot();
  }

  function queueMeasurement(index: number, height: number): void {
    if (
      !Number.isFinite(height) ||
      height <= 0 ||
      index < 0 ||
      index >= count
    ) {
      return;
    }
    pendingMeasurements.set(index, positiveSize(height));
    if (scrollSettle.isUserScrollActive()) return;
    scheduleMeasurementFlush();
  }

  function scheduleMeasurementFlush(): void {
    if (measurementFrame || disposed) return;
    measurementFrame = requestAnimationFrame(runScheduledMeasurementFlush);
  }

  // rAF body for the deferred measurement flush. While bottom-follow is
  // animating (e.g. streaming follow) it already drains pending measurements via
  // flushMeasurementsNow and runs a single scroll+render pass per frame, so hand
  // off to it instead of running a second flush+scroll+render the same frame.
  function runScheduledMeasurementFlush(): void {
    measurementFrame = 0;
    if (bottomFollowActive && !scrollSettle.isUserScrollActive()) {
      wakeBottomFollow();
      return;
    }
    flushMeasurements();
  }

  function flushMeasurementsNow(): boolean {
    if (pendingMeasurements.size === 0 || scrollSettle.isUserScrollActive()) {
      return false;
    }
    if (measurementFrame) {
      cancelAnimationFrame(measurementFrame);
      measurementFrame = 0;
    }
    flushMeasurements();
    return true;
  }

  function commitMeasurement(
    index: number,
    height: number,
    anchorIndex: number,
  ): number | null {
    const previous = sizes[index];
    if (previous === undefined) return null;

    if (!measured[index]) {
      measured[index] = 1;
      measuredCount++;
    }

    const delta = height - previous;
    if (Math.abs(delta) <= measureEpsilon) return null;

    sizes[index] = height;
    sizeTree.add(index, delta);
    itemSizeTotal += delta;
    markLayoutDirtyFrom(index + 1);

    return index < anchorIndex ? delta : 0;
  }

  // Shared tail of a committed height change: re-sync the content height, keep
  // the viewport anchored (stick to the bottom, or offset by the height change
  // above the anchor), and re-render.
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
    renderNow(logicalScrollTop());
  }

  function flushMeasurements(): void {
    measurementFrame = 0;
    if (pendingMeasurements.size === 0) return;
    if (scrollSettle.isUserScrollActive()) return;

    const wasAtBottom = nearNativeBottom();
    const hadStickyTail = stickyIndex !== null || tailGap > 0;
    const anchorIndex = sizeTree.indexAt(
      Math.max(0, logicalScrollTop() - topSlotHeight()),
    );
    let changed = false;
    let correction = 0;

    for (const [index, height] of pendingMeasurements) {
      pendingMeasurements.delete(index);
      const correctionDelta = commitMeasurement(index, height, anchorIndex);
      if (correctionDelta === null) continue;
      changed = true;
      correction += correctionDelta;
    }

    if (!changed) {
      emitViewportChange();
      return;
    }

    applyMeasurementCorrection(wasAtBottom, hadStickyTail, correction);
  }

  function commitExplicitMeasurement(index: number, height: number): void {
    if (
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
      queueMeasurement(index, height);
      return;
    }

    pendingMeasurements.delete(index);
    const correction = commitMeasurement(index, height, anchorIndex);
    if (correction === null) {
      emitViewportChange();
      return;
    }

    applyMeasurementCorrection(wasAtBottom, hadStickyTail, correction);
  }

  function scrollTopForIndex(
    index: number,
    align: VirtualListAlign = "top",
  ): number {
    const itemTop = topSlotHeight() + sizeTree.prefix(index);
    const itemHeight = sizes[index] ?? modeledItemHeight(index);
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
    activeSmoothScrollCancel?.();
    const hydratedPlaceholders = forceHydratePlaceholders();
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
        } else {
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

  function clearBottomFollowSignal(): void {
    if (bottomFollowSignal && bottomFollowAbortHandler) {
      bottomFollowSignal.removeEventListener("abort", bottomFollowAbortHandler);
    }
    bottomFollowSignal = null;
    bottomFollowAbortHandler = null;
  }

  function stopFollowBottom(): void {
    bottomFollowActive = false;
    if (bottomFollowFrame) {
      cancelAnimationFrame(bottomFollowFrame);
      bottomFollowFrame = 0;
    }
    clearBottomFollowSignal();
    // Drain any measurements that were deferred to the follow loop while it ran.
    if (pendingMeasurements.size > 0) scheduleMeasurementFlush();
  }

  function wakeBottomFollow(): void {
    if (
      !bottomFollowActive ||
      disposed ||
      scrollSettle.isUserScrollActive() ||
      bottomFollowSignal?.aborted ||
      count <= 0
    ) {
      return;
    }
    scheduleBottomFollowFrame();
  }

  function bottomFollowFrameProgress(now: number): number {
    const previousFrameAt = bottomFollowLastFrameAt || now;
    bottomFollowLastFrameAt = now;
    const elapsed = Math.max(0, now - previousFrameAt);
    const duration = Math.max(1, bottomFollowDuration);
    if (duration <= 1) return 1;

    return clamp(1 - 0.01 ** (elapsed / duration), 0, 1);
  }

  function scheduleBottomFollowFrame(): void {
    if (bottomFollowFrame || disposed) return;
    bottomFollowFrame = requestAnimationFrame(tickBottomFollow);
  }

  function tickBottomFollow(now: number): void {
    bottomFollowFrame = 0;
    if (
      disposed ||
      !bottomFollowActive ||
      scrollSettle.isUserScrollActive() ||
      bottomFollowSignal?.aborted ||
      count <= 0
    ) {
      stopFollowBottom();
      return;
    }

    const flushedMeasurements = flushMeasurementsNow();
    syncContentHeight();

    const target = nativeMaxScrollTop();

    const distance = Math.abs(viewport.scrollTop - target);
    if (distance <= bottomFollowSnapThreshold) {
      const didScroll = setScrollTop(target, ALLOW_DURING_SCROLL);
      if (didScroll || flushedMeasurements) {
        renderNow(viewport.scrollTop);
      }
      if (Math.abs(viewport.scrollTop - target) <= bottomFollowSnapThreshold) {
        return;
      }
      bottomFollowLastFrameAt = now;
      scheduleBottomFollowFrame();
      return;
    }

    const progress = bottomFollowFrameProgress(now);
    const nextTop =
      viewport.scrollTop + (target - viewport.scrollTop) * progress;
    if (setScrollTop(nextTop, ALLOW_DURING_SCROLL)) {
      renderNow(viewport.scrollTop);
    }
    scheduleBottomFollowFrame();
  }

  function followBottom(options: VirtualListScrollOptions = {}): void {
    stopFollowBottom();
    if (count <= 0 || options.signal?.aborted) return;

    syncContentHeight();
    const snapThreshold = options.snapThreshold ?? SCROLL_SNAP_THRESHOLD;

    bottomFollowDuration = Math.max(
      1,
      options.behavior === "smooth"
        ? (options.duration ?? DEFAULT_SMOOTH_SCROLL_DURATION)
        : 1,
    );
    bottomFollowSnapThreshold = snapThreshold;
    bottomFollowActive = true;
    bottomFollowSignal = options.signal ?? null;
    if (bottomFollowSignal) {
      bottomFollowAbortHandler = stopFollowBottom;
      bottomFollowSignal.addEventListener("abort", bottomFollowAbortHandler, {
        once: true,
      });
    }
    bottomFollowLastFrameAt = performance.now();
    scheduleBottomFollowFrame();
  }

  async function scrollToIndex(
    index: number,
    align: VirtualListAlign = "top",
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    flushDeferredLayoutBeforeProgrammaticOperation();
    stopFollowBottom();
    if (count <= 0 || options.signal?.aborted) return false;
    const targetIndex = clamp(Math.floor(index), 0, count - 1);
    syncScrollSurface();
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
    renderNow(viewport.scrollTop);
    emitVisibleBoundaryReach(boundary);
    clearProgrammaticBoundaryReach(boundary);
    return ok;
  }

  async function scrollToOffset(
    offset: number,
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    flushDeferredLayoutBeforeProgrammaticOperation();
    stopFollowBottom();
    if (options.signal?.aborted) return false;
    clearProgrammaticBoundaryReach();
    syncScrollSurface();
    const ok = await scrollToNativeTop(offset, options);
    renderNow(viewport.scrollTop);
    return ok;
  }

  async function scrollToTop(
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    flushDeferredLayoutBeforeProgrammaticOperation();
    stopFollowBottom();
    if (options.signal?.aborted) return false;
    syncScrollSurface();
    armProgrammaticBoundaryReach("top");
    const ok = await scrollToNativeTop(0, options);
    renderNow(viewport.scrollTop);
    emitVisibleBoundaryReach("top");
    clearProgrammaticBoundaryReach("top");
    return ok;
  }

  async function scrollToBottom(
    options: VirtualListScrollOptions = {},
  ): Promise<boolean> {
    flushDeferredLayoutBeforeProgrammaticOperation();
    stopFollowBottom();
    // Commit any settled-but-unflushed row heights so the target is the true
    // content bottom. Without this, a streaming row that just swapped from the
    // (throttled, lagging) live viewer to its taller final static render can
    // leave its measurement queued, and we'd scroll to the shorter old height.
    flushMeasurementsNow();
    if (options.signal?.aborted) return false;
    syncScrollSurface();
    armProgrammaticBoundaryReach("bottom");
    const ok = await scrollToNativeTop(nativeMaxScrollTop(), options);
    renderNow(viewport.scrollTop);
    emitVisibleBoundaryReach("bottom");
    clearProgrammaticBoundaryReach("bottom");
    return ok;
  }

  function setStickyIndex(index: number | null): void {
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
      destroyItem,
    });
    return itemMeasurer.measure(index);
  }

  function refreshIndex(index: number): void {
    const targetIndex = Math.floor(index);
    if (
      !Number.isFinite(targetIndex) ||
      targetIndex < 0 ||
      targetIndex >= count
    ) {
      return;
    }

    const previous = mounted.get(targetIndex);
    if (!previous) {
      commitExplicitMeasurement(targetIndex, measureUnmountedItem(targetIndex));
      return;
    }

    const next = prepareItem(targetIndex, buildItem(targetIndex));
    itemResizeObserver.observe(next);
    previous.replaceWith(next);
    itemResizeObserver.unobserve(previous);
    notifyDestroyItem(targetIndex, previous);
    mounted.set(targetIndex, next);
    mountedPlaceholders.delete(targetIndex);
    emitViewportChange();
  }

  function refreshFrom(index: number): void {
    const from = Math.floor(index);
    // Snapshot the keys: refreshIndex replaces a mounted element in place
    // (same key), so iterating a copy is safe and only the suffix is rebuilt.
    for (const mountedIndex of Array.from(mounted.keys())) {
      if (mountedIndex >= from) refreshIndex(mountedIndex);
    }
  }

  function refreshMounted(): void {
    refreshFrom(0);
  }

  function reindexMounted(addedBefore: number, removedBefore: number): void {
    if (mounted.size === 0) return;

    const nextMounted = new Map<number, HTMLElement>();
    const nextMountedPlaceholders = new Set<number>();
    for (const [index, element] of mounted) {
      if (index < removedBefore) {
        recycleOrDiscard(index, element);
        mountedPlaceholders.delete(index);
        continue;
      }

      const nextIndex = index - removedBefore + addedBefore;
      if (nextIndex < 0 || nextIndex >= count) {
        recycleOrDiscard(index, element);
        mountedPlaceholders.delete(index);
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
  }

  function removePendingMeasurementsOutsideCount(): void {
    for (const index of pendingMeasurements.keys()) {
      if (index >= count) pendingMeasurements.delete(index);
    }
  }

  function flushDeferredLayoutUpdates(): boolean {
    if (deferredLayoutUpdates.length === 0) return false;

    const updates = deferredLayoutUpdates.splice(0);
    for (const update of updates) {
      applyLayoutUpdate(update);
    }
    return true;
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
    if (update.apply?.() === false) return;

    ensureReachBoundarySlots();
    const nextCount = nonNegativeInteger(getCount());
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
    applyBoundarySlotUpdate("top", update.topSlot);
    applyBoundarySlotUpdate("bottom", update.bottomSlot);
    applyPlaceholderSlotUpdate(update.placeholderSlot);
    const beforeHeightDelta = shouldRefreshSizes
      ? fillSizes(nextCount, addedBefore, removedBefore)
      : 0;
    count = nextCount;

    if (isWindowShift) {
      pendingMeasurements.clear();
      if (stickyIndex !== null) {
        const nextStickyIndex = stickyIndex + addedBefore - removedBefore;
        stickyIndex =
          count > 0 && nextStickyIndex >= 0 && nextStickyIndex < count
            ? nextStickyIndex
            : null;
      }
    } else {
      removePendingMeasurementsOutsideCount();
    }

    recomputeTailGap();
    syncContentHeight();
    const topSlotDelta =
      addedBefore > 0 || removedBefore > 0
        ? topSlotHeight() - previousTopSlotHeight
        : 0;
    const nextScrollTop = previousScrollTop + beforeHeightDelta + topSlotDelta;
    const hasScrollTarget =
      Math.abs(nextScrollTop - previousScrollTop) > measureEpsilon;

    if (isWindowShift) {
      reindexMounted(addedBefore, removedBefore);
    } else {
      for (const [index, element] of mounted) {
        if (index >= count) {
          recycleOrDiscard(index, element);
          mounted.delete(index);
          mountedPlaceholders.delete(index);
        }
      }
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
    update.after?.();
  }

  function syncLayout(update: VirtualListLayoutUpdate = {}): void {
    if (shouldDeferLayoutUpdate(update)) {
      deferredLayoutUpdates.push(update);
      return;
    }
    applyLayoutUpdate(update);
  }

  function setCount(options?: VirtualListSetCountOptions): void {
    syncLayout(options);
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
    return currentBoundarySlot(boundary)?.element ?? null;
  }

  function setPlaceholderSlot(slot: VirtualListPlaceholderSlot | null): void {
    syncLayout({ placeholderSlot: slot });
  }

  function getPlaceholderElement(): HTMLElement | null {
    return placeholderSlot?.element ?? null;
  }

  function invalidateMeasurements(): void {
    lastViewportWidth = viewport.clientWidth;
    lastViewportHeight = viewport.clientHeight;
    const previousScrollTop = logicalScrollTop();
    const previousItemOffset = Math.max(0, previousScrollTop - topSlotHeight());
    const anchorIndex =
      count > 0 ? clamp(sizeTree.indexAt(previousItemOffset), 0, count - 1) : 0;
    const anchorOffset =
      count > 0
        ? Math.max(0, previousItemOffset - sizeTree.prefix(anchorIndex))
        : 0;
    const wasAtBottom = nearNativeBottom();

    refillModeledSizes();
    recomputeTailGap();
    const totalSize = syncContentHeight();

    if (count > 0) {
      const nextScrollTop = wasAtBottom
        ? Math.max(0, totalSize - lastViewportHeight)
        : topSlotHeight() + sizeTree.prefix(anchorIndex) + anchorOffset;
      setScrollTop(nextScrollTop, PRESERVE_LOGICAL_SCROLL_OFFSET);
    }

    renderNow(logicalScrollTop());
  }

  function isAtNativeScrollBoundary(scrollTop = viewport.scrollTop): boolean {
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop <= measureEpsilon || maxScrollTop - scrollTop <= measureEpsilon
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

  const scrollSettle = createScrollSettleController({
    viewport,
    strategy: config.scrollSettleStrategy ?? detectScrollSettleStrategy(),
    measureEpsilon,
    isDisposed: () => disposed,
    cancelActiveSmoothScroll: () => {
      activeSmoothScrollCancel?.();
    },
    smoothScrollReachedTarget: activeSmoothScrollReachedTarget,
    onGestureActivity: () => {
      stopFollowBottom();
      clearScrollTopResidual();
    },
    onGestureStarted: () => {
      pendingBoundaryArm = needsBoundaryRender;
      onScrollStart?.(getState());
    },
    onGestureSettled: () => {
      const flushedLayout = flushDeferredLayoutUpdates();
      const flushedMeasurements = flushMeasurementsNow();
      const refreshedPlaceholders = refreshMountedPlaceholders();
      if (refreshedPlaceholders || (!flushedLayout && !flushedMeasurements)) {
        renderNow(viewport.scrollTop);
      }
      onScrollEnd?.(getState());
    },
    onGestureReset: clearPlaceholderFastModeState,
    onScrollEventObserved: scheduleRender,
    onNativeScrollEndIdle: () => {
      if (mountedPlaceholders.size === 0) return;
      if (forceHydratePlaceholders()) renderNow(logicalScrollTop());
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
    followBottom,
    stopFollowBottom,
    setStickyIndex,
    getMountedElement,
    getItemOffset,
    refreshIndex,
    refreshMounted,
    refreshFrom,
    dispose() {
      disposed = true;
      if (renderFrame) cancelAnimationFrame(renderFrame);
      if (measurementFrame) cancelAnimationFrame(measurementFrame);
      cancelPlaceholderHydrationCheck();
      stopFollowBottom();
      scrollSettle.dispose();
      deferredLayoutUpdates.length = 0;
      itemResizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      itemMeasurer?.dispose();
      viewport.classList.remove("vl-viewport", "vl-scrollbar");
      for (const [index, element] of mounted) {
        notifyDestroyItem(index, element);
      }
      for (const element of recyclePool) {
        notifyDestroyItem(Number(element.dataset.index), element);
      }
      recyclePool.length = 0;
      content.remove();
      mounted.clear();
      mountedPlaceholders.clear();
    },
  };
}
