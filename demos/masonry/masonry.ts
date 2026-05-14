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
const PHOTO_GAP = 4;
const MAX_IMAGE_SOURCE_WIDTH = 420;
const INITIAL_GROUPS = 240;
const RETAIN_GROUPS = 360;
const LOAD_GROUPS = 90;
const LOAD_DELAY_MS = 600;
const BOUNDARY_SLOT_HEIGHT = 52;
const MAX_CANVAS_WIDTH = 1180;
const HORIZONTAL_PADDING = 32;
const OVERSCAN_PX = 680;

const ASPECT_RATIOS = [0.66, 0.75, 0.9, 1, 1.18, 1.35, 1.52] as const;

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

interface MasonryPlaceholder {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MasonryGroup {
  top: number;
  height: number;
  photos: readonly PlacedPhoto[];
}

interface MasonryLayout {
  width: number;
  columns: number;
  gap: number;
  cardWidth: number;
  groups: readonly MasonryGroup[];
}

interface LoadedBoundaryGeometry {
  visualEnd: number;
  topPlaceholders: readonly MasonryPlaceholder[];
  bottomPlaceholders: readonly MasonryPlaceholder[];
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
let loadedStartGroup = 0;
let loadedEndGroup = 0;
let loadedBoundaryGeometry: LoadedBoundaryGeometry = {
  visualEnd: 0,
  topPlaceholders: [],
  bottomPlaceholders: [],
};
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
  const photosByTop = new Map<number, PlacedPhoto[]>();

  for (const photo of photos) {
    const column = shortestColumnIndex(columnHeights);
    const top = columnHeights[column] ?? 0;
    const height = Math.max(88, Math.round(cardWidth * photo.aspectRatio));
    const left = column * (cardWidth + gap);
    const placed: PlacedPhoto = {
      ...photo,
      column,
      left,
      top,
      width: cardWidth,
      height,
    };

    const topGroup = placed.top;
    const topPhotos = photosByTop.get(topGroup);
    if (topPhotos) {
      topPhotos.push(placed);
    } else {
      photosByTop.set(topGroup, [placed]);
    }

    columnHeights[column] = top + height + gap;
  }

  const totalHeight = Math.max(1, Math.max(...columnHeights) - gap);
  const groupTops = Array.from(photosByTop.keys()).sort((a, b) => a - b);
  const groups: MasonryGroup[] = [];

  for (let index = 0; index < groupTops.length; index++) {
    const top = groupTops[index] ?? 0;
    const nextTop = groupTops[index + 1] ?? totalHeight;
    groups.push({
      top,
      height: Math.max(1, nextTop - top),
      photos: photosByTop.get(top) ?? [],
    });
  }

  return {
    width,
    columns,
    gap,
    cardWidth,
    groups,
  };
}

function currentCount(): number {
  return Math.max(0, loadedEndGroup - loadedStartGroup);
}

function groupEnd(group: MasonryGroup | undefined): number {
  return group ? group.top + group.height : 0;
}

function placeholderForColumn(
  column: number,
  top: number,
  height: number,
): MasonryPlaceholder | null {
  if (height <= 1) return null;
  return {
    left: column * (layout.cardWidth + layout.gap),
    top,
    width: layout.cardWidth,
    height,
  };
}

function recomputeLoadedBoundaryGeometry(): void {
  const sliceStart = layout.groups[loadedStartGroup]?.top ?? 0;
  const firstTopByColumn = Array.from(
    { length: layout.columns },
    () => Number.POSITIVE_INFINITY,
  );
  const lastBottomByColumn = Array.from(
    { length: layout.columns },
    () => Number.NEGATIVE_INFINITY,
  );
  let nextVisualEnd = groupEnd(layout.groups[loadedEndGroup - 1]);

  for (let index = loadedStartGroup; index < loadedEndGroup; index++) {
    const group = layout.groups[index];
    if (!group) continue;
    for (const photo of group.photos) {
      const bottom = photo.top + photo.height;
      const firstTop =
        firstTopByColumn[photo.column] ?? Number.POSITIVE_INFINITY;
      const lastBottom =
        lastBottomByColumn[photo.column] ?? Number.NEGATIVE_INFINITY;
      firstTopByColumn[photo.column] = Math.min(firstTop, photo.top);
      lastBottomByColumn[photo.column] = Math.max(lastBottom, bottom);
      nextVisualEnd = Math.max(nextVisualEnd, bottom);
    }
  }

  const topPlaceholders: MasonryPlaceholder[] = [];
  if (loadedStartGroup > 0) {
    for (let column = 0; column < layout.columns; column++) {
      const firstTop = firstTopByColumn[column] ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(firstTop)) continue;
      const placeholder = placeholderForColumn(
        column,
        sliceStart,
        firstTop - sliceStart - layout.gap,
      );
      if (placeholder) topPlaceholders.push(placeholder);
    }
  }

  const bottomPlaceholders: MasonryPlaceholder[] = [];
  if (loadedEndGroup < layout.groups.length) {
    for (let column = 0; column < layout.columns; column++) {
      const lastBottom = lastBottomByColumn[column] ?? Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(lastBottom)) continue;
      const top = lastBottom + layout.gap;
      const placeholder = placeholderForColumn(
        column,
        top,
        nextVisualEnd - top,
      );
      if (placeholder) bottomPlaceholders.push(placeholder);
    }
  }

  loadedBoundaryGeometry = {
    visualEnd: nextVisualEnd,
    topPlaceholders,
    bottomPlaceholders,
  };
}

function loadedBottomTailHeight(): number {
  if (currentCount() === 0) return 0;
  const modeledEnd = groupEnd(layout.groups[loadedEndGroup - 1]);
  return Math.max(0, loadedBoundaryGeometry.visualEnd - modeledEnd);
}

function groupForLocalIndex(index: number): MasonryGroup {
  const group = layout.groups[loadedStartGroup + index];
  if (!group) {
    throw new Error(`missing masonry group ${loadedStartGroup + index}`);
  }
  return group;
}

function itemHeight(index: number): number {
  const group = groupForLocalIndex(index);
  const tailHeight =
    index === currentCount() - 1 ? loadedBottomTailHeight() : 0;
  return group.height + tailHeight;
}

function imageSourceWidth(photo: PlacedPhoto): number {
  return Math.min(
    MAX_IMAGE_SOURCE_WIDTH,
    Math.max(120, Math.ceil(photo.width)),
  );
}

function imageUrl(photo: PlacedPhoto): string {
  const width = imageSourceWidth(photo);
  const height = Math.max(120, Math.round(width * photo.aspectRatio));
  return `https://picsum.photos/seed/virtual-list4-${photo.id}/${width}/${height}`;
}

function buildPhotoCard(photo: PlacedPhoto, groupTop: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "masonry-photo";
  card.style.left = px(photo.left);
  card.style.top = px(photo.top - groupTop);
  card.style.width = px(photo.width);
  card.style.height = px(photo.height);

  const image = document.createElement("img");
  image.className = "masonry-photo-img";
  image.alt = "";
  image.decoding = "async";
  image.loading = "lazy";
  const sourceWidth = imageSourceWidth(photo);
  image.width = sourceWidth;
  image.height = Math.max(120, Math.round(sourceWidth * photo.aspectRatio));
  image.src = imageUrl(photo);

  card.append(image);
  return card;
}

function buildPlaceholderCard(
  placeholder: MasonryPlaceholder,
  groupTop: number,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "masonry-placeholder";
  card.setAttribute("aria-hidden", "true");
  card.style.left = px(placeholder.left);
  card.style.top = px(placeholder.top - groupTop);
  card.style.width = px(placeholder.width);
  card.style.height = px(placeholder.height);
  return card;
}

function buildGroup(localIndex: number): HTMLElement {
  const group = groupForLocalIndex(localIndex);
  const height = itemHeight(localIndex);
  const item = document.createElement("section");
  item.className = "masonry-group";
  item.style.height = px(height);
  item.style.contain = "layout style";
  item.style.overflow = "visible";

  const inner = document.createElement("div");
  inner.className = "masonry-group-inner";
  inner.style.width = px(layout.width);
  inner.style.height = px(height);

  if (localIndex === 0) {
    for (const placeholder of loadedBoundaryGeometry.topPlaceholders) {
      inner.appendChild(buildPlaceholderCard(placeholder, group.top));
    }
  }

  for (const photo of group.photos) {
    inner.appendChild(buildPhotoCard(photo, group.top));
  }

  if (localIndex === currentCount() - 1) {
    for (const placeholder of loadedBoundaryGeometry.bottomPlaceholders) {
      inner.appendChild(buildPlaceholderCard(placeholder, group.top));
    }
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
    loadText = `${loadedEndGroup - loadedStartGroup} retained groups`;
  }

  if (loadText !== renderedLoadText) {
    renderedLoadText = setTextIfChanged(loadLabel, loadText);
  }
}

function updateInfo(state: DynamicVirtualizerState = virtualizer.state): void {
  const firstGroup = loadedStartGroup + state.range.start + 1;
  const lastGroup = loadedStartGroup + state.range.end;
  const rangeText = `${firstGroup}-${lastGroup} / ${layout.groups.length} groups`;
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
  const groupCount = layout.groups.length;
  const retained = Math.min(INITIAL_GROUPS, groupCount);
  const middleStart = Math.floor((groupCount - retained) / 2);
  loadedStartGroup = clamp(middleStart, 0, Math.max(0, groupCount - retained));
  loadedEndGroup = Math.min(groupCount, loadedStartGroup + retained);
  recomputeLoadedBoundaryGeometry();
}

function idleStateForBoundary(boundary: Boundary): BoundaryResolvedState {
  if (boundary === "top") return loadedStartGroup <= 0 ? "no-more" : "idle";
  return loadedEndGroup >= layout.groups.length ? "no-more" : "idle";
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
  if (loadedStartGroup <= 0) {
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

    const addedBefore = Math.min(LOAD_GROUPS, loadedStartGroup);
    const nextStart = loadedStartGroup - addedBefore;
    let nextEnd = loadedEndGroup;
    const overflow = nextEnd - nextStart - RETAIN_GROUPS;
    if (overflow > 0) nextEnd -= overflow;

    return {
      boundary: "top",
      state: nextStart <= 0 ? "no-more" : "idle",
      addedBefore,
      apply: () => {
        loadedStartGroup = nextStart;
        loadedEndGroup = nextEnd;
        recomputeLoadedBoundaryGeometry();
        return true;
      },
    };
  });
}

function prepareBottomApply(
  signal: AbortSignal,
): Promise<PendingBoundaryApply> {
  if (loadedEndGroup >= layout.groups.length) {
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

    const appended = Math.min(
      LOAD_GROUPS,
      layout.groups.length - loadedEndGroup,
    );
    let nextStart = loadedStartGroup;
    const nextEnd = loadedEndGroup + appended;
    const overflow = nextEnd - nextStart - RETAIN_GROUPS;
    if (overflow > 0) nextStart += overflow;

    return {
      boundary: "bottom",
      state: nextEnd >= layout.groups.length ? "no-more" : "idle",
      removedBefore: nextStart - loadedStartGroup,
      apply: () => {
        loadedStartGroup = nextStart;
        loadedEndGroup = nextEnd;
        recomputeLoadedBoundaryGeometry();
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
      virtualizer.invalidateMeasurements();
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

function rebuildLayoutAroundCurrentGroup(): void {
  const current = virtualizer.state;
  const anchorGroup = clamp(
    loadedStartGroup + current.range.start,
    0,
    Math.max(0, layout.groups.length - 1),
  );
  layout = computeMasonryLayout();
  const retained = Math.min(RETAIN_GROUPS, layout.groups.length);
  loadedStartGroup = clamp(
    anchorGroup - Math.floor(retained / 2),
    0,
    Math.max(0, layout.groups.length - retained),
  );
  loadedEndGroup = Math.min(layout.groups.length, loadedStartGroup + retained);
  recomputeLoadedBoundaryGeometry();
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
      rebuildLayoutAroundCurrentGroup();
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
  rebuildLayoutAroundCurrentGroup();
}

async function alignInitialViewport(): Promise<void> {
  if (loadedStartGroup <= 0 || currentCount() === 0) return;
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
  buildItem: buildGroup,
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
