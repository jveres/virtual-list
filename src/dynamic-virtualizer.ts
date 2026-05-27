const STYLE_ID = "dynamic-virtualizer-styles";
const DEFAULT_OVERSCAN_PX = 900;
const DEFAULT_MEASURE_EPSILON = 0.5;
const SCROLL_SNAP_THRESHOLD = 1;
const DEFAULT_BOUNDARY_SENTINEL_HEIGHT = 1;
const BOUNDARY_INTERSECTION_THRESHOLD = 0.01;
const DEFAULT_RENDER_DRIFT_EPSILON = 1;
const DEFAULT_SMOOTH_SCROLL_DURATION = 300;
const DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD = 8;
const PLACEHOLDER_VELOCITY_EXIT_RATIO = 0.5;
const PLACEHOLDER_EXIT_SAMPLE_COUNT = 3;
const SCROLL_SETTLE_COOLDOWN_MS = 140;
const WHEEL_INPUT_IDLE_MS = SCROLL_SETTLE_COOLDOWN_MS;
const CHROMIUM_EDGE_SETTLE_QUIET_MS = 450;
const SCROLL_TOP_RESIDUAL_EPSILON = 0.01;
const MAX_SCROLL_TOP_RESIDUAL = 2;
const CSS = `
.dv-viewport {
  overflow-y: auto;
  overscroll-behavior-y: contain;
  overflow-anchor: none;
  -webkit-overflow-scrolling: touch;
}
.minimal-scrollbar {
  isolation: isolate;
  scrollbar-gutter: stable both-edges;
  scrollbar-width: thin;
  will-change: scroll-position;
}
.dv-content {
  position: relative;
  width: 100%;
  min-height: 100%;
  overflow-anchor: none;
}
.dv-item {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  contain: layout paint;
  overflow-anchor: none;
}
.dv-boundary-slot {
  position: absolute;
  left: 0;
  right: 0;
  overflow-anchor: none;
}
.dv-placeholder-slot {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  overflow-anchor: none;
}
`;

export type DynamicVirtualizerAlign = "top" | "center" | "bottom" | number;
export type DynamicVirtualizerBoundary = "top" | "bottom";
export type DynamicVirtualizerRenderMode = "virtual" | "full";
export type DynamicVirtualizerNumberOption = number | (() => number);

export interface DynamicVirtualizerConfig {
  viewport: HTMLElement;
  canvasClassName?: string;
  getCount: () => number;
  getItemHeight: (index: number) => number;
  buildItem: (index: number) => HTMLElement;
  buildPlaceholder?: (index: number) => HTMLElement;
  placeholderVelocityThreshold?: DynamicVirtualizerNumberOption;
  overscanPx?: number | (() => number);
  renderMode?: DynamicVirtualizerRenderMode;
  measureEpsilon?: number;
  debugRenderDrift?: boolean | DynamicVirtualizerRenderDriftReporter;
  onRangeChange?: (state: DynamicVirtualizerState) => void;
  onReachTop?: (state: DynamicVirtualizerState) => void;
  onReachBottom?: (state: DynamicVirtualizerState) => void;
  onScrollStart?: (state: DynamicVirtualizerState) => void;
  onScrollEnd?: (state: DynamicVirtualizerState) => void;
}

export interface DynamicVirtualizerItemMeasurerConfig {
  viewport: HTMLElement;
  canvasClassName?: string;
  buildItem: (index: number) => HTMLElement;
}

export interface DynamicVirtualizerMeasureItemConfig
  extends DynamicVirtualizerItemMeasurerConfig {
  index: number;
}

export interface DynamicVirtualizerItemMeasurer {
  measure(index: number): number;
  dispose(): void;
}

export interface DynamicVirtualizerScrollOptions {
  behavior?: ScrollBehavior;
  duration?: number;
  signal?: AbortSignal;
  snapThreshold?: number;
}

export interface DynamicVirtualizerSetCountOptions {
  addedBefore?: number;
  removedBefore?: number;
}

export interface DynamicVirtualizerBoundarySlot {
  key: string;
  height: number;
  build: () => HTMLElement;
}

export interface DynamicVirtualizerPlaceholderSlot {
  key: string;
  build: () => HTMLElement;
}

export interface DynamicVirtualizerLayoutUpdate
  extends DynamicVirtualizerSetCountOptions {
  topSlot?: DynamicVirtualizerBoundarySlot | null;
  bottomSlot?: DynamicVirtualizerBoundarySlot | null;
  placeholderSlot?: DynamicVirtualizerPlaceholderSlot | null;
  apply?: () => boolean | undefined;
  after?: () => void;
}

export interface DynamicVirtualizerPixelWindowPlan {
  start: number;
  end: number;
  count: number;
  height: number;
}

export interface DynamicVirtualizerPixelWindowConfig {
  count: number;
  minimumPx: number;
  getItemHeight: (index: number) => number;
  minItems?: number;
  maxItems?: number;
}

export interface DynamicVirtualizerPixelWindowFromStartConfig
  extends DynamicVirtualizerPixelWindowConfig {
  start?: number;
}

export interface DynamicVirtualizerPixelWindowFromEndConfig
  extends DynamicVirtualizerPixelWindowConfig {
  end?: number;
}

export interface DynamicVirtualizerState {
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

export interface DynamicVirtualizerRenderDrift {
  index: number;
  actualHeight: number;
  expectedHeight: number;
  heightDrift: number;
  actualTop: number;
  expectedTop: number;
  topDrift: number;
}

export type DynamicVirtualizerRenderDriftReporter = (
  drifts: readonly DynamicVirtualizerRenderDrift[],
) => void;

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

type ScrollSettleStrategy =
  | "default"
  | "chromium-wheel"
  | "firefox-wheel"
  | "safari-wheel";

interface MountedBoundarySlot {
  key: string | null;
  build: (() => HTMLElement) | null;
  element: HTMLElement;
  height: number;
  renderedHeight: number;
  renderedTop: number;
  observed: boolean;
}

interface MountedPlaceholderSlot extends DynamicVirtualizerPlaceholderSlot {
  element: HTMLElement | null;
  renderedHeight: number;
}

export interface DynamicVirtualizer {
  readonly state: DynamicVirtualizerState;

  invalidateMeasurements(): void;
  setCount(options?: DynamicVirtualizerSetCountOptions): void;
  syncLayout(update?: DynamicVirtualizerLayoutUpdate): void;
  setBoundarySlot(
    boundary: DynamicVirtualizerBoundary,
    slot: DynamicVirtualizerBoundarySlot | null,
  ): void;
  getBoundaryElement(boundary: DynamicVirtualizerBoundary): HTMLElement | null;
  setPlaceholderSlot(slot: DynamicVirtualizerPlaceholderSlot | null): void;
  getPlaceholderElement(): HTMLElement | null;
  scrollToIndex(
    index: number,
    align?: DynamicVirtualizerAlign,
    options?: DynamicVirtualizerScrollOptions,
  ): Promise<boolean>;
  scrollToOffset(
    offset: number,
    options?: DynamicVirtualizerScrollOptions,
  ): Promise<boolean>;
  scrollToTop(options?: DynamicVirtualizerScrollOptions): Promise<boolean>;
  scrollToBottom(options?: DynamicVirtualizerScrollOptions): Promise<boolean>;
  followBottom(options?: DynamicVirtualizerScrollOptions): void;
  stopFollowBottom(): void;
  setStickyIndex(index: number | null): void;
  getMountedElement(index: number): HTMLElement | null;
  refreshIndex(index: number): void;
  refreshMounted(): void;
  dispose(): void;
}

export class FenwickTree {
  private readonly tree: Float64Array;

  readonly size: number;
  readonly maxBit: number;

  constructor(values: Float64Array) {
    this.size = values.length;
    this.tree = new Float64Array(this.size + 1);
    for (let index = 0; index < values.length; index++) {
      this.add(index, values[index] ?? 0);
    }
    let maxBit = 1;
    while (maxBit << 1 <= this.size) maxBit <<= 1;
    this.maxBit = maxBit;
  }

  add(index: number, delta: number): void {
    for (let i = index + 1; i <= this.size; i += i & -i) {
      this.tree[i] = (this.tree[i] ?? 0) + delta;
    }
  }

  prefix(count: number): number {
    let sum = 0;
    const safeCount = Math.max(0, Math.min(this.size, count));
    for (let i = safeCount; i > 0; i -= i & -i) {
      sum += this.tree[i] ?? 0;
    }
    return sum;
  }

  total(): number {
    return this.prefix(this.size);
  }

  indexAt(offset: number): number {
    if (this.size === 0) return 0;

    let index = 0;
    let sum = 0;

    for (let bit = this.maxBit; bit > 0; bit >>= 1) {
      const next = index + bit;
      const nextValue = this.tree[next] ?? 0;
      if (next <= this.size && sum + nextValue <= offset) {
        index = next;
        sum += nextValue;
      }
    }

    return Math.max(0, Math.min(this.size - 1, index));
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

export function planDynamicVirtualizerPixelWindowFromEnd(
  config: DynamicVirtualizerPixelWindowFromEndConfig,
): DynamicVirtualizerPixelWindowPlan {
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

export function planDynamicVirtualizerPixelWindowFromStart(
  config: DynamicVirtualizerPixelWindowFromStartConfig,
): DynamicVirtualizerPixelWindowPlan {
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
  element.classList.remove("dv-item");
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
  measureRoot.className = "dv-content";
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

export function createDynamicVirtualizerItemMeasurer(
  config: DynamicVirtualizerItemMeasurerConfig,
): DynamicVirtualizerItemMeasurer {
  injectStyles();
  const { viewport, canvasClassName, buildItem } = config;
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
      return height;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      measureRoot.remove();
    },
  };
}

export function measureDynamicVirtualizerItem(
  config: DynamicVirtualizerMeasureItemConfig,
): number {
  const { index, ...measurerConfig } = config;
  const measurer = createDynamicVirtualizerItemMeasurer(measurerConfig);
  try {
    return measurer.measure(index);
  } finally {
    measurer.dispose();
  }
}

function detectScrollSettleStrategy(): ScrollSettleStrategy {
  const userAgent = navigator.userAgent;
  if (/\bFirefox\//.test(userAgent)) return "firefox-wheel";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) {
    return "safari-wheel";
  }
  return /\b(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
    ? "chromium-wheel"
    : "default";
}

export function createDynamicVirtualizer(
  config: DynamicVirtualizerConfig,
): DynamicVirtualizer {
  injectStyles();

  const {
    viewport,
    canvasClassName,
    buildItem,
    buildPlaceholder,
    getCount,
    getItemHeight,
    onRangeChange,
    onReachTop,
    onReachBottom,
    onScrollStart,
    onScrollEnd,
  } = config;

  const overscanPx = config.overscanPx;
  const staticOverscanPx =
    typeof overscanPx === "function"
      ? null
      : (overscanPx ?? DEFAULT_OVERSCAN_PX);
  const getOverscanPx: () => number =
    staticOverscanPx === null
      ? (overscanPx as () => number)
      : () => staticOverscanPx;
  const needsBoundaryRender = Boolean(onReachTop || onReachBottom);
  const placeholderVelocityThresholdOption =
    config.placeholderVelocityThreshold;
  const getPlaceholderVelocityThreshold: () => number =
    typeof placeholderVelocityThresholdOption === "function"
      ? placeholderVelocityThresholdOption
      : () =>
          placeholderVelocityThresholdOption ??
          DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD;
  const renderMode = config.renderMode ?? "virtual";
  const measureEpsilon = config.measureEpsilon ?? DEFAULT_MEASURE_EPSILON;
  const scrollSettleStrategy = detectScrollSettleStrategy();
  const urlSearchParams = new URLSearchParams(window.location.search);
  const debugScrollSettle = urlSearchParams.has("debugScrollSettle");
  const debugPlaceholder =
    urlSearchParams.has("debugPlaceholder") ||
    urlSearchParams.has("debugPlaceholders");
  const renderDriftReporter =
    typeof config.debugRenderDrift === "function"
      ? config.debugRenderDrift
      : config.debugRenderDrift === true
        ? (drifts: readonly DynamicVirtualizerRenderDrift[]) => {
            console.warn("[dynamic-virtualizer] render drift", drifts);
          }
        : null;
  let count = 0;
  let sizes = new Float64Array(0);
  let measured = new Uint8Array(0);
  let sizeTree = new FenwickTree(sizes);
  let itemSizeTotal = 0;
  let measuredCount = 0;
  let mounted = new Map<number, HTMLElement>();
  let mountedPlaceholders = new Set<number>();
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
  let layoutVersion = 0;
  let renderedLayoutVersion = -1;
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
  let userScrollActive = false;
  let userScrollMoved = false;
  let scrollVelocity = 0;
  let lastScrollSampleDelta = 0;
  let placeholderFastMode = false;
  let hydratePlaceholdersBlocked = false;
  let placeholderLowVelocitySamples = 0;
  let placeholderHydrationFrame = 0;
  let lastScrollSampleTop = viewport.scrollTop;
  let lastScrollSampleAt = performance.now();
  let programmaticScrollTop: number | null = null;
  let nativeScrollEndPending = false;
  let wheelPendingNativeScrollEndTop: number | null = null;
  let settleFrame = 0;
  let settleTimer = 0;
  let wheelInputActive = false;
  let wheelInputTimer = 0;
  let chromiumEdgeWheelActive: DynamicVirtualizerBoundary | null = null;
  let chromiumEdgeWheelIdle = false;
  let chromiumWheelSawNativeScrollEnd = false;
  let chromiumWheelAwaitingFinalScrollEnd = false;
  let chromiumEdgeWheelSuppressed = false;
  let chromiumEdgeSettleTimer = 0;
  const activePointers = new Set<number>();
  let touchInputActive = false;
  let reachTopArmed = false;
  let reachBottomArmed = false;
  let topReachConsumed = false;
  let bottomReachConsumed = false;
  let activeSmoothScrollCancel: (() => void) | null = null;
  let activeSmoothScrollTarget: number | null = null;
  let activeSmoothScrollSnapThreshold = SCROLL_SNAP_THRESHOLD;
  let programmaticReachBoundary: DynamicVirtualizerBoundary | null = null;
  let reachCallbacksEnabled = false;
  let emittingChangeCallback = false;
  let emittingReachCallback = false;
  let pendingBoundaryArm = false;
  let boundaryIntersectionObserver: IntersectionObserver | null = null;
  let itemMeasurer: DynamicVirtualizerItemMeasurer | null = null;
  let disposed = false;

  const pendingMeasurements = new Map<number, number>();
  const deferredLayoutUpdates: DynamicVirtualizerLayoutUpdate[] = [];
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

  content.className = "dv-content";
  addClassNames(content, canvasClassName);
  viewport.classList.add("dv-viewport", "minimal-scrollbar");
  viewport.appendChild(content);

  function nativeMaxScrollTop(): number {
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function topSlotHeight(): number {
    return topSlot?.height ?? 0;
  }

  function bottomSlotHeight(): number {
    return bottomSlot?.height ?? 0;
  }

  function atBottom(): boolean {
    return nativeMaxScrollTop() - logicalScrollTop() <= 2;
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
  ): DynamicVirtualizerState {
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
      atTop: scrollTop <= 1,
      atBottom: scrollMax - scrollTop <= 1,
    };
  }

  function callReachCallback(
    callback: ((state: DynamicVirtualizerState) => void) | undefined,
    state: DynamicVirtualizerState,
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
      Math.abs(totalSize - emittedTotalSize) > 0.01 ||
      atTop !== emittedAtTop ||
      atBottom !== emittedAtBottom
    );
  }

  function rememberEmittedRange(state: DynamicVirtualizerState): void {
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
    const atTop = scrollTop <= 1;
    const atBottom = scrollMax - scrollTop <= 1;
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

  function canEmitBoundaryReach(boundary: DynamicVirtualizerBoundary): boolean {
    return (
      reachCallbacksEnabled &&
      !emittingReachCallback &&
      count > 0 &&
      (boundary === "top" ? Boolean(onReachTop) : Boolean(onReachBottom))
    );
  }

  function armedForBoundary(boundary: DynamicVirtualizerBoundary): boolean {
    return boundary === "top" ? reachTopArmed : reachBottomArmed;
  }

  function reachConsumedForBoundary(
    boundary: DynamicVirtualizerBoundary,
  ): boolean {
    return boundary === "top" ? topReachConsumed : bottomReachConsumed;
  }

  function setReachConsumed(
    boundary: DynamicVirtualizerBoundary,
    consumed: boolean,
  ): void {
    if (boundary === "top") {
      topReachConsumed = consumed;
    } else {
      bottomReachConsumed = consumed;
    }
  }

  function setBoundaryArmed(
    boundary: DynamicVirtualizerBoundary,
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

  function armProgrammaticBoundaryReach(
    boundary: DynamicVirtualizerBoundary,
  ): void {
    programmaticReachBoundary = boundary;
    setBoundaryArmed(boundary, true);
  }

  function clearProgrammaticBoundaryReach(
    boundary: DynamicVirtualizerBoundary | null = null,
  ): void {
    if (boundary === null || programmaticReachBoundary === boundary) {
      programmaticReachBoundary = null;
    }
  }

  function emitBoundaryReach(boundary: DynamicVirtualizerBoundary): void {
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
    if (Math.abs(totalSize - renderedTotalSize) > 0.01) {
      content.style.height = px(totalSize);
      renderedTotalSize = totalSize;
      wakeBottomFollow();
    }
    return totalSize;
  }

  function normalizePlaceholderSlot(
    slot: DynamicVirtualizerPlaceholderSlot,
  ): MountedPlaceholderSlot {
    return {
      key: String(slot.key),
      build: slot.build,
      element: null,
      renderedHeight: -1,
    };
  }

  function currentBoundarySlot(
    boundary: DynamicVirtualizerBoundary,
  ): MountedBoundarySlot | null {
    return boundary === "top" ? topSlot : bottomSlot;
  }

  function setCurrentBoundarySlot(
    boundary: DynamicVirtualizerBoundary,
    slot: MountedBoundarySlot | null,
  ): void {
    if (boundary === "top") {
      topSlot = slot;
    } else {
      bottomSlot = slot;
    }
  }

  function shouldKeepBoundarySlot(
    boundary: DynamicVirtualizerBoundary,
  ): boolean {
    return boundary === "top" ? Boolean(onReachTop) : Boolean(onReachBottom);
  }

  function emptyBoundarySlotHeight(
    boundary: DynamicVirtualizerBoundary,
  ): number {
    return shouldKeepBoundarySlot(boundary)
      ? DEFAULT_BOUNDARY_SENTINEL_HEIGHT
      : 0;
  }

  function ensureBoundarySlot(
    boundary: DynamicVirtualizerBoundary,
  ): MountedBoundarySlot {
    const current = currentBoundarySlot(boundary);
    if (current) return current;

    const element = document.createElement("div");
    element.classList.add("dv-boundary-slot", `dv-boundary-${boundary}`);
    element.dataset.boundary = boundary;

    const next: MountedBoundarySlot = {
      key: null,
      build: null,
      element,
      height: emptyBoundarySlotHeight(boundary),
      renderedHeight: -1,
      renderedTop: -1,
      observed: false,
    };
    setCurrentBoundarySlot(boundary, next);
    layoutVersion++;
    return next;
  }

  function removeBoundarySlot(boundary: DynamicVirtualizerBoundary): void {
    const current = currentBoundarySlot(boundary);
    if (!current) return;
    boundaryIntersectionObserver?.unobserve(current.element);
    current.element.remove();
    setCurrentBoundarySlot(boundary, null);
    layoutVersion++;
  }

  function applyBoundarySlotUpdate(
    boundary: DynamicVirtualizerBoundary,
    slot: DynamicVirtualizerBoundarySlot | null | undefined,
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
      if (Math.abs(current.height - nextHeight) <= 0.01) return false;
      current.height = nextHeight;
      layoutVersion++;
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

    if (Math.abs(current.height - nextHeight) <= 0.01) return false;
    current.height = nextHeight;
    layoutVersion++;
    return true;
  }

  function applyPlaceholderSlotUpdate(
    slot: DynamicVirtualizerPlaceholderSlot | null | undefined,
  ): boolean {
    if (slot === undefined) return false;

    if (slot === null) {
      placeholderSlot?.element?.remove();
      if (!placeholderSlot) return false;
      placeholderSlot = null;
      layoutVersion++;
      return true;
    }

    const next = normalizePlaceholderSlot(slot);
    if (placeholderSlot && placeholderSlot.key === next.key) {
      placeholderSlot.build = next.build;
      return false;
    }

    placeholderSlot?.element?.remove();
    placeholderSlot = next;
    layoutVersion++;
    return true;
  }

  function boundarySlotTop(boundary: DynamicVirtualizerBoundary): number {
    return boundary === "top" ? 0 : topSlotHeight() + itemTotalSize();
  }

  function renderBoundarySlot(boundary: DynamicVirtualizerBoundary): void {
    const slot = currentBoundarySlot(boundary);
    if (!slot) return;

    const { element } = slot;
    if (!element.isConnected) {
      content.appendChild(element);
    }
    const top = boundarySlotTop(boundary);
    if (Math.abs(slot.renderedTop - top) > 0.01) {
      element.style.top = px(top);
      slot.renderedTop = top;
    }
    if (Math.abs(slot.renderedHeight - slot.height) > 0.01) {
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
    syncBoundaryIntersectionObserver();
  }

  function boundaryForElement(
    element: Element,
  ): DynamicVirtualizerBoundary | null {
    const boundary = (element as HTMLElement).dataset.boundary;
    return boundary === "top" || boundary === "bottom" ? boundary : null;
  }

  function handleBoundaryIntersections(
    entries: readonly IntersectionObserverEntry[],
  ): void {
    for (const entry of entries) {
      const boundary = boundaryForElement(entry.target);
      if (!boundary) continue;

      if (
        !entry.isIntersecting ||
        entry.intersectionRatio < BOUNDARY_INTERSECTION_THRESHOLD
      ) {
        const canRearm =
          userScrollActive || !reachConsumedForBoundary(boundary);
        if (canRearm) {
          setReachConsumed(boundary, false);
          setBoundaryArmed(boundary, true);
        }
        continue;
      }

      emitBoundaryReach(boundary);
    }
  }

  function boundarySlotVisible(boundary: DynamicVirtualizerBoundary): boolean {
    const slot = currentBoundarySlot(boundary);
    if (!slot?.element.isConnected || slot.height <= 0) return false;

    const rootRect = viewport.getBoundingClientRect();
    const slotRect = slot.element.getBoundingClientRect();
    const visibleHeight =
      Math.min(slotRect.bottom, rootRect.bottom) -
      Math.max(slotRect.top, rootRect.top);
    if (visibleHeight <= 0) return false;

    const visibleWidth =
      Math.min(slotRect.right, rootRect.right) -
      Math.max(slotRect.left, rootRect.left);
    if (visibleWidth <= 0) return false;

    return (
      visibleHeight / Math.max(1, slotRect.height) >=
      BOUNDARY_INTERSECTION_THRESHOLD
    );
  }

  function emitVisibleBoundaryReach(
    boundary: DynamicVirtualizerBoundary | null,
  ): void {
    if (!boundary) return;
    const visible = boundarySlotVisible(boundary);
    if (!visible) return;
    emitBoundaryReach(boundary);
  }

  function armCoveredBoundaryForScroll(
    boundary: DynamicVirtualizerBoundary,
  ): void {
    if (boundarySlotVisible(boundary)) return;
    setReachConsumed(boundary, false);
    setBoundaryArmed(boundary, true);
  }

  function recreateBoundaryIntersectionObserver(): void {
    boundaryIntersectionObserver?.disconnect();
    boundaryIntersectionObserver = new IntersectionObserver(
      handleBoundaryIntersections,
      {
        root: viewport,
        rootMargin: "0px",
        threshold: BOUNDARY_INTERSECTION_THRESHOLD,
      },
    );
    if (topSlot) topSlot.observed = false;
    if (bottomSlot) bottomSlot.observed = false;
  }

  function observeBoundarySlot(slot: MountedBoundarySlot | null): void {
    if (!slot || slot.observed || !slot.element.isConnected) return;
    boundaryIntersectionObserver?.observe(slot.element);
    slot.observed = true;
  }

  function syncBoundaryIntersectionObserver(): void {
    if (count <= 0 || (!onReachTop && !onReachBottom)) return;

    if (!boundaryIntersectionObserver) recreateBoundaryIntersectionObserver();

    observeBoundarySlot(topSlot);
    observeBoundarySlot(bottomSlot);
  }

  function preparePlaceholderSlot(slot: MountedPlaceholderSlot): HTMLElement {
    const element = slot.build();
    element.classList.add("dv-placeholder-slot");
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
    if (Math.abs(slot.renderedHeight - height) > 0.01) {
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
    if (userScrollActive && options?.allowDuringScroll !== true) return false;
    const target = clamp(value, 0, nativeMaxScrollTop());
    const shouldWrite = Math.abs(viewport.scrollTop - target) > 0.5;
    if (shouldWrite) {
      programmaticScrollTop = target;
      viewport.scrollTop = target;
    }
    if (options?.preserveLogicalOffset) {
      setScrollTopResidual(target - viewport.scrollTop);
      if (userScrollActive) resetScrollVelocity(viewport.scrollTop);
    } else {
      clearScrollTopResidual();
    }
    return shouldWrite;
  }

  function fillSizes(
    nextCount: number,
    addedBefore: number,
    removedBefore: number,
  ): number {
    const previousSizes = sizes;
    const previousMeasured = measured;
    const nextSizes = new Float64Array(nextCount);
    const nextMeasured = new Uint8Array(nextCount);
    const previousStart = Math.min(removedBefore, previousSizes.length);
    const preserved = Math.min(
      Math.max(0, previousSizes.length - previousStart),
      Math.max(0, nextCount - addedBefore),
    );

    if (preserved > 0) {
      nextSizes.set(
        previousSizes.subarray(previousStart, previousStart + preserved),
        addedBefore,
      );
      nextMeasured.set(
        previousMeasured.subarray(previousStart, previousStart + preserved),
        addedBefore,
      );
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
    measuredCount = 0;
    for (const value of measured) {
      if (value) measuredCount++;
    }
    sizeTree = new FenwickTree(sizes);
    itemSizeTotal = sizeTree.total();
    layoutVersion++;
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
    layoutVersion++;
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
    element.classList.add("dv-item");
    positionItem(index, element, offset);
    return element;
  }

  function canMountPlaceholderItems(): boolean {
    return renderMode !== "full" && buildPlaceholder !== undefined;
  }

  function currentScrollVelocity(): number {
    if (lastScrollSampleDelta <= 0) return scrollVelocity;
    const elapsed = performance.now() - lastScrollSampleAt;
    if (elapsed <= 0) return scrollVelocity;
    return Math.min(scrollVelocity, lastScrollSampleDelta / elapsed);
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

  function mountedPlaceholderCount(): number {
    return mountedPlaceholders.size;
  }

  function mountedRealCount(): number {
    return Math.max(0, mounted.size - mountedPlaceholderCount());
  }

  function debugPlaceholderEvent(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    if (!debugPlaceholder) return;
    console.info("[vl-placeholder]", {
      event,
      scrollTop: viewport.scrollTop,
      scrollMax: nativeMaxScrollTop(),
      scrollVelocity,
      currentVelocity: currentScrollVelocity(),
      lastScrollSampleDelta,
      placeholderFastMode,
      hydratePlaceholdersBlocked,
      placeholderLowVelocitySamples,
      mountedPlaceholders: mountedPlaceholderCount(),
      mountedReal: mountedRealCount(),
      userScrollActive,
      userScrollMoved,
      nativeScrollEndPending,
      wheelInputActive,
      touchInputActive,
      activePointers: activePointers.size,
      range: { start: rangeStart, end: rangeEnd },
      ...detail,
    });
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

  function shouldUsePlaceholderMode(): boolean {
    if (!canMountPlaceholderItems()) {
      disablePlaceholderFastMode();
      return false;
    }

    const enterVelocity = placeholderEnterVelocity();
    if (enterVelocity === Number.POSITIVE_INFINITY) {
      disablePlaceholderFastMode();
      return false;
    }

    const velocity = currentScrollVelocity();

    if (isAtNativeScrollBoundary()) {
      const refreshedPlaceholders = disablePlaceholderFastMode();
      if (debugPlaceholder && refreshedPlaceholders) {
        debugPlaceholderEvent("fast-mode-boundary-exit", {
          velocity,
        });
      }
      return false;
    }

    if (velocity >= enterVelocity) {
      const wasFast = placeholderFastMode;
      hydratePlaceholdersBlocked = true;
      placeholderFastMode = true;
      placeholderLowVelocitySamples = 0;
      schedulePlaceholderHydrationCheck();
      if (!wasFast && debugPlaceholder) {
        debugPlaceholderEvent("fast-mode-enter", { velocity });
      }
    } else if (placeholderFastMode) {
      const exitVelocity = enterVelocity * PLACEHOLDER_VELOCITY_EXIT_RATIO;
      if (lastScrollSampleDelta > measureEpsilon && velocity <= exitVelocity) {
        placeholderLowVelocitySamples++;
      } else if (lastScrollSampleDelta > measureEpsilon) {
        placeholderLowVelocitySamples = 0;
      }
      if (placeholderLowVelocitySamples >= PLACEHOLDER_EXIT_SAMPLE_COUNT) {
        hydratePlaceholdersBlocked = false;
        placeholderFastMode = false;
        placeholderLowVelocitySamples = 0;
        if (debugPlaceholder) {
          debugPlaceholderEvent("fast-mode-exit", {
            velocity,
          });
        }
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
        : prepareItem(index, buildItem(index), offset);

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

    const next = prepareItem(index, buildItem(index));
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
    let refreshedCount = 0;
    for (const index of Array.from(mountedPlaceholders)) {
      if (refreshMountedPlaceholder(index)) {
        refreshed = true;
        refreshedCount++;
      }
    }
    if (refreshedCount > 0) {
      if (debugPlaceholder) {
        debugPlaceholderEvent("hydrate-range", { refreshedCount });
      }
    }
    return refreshed;
  }

  function forceHydratePlaceholders(): boolean {
    clearPlaceholderFastModeState();
    return refreshMountedPlaceholders();
  }

  function hydratePlaceholdersAfterNativeScrollEnd(): void {
    if (mountedPlaceholders.size === 0) return;
    if (!nativeScrollEndPending) return;
    if (!canSettleUserScroll()) return;
    const refreshedPlaceholders = forceHydratePlaceholders();
    if (!refreshedPlaceholders) return;
    if (debugPlaceholder) debugPlaceholderEvent("hydrate-scrollend");
    renderNow(logicalScrollTop());
  }

  function inspectRenderDrift(): void {
    if (!renderDriftReporter || mounted.size === 0) return;

    const drifts: DynamicVirtualizerRenderDrift[] = [];
    const offset = topSlotHeight();
    const contentTop = content.getBoundingClientRect().top;

    for (const [index, element] of mounted) {
      const expectedTop = offset + sizeTree.prefix(index);
      const actualRect = element.getBoundingClientRect();
      const actualTop = actualRect.top - contentTop;
      const expectedHeight = sizes[index] ?? modeledItemHeight(index);
      const actualHeight = actualRect.height;
      const topDrift = actualTop - expectedTop;
      const heightDrift = actualHeight - expectedHeight;

      if (
        Math.abs(topDrift) <= DEFAULT_RENDER_DRIFT_EPSILON &&
        Math.abs(heightDrift) <= DEFAULT_RENDER_DRIFT_EPSILON
      ) {
        continue;
      }

      drifts.push({
        index,
        actualHeight,
        expectedHeight,
        heightDrift,
        actualTop,
        expectedTop,
        topDrift,
      });
    }

    if (drifts.length > 0) renderDriftReporter(drifts);
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

  function unmountIndex(index: number): void {
    const element = mounted.get(index);
    if (!element) return;
    itemResizeObserver.unobserve(element);
    element.remove();
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
    const layoutDirty = renderedLayoutVersion !== layoutVersion;
    const mountPlaceholders = shouldUsePlaceholderMode();
    const rangeChanged = start !== previousStart || end !== previousEnd;
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
      const refreshedMountedItems = mountPlaceholders
        ? false
        : hydratePlaceholdersBlocked
          ? false
          : refreshMountedPlaceholders();
      if (!layoutDirty && !refreshedMountedItems) {
        inspectRenderDrift();
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
        if (layoutDirty || rangeChanged) {
          positionItem(index, element, itemOffset);
        }
      }
      if (complete) {
        renderedLayoutVersion = layoutVersion;
        inspectRenderDrift();
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
      } else if (layoutDirty || rangeChanged) {
        positionItem(index, element, itemOffset);
      }
    }
    if (newItems) content.appendChild(newItems);

    renderedLayoutVersion = layoutVersion;
    inspectRenderDrift();
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
    if (userScrollActive) return;
    scheduleMeasurementFlush();
  }

  function scheduleMeasurementFlush(): void {
    if (measurementFrame || disposed) return;
    measurementFrame = requestAnimationFrame(flushMeasurements);
  }

  function flushMeasurementsNow(): boolean {
    if (pendingMeasurements.size === 0 || userScrollActive) return false;
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
    layoutVersion++;

    return index < anchorIndex ? delta : 0;
  }

  function flushMeasurements(): void {
    measurementFrame = 0;
    if (pendingMeasurements.size === 0) return;
    if (userScrollActive) return;

    const wasAtBottom = atBottom();
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

    recomputeTailGap();
    syncContentHeight();
    if (!hadStickyTail && wasAtBottom && !userScrollActive && count > 0) {
      setScrollTop(nativeMaxScrollTop());
    } else if (!userScrollActive && Math.abs(correction) > measureEpsilon) {
      setScrollTop(
        logicalScrollTop() + correction,
        PRESERVE_LOGICAL_SCROLL_OFFSET,
      );
    }
    renderNow(logicalScrollTop());
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

    const wasAtBottom = atBottom();
    const hadStickyTail = stickyIndex !== null || tailGap > 0;
    const anchorIndex = sizeTree.indexAt(
      Math.max(0, logicalScrollTop() - topSlotHeight()),
    );
    if (userScrollActive && index < anchorIndex) {
      queueMeasurement(index, height);
      return;
    }

    pendingMeasurements.delete(index);
    const correction = commitMeasurement(index, height, anchorIndex);
    if (correction === null) {
      emitViewportChange();
      return;
    }

    recomputeTailGap();
    syncContentHeight();
    if (!hadStickyTail && wasAtBottom && !userScrollActive && count > 0) {
      setScrollTop(nativeMaxScrollTop());
    } else if (!userScrollActive && Math.abs(correction) > measureEpsilon) {
      setScrollTop(
        logicalScrollTop() + correction,
        PRESERVE_LOGICAL_SCROLL_OFFSET,
      );
    }
    renderNow(logicalScrollTop());
  }

  function scrollTopForIndex(
    index: number,
    align: DynamicVirtualizerAlign = "top",
  ): number {
    const itemTop = topSlotHeight() + sizeTree.prefix(index);
    const itemHeight = sizes[index] ?? modeledItemHeight(index);
    if (typeof align === "number") return itemTop - align;
    if (align === "bottom") return itemTop + itemHeight - viewport.clientHeight;
    if (align === "center") {
      return itemTop + itemHeight / 2 - viewport.clientHeight / 2;
    }
    return itemTop;
  }

  function flushDeferredLayoutBeforeProgrammaticOperation(): void {
    if (deferredLayoutUpdates.length === 0) return;
    flushDeferredLayoutUpdates();
  }

  function interruptNativeScrollMomentum(): void {
    if (!userScrollActive) return;

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
    options: DynamicVirtualizerScrollOptions = {},
  ): Promise<boolean> {
    activeSmoothScrollCancel?.();
    const hydratedPlaceholders = forceHydratePlaceholders();
    interruptNativeScrollMomentum();
    cancelUserScroll();
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

    handleUserScrollStart();

    if (options.behavior !== "smooth") {
      setScrollTop(target, ALLOW_DURING_SCROLL);
      nativeScrollEndPending = true;
      scheduleSettleCooldown();
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (completed: boolean) => {
        if (finished) return;
        finished = true;
        if (completed && !options.signal?.aborted) {
          const finalTarget = clamp(target, 0, nativeMaxScrollTop());
          if (Math.abs(viewport.scrollTop - finalTarget) <= snapThreshold) {
            setScrollTop(finalTarget, ALLOW_DURING_SCROLL);
          }
        }
        clearActiveSmoothScrollTarget(cancel);
        viewport.removeEventListener("scrollend", handleScrollEnd);
        options.signal?.removeEventListener("abort", handleAbort);
        resolve(completed);
      };
      const cancel = () => {
        const currentTop = viewport.scrollTop;
        viewport.scrollTo({ top: currentTop, behavior: "auto" });
        nativeScrollEndPending = true;
        scheduleSettleCooldown();
        finish(false);
      };
      const handleScrollEnd = () => {
        if (options.signal?.aborted) {
          finish(false);
          return;
        }
        if (!activeSmoothScrollReachedTarget()) {
          const currentTarget = clamp(target, 0, nativeMaxScrollTop());
          viewport.scrollTo({ top: currentTarget, behavior: "smooth" });
          return;
        }
        finish(true);
      };
      const handleAbort = () => finish(false);

      activeSmoothScrollCancel = cancel;
      activeSmoothScrollTarget = target;
      activeSmoothScrollSnapThreshold = snapThreshold;
      viewport.addEventListener("scrollend", handleScrollEnd);
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      viewport.scrollTo({ top: target, behavior: "smooth" });
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
  }

  function wakeBottomFollow(): void {
    if (
      !bottomFollowActive ||
      disposed ||
      userScrollActive ||
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
      userScrollActive ||
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

  function followBottom(options: DynamicVirtualizerScrollOptions = {}): void {
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
    align: DynamicVirtualizerAlign = "top",
    options: DynamicVirtualizerScrollOptions = {},
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
    options: DynamicVirtualizerScrollOptions = {},
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
    options: DynamicVirtualizerScrollOptions = {},
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
    options: DynamicVirtualizerScrollOptions = {},
  ): Promise<boolean> {
    flushDeferredLayoutBeforeProgrammaticOperation();
    stopFollowBottom();
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

  function measureUnmountedItem(index: number): number {
    itemMeasurer ??= createDynamicVirtualizerItemMeasurer({
      viewport,
      canvasClassName,
      buildItem,
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
    mounted.set(targetIndex, next);
    mountedPlaceholders.delete(targetIndex);
    emitViewportChange();
  }

  function refreshMounted(): void {
    const indexes = Array.from(mounted.keys());
    for (const index of indexes) refreshIndex(index);
  }

  function reindexMounted(addedBefore: number, removedBefore: number): void {
    if (mounted.size === 0) return;

    const nextMounted = new Map<number, HTMLElement>();
    const nextMountedPlaceholders = new Set<number>();
    for (const [index, element] of mounted) {
      if (index < removedBefore) {
        itemResizeObserver.unobserve(element);
        element.remove();
        mountedPlaceholders.delete(index);
        continue;
      }

      const nextIndex = index - removedBefore + addedBefore;
      if (nextIndex < 0 || nextIndex >= count) {
        itemResizeObserver.unobserve(element);
        element.remove();
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

  function shouldDeferLayoutUpdate(
    update: DynamicVirtualizerLayoutUpdate,
  ): boolean {
    if (!userScrollActive) return false;
    if (update.apply) return true;
    if (
      normalizedCountShift(update.addedBefore, Number.MAX_SAFE_INTEGER) > 0 ||
      normalizedCountShift(update.removedBefore, sizes.length) > 0
    ) {
      return true;
    }
    return nonNegativeInteger(getCount()) !== count;
  }

  function applyLayoutUpdate(
    update: DynamicVirtualizerLayoutUpdate = {},
  ): void {
    if (update.apply?.() === false) return;

    ensureReachBoundarySlots();
    const nextCount = nonNegativeInteger(getCount());
    const addedBefore = normalizedCountShift(update.addedBefore, nextCount);
    const removedBefore = normalizedCountShift(
      update.removedBefore,
      sizes.length,
    );
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
          itemResizeObserver.unobserve(element);
          element.remove();
          mounted.delete(index);
          mountedPlaceholders.delete(index);
        }
      }
    }
    if (emittingChangeCallback) {
      if (hasScrollTarget) {
        setScrollTop(nextScrollTop, PRESERVE_LOGICAL_SCROLL_OFFSET);
      }
      scheduleRender();
    } else {
      if (hasScrollTarget) {
        setScrollTop(nextScrollTop, PRESERVE_LOGICAL_SCROLL_OFFSET);
        scheduleRender();
      } else {
        renderNow(logicalScrollTop());
      }
    }
    update.after?.();
  }

  function syncLayout(update: DynamicVirtualizerLayoutUpdate = {}): void {
    if (shouldDeferLayoutUpdate(update)) {
      deferredLayoutUpdates.push(update);
      return;
    }
    applyLayoutUpdate(update);
  }

  function setCount(options?: DynamicVirtualizerSetCountOptions): void {
    syncLayout(options);
  }

  function setBoundarySlot(
    boundary: DynamicVirtualizerBoundary,
    slot: DynamicVirtualizerBoundarySlot | null,
  ): void {
    const update =
      boundary === "top" ? { topSlot: slot } : { bottomSlot: slot };
    syncLayout(update);
  }

  function getBoundaryElement(
    boundary: DynamicVirtualizerBoundary,
  ): HTMLElement | null {
    return currentBoundarySlot(boundary)?.element ?? null;
  }

  function setPlaceholderSlot(
    slot: DynamicVirtualizerPlaceholderSlot | null,
  ): void {
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
    const wasAtBottom = atBottom();

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

  function resetScrollVelocity(scrollTop = viewport.scrollTop): void {
    scrollVelocity = 0;
    lastScrollSampleDelta = 0;
    lastScrollSampleTop = scrollTop;
    lastScrollSampleAt = performance.now();
  }

  function updateScrollVelocity(scrollTop = viewport.scrollTop): void {
    const now = performance.now();
    const elapsed = now - lastScrollSampleAt;
    lastScrollSampleDelta = Math.abs(scrollTop - lastScrollSampleTop);
    if (elapsed > 0) {
      scrollVelocity = lastScrollSampleDelta / elapsed;
    }
    lastScrollSampleTop = scrollTop;
    lastScrollSampleAt = now;
  }

  function consumeProgrammaticScrollWrite(scrollTop: number): boolean {
    if (programmaticScrollTop === null) return false;
    const expectedScrollTop = programmaticScrollTop;
    programmaticScrollTop = null;
    return (
      Math.abs(scrollTop - expectedScrollTop) <= Math.max(1, measureEpsilon)
    );
  }

  function handleScroll(): void {
    const previousScrollTop = lastScrollSampleTop;
    const nextScrollTop = viewport.scrollTop;
    const moved = Math.abs(nextScrollTop - previousScrollTop) > measureEpsilon;
    const programmaticScroll = consumeProgrammaticScrollWrite(nextScrollTop);
    if (!userScrollActive && moved && !programmaticScroll) {
      handleUserScrollStart();
    }
    updateScrollVelocity(nextScrollTop);
    if (
      (scrollSettleStrategy === "firefox-wheel" ||
        scrollSettleStrategy === "safari-wheel") &&
      nativeScrollEndPending &&
      wheelPendingNativeScrollEndTop !== null &&
      !isRubberBandOverscrolled() &&
      Math.abs(nextScrollTop - wheelPendingNativeScrollEndTop) > measureEpsilon
    ) {
      nativeScrollEndPending = false;
      wheelPendingNativeScrollEndTop = null;
      cancelSettleTimer();
      cancelSettleFrame();
    }
    if (userScrollActive && moved) {
      userScrollMoved = true;
    }
    if (nativeScrollEndPending) {
      scheduleSettleCooldown();
    } else {
      scheduleWheelScrollEndFallback();
    }
    scheduleRender();
  }

  function hasActiveTouchOrPointerInput(): boolean {
    return touchInputActive || activePointers.size > 0;
  }

  function isRubberBandOverscrolled(): boolean {
    const scrollTop = viewport.scrollTop;
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop < -measureEpsilon || scrollTop - maxScrollTop > measureEpsilon
    );
  }

  function isAtNativeScrollBoundary(scrollTop = viewport.scrollTop): boolean {
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop <= measureEpsilon || maxScrollTop - scrollTop <= measureEpsilon
    );
  }

  function isStrictlyOutOfScrollRange(): boolean {
    const scrollTop = viewport.scrollTop;
    return scrollTop < 0 || scrollTop > nativeMaxScrollTop();
  }

  function debugScrollSettleEvent(
    event: "native-scrollend" | "scrollend",
  ): void {
    if (!debugScrollSettle) return;
    console.info("[vl-scroll-settle]", {
      event,
      strategy: scrollSettleStrategy,
      scrollTop: viewport.scrollTop,
      scrollMax: nativeMaxScrollTop(),
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      scrollVelocity,
      placeholderFastMode,
      inScrollRange: !isRubberBandOverscrolled(),
      strictlyInScrollRange: !isStrictlyOutOfScrollRange(),
      nativeScrollEndPending,
      wheelPendingNativeScrollEndTop,
      wheelInputActive,
      chromiumEdgeWheelActive,
      chromiumEdgeWheelIdle,
      chromiumWheelSawNativeScrollEnd,
      chromiumWheelAwaitingFinalScrollEnd,
      chromiumEdgeWheelSuppressed,
      chromiumEdgeSettleTimerActive: chromiumEdgeSettleTimer !== 0,
      touchInputActive,
      activePointers: activePointers.size,
      rubberBandOverscrolled: isRubberBandOverscrolled(),
    });
  }

  function debugScrollEnd(): void {
    debugScrollSettleEvent("scrollend");
  }

  function cancelSettleFrame(): void {
    if (!settleFrame) return;
    cancelAnimationFrame(settleFrame);
    settleFrame = 0;
  }

  function cancelSettleTimer(): void {
    if (!settleTimer) return;
    window.clearTimeout(settleTimer);
    settleTimer = 0;
  }

  function cancelWheelInputTimer(): void {
    if (!wheelInputTimer) return;
    window.clearTimeout(wheelInputTimer);
    wheelInputTimer = 0;
  }

  function cancelChromiumEdgeSettleTimer(): void {
    if (!chromiumEdgeSettleTimer) return;
    window.clearTimeout(chromiumEdgeSettleTimer);
    chromiumEdgeSettleTimer = 0;
  }

  function usesWheelInputSettle(): boolean {
    return (
      scrollSettleStrategy === "chromium-wheel" ||
      scrollSettleStrategy === "firefox-wheel" ||
      scrollSettleStrategy === "safari-wheel"
    );
  }

  function usesWheelScrollEndFallback(): boolean {
    return (
      scrollSettleStrategy === "firefox-wheel" ||
      scrollSettleStrategy === "safari-wheel"
    );
  }

  function hasActiveWheelInput(): boolean {
    return usesWheelInputSettle() && wheelInputActive;
  }

  function hasActiveChromiumEdgeWheel(): boolean {
    return (
      scrollSettleStrategy === "chromium-wheel" &&
      chromiumEdgeWheelActive !== null
    );
  }

  function boundaryForOutwardWheel(
    event: WheelEvent,
  ): DynamicVirtualizerBoundary | null {
    const scrollTop = viewport.scrollTop;
    if (event.deltaY < 0 && scrollTop <= measureEpsilon) return "top";
    if (event.deltaY <= 0) return null;

    const maxScrollTop = nativeMaxScrollTop();
    if (
      maxScrollTop > measureEpsilon &&
      maxScrollTop - scrollTop <= measureEpsilon
    ) {
      return "bottom";
    }
    return null;
  }

  function canSettleUserScroll(): boolean {
    return (
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput() &&
      !hasActiveChromiumEdgeWheel() &&
      !chromiumWheelAwaitingFinalScrollEnd &&
      !isRubberBandOverscrolled()
    );
  }

  function canScheduleWheelScrollEndFallback(): boolean {
    return (
      usesWheelScrollEndFallback() &&
      userScrollActive &&
      userScrollMoved &&
      !nativeScrollEndPending &&
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput()
    );
  }

  function cancelUserScrollTimers(): void {
    cancelSettleTimer();
    cancelSettleFrame();
    cancelWheelInputTimer();
    cancelChromiumEdgeSettleTimer();
  }

  function resetScrollSettleState(): void {
    wheelInputActive = false;
    chromiumEdgeWheelActive = null;
    chromiumEdgeWheelIdle = false;
    chromiumWheelSawNativeScrollEnd = false;
    chromiumWheelAwaitingFinalScrollEnd = false;
    chromiumEdgeWheelSuppressed = false;
  }

  function cancelPendingUserScrollEnd(): void {
    nativeScrollEndPending = false;
    wheelPendingNativeScrollEndTop = null;
    chromiumWheelSawNativeScrollEnd = false;
    cancelSettleTimer();
    cancelSettleFrame();
  }

  function resetUserScrollState(): void {
    nativeScrollEndPending = false;
    wheelPendingNativeScrollEndTop = null;
    userScrollActive = false;
    userScrollMoved = false;
    resetScrollVelocity();
    clearPlaceholderFastModeState();
    placeholderLowVelocitySamples = 0;
  }

  function finishUserScroll(): void {
    if (debugPlaceholder) debugPlaceholderEvent("finish-attempt");
    cancelUserScrollTimers();
    resetScrollSettleState();
    debugScrollEnd();
    resetUserScrollState();
    const flushedLayout = flushDeferredLayoutUpdates();
    const flushedMeasurements = flushMeasurementsNow();
    const refreshedPlaceholders = refreshMountedPlaceholders();
    if (refreshedPlaceholders || (!flushedLayout && !flushedMeasurements)) {
      renderNow(viewport.scrollTop);
    }
    if (debugPlaceholder) {
      debugPlaceholderEvent("finish-commit", {
        flushedLayout,
        flushedMeasurements,
        refreshedPlaceholders,
      });
    }
    const state = getState();
    onScrollEnd?.(state);
  }

  function cancelUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
  }

  function maybeFinishUserScroll(): void {
    if (!userScrollActive || !nativeScrollEndPending) return;
    if (!canSettleUserScroll()) {
      if (
        ((scrollSettleStrategy === "firefox-wheel" ||
          scrollSettleStrategy === "safari-wheel") &&
          wheelInputActive) ||
        hasActiveChromiumEdgeWheel() ||
        (scrollSettleStrategy === "chromium-wheel" &&
          (chromiumWheelAwaitingFinalScrollEnd || chromiumEdgeWheelSuppressed))
      ) {
        return;
      }
      schedulePendingSettleCheck();
      return;
    }
    finishUserScroll();
  }

  function schedulePendingSettleCheck(): void {
    if (settleFrame || disposed) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      maybeFinishUserScroll();
    });
  }

  function scheduleSettleCooldown(): void {
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      maybeFinishUserScroll();
    }, SCROLL_SETTLE_COOLDOWN_MS);
  }

  function markPendingWheelScrollEnd(): void {
    nativeScrollEndPending = true;
    wheelPendingNativeScrollEndTop = clamp(
      viewport.scrollTop,
      0,
      nativeMaxScrollTop(),
    );
    hydratePlaceholdersAfterNativeScrollEnd();
    scheduleSettleCooldown();
  }

  function scheduleWheelScrollEndFallback(): void {
    if (!canScheduleWheelScrollEndFallback()) return;
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (!canScheduleWheelScrollEndFallback()) return;
      markPendingWheelScrollEnd();
    }, SCROLL_SETTLE_COOLDOWN_MS);
  }

  function scheduleChromiumEdgeSettleFallback(
    boundary: DynamicVirtualizerBoundary,
  ): void {
    cancelChromiumEdgeSettleTimer();
    chromiumEdgeSettleTimer = window.setTimeout(() => {
      chromiumEdgeSettleTimer = 0;
      if (
        disposed ||
        !userScrollActive ||
        wheelInputActive ||
        !chromiumEdgeWheelSuppressed ||
        chromiumEdgeWheelActive !== boundary ||
        isRubberBandOverscrolled()
      ) {
        return;
      }
      chromiumWheelAwaitingFinalScrollEnd = false;
      chromiumEdgeWheelSuppressed = false;
      chromiumEdgeWheelActive = null;
      chromiumEdgeWheelIdle = false;
      nativeScrollEndPending = true;
      scheduleSettleCooldown();
    }, CHROMIUM_EDGE_SETTLE_QUIET_MS);
  }

  function handleScrollEnd(): void {
    debugScrollSettleEvent("native-scrollend");

    if (!activeSmoothScrollReachedTarget()) return;

    if (
      scrollSettleStrategy === "firefox-wheel" ||
      scrollSettleStrategy === "safari-wheel"
    ) {
      if (!userScrollActive) return;
      if (!userScrollMoved) {
        cancelUserScroll();
        return;
      }
      markPendingWheelScrollEnd();
      return;
    }

    nativeScrollEndPending = true;
    if (scrollSettleStrategy === "chromium-wheel" && userScrollActive) {
      chromiumWheelSawNativeScrollEnd = true;
      if (!wheelInputActive && chromiumWheelAwaitingFinalScrollEnd) {
        chromiumWheelAwaitingFinalScrollEnd = false;
        chromiumEdgeWheelActive = null;
        chromiumEdgeWheelIdle = false;
      }
    }
    if (
      scrollSettleStrategy === "chromium-wheel" &&
      chromiumEdgeWheelActive &&
      chromiumEdgeWheelIdle
    ) {
      chromiumEdgeWheelActive = null;
      chromiumEdgeWheelIdle = false;
    }
    hydratePlaceholdersAfterNativeScrollEnd();
    scheduleSettleCooldown();
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

  function handleUserScrollStart(): void {
    stopFollowBottom();
    clearScrollTopResidual();
    const wasActive = userScrollActive;
    userScrollActive = true;
    if (!wasActive) {
      nativeScrollEndPending = false;
      wheelPendingNativeScrollEndTop = null;
      userScrollMoved = false;
      pendingBoundaryArm = needsBoundaryRender;
      resetScrollVelocity();
      chromiumWheelSawNativeScrollEnd = false;
      chromiumWheelAwaitingFinalScrollEnd = false;
      chromiumEdgeWheelSuppressed = false;
      cancelChromiumEdgeSettleTimer();
    } else if (
      scrollSettleStrategy !== "firefox-wheel" &&
      scrollSettleStrategy !== "safari-wheel"
    ) {
      cancelPendingUserScrollEnd();
    }
    if (debugPlaceholder) {
      debugPlaceholderEvent(wasActive ? "scroll-start-active" : "scroll-start");
    }
    if (!wasActive) {
      onScrollStart?.(getState());
    }
  }

  function handleChromiumWheelInput(event: WheelEvent): void {
    if (scrollSettleStrategy !== "chromium-wheel") return;
    const outwardBoundary = boundaryForOutwardWheel(event);
    chromiumWheelAwaitingFinalScrollEnd = false;
    cancelChromiumEdgeSettleTimer();
    if (outwardBoundary) {
      chromiumEdgeWheelSuppressed = true;
      nativeScrollEndPending = false;
      chromiumWheelAwaitingFinalScrollEnd = true;
    } else if (nativeScrollEndPending) {
      nativeScrollEndPending = false;
    }
    if (!outwardBoundary) {
      chromiumEdgeWheelActive = null;
      chromiumEdgeWheelIdle = false;
    } else {
      chromiumEdgeWheelActive = outwardBoundary;
      chromiumEdgeWheelIdle = false;
    }
    wheelInputActive = true;
    cancelWheelInputTimer();
    wheelInputTimer = window.setTimeout(() => {
      wheelInputTimer = 0;
      wheelInputActive = false;
      if (outwardBoundary) {
        chromiumEdgeWheelIdle = true;
        chromiumWheelAwaitingFinalScrollEnd = true;
        nativeScrollEndPending = false;
        scheduleChromiumEdgeSettleFallback(outwardBoundary);
      } else if (chromiumWheelSawNativeScrollEnd) {
        nativeScrollEndPending = true;
        chromiumWheelAwaitingFinalScrollEnd = false;
        chromiumEdgeWheelSuppressed = false;
      }
      hydratePlaceholdersAfterNativeScrollEnd();
      if (nativeScrollEndPending) scheduleSettleCooldown();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleWheelInputSettle(
    outwardBoundary: DynamicVirtualizerBoundary | null = null,
  ): void {
    if (
      scrollSettleStrategy !== "firefox-wheel" &&
      scrollSettleStrategy !== "safari-wheel"
    ) {
      return;
    }
    wheelInputActive = true;
    cancelWheelInputTimer();
    wheelInputTimer = window.setTimeout(() => {
      wheelInputTimer = 0;
      wheelInputActive = false;
      hydratePlaceholdersAfterNativeScrollEnd();
      if (nativeScrollEndPending) {
        scheduleSettleCooldown();
        return;
      }
      if (
        scrollSettleStrategy === "firefox-wheel" &&
        outwardBoundary !== null
      ) {
        return;
      }
      scheduleWheelScrollEndFallback();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleWheel(event: WheelEvent): void {
    if (debugPlaceholder) {
      debugPlaceholderEvent("wheel", { deltaY: event.deltaY });
    }
    if (
      scrollSettleStrategy === "firefox-wheel" ||
      scrollSettleStrategy === "safari-wheel"
    ) {
      const outwardBoundary = boundaryForOutwardWheel(event);
      handleUserScrollStart();
      if (outwardBoundary) userScrollMoved = true;
      handleWheelInputSettle(outwardBoundary);
      return;
    }

    handleUserScrollStart();
    handleChromiumWheelInput(event);
  }

  function handleUserScrollMaybeEnd(): void {
    if (hasActiveTouchOrPointerInput()) return;
    maybeFinishUserScroll();
    if (
      userScrollActive &&
      !userScrollMoved &&
      !nativeScrollEndPending &&
      !isRubberBandOverscrolled()
    ) {
      finishUserScroll();
    }
  }

  function handleTouchScrollStart(): void {
    touchInputActive = true;
    handleUserScrollStart();
  }

  function handleTouchScrollMove(): void {
    handleUserScrollStart();
  }

  function handleTouchScrollEnd(event: TouchEvent): void {
    if (event.touches.length === 0) touchInputActive = false;
    handleUserScrollMaybeEnd();
  }

  function isLikelyScrollbarPointer(event: PointerEvent): boolean {
    if (event.pointerType !== "mouse") return false;

    const scrollbarGutterWidth = Math.max(
      0,
      viewport.offsetWidth - viewport.clientWidth,
    );
    if (scrollbarGutterWidth <= 0) return event.target === viewport;

    const rect = viewport.getBoundingClientRect();
    return (
      event.clientX <= rect.left + scrollbarGutterWidth ||
      event.clientX >= rect.right - scrollbarGutterWidth
    );
  }

  function handlePointerScrollStart(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    if (event.pointerType === "mouse" && !isLikelyScrollbarPointer(event)) {
      return;
    }
    activePointers.add(event.pointerId);
    handleUserScrollStart();
  }

  function settlePointerScrollWithoutNativeScrollEnd(): void {
    if (
      activePointers.size > 0 ||
      !userScrollActive ||
      !userScrollMoved ||
      nativeScrollEndPending ||
      isRubberBandOverscrolled()
    ) {
      return;
    }

    nativeScrollEndPending = true;
    wheelPendingNativeScrollEndTop = null;
  }

  function handlePointerScrollEnd(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    if (event.pointerType === "mouse" && !activePointers.has(event.pointerId)) {
      return;
    }
    activePointers.delete(event.pointerId);
    settlePointerScrollWithoutNativeScrollEnd();
    handleUserScrollMaybeEnd();
  }

  viewport.addEventListener("scroll", handleScroll, { passive: true });
  viewport.addEventListener("scrollend", handleScrollEnd, { passive: true });
  viewport.addEventListener("wheel", handleWheel, { passive: true });
  const supportsPointerEvents = "PointerEvent" in window;
  const supportsTouchEvents = "TouchEvent" in window;
  if (supportsPointerEvents) {
    viewport.addEventListener("pointerdown", handlePointerScrollStart, {
      passive: true,
    });
    window.addEventListener("pointerup", handlePointerScrollEnd, {
      passive: true,
    });
    window.addEventListener("pointercancel", handlePointerScrollEnd, {
      passive: true,
    });
  }
  if (supportsTouchEvents) {
    viewport.addEventListener("touchstart", handleTouchScrollStart, {
      passive: true,
    });
    viewport.addEventListener("touchmove", handleTouchScrollMove, {
      passive: true,
    });
    viewport.addEventListener("touchend", handleTouchScrollEnd, {
      passive: true,
    });
    viewport.addEventListener("touchcancel", handleTouchScrollEnd, {
      passive: true,
    });
  }
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
    refreshIndex,
    refreshMounted,
    dispose() {
      disposed = true;
      if (renderFrame) cancelAnimationFrame(renderFrame);
      if (measurementFrame) cancelAnimationFrame(measurementFrame);
      cancelPlaceholderHydrationCheck();
      cancelSettleFrame();
      cancelSettleTimer();
      cancelWheelInputTimer();
      cancelChromiumEdgeSettleTimer();
      stopFollowBottom();
      deferredLayoutUpdates.length = 0;
      itemResizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      itemMeasurer?.dispose();
      boundaryIntersectionObserver?.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("scrollend", handleScrollEnd);
      viewport.removeEventListener("wheel", handleWheel);
      if (supportsPointerEvents) {
        viewport.removeEventListener("pointerdown", handlePointerScrollStart);
        window.removeEventListener("pointerup", handlePointerScrollEnd);
        window.removeEventListener("pointercancel", handlePointerScrollEnd);
      }
      if (supportsTouchEvents) {
        viewport.removeEventListener("touchstart", handleTouchScrollStart);
        viewport.removeEventListener("touchmove", handleTouchScrollMove);
        viewport.removeEventListener("touchend", handleTouchScrollEnd);
        viewport.removeEventListener("touchcancel", handleTouchScrollEnd);
      }
      viewport.classList.remove("dv-viewport", "minimal-scrollbar");
      content.remove();
      mounted.clear();
      mountedPlaceholders.clear();
    },
  };
}
