import {
  createVirtualList,
  type VirtualList,
  type VirtualListBoundary,
  type VirtualListBoundarySlot,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { applyDocumentTheme, watchSystemTheme } from "../demo-theme.js";
import {
  at,
  bindThemeButtons,
  mustGet,
  syncThemeButtons,
} from "../demo-utils.js";
import { createPhotoPreview } from "../photo-preview.js";

import "../demo-styles.css";
import "../photo-preview.css";
import "./gallery.css";

// One gallery demo with a runtime layout toggle: justified rows (each band is a
// single photo strip) or masonry columns (each band is a column-balanced slice).
// Both layouts emit the same shape — a list of variable-height `Band`s of
// absolutely-positioned photos — so the virtual list, boundary loading, photo
// preview, and retained window are shared; only the layout engine differs.

const TOTAL_PHOTOS = 1_600;
const PHOTO_GAP = 4;
const MAX_CANVAS_WIDTH = 1180;
const HORIZONTAL_PADDING = 32;
const BOUNDARY_SLOT_HEIGHT = 52;
const OVERSCAN_PX = 720;
const MAX_IMAGE_SOURCE_WIDTH = 640;
const PLACEHOLDER_VELOCITY_THRESHOLD = 10;
const LOAD_DELAY_MS = 540;

// Justified layout
const DEFAULT_ROW_HEIGHT = 190;
// Masonry layout
const DEFAULT_COLUMNS = 4;
const BAND_TARGET_HEIGHT = 520;

// Real picsum aspect ratios vary widely; this palette stands in for that range.
const ASPECT_RATIOS = [
  0.58, 0.66, 0.72, 0.82, 0.9, 1, 1.12, 1.28, 1.35, 1.45, 1.52,
] as const;

type LayoutMode = "justified" | "masonry";

// Retained-window sizing differs because masonry bands (~520px) are far taller
// than justified rows (~190px), so each unit covers a different pixel slice.
const WINDOW: Record<
  LayoutMode,
  { initial: number; retain: number; load: number; unit: string }
> = {
  justified: { initial: 180, retain: 260, load: 64, unit: "rows" },
  masonry: { initial: 24, retain: 72, load: 18, unit: "bands" },
};

interface Photo {
  id: number;
  aspectRatio: number;
}

interface PlacedPhoto extends Photo {
  column: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Band {
  top: number;
  // Top-to-next-top distance (includes the trailing gap), so bands tile the
  // content space contiguously and `itemHeight` is just this plus any tail.
  tileHeight: number;
  photos: readonly PlacedPhoto[];
}

interface Layout {
  mode: LayoutMode;
  width: number;
  gap: number;
  columns: number;
  cardWidth: number;
  targetHeight: number;
  bands: readonly Band[];
  photoBandIndex: Int32Array;
}

interface EdgePlaceholder {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BoundaryGeometry {
  visualEnd: number;
  topPlaceholders: readonly EdgePlaceholder[];
  bottomPlaceholders: readonly EdgePlaceholder[];
}

type Boundary = VirtualListBoundary;
type BoundarySlotState = "idle" | "loading" | "no-more" | "error";
type BoundaryResolvedState = Exclude<BoundarySlotState, "loading">;

interface ActiveBoundaryLoad {
  boundary: Boundary;
  sequence: number;
  controller: AbortController;
}

interface PendingBoundaryApply {
  boundary: Boundary;
  state: BoundaryResolvedState;
  addedBefore?: number;
  removedBefore?: number;
  apply: () => boolean;
}

const viewport = mustGet("viewport");
const rangeLabel = mustGet("range-label");
const mountedLabel = mustGet("mounted-label");
const layoutLabel = mustGet("layout-label");
const loadLabel = mustGet("load-label");
const topBtn = mustGet("top-btn", HTMLButtonElement);
const bottomBtn = mustGet("bottom-btn", HTMLButtonElement);

const photos: readonly Photo[] = Array.from(
  { length: TOTAL_PHOTOS },
  (_, index) => createPhoto(index),
);

let mode: LayoutMode = "masonry";
let selectedRowHeight = DEFAULT_ROW_HEIGHT;
let selectedColumns = DEFAULT_COLUMNS;
let layout: Layout = computeLayout();
let boundaryGeometry: BoundaryGeometry = {
  visualEnd: 0,
  topPlaceholders: [],
  bottomPlaceholders: [],
};
let loadedStart = 0;
let loadedEnd = 0;
const boundaryStates: Record<Boundary, BoundarySlotState> = {
  top: "idle",
  bottom: "idle",
};
let loadSequence = 0;
let activeBoundaryLoad: ActiveBoundaryLoad | null = null;
let pendingBoundaryApply: PendingBoundaryApply | null = null;
let scrollEnded = true;
let measuredViewportWidth = viewport.clientWidth;
let virtualList: VirtualList;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";
let renderedLoadText = "";

function createPhoto(index: number): Photo {
  const aspectRatio =
    ASPECT_RATIOS[(index * 7 + Math.floor(index / 3)) % ASPECT_RATIOS.length] ??
    1;
  return { id: index + 1, aspectRatio };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function px(value: number): string {
  return `${value.toFixed(3)}px`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function canvasWidthForViewport(): number {
  return Math.max(
    240,
    Math.min(MAX_CANVAS_WIDTH, viewport.clientWidth - HORIZONTAL_PADDING),
  );
}

function windowConfig(): (typeof WINDOW)[LayoutMode] {
  return WINDOW[mode];
}

// --- Layout engines ----------------------------------------------------------

function targetRowHeightForWidth(width: number): number {
  if (width < 520) return Math.min(selectedRowHeight, 150);
  if (width < 760) return Math.min(selectedRowHeight, 175);
  return selectedRowHeight;
}

// Justified row height from a running sum of 1/aspectRatio and the photo count,
// so the packing loop computes it incrementally instead of re-summing each add.
function justifiedRowHeight(
  widthFactor: number,
  photoCount: number,
  width: number,
): number {
  const available = width - Math.max(0, photoCount - 1) * PHOTO_GAP;
  return available / Math.max(0.01, widthFactor);
}

function placeJustifiedRow(
  rowPhotos: readonly Photo[],
  bandTop: number,
  rowHeight: number,
  width: number,
  justify: boolean,
): PlacedPhoto[] {
  const placed: PlacedPhoto[] = [];
  let left = 0;
  for (let index = 0; index < rowPhotos.length; index++) {
    const photo = rowPhotos[index];
    if (!photo) continue;
    const last = index === rowPhotos.length - 1;
    const photoWidth =
      justify && last
        ? Math.max(1, width - left)
        : Math.max(1, rowHeight / photo.aspectRatio);
    placed.push({
      ...photo,
      column: 0,
      left,
      top: bandTop,
      width: photoWidth,
      height: rowHeight,
    });
    left += photoWidth + PHOTO_GAP;
  }
  return placed;
}

function computeJustifiedLayout(width: number): Layout {
  const targetHeight = targetRowHeightForWidth(width);
  const bands: Band[] = [];
  const photoBandIndex = new Int32Array(photos.length);
  const currentPhotos: Photo[] = [];
  let widthFactor = 0;
  let top = 0;

  function flush(rowHeight: number, justify: boolean): void {
    const bandIndex = bands.length;
    const placed = placeJustifiedRow(
      currentPhotos,
      top,
      rowHeight,
      width,
      justify,
    );
    const tileHeight = rowHeight + PHOTO_GAP;
    bands.push({ top, tileHeight, photos: placed });
    for (const photo of currentPhotos) {
      photoBandIndex[photo.id - 1] = bandIndex;
    }
    top += tileHeight;
    currentPhotos.length = 0;
    widthFactor = 0;
  }

  for (const photo of photos) {
    currentPhotos.push(photo);
    widthFactor += 1 / photo.aspectRatio;
    if (currentPhotos.length < 2) continue;
    const rowHeight = justifiedRowHeight(
      widthFactor,
      currentPhotos.length,
      width,
    );
    if (rowHeight <= targetHeight) flush(rowHeight, true);
  }
  if (currentPhotos.length > 0) flush(targetHeight, false);

  return {
    mode: "justified",
    width,
    gap: PHOTO_GAP,
    columns: 0,
    cardWidth: 0,
    targetHeight,
    bands,
    photoBandIndex,
  };
}

function effectiveColumns(width: number): number {
  if (width < 520) return Math.min(2, selectedColumns);
  if (width < 760) return Math.min(3, selectedColumns);
  return selectedColumns;
}

function shortestColumnIndex(heights: readonly number[]): number {
  let column = 0;
  let shortest = heights[0] ?? 0;
  for (let index = 1; index < heights.length; index++) {
    const height = heights[index] ?? 0;
    if (height < shortest) {
      shortest = height;
      column = index;
    }
  }
  return column;
}

// Slice the placed photos into fine groups at each distinct photo top, then
// merge adjacent fine groups up to a target band height. Each band becomes one
// virtualized item; mounting a band mounts a contiguous horizontal slice.
function computeMasonryBands(
  placed: readonly PlacedPhoto[],
  totalHeight: number,
  targetHeight: number,
  photoBandIndex: Int32Array,
): Band[] {
  const photosByTop = new Map<number, PlacedPhoto[]>();
  for (const photo of placed) {
    const group = photosByTop.get(photo.top);
    if (group) group.push(photo);
    else photosByTop.set(photo.top, [photo]);
  }
  const tops = Array.from(photosByTop.keys()).sort(
    (left, right) => left - right,
  );

  const bands: Band[] = [];
  let chunkPhotos: PlacedPhoto[] = [];
  let chunkTop = tops[0] ?? 0;
  let chunkHeight = 0;

  const flush = (): void => {
    if (chunkPhotos.length === 0) return;
    const bandIndex = bands.length;
    bands.push({ top: chunkTop, tileHeight: chunkHeight, photos: chunkPhotos });
    for (const photo of chunkPhotos) {
      photoBandIndex[photo.id - 1] = bandIndex;
    }
  };

  for (let index = 0; index < tops.length; index++) {
    const top = at(tops, index);
    const next = tops[index + 1] ?? totalHeight;
    const sliceHeight = Math.max(1, next - top);
    if (chunkPhotos.length > 0 && chunkHeight >= targetHeight) {
      flush();
      chunkPhotos = [];
      chunkTop = top;
      chunkHeight = 0;
    }
    if (chunkPhotos.length === 0) chunkTop = top;
    chunkPhotos.push(...(photosByTop.get(top) ?? []));
    chunkHeight += sliceHeight;
  }
  flush();
  return bands;
}

function computeMasonryLayout(width: number): Layout {
  const columns = effectiveColumns(width);
  const gap = PHOTO_GAP;
  const cardWidth = Math.max(80, (width - (columns - 1) * gap) / columns);
  const columnHeights = Array.from({ length: columns }, () => 0);
  const placed: PlacedPhoto[] = [];
  const photoBandIndex = new Int32Array(photos.length);

  for (const photo of photos) {
    const column = shortestColumnIndex(columnHeights);
    const top = columnHeights[column] ?? 0;
    const height = Math.max(88, Math.round(cardWidth * photo.aspectRatio));
    placed.push({
      ...photo,
      column,
      left: column * (cardWidth + gap),
      top,
      width: cardWidth,
      height,
    });
    columnHeights[column] = top + height + gap;
  }

  const totalHeight = Math.max(1, Math.max(...columnHeights) - gap);
  const bands = computeMasonryBands(
    placed,
    totalHeight,
    BAND_TARGET_HEIGHT,
    photoBandIndex,
  );

  return {
    mode: "masonry",
    width,
    gap,
    columns,
    cardWidth,
    targetHeight: 0,
    bands,
    photoBandIndex,
  };
}

function computeLayout(): Layout {
  const width = canvasWidthForViewport();
  return mode === "masonry"
    ? computeMasonryLayout(width)
    : computeJustifiedLayout(width);
}

// --- Ragged-edge geometry (masonry only) -------------------------------------
// A masonry retained window has ragged top/bottom edges because the columns are
// uneven. Fill those edges with placeholder cards so the slice reads as a clean
// block, and pad the last band so the tallest column's overflow is covered.

function bandEnd(band: Band | undefined): number {
  return band ? band.top + band.tileHeight : 0;
}

function edgePlaceholder(
  column: number,
  top: number,
  height: number,
): EdgePlaceholder | null {
  if (height <= 1) return null;
  return {
    left: column * (layout.cardWidth + layout.gap),
    top,
    width: layout.cardWidth,
    height,
  };
}

function recomputeBoundaryGeometry(): void {
  if (mode !== "masonry") {
    boundaryGeometry = {
      visualEnd: bandEnd(layout.bands[loadedEnd - 1]),
      topPlaceholders: [],
      bottomPlaceholders: [],
    };
    return;
  }

  const sliceStart = layout.bands[loadedStart]?.top ?? 0;
  const firstTopByColumn = Array.from(
    { length: layout.columns },
    () => Number.POSITIVE_INFINITY,
  );
  const lastBottomByColumn = Array.from(
    { length: layout.columns },
    () => Number.NEGATIVE_INFINITY,
  );
  let visualEnd = bandEnd(layout.bands[loadedEnd - 1]);

  for (let index = loadedStart; index < loadedEnd; index++) {
    const band = layout.bands[index];
    if (!band) continue;
    for (const photo of band.photos) {
      const bottom = photo.top + photo.height;
      firstTopByColumn[photo.column] = Math.min(
        firstTopByColumn[photo.column] ?? Number.POSITIVE_INFINITY,
        photo.top,
      );
      lastBottomByColumn[photo.column] = Math.max(
        lastBottomByColumn[photo.column] ?? Number.NEGATIVE_INFINITY,
        bottom,
      );
      visualEnd = Math.max(visualEnd, bottom);
    }
  }

  const topPlaceholders: EdgePlaceholder[] = [];
  if (loadedStart > 0) {
    for (let column = 0; column < layout.columns; column++) {
      const firstTop = firstTopByColumn[column] ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(firstTop)) continue;
      const placeholder = edgePlaceholder(
        column,
        sliceStart,
        firstTop - sliceStart - layout.gap,
      );
      if (placeholder) topPlaceholders.push(placeholder);
    }
  }

  const bottomPlaceholders: EdgePlaceholder[] = [];
  if (loadedEnd < layout.bands.length) {
    for (let column = 0; column < layout.columns; column++) {
      const lastBottom = lastBottomByColumn[column] ?? Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(lastBottom)) continue;
      const top = lastBottom + layout.gap;
      const placeholder = edgePlaceholder(column, top, visualEnd - top);
      if (placeholder) bottomPlaceholders.push(placeholder);
    }
  }

  boundaryGeometry = { visualEnd, topPlaceholders, bottomPlaceholders };
}

function loadedBottomTailHeight(): number {
  if (mode !== "masonry" || currentCount() === 0) return 0;
  return Math.max(
    0,
    boundaryGeometry.visualEnd - bandEnd(layout.bands[loadedEnd - 1]),
  );
}

// --- Item model --------------------------------------------------------------

function currentCount(): number {
  return Math.max(0, loadedEnd - loadedStart);
}

function bandForLocalIndex(index: number): Band {
  const band = layout.bands[loadedStart + index];
  if (!band) throw new Error(`missing gallery band ${loadedStart + index}`);
  return band;
}

function itemHeight(index: number): number {
  const band = bandForLocalIndex(index);
  const tail = index === currentCount() - 1 ? loadedBottomTailHeight() : 0;
  return band.tileHeight + tail;
}

function imageSourceWidth(photo: PlacedPhoto): number {
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  return Math.min(
    MAX_IMAGE_SOURCE_WIDTH,
    Math.max(120, Math.ceil(photo.width * pixelRatio)),
  );
}

function imageUrlForWidth(photo: Photo, width: number): string {
  const height = Math.max(120, Math.round(width * photo.aspectRatio));
  return `https://picsum.photos/seed/virtual-list-gallery-${photo.id}/${width}/${height}`;
}

function imageUrl(photo: PlacedPhoto): string {
  return imageUrlForWidth(photo, imageSourceWidth(photo));
}

function photoDetailsText(photo: PlacedPhoto): string {
  return `Photo ${photo.id} · ${Math.round(photo.width)}×${Math.round(photo.height)} · ${photo.aspectRatio.toFixed(2)} ratio`;
}

const photoPreview = createPhotoPreview<PlacedPhoto>({
  viewport,
  thumbnailUrl: imageUrl,
  previewUrl: imageUrlForWidth,
  detailsText: photoDetailsText,
});

function buildPhotoFrame(photo: PlacedPhoto, bandTop: number): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "gallery-photo";
  frame.style.left = px(photo.left);
  frame.style.top = px(photo.top - bandTop);
  frame.style.width = px(photo.width);
  frame.style.height = px(photo.height);

  const image = document.createElement("img");
  image.className = "gallery-photo-img photo-preview-image";
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  const sourceWidth = imageSourceWidth(photo);
  image.width = sourceWidth;
  image.height = Math.max(120, Math.round(sourceWidth * photo.aspectRatio));
  image.src = imageUrlForWidth(photo, sourceWidth);

  frame.append(image);
  photoPreview.bind(frame, photo);
  return frame;
}

function buildPlaceholderFrame(
  rect: EdgePlaceholder,
  bandTop: number,
): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "gallery-photo-placeholder";
  frame.setAttribute("aria-hidden", "true");
  frame.style.left = px(rect.left);
  frame.style.top = px(rect.top - bandTop);
  frame.style.width = px(rect.width);
  frame.style.height = px(rect.height);
  return frame;
}

function appendEdgePlaceholders(
  inner: HTMLElement,
  localIndex: number,
  bandTop: number,
): void {
  if (localIndex === 0) {
    for (const rect of boundaryGeometry.topPlaceholders) {
      inner.appendChild(buildPlaceholderFrame(rect, bandTop));
    }
  }
  if (localIndex === currentCount() - 1) {
    for (const rect of boundaryGeometry.bottomPlaceholders) {
      inner.appendChild(buildPlaceholderFrame(rect, bandTop));
    }
  }
}

function buildBandShell(
  localIndex: number,
  fill: (inner: HTMLElement, band: Band) => void,
): HTMLElement {
  const band = bandForLocalIndex(localIndex);
  const height = itemHeight(localIndex);
  const item = document.createElement("section");
  item.className = "gallery-band";
  item.style.height = px(height);

  const inner = document.createElement("div");
  inner.className = "gallery-band-inner";
  inner.style.width = px(layout.width);
  inner.style.height = px(height);
  appendEdgePlaceholders(inner, localIndex, band.top);
  fill(inner, band);

  item.appendChild(inner);
  return item;
}

function buildItem(localIndex: number): HTMLElement {
  return buildBandShell(localIndex, (inner, band) => {
    for (const photo of band.photos) {
      inner.appendChild(buildPhotoFrame(photo, band.top));
    }
  });
}

function buildPlaceholder(localIndex: number): HTMLElement {
  return buildBandShell(localIndex, (inner, band) => {
    for (const photo of band.photos) {
      inner.appendChild(buildPlaceholderFrame(photo, band.top));
    }
  });
}

// --- Boundary slots ----------------------------------------------------------

function buildBoundarySlot(boundary: Boundary): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "boundary-slot";
  slot.dataset.boundaryContent = boundary;

  const spinner = document.createElement("span");
  spinner.className = "boundary-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "boundary-text";

  slot.append(spinner, text);
  updateBoundarySlotElement(slot, boundary);
  return slot;
}

function updateBoundarySlotElement(
  container: HTMLElement,
  boundary: Boundary,
): void {
  const slot = container.matches(".boundary-slot")
    ? container
    : container.querySelector<HTMLElement>(".boundary-slot");
  if (!slot) return;

  const state = boundaryStates[boundary];
  const text = slot.querySelector(".boundary-text");
  if (slot.dataset.state !== state) {
    slot.dataset.state = state;
  }
  if (!text) return;

  let nextText = "";
  if (state === "loading") {
    nextText =
      boundary === "top" ? "Loading previous photos" : "Loading next photos";
  } else if (state === "no-more") {
    nextText = boundary === "top" ? "At first photo" : "At last photo";
  } else if (state === "error") {
    nextText = "Could not load photos";
  }

  if (text.textContent !== nextText) {
    text.textContent = nextText;
  }
}

function boundarySlotFor(boundary: Boundary): VirtualListBoundarySlot {
  return {
    key: `${boundary}:slot`,
    height: BOUNDARY_SLOT_HEIGHT,
    build: () => buildBoundarySlot(boundary),
  };
}

function refreshBoundarySlot(boundary: Boundary): void {
  const element = virtualList.getBoundaryElement(boundary);
  if (element) updateBoundarySlotElement(element, boundary);
}

function refreshBoundarySlots(): void {
  refreshBoundarySlot("top");
  refreshBoundarySlot("bottom");
}

function syncBoundarySlots(): void {
  virtualList.syncLayout({
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    after: () => {
      refreshBoundarySlots();
      updateInfo();
    },
  });
}

function setBoundaryState(boundary: Boundary, state: BoundarySlotState): void {
  boundaryStates[boundary] = state;
  refreshBoundarySlot(boundary);
  syncLoadLabel();
}

// --- Status bar --------------------------------------------------------------

function setTextIfChanged(element: HTMLElement, nextText: string): string {
  if (element.textContent !== nextText) {
    element.textContent = nextText;
  }
  return nextText;
}

function syncLoadLabel(): void {
  let loadText: string;
  if (boundaryStates.top === "loading") {
    loadText = "loading previous";
  } else if (boundaryStates.bottom === "loading") {
    loadText = "loading next";
  } else {
    loadText = `${currentCount()} retained ${windowConfig().unit}`;
  }

  if (loadText !== renderedLoadText) {
    renderedLoadText = setTextIfChanged(loadLabel, loadText);
  }
}

function updateInfo(state: VirtualListState = virtualList.state): void {
  const unit = windowConfig().unit;
  const first = loadedStart + state.range.start + 1;
  const last = loadedStart + state.range.end;
  const rangeText = `${first}-${last} / ${layout.bands.length} ${unit}`;
  if (rangeText !== renderedRangeText) {
    renderedRangeText = setTextIfChanged(rangeLabel, rangeText);
  }

  const mountedText = `${state.mountedCount} mounted`;
  if (mountedText !== renderedMountedText) {
    renderedMountedText = setTextIfChanged(mountedLabel, mountedText);
  }

  const layoutText =
    mode === "masonry"
      ? `${layout.columns} columns · ${layout.gap}px gap`
      : `${Math.round(layout.targetHeight)}px row target`;
  if (layoutText !== renderedLayoutText) {
    renderedLayoutText = setTextIfChanged(layoutLabel, layoutText);
  }

  syncLoadLabel();
}

// --- Retained window + boundary loading --------------------------------------

function initializeLoadedWindow(): void {
  const count = layout.bands.length;
  const retained = Math.min(windowConfig().initial, count);
  loadedStart = 0;
  loadedEnd = Math.min(count, loadedStart + retained);
  recomputeBoundaryGeometry();
  boundaryStates.top = idleStateForBoundary("top");
  boundaryStates.bottom = idleStateForBoundary("bottom");
}

function idleStateForBoundary(boundary: Boundary): BoundaryResolvedState {
  if (boundary === "top") return loadedStart <= 0 ? "no-more" : "idle";
  return loadedEnd >= layout.bands.length ? "no-more" : "idle";
}

function canLoadBoundary(boundary: Boundary): boolean {
  return idleStateForBoundary(boundary) !== "no-more";
}

function isCurrentBoundaryLoad(load: ActiveBoundaryLoad): boolean {
  return (
    activeBoundaryLoad?.boundary === load.boundary &&
    activeBoundaryLoad.sequence === load.sequence
  );
}

function cancelActiveBoundaryLoad(): void {
  const load = activeBoundaryLoad;
  if (!load) return;
  load.controller.abort();
  activeBoundaryLoad = null;
  setBoundaryState(load.boundary, idleStateForBoundary(load.boundary));
}

function resetBoundaryLoading(): void {
  cancelActiveBoundaryLoad();
  pendingBoundaryApply = null;
  boundaryStates.top = idleStateForBoundary("top");
  boundaryStates.bottom = idleStateForBoundary("bottom");
  refreshBoundarySlots();
  syncLoadLabel();
}

function prepareTopApply(signal: AbortSignal): Promise<PendingBoundaryApply> {
  if (loadedStart <= 0) {
    return Promise.resolve({
      boundary: "top",
      state: "no-more",
      apply: () => false,
    });
  }

  return sleep(LOAD_DELAY_MS, signal).then(() => {
    if (signal.aborted) {
      return {
        boundary: "top",
        state: idleStateForBoundary("top"),
        apply: () => false,
      };
    }

    const load = windowConfig().load;
    const retain = windowConfig().retain;
    const addedBefore = Math.min(load, loadedStart);
    const nextStart = loadedStart - addedBefore;
    let nextEnd = loadedEnd;
    const overflow = nextEnd - nextStart - retain;
    if (overflow > 0) nextEnd -= overflow;

    return {
      boundary: "top",
      state: nextStart <= 0 ? "no-more" : "idle",
      addedBefore,
      apply: () => {
        loadedStart = nextStart;
        loadedEnd = nextEnd;
        recomputeBoundaryGeometry();
        return true;
      },
    };
  });
}

function prepareBottomApply(
  signal: AbortSignal,
): Promise<PendingBoundaryApply> {
  if (loadedEnd >= layout.bands.length) {
    return Promise.resolve({
      boundary: "bottom",
      state: "no-more",
      apply: () => false,
    });
  }

  return sleep(LOAD_DELAY_MS, signal).then(() => {
    if (signal.aborted) {
      return {
        boundary: "bottom",
        state: idleStateForBoundary("bottom"),
        apply: () => false,
      };
    }

    const load = windowConfig().load;
    const retain = windowConfig().retain;
    const appended = Math.min(load, layout.bands.length - loadedEnd);
    let nextStart = loadedStart;
    const nextEnd = loadedEnd + appended;
    const overflow = nextEnd - nextStart - retain;
    if (overflow > 0) nextStart += overflow;

    return {
      boundary: "bottom",
      state: nextEnd >= layout.bands.length ? "no-more" : "idle",
      removedBefore: nextStart - loadedStart,
      apply: () => {
        loadedStart = nextStart;
        loadedEnd = nextEnd;
        recomputeBoundaryGeometry();
        return true;
      },
    };
  });
}

function applyPendingBoundaryLoad(): void {
  if (!scrollEnded || !pendingBoundaryApply) return;

  const pending = pendingBoundaryApply;
  pendingBoundaryApply = null;
  boundaryStates[pending.boundary] = pending.state;

  virtualList.syncLayout({
    addedBefore: pending.addedBefore,
    removedBefore: pending.removedBefore,
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    apply: pending.apply,
    after: () => {
      virtualList.invalidateMeasurements();
      refreshBoundarySlots();
      updateInfo();
    },
  });
}

async function prepareBoundaryLoad(load: ActiveBoundaryLoad): Promise<void> {
  try {
    const pending =
      load.boundary === "top"
        ? await prepareTopApply(load.controller.signal)
        : await prepareBottomApply(load.controller.signal);
    if (!isCurrentBoundaryLoad(load) || load.controller.signal.aborted) return;

    activeBoundaryLoad = null;
    if (
      pending.addedBefore === undefined &&
      pending.removedBefore === undefined
    ) {
      setBoundaryState(load.boundary, pending.state);
      return;
    }
    pendingBoundaryApply = pending;
    applyPendingBoundaryLoad();
  } catch (error) {
    if (!isCurrentBoundaryLoad(load) || load.controller.signal.aborted) return;
    activeBoundaryLoad = null;
    console.error(error);
    setBoundaryState(load.boundary, "error");
  }
}

function startBoundaryLoad(boundary: Boundary): void {
  if (pendingBoundaryApply?.boundary === boundary) return;
  if (activeBoundaryLoad?.boundary === boundary) return;
  cancelActiveBoundaryLoad();
  if (pendingBoundaryApply) {
    setBoundaryState(
      pendingBoundaryApply.boundary,
      idleStateForBoundary(pendingBoundaryApply.boundary),
    );
  }
  pendingBoundaryApply = null;

  if (!canLoadBoundary(boundary)) {
    setBoundaryState(boundary, "no-more");
    return;
  }

  const load: ActiveBoundaryLoad = {
    boundary,
    sequence: ++loadSequence,
    controller: new AbortController(),
  };
  activeBoundaryLoad = load;
  setBoundaryState(boundary, "loading");
  void prepareBoundaryLoad(load);
}

function handleScrollStart(): void {
  scrollEnded = false;
}

function handleScrollEnd(): void {
  scrollEnded = true;
  applyPendingBoundaryLoad();
}

// --- Layout rebuild (mode / density / resize) --------------------------------

function firstVisiblePhotoId(): number {
  const bandIndex = clamp(
    loadedStart + virtualList.state.range.start,
    0,
    Math.max(0, layout.bands.length - 1),
  );
  return layout.bands[bandIndex]?.photos[0]?.id ?? 1;
}

function bandIndexForPhotoId(photoId: number): number {
  return clamp(
    layout.photoBandIndex[photoId - 1] ?? 0,
    0,
    Math.max(0, layout.bands.length - 1),
  );
}

function rebuildLayout(): void {
  const anchorPhotoId = firstVisiblePhotoId();
  const previousLocalStart = virtualList.state.range.start;
  layout = computeLayout();

  const retained = Math.min(windowConfig().retain, layout.bands.length);
  const anchorBand = bandIndexForPhotoId(anchorPhotoId);
  const anchorOffset = Math.min(previousLocalStart, Math.floor(retained / 2));
  loadedStart = clamp(
    anchorBand - anchorOffset,
    0,
    Math.max(0, layout.bands.length - retained),
  );
  loadedEnd = Math.min(layout.bands.length, loadedStart + retained);
  recomputeBoundaryGeometry();
  resetBoundaryLoading();

  virtualList.syncLayout({
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    after: () => {
      virtualList.invalidateMeasurements();
      virtualList.refreshMounted();
      refreshBoundarySlots();
      updateInfo();
    },
  });
}

// --- Controls ----------------------------------------------------------------

function syncControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-layout]",
  )) {
    button.classList.toggle("active", button.dataset.layout === mode);
  }
  for (const group of document.querySelectorAll<HTMLElement>(
    "[data-control]",
  )) {
    const forMode = group.dataset.control === mode;
    group.hidden = !forMode;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-row-height]",
  )) {
    button.classList.toggle(
      "active",
      Number(button.dataset.rowHeight) === selectedRowHeight,
    );
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-columns]",
  )) {
    button.classList.toggle(
      "active",
      Number(button.dataset.columns) === selectedColumns,
    );
  }
}

function bindControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-layout]",
  )) {
    button.addEventListener("click", () => {
      const next = button.dataset.layout;
      if ((next !== "justified" && next !== "masonry") || next === mode) return;
      mode = next;
      syncControls();
      rebuildLayout();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-row-height]",
  )) {
    button.addEventListener("click", () => {
      const rowHeight = Number(button.dataset.rowHeight);
      if (!Number.isFinite(rowHeight) || rowHeight === selectedRowHeight)
        return;
      selectedRowHeight = rowHeight;
      syncControls();
      if (mode === "justified") rebuildLayout();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-columns]",
  )) {
    button.addEventListener("click", () => {
      const columns = Number(button.dataset.columns);
      if (!Number.isFinite(columns) || columns === selectedColumns) return;
      selectedColumns = columns;
      syncControls();
      if (mode === "masonry") rebuildLayout();
    });
  }

  topBtn.addEventListener("click", () => {
    void virtualList.scrollToTop({ behavior: "smooth" });
  });
  bottomBtn.addEventListener("click", () => {
    void virtualList.scrollToBottom({ behavior: "smooth" });
  });
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
}

function handleViewportResize(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measuredViewportWidth = viewport.clientWidth;
  rebuildLayout();
}

// --- Boot --------------------------------------------------------------------

initializeLoadedWindow();
bindControls();
bindThemeButtons(refreshTheme);
syncControls();
refreshTheme();

virtualList = createVirtualList({
  viewport,
  canvasClassName: "gallery-canvas",
  getCount: currentCount,
  getItemHeight: itemHeight,
  buildItem,
  buildPlaceholder,
  placeholderVelocityThreshold: PLACEHOLDER_VELOCITY_THRESHOLD,
  overscanPx: OVERSCAN_PX,
  onReachTop: () => {
    startBoundaryLoad("top");
  },
  onReachBottom: () => {
    startBoundaryLoad("bottom");
  },
  onScrollStart: handleScrollStart,
  onScrollEnd: handleScrollEnd,
  onRangeChange: updateInfo,
});
syncBoundarySlots();

const viewportResizeObserver = new ResizeObserver(handleViewportResize);
viewportResizeObserver.observe(viewport);

await document.fonts.ready;
updateInfo();
document.documentElement.classList.remove("booting");
watchSystemTheme(refreshTheme);
