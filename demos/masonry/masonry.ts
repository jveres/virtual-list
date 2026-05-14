import {
  createDynamicVirtualizer,
  type DynamicVirtualizer,
  type DynamicVirtualizerBoundary,
  type DynamicVirtualizerBoundarySlot,
  type DynamicVirtualizerState,
} from "../../src/dynamic-virtualizer.js";
import { applyDocumentTheme, watchSystemTheme } from "../../src/markdown.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";
import "../demo-styles.css";
import "./masonry.css";

const TOTAL_PHOTOS = 2_400;
const BAND_HEIGHT = 720;
const PHOTO_GAP = 4;
const IMAGE_SOURCE_WIDTH = 420;
const INITIAL_BANDS = 44;
const RETAIN_BANDS = 74;
const LOAD_BANDS = 10;
const LOAD_DELAY_MS = 600;
const BOUNDARY_SLOT_HEIGHT = 52;
const MAX_CANVAS_WIDTH = 1180;
const HORIZONTAL_PADDING = 32;
const OVERSCAN_PX = 900;

const ASPECT_RATIOS = [0.66, 0.75, 0.9, 1, 1.18, 1.35, 1.52] as const;

interface Photo {
  id: number;
  aspectRatio: number;
}

interface PlacedPhoto extends Photo {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MasonryBand {
  top: number;
  height: number;
  photos: readonly PlacedPhoto[];
}

interface MasonryLayout {
  width: number;
  columns: number;
  gap: number;
  totalHeight: number;
  bands: readonly MasonryBand[];
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

let selectedColumns = 4;
let layout = computeMasonryLayout();
let loadedStartBand = 0;
let loadedEndBand = 0;
const boundaryStates: Record<Boundary, BoundarySlotState> = {
  top: "idle",
  bottom: "idle",
};
let loadSequence = 0;
let activeBoundaryLoad: ActiveBoundaryLoad | null = null;
let pendingBoundaryApply: PendingBoundaryApply | null = null;
let scrollSettled = true;
let measuredViewportWidth = viewport.clientWidth;
let virtualizer: DynamicVirtualizer;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";
let renderedLoadText = "";

function createPhoto(index: number): Photo {
  const aspectRatio = ASPECT_RATIOS[index % ASPECT_RATIOS.length] ?? 1;
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

function effectiveColumns(width: number): number {
  if (width < 520) return Math.min(2, selectedColumns);
  if (width < 760) return Math.min(3, selectedColumns);
  return selectedColumns;
}

function canvasWidthForViewport(): number {
  return Math.max(
    240,
    Math.min(MAX_CANVAS_WIDTH, viewport.clientWidth - HORIZONTAL_PADDING),
  );
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

function computeMasonryLayout(): MasonryLayout {
  const width = canvasWidthForViewport();
  const columns = effectiveColumns(width);
  const gap = PHOTO_GAP;
  const cardWidth = Math.max(80, (width - (columns - 1) * gap) / columns);
  const columnHeights = Array.from({ length: columns }, () => 0);
  const photosByBand = new Map<number, PlacedPhoto[]>();
  const bands: MasonryBand[] = [];

  for (const photo of photos) {
    const column = shortestColumnIndex(columnHeights);
    const top = columnHeights[column] ?? 0;
    const height = Math.max(88, Math.round(cardWidth * photo.aspectRatio));
    const left = column * (cardWidth + gap);
    const placed: PlacedPhoto = {
      ...photo,
      left,
      top,
      width: cardWidth,
      height,
    };

    const firstBand = Math.floor(top / BAND_HEIGHT);
    const lastBand = Math.floor((top + height - 0.01) / BAND_HEIGHT);
    for (let bandIndex = firstBand; bandIndex <= lastBand; bandIndex++) {
      const bandPhotos = photosByBand.get(bandIndex);
      if (bandPhotos) {
        bandPhotos.push(placed);
      } else {
        photosByBand.set(bandIndex, [placed]);
      }
    }

    columnHeights[column] = top + height + gap;
  }

  const totalHeight = Math.max(BAND_HEIGHT, Math.max(...columnHeights) - gap);
  const bandCount = Math.max(1, Math.ceil(totalHeight / BAND_HEIGHT));

  for (let index = 0; index < bandCount; index++) {
    const top = index * BAND_HEIGHT;
    const height = Math.max(1, Math.min(BAND_HEIGHT, totalHeight - top));
    bands.push({
      top,
      height,
      photos: photosByBand.get(index) ?? [],
    });
  }

  return {
    width,
    columns,
    gap,
    totalHeight,
    bands,
  };
}

function currentCount(): number {
  return Math.max(0, loadedEndBand - loadedStartBand);
}

function bandForLocalIndex(index: number): MasonryBand {
  const band = layout.bands[loadedStartBand + index];
  if (!band) throw new Error(`missing masonry band ${loadedStartBand + index}`);
  return band;
}

function itemHeight(index: number): number {
  return bandForLocalIndex(index).height;
}

function imageUrl(photo: Photo): string {
  const height = Math.max(
    120,
    Math.round(IMAGE_SOURCE_WIDTH * photo.aspectRatio),
  );
  return `https://picsum.photos/seed/virtual-list4-${photo.id}/${IMAGE_SOURCE_WIDTH}/${height}`;
}

function buildPhotoCard(photo: PlacedPhoto, bandTop: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "masonry-photo";
  card.style.left = px(photo.left);
  card.style.top = px(photo.top - bandTop);
  card.style.width = px(photo.width);
  card.style.height = px(photo.height);

  const image = document.createElement("img");
  image.className = "masonry-photo-img";
  image.alt = "";
  image.loading = "lazy";
  image.width = IMAGE_SOURCE_WIDTH;
  image.height = Math.max(
    120,
    Math.round(IMAGE_SOURCE_WIDTH * photo.aspectRatio),
  );
  image.src = imageUrl(photo);

  card.append(image);
  return card;
}

function buildBand(localIndex: number): HTMLElement {
  const band = bandForLocalIndex(localIndex);
  const item = document.createElement("section");
  item.className = "masonry-band";
  item.style.height = px(band.height);
  item.style.contain = "layout paint style";
  item.style.overflow = "hidden";

  const inner = document.createElement("div");
  inner.className = "masonry-band-inner";
  inner.style.width = px(layout.width);
  inner.style.height = px(band.height);

  for (const photo of band.photos) {
    inner.appendChild(buildPhotoCard(photo, band.top));
  }

  item.appendChild(inner);
  return item;
}

function buildBoundarySlot(boundary: Boundary): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "boundary-slot";
  slot.dataset.boundaryContent = boundary;

  const spinner = document.createElement("span");
  spinner.className = "boundary-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");

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
  const text = slot.querySelector("span:last-child");
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
  syncLoadLabel();
}

function boundarySlotFor(boundary: Boundary): DynamicVirtualizerBoundarySlot {
  return {
    key: boundary,
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
    loadText = `${loadedEndBand - loadedStartBand} retained bands`;
  }

  if (loadText !== renderedLoadText) {
    renderedLoadText = setTextIfChanged(loadLabel, loadText);
  }
}

function updateInfo(state: DynamicVirtualizerState = virtualizer.state): void {
  const firstBand = loadedStartBand + state.range.start + 1;
  const lastBand = loadedStartBand + state.range.end;
  const rangeText = `${firstBand}-${lastBand} / ${layout.bands.length} bands`;
  if (rangeText !== renderedRangeText) {
    renderedRangeText = setTextIfChanged(rangeLabel, rangeText);
  }

  const mountedText = `${state.mountedCount} mounted`;
  if (mountedText !== renderedMountedText) {
    renderedMountedText = setTextIfChanged(mountedLabel, mountedText);
  }

  const layoutText = `${layout.columns} columns · ${layout.gap}px gap`;
  if (layoutText !== renderedLayoutText) {
    renderedLayoutText = setTextIfChanged(layoutLabel, layoutText);
  }

  syncLoadLabel();
}

function initializeLoadedWindow(): void {
  const bandCount = layout.bands.length;
  const retained = Math.min(INITIAL_BANDS, bandCount);
  const middleStart = Math.floor((bandCount - retained) / 2);
  loadedStartBand = clamp(middleStart, 0, Math.max(0, bandCount - retained));
  loadedEndBand = Math.min(bandCount, loadedStartBand + retained);
}

function idleStateForBoundary(boundary: Boundary): BoundaryResolvedState {
  if (boundary === "top") return loadedStartBand <= 0 ? "no-more" : "idle";
  return loadedEndBand >= layout.bands.length ? "no-more" : "idle";
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
  if (loadedStartBand <= 0) {
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

    const addedBefore = Math.min(LOAD_BANDS, loadedStartBand);
    const nextStart = loadedStartBand - addedBefore;
    let nextEnd = loadedEndBand;
    const overflow = nextEnd - nextStart - RETAIN_BANDS;
    if (overflow > 0) nextEnd -= overflow;

    return {
      boundary: "top",
      state: nextStart <= 0 ? "no-more" : "idle",
      addedBefore,
      apply: () => {
        loadedStartBand = nextStart;
        loadedEndBand = nextEnd;
        return true;
      },
    };
  });
}

function prepareBottomApply(
  signal: AbortSignal,
): Promise<PendingBoundaryApply> {
  if (loadedEndBand >= layout.bands.length) {
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

    const appended = Math.min(LOAD_BANDS, layout.bands.length - loadedEndBand);
    let nextStart = loadedStartBand;
    const nextEnd = loadedEndBand + appended;
    const overflow = nextEnd - nextStart - RETAIN_BANDS;
    if (overflow > 0) nextStart += overflow;

    return {
      boundary: "bottom",
      state: nextEnd >= layout.bands.length ? "no-more" : "idle",
      removedBefore: nextStart - loadedStartBand,
      apply: () => {
        loadedStartBand = nextStart;
        loadedEndBand = nextEnd;
        return true;
      },
    };
  });
}

function applyPendingBoundaryLoad(): void {
  if (!scrollSettled || !pendingBoundaryApply) return;

  const pending = pendingBoundaryApply;
  pendingBoundaryApply = null;
  boundaryStates[pending.boundary] = pending.state;
  const slot =
    pending.boundary === "top"
      ? { topSlot: boundarySlotFor("top") }
      : { bottomSlot: boundarySlotFor("bottom") };

  virtualizer.syncLayout({
    ...slot,
    addedBefore: pending.addedBefore,
    removedBefore: pending.removedBefore,
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
  scrollSettled = false;
}

function handleScrollSettled(): void {
  scrollSettled = true;
  applyPendingBoundaryLoad();
}

function syncControlButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-columns]",
  )) {
    button.classList.toggle(
      "active",
      Number(button.dataset.columns) === selectedColumns,
    );
  }
}

function rebuildLayoutAroundCurrentBand(): void {
  const current = virtualizer.state;
  const anchorBand = clamp(
    loadedStartBand + current.range.start,
    0,
    Math.max(0, layout.bands.length - 1),
  );
  layout = computeMasonryLayout();
  const retained = Math.min(RETAIN_BANDS, layout.bands.length);
  loadedStartBand = clamp(
    anchorBand - Math.floor(retained / 2),
    0,
    Math.max(0, layout.bands.length - retained),
  );
  loadedEndBand = Math.min(layout.bands.length, loadedStartBand + retained);
  resetBoundaryLoading();
  virtualizer.syncLayout({
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    after: () => {
      refreshBoundarySlots();
      updateInfo();
    },
  });
  virtualizer.refreshMounted();
  virtualizer.invalidateMeasurements();
  updateInfo();
}

function bindControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-columns]",
  )) {
    button.addEventListener("click", () => {
      const columns = Number(button.dataset.columns);
      if (!Number.isFinite(columns) || columns === selectedColumns) return;
      selectedColumns = columns;
      syncControlButtons();
      rebuildLayoutAroundCurrentBand();
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
  rebuildLayoutAroundCurrentBand();
}

async function alignInitialViewport(): Promise<void> {
  if (loadedStartBand <= 0 || currentCount() === 0) return;
  await virtualizer.scrollToIndex(0, "top");
}

initializeLoadedWindow();
bindControls();
bindThemeButtons(refreshTheme);
syncControlButtons();
refreshTheme();

virtualizer = createDynamicVirtualizer({
  viewport,
  canvasClassName: "masonry-canvas",
  getCount: currentCount,
  getItemHeight: itemHeight,
  buildItem: buildBand,
  overscanPx: OVERSCAN_PX,
  onReachTop: () => {
    startBoundaryLoad("top");
  },
  onReachBottom: () => {
    startBoundaryLoad("bottom");
  },
  onScrollStart: handleScrollStart,
  onScrollSettled: handleScrollSettled,
  onRangeChange: updateInfo,
});
syncBoundarySlots();
await alignInitialViewport();

const viewportResizeObserver = new ResizeObserver(handleViewportResize);
viewportResizeObserver.observe(viewport);

await document.fonts.ready;
updateInfo();
document.documentElement.classList.remove("booting");
watchSystemTheme(refreshTheme);
