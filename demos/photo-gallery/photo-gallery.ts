import {
  createDynamicVirtualizer,
  type DynamicVirtualizer,
  type DynamicVirtualizerBoundary,
  type DynamicVirtualizerBoundarySlot,
  type DynamicVirtualizerState,
} from "../../src/dynamic-virtualizer.js";
import { applyDocumentTheme, watchSystemTheme } from "../demo-theme.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";
import { createPhotoPreview } from "../photo-preview.js";

import "../demo-styles.css";
import "../photo-preview.css";
import "./photo-gallery.css";

const TOTAL_PHOTOS = 2_400;
const PHOTO_GAP = 4;
const MAX_CANVAS_WIDTH = 1180;
const HORIZONTAL_PADDING = 32;
const DEFAULT_ROW_HEIGHT = 190;
const INITIAL_ROWS = 180;
const RETAIN_ROWS = 260;
const LOAD_ROWS = 64;
const LOAD_DELAY_MS = 520;
const BOUNDARY_SLOT_HEIGHT = 52;
const MAX_IMAGE_SOURCE_WIDTH = 640;
const OVERSCAN_PX = 720;

const ASPECT_RATIOS = [
  0.58, 0.66, 0.72, 0.82, 0.9, 1, 1.12, 1.28, 1.45,
] as const;

interface Photo {
  id: number;
  aspectRatio: number;
}

interface PlacedPhoto extends Photo {
  left: number;
  width: number;
  height: number;
}

interface GalleryRow {
  height: number;
  photos: readonly PlacedPhoto[];
}

interface GalleryLayout {
  width: number;
  gap: number;
  targetHeight: number;
  rows: readonly GalleryRow[];
  photoRowIndexes: Int32Array;
}

type Boundary = DynamicVirtualizerBoundary;
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

const photos = Array.from({ length: TOTAL_PHOTOS }, (_, index) =>
  createPhoto(index),
);

let selectedRowHeight = DEFAULT_ROW_HEIGHT;
let layout = computeGalleryLayout();
let loadedStartRow = 0;
let loadedEndRow = 0;
const boundaryStates: Record<Boundary, BoundarySlotState> = {
  top: "idle",
  bottom: "idle",
};
let loadSequence = 0;
let activeBoundaryLoad: ActiveBoundaryLoad | null = null;
let pendingBoundaryApply: PendingBoundaryApply | null = null;
let scrollEnded = true;
let measuredViewportWidth = viewport.clientWidth;
let virtualizer: DynamicVirtualizer;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";
let renderedLoadText = "";

function createPhoto(index: number): Photo {
  const aspectRatio =
    ASPECT_RATIOS[(index * 7 + Math.floor(index / 3)) % ASPECT_RATIOS.length] ??
    1;
  return {
    id: index + 1,
    aspectRatio,
  };
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

function targetRowHeightForWidth(width: number): number {
  if (width < 520) return Math.min(selectedRowHeight, 150);
  if (width < 760) return Math.min(selectedRowHeight, 175);
  return selectedRowHeight;
}

function justifiedHeight(rowPhotos: readonly Photo[], width: number): number {
  const available = width - Math.max(0, rowPhotos.length - 1) * PHOTO_GAP;
  let widthFactor = 0;
  for (const photo of rowPhotos) {
    widthFactor += 1 / photo.aspectRatio;
  }
  return available / Math.max(0.01, widthFactor);
}

function createJustifiedRow(
  rowPhotos: readonly Photo[],
  rowHeight: number,
  width: number,
  justify: boolean,
): GalleryRow {
  const photosInRow: PlacedPhoto[] = [];
  let left = 0;

  for (let index = 0; index < rowPhotos.length; index++) {
    const photo = rowPhotos[index];
    if (!photo) continue;
    const last = index === rowPhotos.length - 1;
    const photoWidth =
      justify && last
        ? Math.max(1, width - left)
        : Math.max(1, rowHeight / photo.aspectRatio);
    photosInRow.push({
      ...photo,
      left,
      width: photoWidth,
      height: rowHeight,
    });
    left += photoWidth + PHOTO_GAP;
  }

  return {
    height: rowHeight,
    photos: photosInRow,
  };
}

function computeGalleryLayout(): GalleryLayout {
  const width = canvasWidthForViewport();
  const targetHeight = targetRowHeightForWidth(width);
  const rows: GalleryRow[] = [];
  const photoRowIndexes = new Int32Array(photos.length);
  const currentPhotos: Photo[] = [];

  function flushCurrent(rowHeight: number, justify: boolean): void {
    const row = createJustifiedRow(currentPhotos, rowHeight, width, justify);
    const rowIndex = rows.length;
    rows.push(row);
    for (const photo of currentPhotos) {
      photoRowIndexes[photo.id - 1] = rowIndex;
    }
    currentPhotos.length = 0;
  }

  for (const photo of photos) {
    currentPhotos.push(photo);
    if (currentPhotos.length < 2) continue;
    const rowHeight = justifiedHeight(currentPhotos, width);
    if (rowHeight <= targetHeight) flushCurrent(rowHeight, true);
  }

  if (currentPhotos.length > 0) {
    flushCurrent(targetHeight, false);
  }

  return {
    width,
    gap: PHOTO_GAP,
    targetHeight,
    rows,
    photoRowIndexes,
  };
}

function currentCount(): number {
  return Math.max(0, loadedEndRow - loadedStartRow);
}

function rowForLocalIndex(index: number): GalleryRow {
  const row = layout.rows[loadedStartRow + index];
  if (!row) {
    throw new Error(`missing gallery row ${loadedStartRow + index}`);
  }
  return row;
}

function itemHeight(index: number): number {
  return rowForLocalIndex(index).height + layout.gap;
}

function imageSourceWidth(photo: PlacedPhoto): number {
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  return Math.min(
    MAX_IMAGE_SOURCE_WIDTH,
    Math.max(120, Math.ceil(photo.width * pixelRatio)),
  );
}

function imageUrl(photo: PlacedPhoto): string {
  const width = imageSourceWidth(photo);
  return imageUrlForWidth(photo, width);
}

function imageUrlForWidth(photo: Photo, width: number): string {
  const height = Math.max(120, Math.round(width * photo.aspectRatio));
  return `https://picsum.photos/seed/virtual-list-gallery-${photo.id}/${width}/${height}`;
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

function buildItem(index: number): HTMLElement {
  const row = rowForLocalIndex(index);
  const element = document.createElement("div");
  element.className = "gallery-row";
  element.style.height = px(itemHeight(index));

  const inner = document.createElement("div");
  inner.className = "gallery-row-inner";
  inner.style.width = px(layout.width);
  inner.style.height = px(row.height);

  for (const photo of row.photos) {
    const frame = document.createElement("div");
    frame.className = "gallery-photo";
    frame.style.left = px(photo.left);
    frame.style.width = px(photo.width);
    frame.style.height = px(photo.height);

    const image = document.createElement("img");
    image.className = "gallery-photo-img photo-preview-image";
    image.src = imageUrl(photo);
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    const sourceWidth = imageSourceWidth(photo);
    image.width = sourceWidth;
    image.height = Math.max(120, Math.round(sourceWidth * photo.aspectRatio));

    frame.append(image);
    photoPreview.bind(frame, photo);
    inner.append(frame);
  }

  element.append(inner);
  return element;
}

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
      boundary === "top" ? "Loading previous rows" : "Loading next rows";
  } else if (state === "no-more") {
    nextText = boundary === "top" ? "At first row" : "At last row";
  } else if (state === "error") {
    nextText = "Could not load rows";
  }

  if (text.textContent !== nextText) {
    text.textContent = nextText;
  }
}

function boundarySlotFor(boundary: Boundary): DynamicVirtualizerBoundarySlot {
  return {
    key: `${boundary}:slot`,
    height: BOUNDARY_SLOT_HEIGHT,
    build: () => buildBoundarySlot(boundary),
  };
}

function refreshBoundarySlot(boundary: Boundary): void {
  const element = virtualizer.getBoundaryElement(boundary);
  if (element) updateBoundarySlotElement(element, boundary);
}

function refreshBoundarySlots(): void {
  refreshBoundarySlot("top");
  refreshBoundarySlot("bottom");
}

function syncBoundarySlots(): void {
  virtualizer.syncLayout({
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
    loadText = `${loadedEndRow - loadedStartRow} retained rows`;
  }

  if (loadText !== renderedLoadText) {
    renderedLoadText = setTextIfChanged(loadLabel, loadText);
  }
}

function updateInfo(state: DynamicVirtualizerState = virtualizer.state): void {
  const firstRow = loadedStartRow + state.range.start + 1;
  const lastRow = loadedStartRow + state.range.end;
  const rangeText = `${firstRow}-${lastRow} / ${layout.rows.length} rows`;
  if (rangeText !== renderedRangeText) {
    renderedRangeText = setTextIfChanged(rangeLabel, rangeText);
  }

  const mountedText = `${state.mountedCount} mounted`;
  if (mountedText !== renderedMountedText) {
    renderedMountedText = setTextIfChanged(mountedLabel, mountedText);
  }

  const layoutText = `${Math.round(layout.targetHeight)}px row target`;
  if (layoutText !== renderedLayoutText) {
    renderedLayoutText = setTextIfChanged(layoutLabel, layoutText);
  }

  syncLoadLabel();
}

function initializeLoadedWindow(): void {
  const rowCount = layout.rows.length;
  const retained = Math.min(INITIAL_ROWS, rowCount);
  loadedStartRow = 0;
  loadedEndRow = Math.min(rowCount, loadedStartRow + retained);
  boundaryStates.top = idleStateForBoundary("top");
  boundaryStates.bottom = idleStateForBoundary("bottom");
}

function idleStateForBoundary(boundary: Boundary): BoundaryResolvedState {
  if (boundary === "top") return loadedStartRow <= 0 ? "no-more" : "idle";
  return loadedEndRow >= layout.rows.length ? "no-more" : "idle";
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
  if (loadedStartRow <= 0) {
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

    const addedBefore = Math.min(LOAD_ROWS, loadedStartRow);
    const nextStart = loadedStartRow - addedBefore;
    let nextEnd = loadedEndRow;
    const overflow = nextEnd - nextStart - RETAIN_ROWS;
    if (overflow > 0) nextEnd -= overflow;

    return {
      boundary: "top",
      state: nextStart <= 0 ? "no-more" : "idle",
      addedBefore,
      apply: () => {
        loadedStartRow = nextStart;
        loadedEndRow = nextEnd;
        return true;
      },
    };
  });
}

function prepareBottomApply(
  signal: AbortSignal,
): Promise<PendingBoundaryApply> {
  if (loadedEndRow >= layout.rows.length) {
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

    const appended = Math.min(LOAD_ROWS, layout.rows.length - loadedEndRow);
    let nextStart = loadedStartRow;
    const nextEnd = loadedEndRow + appended;
    const overflow = nextEnd - nextStart - RETAIN_ROWS;
    if (overflow > 0) nextStart += overflow;

    return {
      boundary: "bottom",
      state: nextEnd >= layout.rows.length ? "no-more" : "idle",
      removedBefore: nextStart - loadedStartRow,
      apply: () => {
        loadedStartRow = nextStart;
        loadedEndRow = nextEnd;
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

  virtualizer.syncLayout({
    addedBefore: pending.addedBefore,
    removedBefore: pending.removedBefore,
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    apply: pending.apply,
    after: () => {
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

function syncControlButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-row-height]",
  )) {
    button.classList.toggle(
      "active",
      Number(button.dataset.rowHeight) === selectedRowHeight,
    );
  }
}

function firstVisiblePhotoId(): number {
  const rowIndex = clamp(
    loadedStartRow + virtualizer.state.range.start,
    0,
    Math.max(0, layout.rows.length - 1),
  );
  return layout.rows[rowIndex]?.photos[0]?.id ?? 1;
}

function rowIndexForPhotoId(photoId: number): number {
  return clamp(
    layout.photoRowIndexes[photoId - 1] ?? 0,
    0,
    Math.max(0, layout.rows.length - 1),
  );
}

function rebuildLayoutAroundCurrentPhoto(): void {
  const anchorPhotoId = firstVisiblePhotoId();
  const previousLocalStart = virtualizer.state.range.start;
  layout = computeGalleryLayout();

  const retained = Math.min(RETAIN_ROWS, layout.rows.length);
  const anchorRow = rowIndexForPhotoId(anchorPhotoId);
  const anchorOffset = Math.min(previousLocalStart, Math.floor(retained / 2));
  loadedStartRow = clamp(
    anchorRow - anchorOffset,
    0,
    Math.max(0, layout.rows.length - retained),
  );
  loadedEndRow = Math.min(layout.rows.length, loadedStartRow + retained);
  resetBoundaryLoading();

  virtualizer.syncLayout({
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    after: () => {
      virtualizer.invalidateMeasurements();
      virtualizer.refreshMounted();
      refreshBoundarySlots();
      updateInfo();
    },
  });
}

function bindControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-row-height]",
  )) {
    button.addEventListener("click", () => {
      const rowHeight = Number(button.dataset.rowHeight);
      if (!Number.isFinite(rowHeight) || rowHeight === selectedRowHeight)
        return;
      selectedRowHeight = rowHeight;
      syncControlButtons();
      rebuildLayoutAroundCurrentPhoto();
    });
  }

  topBtn.addEventListener("click", () => {
    void virtualizer.scrollToTop({ behavior: "smooth" });
  });
  bottomBtn.addEventListener("click", () => {
    void virtualizer.scrollToBottom({ behavior: "smooth" });
  });
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
}

function handleViewportResize(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measuredViewportWidth = viewport.clientWidth;
  rebuildLayoutAroundCurrentPhoto();
}

initializeLoadedWindow();
bindControls();
bindThemeButtons(refreshTheme);
syncControlButtons();
refreshTheme();

virtualizer = createDynamicVirtualizer({
  viewport,
  canvasClassName: "gallery-canvas",
  getCount: currentCount,
  getItemHeight: itemHeight,
  buildItem,
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
