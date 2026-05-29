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
import "./masonry.css";

const FALLBACK_PHOTO_COUNT = 600;
const PICSUM_LIST_PAGE_COUNT = 8;
const PICSUM_LIST_PAGE_SIZE = 100;
const PICSUM_LIST_URL = "https://picsum.photos/v2/list";
const PHOTO_GAP = 4;
const BAND_TARGET_HEIGHT = 520;
const MAX_IMAGE_SOURCE_WIDTH = 420;
const INITIAL_GROUPS = 24;
const RETAIN_GROUPS = 72;
const LOAD_GROUPS = 18;
const LOAD_DELAY_MS = 600;
const BOUNDARY_SLOT_HEIGHT = 52;
const MAX_CANVAS_WIDTH = 1180;
const HORIZONTAL_PADDING = 32;
const OVERSCAN_PX = 680;
const PLACEHOLDER_VELOCITY_THRESHOLD = 10;

const ASPECT_RATIOS = [0.66, 0.75, 0.9, 1, 1.18, 1.35, 1.52] as const;

interface Photo {
  id: number;
  picsumId: string | null;
  aspectRatio: number;
  sourceHeight: number;
  sourceWidth: number;
  author: string | null;
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

interface PicsumPhotoMetadata {
  id: string;
  author?: string;
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

let selectedColumns = 4;
let photos: readonly Photo[] = [];
let layout: MasonryLayout = {
  width: 0,
  columns: 0,
  gap: PHOTO_GAP,
  cardWidth: 0,
  groups: [],
};
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
let scrollEnded = true;
let measuredViewportWidth = viewport.clientWidth;
let virtualList: VirtualList;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";
let renderedLoadText = "";

function createFallbackPhoto(index: number): Photo {
  const aspectRatio = ASPECT_RATIOS[index % ASPECT_RATIOS.length] ?? 1;
  const sourceWidth = 1200;
  return {
    id: index + 1,
    picsumId: null,
    aspectRatio,
    sourceHeight: Math.round(sourceWidth * aspectRatio),
    sourceWidth,
    author: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readPicsumPhotoMetadata(value: unknown): PicsumPhotoMetadata | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const width = readPositiveNumber(value.width);
  const height = readPositiveNumber(value.height);
  if (!id || width === null || height === null) return null;
  return {
    id,
    author: readString(value.author) ?? undefined,
    width,
    height,
  };
}

function photoFromPicsumMetadata(
  metadata: PicsumPhotoMetadata,
  index: number,
): Photo {
  return {
    id: index + 1,
    picsumId: metadata.id,
    aspectRatio: metadata.height / metadata.width,
    sourceHeight: metadata.height,
    sourceWidth: metadata.width,
    author: metadata.author ?? null,
  };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function compareByStableHash(left: string, right: string): number {
  return stableHash(left) - stableHash(right);
}

function photoStableKey(photo: Photo): string {
  return `${photo.author ?? ""}:${photo.picsumId ?? photo.id}:${photo.sourceWidth}:${photo.sourceHeight}`;
}

function spreadPhotosByAuthor(nextPhotos: readonly Photo[]): Photo[] {
  const groups = new Map<string, Photo[]>();
  for (const photo of nextPhotos) {
    const author = photo.author ?? "";
    const group = groups.get(author);
    if (group) {
      group.push(photo);
    } else {
      groups.set(author, [photo]);
    }
  }

  const orderedGroups = Array.from(groups.entries())
    .sort(([left], [right]) => compareByStableHash(left, right))
    .map(([, group]) =>
      group.sort((left, right) =>
        compareByStableHash(photoStableKey(left), photoStableKey(right)),
      ),
    );

  const spread: Photo[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (const group of orderedGroups) {
      const photo = group[offset];
      if (!photo) continue;
      hasMore = true;
      spread.push({
        ...photo,
        id: spread.length + 1,
      });
    }
    offset++;
  }
  return spread;
}

async function fetchPicsumPhotoPage(page: number): Promise<Photo[]> {
  const url = `${PICSUM_LIST_URL}?page=${page}&limit=${PICSUM_LIST_PAGE_SIZE}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Picsum metadata request failed: ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Picsum metadata response was not a list");
  }

  return body
    .map(readPicsumPhotoMetadata)
    .filter((metadata): metadata is PicsumPhotoMetadata => metadata !== null)
    .map((metadata, index) =>
      photoFromPicsumMetadata(
        metadata,
        (page - 1) * PICSUM_LIST_PAGE_SIZE + index,
      ),
    );
}

async function loadPicsumPhotos(): Promise<Photo[]> {
  const pages = Array.from(
    { length: PICSUM_LIST_PAGE_COUNT },
    (_, index) => index + 1,
  );
  const results = await Promise.allSettled(
    pages.map((page) => fetchPicsumPhotoPage(page)),
  );
  const nextPhotos = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (nextPhotos.length === 0) {
    const reason = results.find(
      (result) => result.status === "rejected",
    )?.reason;
    throw reason instanceof Error ? reason : new Error("No Picsum photos");
  }
  return spreadPhotosByAuthor(nextPhotos);
}

async function loadPhotos(): Promise<readonly Photo[]> {
  try {
    return await loadPicsumPhotos();
  } catch (error) {
    console.warn("Falling back to generated masonry photo metadata", error);
    return Array.from({ length: FALLBACK_PHOTO_COUNT }, (_, index) =>
      createFallbackPhoto(index),
    );
  }
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

function computeFineGroups(
  placedPhotos: readonly PlacedPhoto[],
  totalHeight: number,
): MasonryGroup[] {
  const photosByTop = new Map<number, PlacedPhoto[]>();
  for (const photo of placedPhotos) {
    const topPhotos = photosByTop.get(photo.top);
    if (topPhotos) {
      topPhotos.push(photo);
    } else {
      photosByTop.set(photo.top, [photo]);
    }
  }

  const groupTops = Array.from(photosByTop.keys()).sort(
    (left, right) => left - right,
  );
  return groupTops.map((top, index) => ({
    top,
    height: Math.max(1, (groupTops[index + 1] ?? totalHeight) - top),
    photos: photosByTop.get(top) ?? [],
  }));
}

function combineMasonryGroups(groups: readonly MasonryGroup[]): MasonryGroup {
  const first = at(groups, 0);
  const last = at(groups, groups.length - 1);
  const bandPhotos: PlacedPhoto[] = [];
  for (const group of groups) {
    bandPhotos.push(...group.photos);
  }
  return {
    top: first.top,
    height: last.top + last.height - first.top,
    photos: bandPhotos,
  };
}

function mergeFineGroups(
  fineGroups: readonly MasonryGroup[],
  targetHeight: number,
): MasonryGroup[] {
  if (fineGroups.length === 0) return [];

  const merged: MasonryGroup[] = [];
  let chunk: MasonryGroup[] = [at(fineGroups, 0)];
  let chunkHeight = fineGroups[0]?.height ?? 0;

  for (let index = 1; index < fineGroups.length; index++) {
    const group = at(fineGroups, index);
    if (chunkHeight >= targetHeight) {
      merged.push(combineMasonryGroups(chunk));
      chunk = [group];
      chunkHeight = group.height;
      continue;
    }
    chunk.push(group);
    chunkHeight += group.height;
  }

  if (chunk.length > 0) {
    merged.push(combineMasonryGroups(chunk));
  }
  return merged;
}

function computeMasonryLayout(): MasonryLayout {
  const width = canvasWidthForViewport();
  const columns = effectiveColumns(width);
  const gap = PHOTO_GAP;
  const cardWidth = Math.max(80, (width - (columns - 1) * gap) / columns);
  const columnHeights = Array.from({ length: columns }, () => 0);
  const placedPhotos: PlacedPhoto[] = [];

  for (const photo of photos) {
    const column = shortestColumnIndex(columnHeights);
    const top = columnHeights[column] ?? 0;
    const height = Math.max(88, Math.round(cardWidth * photo.aspectRatio));
    const left = column * (cardWidth + gap);
    placedPhotos.push({
      ...photo,
      column,
      left,
      top,
      width: cardWidth,
      height,
    });

    columnHeights[column] = top + height + gap;
  }

  const totalHeight = Math.max(1, Math.max(...columnHeights) - gap);
  const fineGroups = computeFineGroups(placedPhotos, totalHeight);

  return {
    width,
    columns,
    gap,
    cardWidth,
    groups: mergeFineGroups(fineGroups, BAND_TARGET_HEIGHT),
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
  return imageUrlForWidth(photo, imageSourceWidth(photo));
}

function imageHeightForWidth(photo: Photo, width: number): number {
  return Math.max(1, Math.round(width * photo.aspectRatio));
}

function imageUrlForWidth(photo: Photo, width: number): string {
  const height = imageHeightForWidth(photo, width);
  if (photo.picsumId) {
    return `https://picsum.photos/id/${encodeURIComponent(photo.picsumId)}/${width}/${height}`;
  }
  return `https://picsum.photos/seed/virtual-list-${photo.id}/${width}/${height}`;
}

function photoDetailsText(photo: PlacedPhoto): string {
  const source = photo.picsumId
    ? `Picsum ${photo.picsumId}`
    : `Photo ${photo.id}`;
  const author = photo.author ? ` · ${photo.author}` : "";
  return `${source}${author} · ${photo.sourceWidth}×${photo.sourceHeight} source · ${Math.round(photo.width)}×${Math.round(photo.height)} view`;
}

const photoPreview = createPhotoPreview<PlacedPhoto>({
  viewport,
  thumbnailUrl: imageUrl,
  previewUrl: imageUrlForWidth,
  detailsText: photoDetailsText,
});

function buildPhotoCard(photo: PlacedPhoto, groupTop: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "masonry-photo";
  card.style.left = px(photo.left);
  card.style.top = px(photo.top - groupTop);
  card.style.width = px(photo.width);
  card.style.height = px(photo.height);

  const image = document.createElement("img");
  image.className = "masonry-photo-img photo-preview-image";
  image.alt = "";
  image.decoding = "async";
  image.draggable = false;
  image.loading = "lazy";
  const sourceWidth = imageSourceWidth(photo);
  image.width = sourceWidth;
  image.height = imageHeightForWidth(photo, sourceWidth);
  image.src = imageUrl(photo);

  card.append(image);
  photoPreview.bind(card, photo);
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

function buildGroupShell(
  localIndex: number,
  className: string,
  buildContent: (inner: HTMLElement, group: MasonryGroup) => void,
): HTMLElement {
  const group = groupForLocalIndex(localIndex);
  const height = itemHeight(localIndex);
  const item = document.createElement("section");
  item.className = className;
  item.style.height = px(height);
  item.style.contain = "layout style";
  item.style.overflow = "visible";

  const inner = document.createElement("div");
  inner.className = "masonry-group-inner";
  inner.style.width = px(layout.width);
  inner.style.height = px(height);
  buildContent(inner, group);

  item.appendChild(inner);
  return item;
}

function appendRetainedEdgePlaceholders(
  inner: HTMLElement,
  localIndex: number,
  groupTop: number,
): void {
  if (localIndex === 0) {
    for (const placeholder of loadedBoundaryGeometry.topPlaceholders) {
      inner.appendChild(buildPlaceholderCard(placeholder, groupTop));
    }
  }
  if (localIndex === currentCount() - 1) {
    for (const placeholder of loadedBoundaryGeometry.bottomPlaceholders) {
      inner.appendChild(buildPlaceholderCard(placeholder, groupTop));
    }
  }
}

function placeholderForPhoto(photo: PlacedPhoto): MasonryPlaceholder {
  return {
    left: photo.left,
    top: photo.top,
    width: photo.width,
    height: photo.height,
  };
}

function buildGroup(localIndex: number): HTMLElement {
  return buildGroupShell(localIndex, "masonry-group", (inner, group) => {
    appendRetainedEdgePlaceholders(inner, localIndex, group.top);
    for (const photo of group.photos) {
      inner.appendChild(buildPhotoCard(photo, group.top));
    }
  });
}

function buildGroupPlaceholder(localIndex: number): HTMLElement {
  return buildGroupShell(localIndex, "masonry-group", (inner, group) => {
    appendRetainedEdgePlaceholders(inner, localIndex, group.top);
    for (const photo of group.photos) {
      inner.appendChild(
        buildPlaceholderCard(placeholderForPhoto(photo), group.top),
      );
    }
  });
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

function boundarySlotFor(boundary: Boundary): VirtualListBoundarySlot {
  return {
    key: boundary,
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

function updateInfo(state: VirtualListState = virtualList.state): void {
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
  loadedStartGroup = 0;
  loadedEndGroup = Math.min(groupCount, loadedStartGroup + retained);
  recomputeLoadedBoundaryGeometry();
  boundaryStates.top = idleStateForBoundary("top");
  boundaryStates.bottom = idleStateForBoundary("bottom");
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
  if (!scrollEnded || !pendingBoundaryApply) return;

  const pending = pendingBoundaryApply;
  pendingBoundaryApply = null;
  boundaryStates[pending.boundary] = pending.state;
  const slot =
    pending.boundary === "top"
      ? { topSlot: boundarySlotFor("top") }
      : { bottomSlot: boundarySlotFor("bottom") };

  virtualList.syncLayout({
    ...slot,
    addedBefore: pending.addedBefore,
    removedBefore: pending.removedBefore,
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
  const current = virtualList.state;
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
  virtualList.syncLayout({
    topSlot: boundarySlotFor("top"),
    bottomSlot: boundarySlotFor("bottom"),
    after: () => {
      refreshBoundarySlots();
      updateInfo();
    },
  });
  virtualList.refreshMounted();
  virtualList.invalidateMeasurements();
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
  rebuildLayoutAroundCurrentGroup();
}

photos = await loadPhotos();
layout = computeMasonryLayout();
initializeLoadedWindow();
bindControls();
bindThemeButtons(refreshTheme);
syncControlButtons();
refreshTheme();

virtualList = createVirtualList({
  viewport,
  canvasClassName: "masonry-canvas",
  getCount: currentCount,
  getItemHeight: itemHeight,
  buildItem: buildGroup,
  buildPlaceholder: buildGroupPlaceholder,
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
