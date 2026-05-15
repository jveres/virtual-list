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
const PHOTO_VIEW_INLINE_PADDING = 24;
const PHOTO_VIEW_BLOCK_PADDING = 0;
const PHOTO_VIEW_MAX_WIDTH = 1280;
const PHOTO_VIEW_MAX_SOURCE_WIDTH = 1800;
const PHOTO_VIEW_DURATION_MS = 340;
const PHOTO_VIEW_EASING = "cubic-bezier(0.2, 0, 0, 1)";
const PHOTO_PRESS_DOWN_MS = 150;
const PHOTO_TOUCH_PRESS_DELAY_MS = 80;
const PHOTO_TAP_MOVE_TOLERANCE_PX = 10;
const PHOTO_SWIPE_CLOSE_DISTANCE_PX = 120;
const PHOTO_SWIPE_CLOSE_VELOCITY_PX_MS = 0.55;
const PHOTO_SWIPE_SCROLL_TOP_TOLERANCE_PX = 24;
const PHOTO_SWIPE_START_PX = 14;

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

interface PhotoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PhotoViewBox {
  width: number;
  height: number;
}

interface ActivePhotoView {
  photo: PlacedPhoto;
  overlay: HTMLElement;
  backdrop: HTMLElement;
  closeButton: HTMLButtonElement;
  frame: HTMLElement;
  stage: HTMLElement;
  scroll: HTMLElement;
  image: HTMLImageElement;
  highResolutionImage: HTMLImageElement;
  details: HTMLElement;
  openingAnimations: Animation[];
  openingHero: HTMLElement | null;
  sourceElement: HTMLElement | null;
  sourceRect: PhotoRect;
  onKeyDown: (event: KeyboardEvent) => void;
  onOverlayClick: (event: MouseEvent) => void;
  onSwipePointerCancel: (event: PointerEvent) => void;
  onSwipePointerDown: (event: PointerEvent) => void;
  onSwipePointerMove: (event: PointerEvent) => void;
  onSwipePointerUp: (event: PointerEvent) => void;
  onViewportChange: () => void;
  swipeResetAnimations: Animation[];
  swipeState: PhotoSwipeState | null;
  closing: boolean;
}

interface PhotoSwipeState {
  dragY: number;
  dragging: boolean;
  lastTime: number;
  lastY: number;
  pointerId: number;
  startX: number;
  startY: number;
  velocityY: number;
}

interface PhotoPressState {
  pointerId: number;
  pressedAt: number | null;
  pressTimer: number | null;
  startX: number;
  startY: number;
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
let scrollEnded = true;
let measuredViewportWidth = viewport.clientWidth;
let virtualizer: DynamicVirtualizer;
let renderedRangeText = "";
let renderedMountedText = "";
let renderedLayoutText = "";
let renderedLoadText = "";
let activePhotoView: ActivePhotoView | null = null;
const openingPhotoCards = new WeakSet<HTMLElement>();
const photoPressStates = new WeakMap<HTMLElement, PhotoPressState>();

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
  return imageUrlForWidth(photo, imageSourceWidth(photo));
}

function imageUrlForWidth(photo: Photo, width: number): string {
  const height = Math.max(120, Math.round(width * photo.aspectRatio));
  return `https://picsum.photos/seed/virtual-list-${photo.id}/${width}/${height}`;
}

function photoViewImageWidth(): number {
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  return Math.round(
    clamp(
      photoViewViewportWidth() * pixelRatio,
      720,
      PHOTO_VIEW_MAX_SOURCE_WIDTH,
    ),
  );
}

function photoViewImageUrl(photo: Photo): string {
  return imageUrlForWidth(photo, photoViewImageWidth());
}

function photoViewViewportWidth(): number {
  return window.visualViewport?.width ?? window.innerWidth;
}

function photoViewViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

function photoViewImageBox(photo: Photo): PhotoViewBox {
  const maxWidth = Math.max(
    1,
    Math.min(
      PHOTO_VIEW_MAX_WIDTH,
      photoViewViewportWidth() - PHOTO_VIEW_INLINE_PADDING * 2,
    ),
  );
  const maxHeight = Math.max(
    180,
    photoViewViewportHeight() - PHOTO_VIEW_BLOCK_PADDING * 2,
  );
  const aspectRatio = Math.max(0.1, photo.aspectRatio);
  const heightForMaxWidth = maxWidth * aspectRatio;
  if (heightForMaxWidth <= maxHeight) {
    return {
      width: Math.round(maxWidth),
      height: Math.round(heightForMaxWidth),
    };
  }

  return {
    width: Math.round(maxHeight / aspectRatio),
    height: Math.round(maxHeight),
  };
}

function syncPhotoViewViewportVars(
  overlay: HTMLElement,
  photo: Photo,
): PhotoViewBox {
  const imageBox = photoViewImageBox(photo);
  overlay.style.setProperty(
    "--photo-viewer-width",
    `${photoViewViewportWidth()}px`,
  );
  overlay.style.setProperty(
    "--photo-viewer-height",
    `${photoViewViewportHeight()}px`,
  );
  overlay.style.setProperty(
    "--photo-viewer-image-width",
    `${imageBox.width}px`,
  );
  overlay.style.setProperty(
    "--photo-viewer-image-height",
    `${imageBox.height}px`,
  );
  return imageBox;
}

function photoViewBackdropOpacity(view: ActivePhotoView): string {
  return getComputedStyle(view.overlay)
    .getPropertyValue("--photo-viewer-backdrop-opacity")
    .trim();
}

function currentPhotoViewBackdropOpacity(view: ActivePhotoView): string {
  const opacity = Number.parseFloat(getComputedStyle(view.backdrop).opacity);
  return Number.isFinite(opacity)
    ? String(opacity)
    : photoViewBackdropOpacity(view);
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function clearPhotoPressState(card: HTMLElement): void {
  const state = photoPressStates.get(card);
  if (state?.pressTimer !== null && state?.pressTimer !== undefined) {
    window.clearTimeout(state.pressTimer);
  }
  photoPressStates.delete(card);
  card.classList.remove("is-photo-pressed");
}

function applyPhotoPress(card: HTMLElement, state: PhotoPressState): void {
  if (photoPressStates.get(card) !== state || state.pressedAt !== null) return;
  state.pressTimer = null;
  state.pressedAt = performance.now();
  card.classList.add("is-photo-pressed");
}

function startPhotoPress(card: HTMLElement, event: PointerEvent): void {
  if (reducedMotion()) return;

  const state: PhotoPressState = {
    pointerId: event.pointerId,
    pressedAt: null,
    pressTimer: null,
    startX: event.clientX,
    startY: event.clientY,
  };
  photoPressStates.set(card, state);

  if (event.pointerType === "touch") {
    state.pressTimer = window.setTimeout(() => {
      applyPhotoPress(card, state);
    }, PHOTO_TOUCH_PRESS_DELAY_MS);
    return;
  }

  applyPhotoPress(card, state);
}

function releasePhotoPress(card: HTMLElement): void {
  if (reducedMotion()) return;
  clearPhotoPressState(card);
}

async function holdPhotoPressForOpen(card: HTMLElement): Promise<void> {
  if (reducedMotion()) return;

  const pressState = photoPressStates.get(card);
  if (pressState === undefined) {
    const keyboardPressState: PhotoPressState = {
      pointerId: -1,
      pressedAt: null,
      pressTimer: null,
      startX: 0,
      startY: 0,
    };
    photoPressStates.set(card, keyboardPressState);
    applyPhotoPress(card, keyboardPressState);
    await nextAnimationFrame();
    await sleep(PHOTO_PRESS_DOWN_MS);
    return;
  }
  if (pressState.pressedAt === null) {
    if (pressState.pressTimer !== null) {
      window.clearTimeout(pressState.pressTimer);
      pressState.pressTimer = null;
    }
    applyPhotoPress(card, pressState);
    await nextAnimationFrame();
    await sleep(PHOTO_PRESS_DOWN_MS);
    return;
  }
  const elapsed = performance.now() - pressState.pressedAt;
  if (elapsed < PHOTO_PRESS_DOWN_MS) {
    await sleep(PHOTO_PRESS_DOWN_MS - elapsed);
  }
}

async function openPhotoViewWithPressFeedback(
  photo: PlacedPhoto,
  card: HTMLElement,
): Promise<void> {
  if (openingPhotoCards.has(card)) return;
  openingPhotoCards.add(card);

  try {
    if (!reducedMotion()) {
      await holdPhotoPressForOpen(card);
      await nextAnimationFrame();
    }
    if (card.isConnected) await openPhotoView(photo, card);
  } finally {
    clearPhotoPressState(card);
    openingPhotoCards.delete(card);
  }
}

function readRect(rect: DOMRect): PhotoRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function pointInsideElement(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function pointerMovedPastTapTolerance(
  pressState: PhotoPressState,
  event: PointerEvent,
): boolean {
  return (
    Math.hypot(
      event.clientX - pressState.startX,
      event.clientY - pressState.startY,
    ) > PHOTO_TAP_MOVE_TOLERANCE_PX
  );
}

function isPhotoTapRelease(
  card: HTMLElement,
  pressState: PhotoPressState,
  event: PointerEvent,
): boolean {
  return (
    event.isPrimary &&
    pressState.pointerId === event.pointerId &&
    pointInsideElement(card, event.clientX, event.clientY) &&
    !pointerMovedPastTapTolerance(pressState, event)
  );
}

function styleFixedRect(element: HTMLElement, rect: PhotoRect): void {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function setPhotoHeroRadius(hero: HTMLElement, radius: string): void {
  hero.style.borderRadius = radius;
  hero.style.clipPath = `inset(0 round ${radius})`;
}

function animationFinished(animation: Animation): Promise<void> {
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}

function findMountedPhotoElement(photoId: number): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(
    `.masonry-photo[data-photo-id="${photoId}"]`,
  );
}

function revealPhotoSource(element: HTMLElement | null): void {
  element?.classList.remove("is-photo-view-source");
}

function hidePhotoSource(element: HTMLElement | null): void {
  element?.classList.add("is-photo-view-source");
}

function createPhotoHero(src: string, rect: PhotoRect): HTMLElement {
  const hero = document.createElement("div");
  hero.className = "photo-viewer-hero";
  hero.style.backgroundImage = `url(${JSON.stringify(src)})`;
  styleFixedRect(hero, rect);
  return hero;
}

function cancelPhotoViewOpeningAnimation(
  view: ActivePhotoView,
  removeHero = true,
): void {
  for (const animation of view.openingAnimations) {
    animation.cancel();
  }
  view.openingAnimations = [];
  if (removeHero) view.openingHero?.remove();
  view.openingHero = null;
}

function syncPhotoViewScrollMode(view: ActivePhotoView): void {
  const scrollable = view.scroll.scrollHeight > view.scroll.clientHeight + 1;
  view.scroll.classList.toggle("is-scrollable", scrollable);
}

function syncPhotoViewLayout(view: ActivePhotoView): void {
  syncPhotoViewViewportVars(view.overlay, view.photo);
  requestAnimationFrame(() => {
    if (activePhotoView === view) syncPhotoViewScrollMode(view);
  });
}

function currentPhotoViewImage(view: ActivePhotoView): HTMLImageElement {
  return view.highResolutionImage.classList.contains("is-loaded")
    ? view.highResolutionImage
    : view.image;
}

function cancelPhotoSwipeReset(view: ActivePhotoView): void {
  for (const animation of view.swipeResetAnimations) animation.cancel();
  view.swipeResetAnimations = [];
}

function canStartPhotoSwipe(view: ActivePhotoView): boolean {
  if (view.scroll.scrollTop <= PHOTO_SWIPE_SCROLL_TOP_TOLERANCE_PX) {
    view.scroll.scrollTop = 0;
    return true;
  }
  return false;
}

function photoSwipeVisualOffset(deltaY: number): number {
  const sign = Math.sign(deltaY);
  const distance = Math.abs(deltaY);
  if (distance <= 240) return sign * distance * 0.62;
  return sign * (148.8 + (distance - 240) * 0.18);
}

function applyPhotoSwipe(view: ActivePhotoView, dragY: number): void {
  const distance = Math.abs(dragY);
  const scale = clamp(1 - distance / 2400, 0.94, 1);
  const opacity =
    Number.parseFloat(photoViewBackdropOpacity(view)) *
    (1 - clamp(distance / 320, 0, 0.72));
  view.stage.style.transform = `translate3d(0, ${dragY.toFixed(3)}px, 0) scale(${scale.toFixed(4)})`;
  view.stage.style.willChange = "transform";
  view.backdrop.style.opacity = opacity.toFixed(3);
}

function clearPhotoSwipeVisualState(view: ActivePhotoView): void {
  view.scroll.classList.remove("is-swiping");
  view.scroll.scrollTop = 0;
  view.stage.style.transform = "";
  view.stage.style.willChange = "";
  view.backdrop.style.opacity = photoViewBackdropOpacity(view);
}

async function resetPhotoSwipe(view: ActivePhotoView): Promise<void> {
  cancelPhotoSwipeReset(view);
  const backdropOpacity = photoViewBackdropOpacity(view);
  const stageAnimation = view.stage.animate(
    [
      { transform: getComputedStyle(view.stage).transform },
      { transform: "translate3d(0, 0, 0) scale(1)" },
    ],
    {
      duration: 320,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fill: "both",
    },
  );
  const backdropAnimation = view.backdrop.animate(
    [
      { opacity: getComputedStyle(view.backdrop).opacity },
      { opacity: backdropOpacity },
    ],
    {
      duration: 260,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fill: "both",
    },
  );
  view.swipeResetAnimations = [stageAnimation, backdropAnimation];
  await Promise.all([
    animationFinished(stageAnimation),
    animationFinished(backdropAnimation),
  ]);
  if (activePhotoView !== view || view.closing) return;
  stageAnimation.cancel();
  backdropAnimation.cancel();
  view.swipeResetAnimations = [];
  clearPhotoSwipeVisualState(view);
}

function startPhotoSwipe(view: ActivePhotoView, event: PointerEvent): void {
  if (view.closing || event.button !== 0 || !event.isPrimary) return;
  if (view.closeButton.contains(event.target as Node)) return;
  if (!canStartPhotoSwipe(view)) return;

  cancelPhotoSwipeReset(view);
  view.swipeState = {
    dragY: 0,
    dragging: false,
    lastTime: performance.now(),
    lastY: event.clientY,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    velocityY: 0,
  };
}

function updatePhotoSwipe(view: ActivePhotoView, event: PointerEvent): void {
  const state = view.swipeState;
  if (!state || state.pointerId !== event.pointerId || view.closing) return;

  const deltaX = event.clientX - state.startX;
  const deltaY = event.clientY - state.startY;
  const absDeltaY = Math.abs(deltaY);
  if (!state.dragging) {
    if (Math.abs(deltaX) > PHOTO_SWIPE_START_PX * 1.4) {
      view.swipeState = null;
      return;
    }
    if (absDeltaY < PHOTO_SWIPE_START_PX || absDeltaY < Math.abs(deltaX) * 1.2)
      return;
    if (!canStartPhotoSwipe(view)) {
      view.swipeState = null;
      return;
    }
    state.dragging = true;
    view.scroll.classList.add("is-swiping");
  }

  event.preventDefault();
  const now = performance.now();
  const elapsed = Math.max(1, now - state.lastTime);
  state.velocityY = (event.clientY - state.lastY) / elapsed;
  state.lastTime = now;
  state.lastY = event.clientY;
  state.dragY = photoSwipeVisualOffset(deltaY);
  applyPhotoSwipe(view, state.dragY);
}

function endPhotoSwipe(view: ActivePhotoView, event: PointerEvent): void {
  const state = view.swipeState;
  if (!state || state.pointerId !== event.pointerId) return;
  view.swipeState = null;
  view.scroll.classList.remove("is-swiping");
  if (!state.dragging) return;

  event.preventDefault();
  const dragDistance = Math.abs(state.dragY);
  const shouldClose =
    dragDistance >= PHOTO_SWIPE_CLOSE_DISTANCE_PX ||
    (dragDistance >= 40 &&
      Math.abs(state.velocityY) >= PHOTO_SWIPE_CLOSE_VELOCITY_PX_MS);
  if (shouldClose) {
    void closePhotoView();
    return;
  }
  view.scroll.classList.add("is-swiping");
  void resetPhotoSwipe(view);
}

function cancelPhotoSwipe(view: ActivePhotoView, event: PointerEvent): void {
  const state = view.swipeState;
  if (!state || state.pointerId !== event.pointerId) return;
  view.swipeState = null;
  if (state.dragging) void resetPhotoSwipe(view);
  else view.scroll.classList.remove("is-swiping");
}

function photoDetailsText(photo: PlacedPhoto): string {
  return `Photo ${photo.id} · ${Math.round(photo.width)}×${Math.round(photo.height)} · ${photo.aspectRatio.toFixed(2)} ratio`;
}

async function revealHighResolutionImage(view: ActivePhotoView): Promise<void> {
  await view.highResolutionImage.decode?.().catch(() => undefined);
  if (activePhotoView !== view || view.closing) return;
  view.highResolutionImage.classList.add("is-loaded");
  if (view.highResolutionImage.naturalWidth > 0) {
    view.details.textContent = `${photoDetailsText(view.photo)} · source ${view.highResolutionImage.naturalWidth}×${view.highResolutionImage.naturalHeight}`;
    syncPhotoViewScrollMode(view);
  }
}

function cleanupPhotoView(view: ActivePhotoView, source: HTMLElement | null) {
  document.removeEventListener("keydown", view.onKeyDown);
  view.overlay.removeEventListener("click", view.onOverlayClick);
  view.scroll.removeEventListener("pointercancel", view.onSwipePointerCancel);
  view.scroll.removeEventListener("pointerdown", view.onSwipePointerDown);
  view.scroll.removeEventListener("pointermove", view.onSwipePointerMove);
  view.scroll.removeEventListener("pointerup", view.onSwipePointerUp);
  window.removeEventListener("resize", view.onViewportChange);
  window.visualViewport?.removeEventListener("resize", view.onViewportChange);
  window.visualViewport?.removeEventListener("scroll", view.onViewportChange);
  cancelPhotoViewOpeningAnimation(view);
  cancelPhotoSwipeReset(view);
  clearPhotoSwipeVisualState(view);
  revealPhotoSource(source);
  if (source !== view.sourceElement) revealPhotoSource(view.sourceElement);
  view.overlay.remove();
  document.documentElement.classList.remove("photo-view-open");
  if (activePhotoView === view) activePhotoView = null;
}

async function openPhotoView(
  photo: PlacedPhoto,
  sourceElement: HTMLElement,
): Promise<void> {
  if (activePhotoView) {
    await closePhotoView(false);
  }

  const sourceImage =
    sourceElement.querySelector<HTMLImageElement>(".masonry-photo-img");
  const sourceSrc =
    sourceImage?.currentSrc || sourceImage?.src || imageUrl(photo);
  const sourceRect = readRect(sourceElement.getBoundingClientRect());
  const overlay = document.createElement("div");
  overlay.className = "photo-viewer is-preparing";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const imageBox = syncPhotoViewViewportVars(overlay, photo);

  const backdrop = document.createElement("div");
  backdrop.className = "photo-viewer-backdrop";
  backdrop.style.opacity = "0";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "photo-viewer-close";
  closeButton.setAttribute("aria-label", "Close photo");
  closeButton.textContent = "×";

  const details = document.createElement("div");
  details.className = "photo-viewer-details";
  details.textContent = photoDetailsText(photo);

  const scroll = document.createElement("div");
  scroll.className = "photo-viewer-scroll";

  const stage = document.createElement("div");
  stage.className = "photo-viewer-stage";

  const frame = document.createElement("div");
  frame.className = "photo-viewer-frame";

  const image = document.createElement("img");
  image.className = "photo-viewer-image";
  image.alt = "";
  image.decoding = "async";
  image.src = sourceSrc;
  image.width = imageBox.width;
  image.height = imageBox.height;

  const highResolutionImage = document.createElement("img");
  highResolutionImage.className = "photo-viewer-image photo-viewer-image-hires";
  highResolutionImage.alt = "";
  highResolutionImage.decoding = "async";
  highResolutionImage.src = photoViewImageUrl(photo);
  highResolutionImage.width = imageBox.width;
  highResolutionImage.height = imageBox.height;

  frame.append(image, highResolutionImage);
  stage.append(frame, details);
  scroll.append(stage);
  overlay.append(backdrop, scroll, closeButton);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void closePhotoView();
    }
  };
  const onOverlayClick = (event: MouseEvent) => {
    if (!(event.target instanceof Node)) return;
    if (
      view.frame.contains(event.target) ||
      view.closeButton.contains(event.target)
    ) {
      return;
    }
    void closePhotoView();
  };
  const onSwipePointerDown = (event: PointerEvent) =>
    startPhotoSwipe(view, event);
  const onSwipePointerMove = (event: PointerEvent) =>
    updatePhotoSwipe(view, event);
  const onSwipePointerUp = (event: PointerEvent) => endPhotoSwipe(view, event);
  const onSwipePointerCancel = (event: PointerEvent) =>
    cancelPhotoSwipe(view, event);
  const onViewportChange = () => syncPhotoViewLayout(view);

  const view: ActivePhotoView = {
    photo,
    overlay,
    backdrop,
    closeButton,
    frame,
    stage,
    scroll,
    image,
    highResolutionImage,
    details,
    openingAnimations: [],
    openingHero: null,
    sourceElement,
    sourceRect,
    onKeyDown,
    onOverlayClick,
    onSwipePointerCancel,
    onSwipePointerDown,
    onSwipePointerMove,
    onSwipePointerUp,
    onViewportChange,
    swipeResetAnimations: [],
    swipeState: null,
    closing: false,
  };

  activePhotoView = view;
  document.body.append(overlay);
  document.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("click", onOverlayClick);
  scroll.addEventListener("pointercancel", onSwipePointerCancel);
  scroll.addEventListener("pointerdown", onSwipePointerDown);
  scroll.addEventListener("pointermove", onSwipePointerMove);
  scroll.addEventListener("pointerup", onSwipePointerUp);
  window.addEventListener("resize", onViewportChange);
  window.visualViewport?.addEventListener("resize", onViewportChange);
  window.visualViewport?.addEventListener("scroll", onViewportChange);
  closeButton.addEventListener("click", () => void closePhotoView());

  await image.decode?.().catch(() => undefined);
  await nextAnimationFrame();
  if (activePhotoView !== view || view.closing) return;
  syncPhotoViewScrollMode(view);
  const targetRect = readRect(frame.getBoundingClientRect());
  const hero = createPhotoHero(sourceSrc, sourceRect);
  setPhotoHeroRadius(hero, "8px");
  view.openingHero = hero;
  overlay.append(hero);
  hidePhotoSource(sourceElement);
  document.documentElement.classList.add("photo-view-open");
  overlay.classList.remove("is-preparing");
  const backdropOpacity = photoViewBackdropOpacity(view);

  if (reducedMotion()) {
    backdrop.style.opacity = backdropOpacity;
    image.classList.add("is-visible");
    view.openingHero = null;
    hero.remove();
    void revealHighResolutionImage(view);
    return;
  }

  const heroAnimation = hero.animate(
    [
      {
        borderRadius: "8px",
        clipPath: "inset(0 round 8px)",
        height: `${sourceRect.height}px`,
        left: `${sourceRect.left}px`,
        top: `${sourceRect.top}px`,
        width: `${sourceRect.width}px`,
      },
      {
        borderRadius: "10px",
        clipPath: "inset(0 round 10px)",
        height: `${targetRect.height}px`,
        left: `${targetRect.left}px`,
        top: `${targetRect.top}px`,
        width: `${targetRect.width}px`,
      },
    ],
    {
      duration: PHOTO_VIEW_DURATION_MS,
      easing: PHOTO_VIEW_EASING,
      fill: "both",
    },
  );
  const backdropAnimation = backdrop.animate(
    [{ opacity: 0 }, { opacity: backdropOpacity }],
    {
      duration: PHOTO_VIEW_DURATION_MS,
      easing: PHOTO_VIEW_EASING,
      fill: "both",
    },
  );
  view.openingAnimations = [heroAnimation, backdropAnimation];

  await Promise.all([
    animationFinished(heroAnimation),
    animationFinished(backdropAnimation),
  ]);
  if (activePhotoView !== view || view.closing) return;
  backdrop.style.opacity = backdropOpacity;
  image.classList.add("is-visible");
  view.openingAnimations = [];
  view.openingHero = null;
  hero.remove();
  void revealHighResolutionImage(view);
}

async function closePhotoView(animate = true): Promise<void> {
  const view = activePhotoView;
  if (!view || view.closing) return;
  view.closing = true;
  view.swipeState = null;
  cancelPhotoSwipeReset(view);

  const currentSource =
    findMountedPhotoElement(view.photo.id) ??
    (view.sourceElement?.isConnected ? view.sourceElement : null);
  hidePhotoSource(currentSource);

  const openingHero =
    view.openingHero?.isConnected === true ? view.openingHero : null;
  const currentImage = currentPhotoViewImage(view);
  const currentRect = readRect(
    (openingHero ?? view.frame).getBoundingClientRect(),
  );
  const hero =
    openingHero ??
    createPhotoHero(currentImage.currentSrc || currentImage.src, currentRect);
  cancelPhotoViewOpeningAnimation(view, false);
  styleFixedRect(hero, currentRect);
  if (!hero.isConnected) view.overlay.append(hero);
  view.frame.style.visibility = "hidden";
  view.image.classList.remove("is-visible");
  view.highResolutionImage.classList.remove("is-loaded");

  if (!animate || reducedMotion()) {
    cleanupPhotoView(view, currentSource);
    return;
  }

  const targetRect = currentSource
    ? readRect(currentSource.getBoundingClientRect())
    : view.sourceRect;
  const heroBorderRadius = currentSource ? "8px" : "10px";
  const heroClipPath = `inset(0 round ${heroBorderRadius})`;
  setPhotoHeroRadius(hero, heroBorderRadius);

  const heroAnimation = currentSource
    ? hero.animate(
        [
          {
            borderRadius: heroBorderRadius,
            clipPath: heroClipPath,
            height: `${currentRect.height}px`,
            left: `${currentRect.left}px`,
            top: `${currentRect.top}px`,
            width: `${currentRect.width}px`,
          },
          {
            borderRadius: heroBorderRadius,
            clipPath: heroClipPath,
            height: `${targetRect.height}px`,
            left: `${targetRect.left}px`,
            top: `${targetRect.top}px`,
            width: `${targetRect.width}px`,
          },
        ],
        {
          duration: PHOTO_VIEW_DURATION_MS,
          easing: PHOTO_VIEW_EASING,
          fill: "both",
        },
      )
    : hero.animate(
        [
          {
            borderRadius: heroBorderRadius,
            clipPath: heroClipPath,
            opacity: 1,
            transform: "translate3d(0, 0, 0) scale(1)",
          },
          {
            borderRadius: heroBorderRadius,
            clipPath: heroClipPath,
            opacity: 0,
            transform: "translate3d(0, 18px, 0) scale(0.96)",
          },
        ],
        {
          duration: PHOTO_VIEW_DURATION_MS,
          easing: PHOTO_VIEW_EASING,
          fill: "both",
        },
      );
  const backdropAnimation = view.backdrop.animate(
    [{ opacity: currentPhotoViewBackdropOpacity(view) }, { opacity: 0 }],
    {
      duration: PHOTO_VIEW_DURATION_MS,
      easing: PHOTO_VIEW_EASING,
      fill: "both",
    },
  );
  const scrollAnimation = view.scroll.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    {
      duration: Math.round(PHOTO_VIEW_DURATION_MS * 0.72),
      easing: PHOTO_VIEW_EASING,
      fill: "both",
    },
  );
  const closeButtonAnimation = view.closeButton.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    {
      duration: Math.round(PHOTO_VIEW_DURATION_MS * 0.72),
      easing: PHOTO_VIEW_EASING,
      fill: "both",
    },
  );

  await Promise.all([
    animationFinished(heroAnimation),
    animationFinished(backdropAnimation),
    animationFinished(scrollAnimation),
    animationFinished(closeButtonAnimation),
  ]);
  cleanupPhotoView(view, currentSource);
}

function buildPhotoCard(photo: PlacedPhoto, groupTop: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "masonry-photo";
  card.dataset.photoId = String(photo.id);
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `View photo ${photo.id}`);
  card.style.left = px(photo.left);
  card.style.top = px(photo.top - groupTop);
  card.style.width = px(photo.width);
  card.style.height = px(photo.height);
  card.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || activePhotoView) return;
    startPhotoPress(card, event);
  });
  card.addEventListener("pointermove", (event) => {
    const pressState = photoPressStates.get(card);
    if (!pressState || pressState.pointerId !== event.pointerId) return;
    if (pointerMovedPastTapTolerance(pressState, event)) {
      releasePhotoPress(card);
    }
  });
  card.addEventListener("pointerup", (event) => {
    const pressState = photoPressStates.get(card);
    if (!event.isPrimary || !pressState) return;
    if (isPhotoTapRelease(card, pressState, event)) {
      void openPhotoViewWithPressFeedback(photo, card);
    } else {
      releasePhotoPress(card);
    }
  });
  card.addEventListener("pointercancel", () => {
    releasePhotoPress(card);
  });
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
  card.addEventListener("click", () => {
    if (openingPhotoCards.has(card) || photoPressStates.has(card)) return;
    void openPhotoViewWithPressFeedback(photo, card);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openPhotoViewWithPressFeedback(photo, card);
  });

  const image = document.createElement("img");
  image.className = "masonry-photo-img";
  image.alt = "";
  image.decoding = "async";
  image.draggable = false;
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
