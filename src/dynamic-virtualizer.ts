const STYLE_ID = "dynamic-virtualizer-styles";
const DEFAULT_OVERSCAN_PX = 900;
const DEFAULT_MEASURE_EPSILON = 0.5;
const SCROLL_SNAP_THRESHOLD = 1;
const DEFAULT_BOUNDARY_SENTINEL_HEIGHT = 1;
const BOUNDARY_INTERSECTION_THRESHOLD = 0.01;
const DEFAULT_RENDER_DRIFT_EPSILON = 1;

const CSS = `
.dv-viewport {
  overflow-y: auto;
  overscroll-behavior-y: contain;
  overflow-anchor: none;
  scrollbar-width: thin;
  scrollbar-color: gray transparent;
  -webkit-overflow-scrolling: touch;
}
.dv-content {
  position: relative;
  width: 100%;
  min-height: 100%;
}
.dv-item {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  contain: layout paint;
  will-change: transform;
}
.dv-boundary-slot {
  position: absolute;
  left: 0;
  right: 0;
}
.dv-placeholder-slot {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}
`;

export type DynamicVirtualizerAlign = "top" | "center" | "bottom" | number;
export type DynamicVirtualizerBoundary = "top" | "bottom";
export type DynamicVirtualizerRenderMode = "virtual" | "full";

export interface DynamicVirtualizerConfig {
  viewport: HTMLElement;
  canvasClassName?: string;
  getCount: () => number;
  getItemHeight: (index: number) => number;
  buildItem: (index: number) => HTMLElement;
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
  deferDuringScroll?: boolean;
  apply?: () => boolean | undefined;
  after?: () => void;
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
}

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
  scrollToTop(options?: DynamicVirtualizerScrollOptions): Promise<boolean>;
  scrollToBottom(options?: DynamicVirtualizerScrollOptions): Promise<boolean>;
  setStickyIndex(index: number | null): void;
  getMountedElement(index: number): HTMLElement | null;
  refreshIndex(index: number): void;
  refreshMounted(): void;
  dispose(): void;
}

class FenwickTree {
  private readonly tree: Float64Array;

  readonly size: number;

  constructor(values: Float64Array) {
    this.size = values.length;
    this.tree = new Float64Array(this.size + 1);
    for (let index = 0; index < values.length; index++) {
      this.add(index, values[index] ?? 0);
    }
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
    let bit = 1;
    while (bit << 1 <= this.size) bit <<= 1;

    for (; bit > 0; bit >>= 1) {
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

function nonNegativeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function px(value: number): string {
  return `${nonNegativeSize(value).toFixed(3)}px`;
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

function positionItem(
  index: number,
  element: HTMLElement,
  tree: FenwickTree,
  offset = 0,
): void {
  const top = offset + tree.prefix(index);
  element.style.transform = `translateY(${px(top)})`;
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

export function createDynamicVirtualizer(
  config: DynamicVirtualizerConfig,
): DynamicVirtualizer {
  injectStyles();

  const {
    viewport,
    canvasClassName,
    buildItem,
    getCount,
    getItemHeight,
    onRangeChange,
    onReachTop,
    onReachBottom,
    onScrollStart,
    onScrollEnd,
  } = config;

  const overscanPx = config.overscanPx;
  const getOverscanPx: () => number =
    typeof overscanPx === "function"
      ? overscanPx
      : () => overscanPx ?? DEFAULT_OVERSCAN_PX;
  const renderMode = config.renderMode ?? "virtual";
  const measureEpsilon = config.measureEpsilon ?? DEFAULT_MEASURE_EPSILON;
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
  let measuredCount = 0;
  let mounted = new Map<number, HTMLElement>();
  let rangeStart = 0;
  let rangeEnd = 0;
  let renderFrame = 0;
  let measurementFrame = 0;
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
  let scrollEndBlockedByInput = false;
  let blockedScrollEndFrame = 0;
  const activePointers = new Set<number>();
  let touchInputActive = false;
  let reachTopArmed = false;
  let reachBottomArmed = false;
  let reachCallbacksEnabled = false;
  let emittingChangeCallback = false;
  let emittingReachCallback = false;
  let boundaryIntersectionObserver: IntersectionObserver | null = null;
  let disposed = false;

  const pendingMeasurements = new Map<number, number>();
  const deferredLayoutUpdates: DynamicVirtualizerLayoutUpdate[] = [];
  const content = document.createElement("div");

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
  viewport.classList.add("dv-viewport");
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
    return nativeMaxScrollTop() - viewport.scrollTop <= 2;
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

  function getState(
    totalSize = contentTotalSize(),
    scrollTop = viewport.scrollTop,
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
    scrollTop = viewport.scrollTop,
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

  function emitBoundaryReach(boundary: DynamicVirtualizerBoundary): void {
    if (!canEmitBoundaryReach(boundary)) return;
    if (!armedForBoundary(boundary)) return;

    setBoundaryArmed(boundary, false);
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
    current.key = nextKey;
    current.build = slot.build;
    current.element.replaceChildren(slot.build());

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
        setBoundaryArmed(boundary, true);
        continue;
      }

      emitBoundaryReach(boundary);
    }
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

  function syncBoundaryIntersectionObserver(): void {
    if (count <= 0 || (!onReachTop && !onReachBottom)) return;

    if (!boundaryIntersectionObserver) recreateBoundaryIntersectionObserver();

    for (const slot of [topSlot, bottomSlot]) {
      if (!slot || slot.observed || !slot.element.isConnected) continue;
      boundaryIntersectionObserver?.observe(slot.element);
      slot.observed = true;
    }
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
    if (baseTotalSize <= viewport.clientHeight + 0.5) {
      tailGap = 0;
      return;
    }

    const stickyTop = topSlotHeight() + sizeTree.prefix(stickyIndex);
    const baseMaxScrollTop = Math.max(0, baseTotalSize - viewport.clientHeight);
    const nextTailGap = Math.max(0, stickyTop - baseMaxScrollTop);

    if (nextTailGap <= 0.5) {
      stickyIndex = null;
      tailGap = 0;
    } else {
      tailGap = nextTailGap;
    }
  }

  function setScrollTop(
    value: number,
    options: ScrollTopWriteOptions = {},
  ): boolean {
    if (userScrollActive && options.allowDuringScroll !== true) return false;
    const target = clamp(value, 0, nativeMaxScrollTop());
    if (Math.abs(viewport.scrollTop - target) <= 0.5) return false;
    viewport.scrollTop = target;
    return true;
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
    layoutVersion++;
  }

  function computeRange(
    scrollTop: number,
    viewportHeight = lastViewportHeight,
    overscanPx = Math.max(0, getOverscanPx()),
  ): { start: number; end: number } {
    if (count === 0) return { start: 0, end: 0 };
    if (renderMode === "full") return { start: 0, end: count };

    const itemScrollTop = scrollTop - topSlotHeight();
    const startTarget = Math.max(0, itemScrollTop - overscanPx);
    const endTarget = Math.min(
      itemTotalSize(),
      itemScrollTop + viewportHeight + overscanPx,
    );
    return {
      start: Math.max(0, sizeTree.indexAt(startTarget) - 1),
      end: Math.min(count, sizeTree.indexAt(endTarget) + 2),
    };
  }

  function prepareItem(
    index: number,
    element: HTMLElement,
    offset = topSlotHeight(),
  ): HTMLElement {
    element.dataset.index = String(index);
    element.classList.add("dv-item");
    positionItem(index, element, sizeTree, offset);
    return element;
  }

  function inspectRenderDrift(): void {
    if (!renderDriftReporter || mounted.size === 0) return;

    const drifts: DynamicVirtualizerRenderDrift[] = [];
    const slotHeight = topSlotHeight();
    const contentTop = content.getBoundingClientRect().top;

    for (const [index, element] of mounted) {
      const expectedTop = slotHeight + sizeTree.prefix(index);
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

  function render(explicitScrollTop = viewport.scrollTop): void {
    if (disposed) return;

    ensureReachBoundarySlots();
    const totalSize = syncContentHeight();
    renderBoundarySlots();
    renderPlaceholderSlot();
    const viewportHeight = lastViewportHeight;
    const actualScrollTop = viewport.scrollTop;
    const itemOffset = topSlotHeight();

    const previousStart = rangeStart;
    const previousEnd = rangeEnd;
    const { start, end } = computeRange(explicitScrollTop, viewportHeight);
    const layoutDirty = renderedLayoutVersion !== layoutVersion;
    rangeStart = start;
    rangeEnd = end;

    if (
      start === previousStart &&
      end === previousEnd &&
      mounted.size === end - start
    ) {
      if (!layoutDirty) {
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
        if (layoutDirty) {
          positionItem(index, element, sizeTree, itemOffset);
        }
      }
      if (complete) {
        renderedLayoutVersion = layoutVersion;
        inspectRenderDrift();
        emitViewportChange(totalSize, actualScrollTop, viewportHeight);
        return;
      }
    }

    for (const [index, element] of mounted) {
      if (index >= start && index < end) continue;
      itemResizeObserver.unobserve(element);
      element.remove();
      mounted.delete(index);
    }

    for (let index = start; index < end; index++) {
      let element = mounted.get(index);
      if (!element) {
        element = prepareItem(index, buildItem(index), itemOffset);
        itemResizeObserver.observe(element);
        content.appendChild(element);
        mounted.set(index, element);
      } else if (layoutDirty) {
        positionItem(index, element, sizeTree, itemOffset);
      }
    }

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

  function renderNow(explicitScrollTop = viewport.scrollTop): void {
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
    render(explicitScrollTop);
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

    const delta = height - previous;
    if (Math.abs(delta) <= measureEpsilon) return null;

    sizes[index] = height;
    sizeTree.add(index, delta);
    layoutVersion++;

    if (!measured[index]) {
      measured[index] = 1;
      measuredCount++;
    }

    return index < anchorIndex ? delta : 0;
  }

  function flushMeasurements(): void {
    measurementFrame = 0;
    if (pendingMeasurements.size === 0) return;
    if (userScrollActive) return;

    const wasAtBottom = atBottom();
    const hadStickyTail = stickyIndex !== null || tailGap > 0;
    const anchorIndex = sizeTree.indexAt(viewport.scrollTop);
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
      setScrollTop(viewport.scrollTop + correction);
    }
    renderNow(viewport.scrollTop);
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

  function scrollToNativeTop(
    top: number,
    options: DynamicVirtualizerScrollOptions = {},
  ): Promise<boolean> {
    const target = clamp(top, 0, nativeMaxScrollTop());
    const snapThreshold = options.snapThreshold ?? SCROLL_SNAP_THRESHOLD;
    if (options.signal?.aborted) {
      return Promise.resolve(false);
    }

    if (Math.abs(viewport.scrollTop - target) <= snapThreshold) {
      setScrollTop(target, { allowDuringScroll: true });
      return Promise.resolve(true);
    }

    if (options.behavior !== "smooth") {
      setScrollTop(target, { allowDuringScroll: true });
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const finish = (completed: boolean) => {
        viewport.removeEventListener("scrollend", handleScrollEnd);
        options.signal?.removeEventListener("abort", handleAbort);
        resolve(completed);
      };
      const handleScrollEnd = () => finish(true);
      const handleAbort = () => finish(false);

      viewport.addEventListener("scrollend", handleScrollEnd, { once: true });
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      viewport.scrollTo({ top: target, behavior: "smooth" });
    });
  }

  async function scrollToIndex(
    index: number,
    align: DynamicVirtualizerAlign = "top",
    options: DynamicVirtualizerScrollOptions = {},
  ): Promise<boolean> {
    if (count <= 0 || options.signal?.aborted) return false;
    const targetIndex = clamp(Math.floor(index), 0, count - 1);
    const target = scrollTopForIndex(targetIndex, align);
    renderNow(target);
    const ok = await scrollToNativeTop(target, options);
    renderNow(viewport.scrollTop);
    return ok;
  }

  async function scrollToTop(
    options: DynamicVirtualizerScrollOptions = {},
  ): Promise<boolean> {
    return scrollToIndex(0, "top", options);
  }

  async function scrollToBottom(
    options: DynamicVirtualizerScrollOptions = {},
  ): Promise<boolean> {
    if (count <= 0 || options.signal?.aborted) return false;
    syncContentHeight();
    const target = nativeMaxScrollTop();
    renderNow(target);
    const ok = await scrollToNativeTop(target, options);
    renderNow(viewport.scrollTop);
    return ok;
  }

  function setStickyIndex(index: number | null): void {
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

  function refreshIndex(index: number): void {
    const previous = mounted.get(index);
    if (!previous) return;

    const next = prepareItem(index, buildItem(index));
    itemResizeObserver.observe(next);
    previous.replaceWith(next);
    itemResizeObserver.unobserve(previous);
    mounted.set(index, next);
    emitViewportChange();
  }

  function refreshMounted(): void {
    const indexes = Array.from(mounted.keys());
    for (const index of indexes) refreshIndex(index);
  }

  function reindexMounted(addedBefore: number, removedBefore: number): void {
    if (mounted.size === 0) return;

    const nextMounted = new Map<number, HTMLElement>();
    for (const [index, element] of mounted) {
      if (index < removedBefore) {
        itemResizeObserver.unobserve(element);
        element.remove();
        continue;
      }

      const nextIndex = index - removedBefore + addedBefore;
      if (nextIndex < 0 || nextIndex >= count) {
        itemResizeObserver.unobserve(element);
        element.remove();
        continue;
      }

      element.dataset.index = String(nextIndex);
      nextMounted.set(nextIndex, element);
    }

    mounted = nextMounted;
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
      applyLayoutUpdate({
        ...update,
        deferDuringScroll: false,
      });
    }
    return true;
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
    const previousScrollTop = viewport.scrollTop;
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
    applyBoundarySlotUpdate("top", update.topSlot);
    applyBoundarySlotUpdate("bottom", update.bottomSlot);
    applyPlaceholderSlotUpdate(update.placeholderSlot);
    const beforeHeightDelta = shouldRefreshSizes
      ? fillSizes(nextCount, addedBefore, removedBefore)
      : 0;
    count = nextCount;

    if (addedBefore > 0 || removedBefore > 0) {
      pendingMeasurements.clear();
      reindexMounted(addedBefore, removedBefore);
      if (stickyIndex !== null) {
        const nextStickyIndex = stickyIndex + addedBefore - removedBefore;
        stickyIndex =
          count > 0 && nextStickyIndex >= 0 && nextStickyIndex < count
            ? nextStickyIndex
            : null;
      }
    } else {
      removePendingMeasurementsOutsideCount();

      for (const [index, element] of mounted) {
        if (index >= count) {
          itemResizeObserver.unobserve(element);
          element.remove();
          mounted.delete(index);
        }
      }
    }

    recomputeTailGap();
    syncContentHeight();
    const topSlotDelta =
      addedBefore > 0 || removedBefore > 0
        ? topSlotHeight() - previousTopSlotHeight
        : 0;
    const scrollCorrection = beforeHeightDelta + topSlotDelta;
    if (Math.abs(scrollCorrection) > measureEpsilon) {
      setScrollTop(previousScrollTop + scrollCorrection, {
        allowDuringScroll: true,
      });
    }
    if (
      addedBefore > 0 &&
      previousScrollTop <= previousTopSlotHeight + 1 &&
      viewport.scrollTop > topSlotHeight() + 1
    ) {
      setBoundaryArmed("top", true);
    }
    if (emittingChangeCallback) {
      scheduleRender();
    } else {
      renderNow();
    }
    update.after?.();
  }

  function syncLayout(update: DynamicVirtualizerLayoutUpdate = {}): void {
    if (update.deferDuringScroll && userScrollActive) {
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
    const previousScrollTop = viewport.scrollTop;
    const previousTopSlotHeight = topSlotHeight();
    const previousItemOffset = Math.max(
      0,
      previousScrollTop - previousTopSlotHeight,
    );
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
      setScrollTop(nextScrollTop);
    }

    renderNow(viewport.scrollTop);
  }

  function handleScroll(): void {
    if (userScrollActive) userScrollMoved = true;
    scheduleRender();
  }

  function hasActiveTouchOrPointerInput(): boolean {
    return touchInputActive || activePointers.size > 0;
  }

  function cancelBlockedScrollEndFrame(): void {
    if (!blockedScrollEndFrame) return;
    cancelAnimationFrame(blockedScrollEndFrame);
    blockedScrollEndFrame = 0;
  }

  function finishUserScroll(): void {
    cancelBlockedScrollEndFrame();
    scrollEndBlockedByInput = false;
    userScrollActive = false;
    userScrollMoved = false;
    if (flushDeferredLayoutUpdates()) {
      flushMeasurementsNow();
    } else if (!flushMeasurementsNow()) {
      renderNow(viewport.scrollTop);
    }
    onScrollEnd?.(getState());
  }

  function scheduleBlockedScrollEndFinish(): void {
    if (blockedScrollEndFrame || !scrollEndBlockedByInput) return;

    // Some browsers can report scrollend before the final touch/pointer release.
    // If no second scrollend follows, this releases deferred layout work.
    blockedScrollEndFrame = requestAnimationFrame(() => {
      blockedScrollEndFrame = 0;
      if (
        disposed ||
        hasActiveTouchOrPointerInput() ||
        !scrollEndBlockedByInput
      ) {
        return;
      }
      finishUserScroll();
    });
  }

  function handleScrollEnd(): void {
    if (hasActiveTouchOrPointerInput()) {
      scrollEndBlockedByInput = true;
      scheduleRender();
      return;
    }
    finishUserScroll();
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
    cancelBlockedScrollEndFrame();
    const wasActive = userScrollActive;
    userScrollActive = true;
    if (!wasActive) userScrollMoved = false;
    if (!wasActive) {
      onScrollStart?.(getState());
    }
  }

  function handleUserScrollMaybeEnd(): void {
    if (hasActiveTouchOrPointerInput()) return;
    if (scrollEndBlockedByInput) {
      scheduleBlockedScrollEndFinish();
      return;
    }
    if (userScrollMoved) return;
    userScrollActive = false;
    if (pendingMeasurements.size > 0) {
      scheduleMeasurementFlush();
    }
  }

  function handleTouchScrollStart(): void {
    touchInputActive = true;
    handleUserScrollStart();
  }

  function handleTouchScrollEnd(event: TouchEvent): void {
    if (event.touches.length === 0) touchInputActive = false;
    handleUserScrollMaybeEnd();
  }

  function handlePointerScrollStart(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    activePointers.add(event.pointerId);
    handleUserScrollStart();
  }

  function handlePointerScrollEnd(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    activePointers.delete(event.pointerId);
    handleUserScrollMaybeEnd();
  }

  viewport.addEventListener("scroll", handleScroll, { passive: true });
  viewport.addEventListener("scrollend", handleScrollEnd, { passive: true });
  viewport.addEventListener("wheel", handleUserScrollStart, { passive: true });
  const supportsPointerEvents = "PointerEvent" in window;
  const supportsTouchEvents = "TouchEvent" in window;
  if (supportsPointerEvents) {
    viewport.addEventListener("pointerdown", handlePointerScrollStart, {
      passive: true,
    });
    viewport.addEventListener("pointerup", handlePointerScrollEnd, {
      passive: true,
    });
    viewport.addEventListener("pointercancel", handlePointerScrollEnd, {
      passive: true,
    });
  }
  if (supportsTouchEvents) {
    viewport.addEventListener("touchstart", handleTouchScrollStart, {
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
    scrollToTop,
    scrollToBottom,
    setStickyIndex,
    getMountedElement,
    refreshIndex,
    refreshMounted,
    dispose() {
      disposed = true;
      if (renderFrame) cancelAnimationFrame(renderFrame);
      if (measurementFrame) cancelAnimationFrame(measurementFrame);
      cancelBlockedScrollEndFrame();
      deferredLayoutUpdates.length = 0;
      itemResizeObserver.disconnect();
      viewportResizeObserver.disconnect();
      boundaryIntersectionObserver?.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("scrollend", handleScrollEnd);
      viewport.removeEventListener("wheel", handleUserScrollStart);
      if (supportsPointerEvents) {
        viewport.removeEventListener("pointerdown", handlePointerScrollStart);
        viewport.removeEventListener("pointerup", handlePointerScrollEnd);
        viewport.removeEventListener("pointercancel", handlePointerScrollEnd);
      }
      if (supportsTouchEvents) {
        viewport.removeEventListener("touchstart", handleTouchScrollStart);
        viewport.removeEventListener("touchend", handleTouchScrollEnd);
        viewport.removeEventListener("touchcancel", handleTouchScrollEnd);
      }
      viewport.classList.remove("dv-viewport");
      content.remove();
      mounted.clear();
    },
  };
}
