import { clamp, nextFrame, sleep } from "../shared/utils.js";

const PHOTO_VIEW_INLINE_PADDING = 24;
const PHOTO_VIEW_BLOCK_PADDING = 0;
const PHOTO_VIEW_MAX_WIDTH = 1280;
const PHOTO_VIEW_MAX_SOURCE_WIDTH = 1800;
const PHOTO_VIEW_DURATION_MS = 420;
const PHOTO_VIEW_IOS_DURATION_MS = 520;
const PHOTO_VIEW_GEOMETRY_EASING = "cubic-bezier(0.18, 1.28, 0.32, 1)";
const PHOTO_VIEW_IOS_GEOMETRY_EASING = "cubic-bezier(0.18, 1.24, 0.32, 1)";
const PHOTO_VIEW_FADE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const PHOTO_PRESS_DOWN_MS = 150;
const PHOTO_TOUCH_PRESS_DELAY_MS = 80;
const PHOTO_TAP_MOVE_TOLERANCE_PX = 10;
const PHOTO_SWIPE_CLOSE_DISTANCE_PX = 120;
const PHOTO_SWIPE_CLOSE_VELOCITY_PX_MS = 0.55;
const PHOTO_SWIPE_EDGE_TOLERANCE_PX = 1;
const PHOTO_SWIPE_START_PX = 14;

export interface PhotoPreviewItem {
  id: number;
  aspectRatio: number;
  width: number;
  height: number;
}

export interface PhotoPreviewOptions<T extends PhotoPreviewItem> {
  viewport: HTMLElement;
  thumbnailUrl: (photo: T) => string;
  previewUrl: (photo: T, width: number) => string;
  detailsText?: (photo: T) => string;
  maxPreviewSourceWidth?: number;
}

export interface PhotoPreviewController<T extends PhotoPreviewItem> {
  readonly active: boolean;
  bind(card: HTMLElement, photo: T): void;
  close(animate?: boolean): Promise<void>;
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

type PhotoSwipeEdge = "bottom" | "top";
type PhotoSwipeAllowedEdge = PhotoSwipeEdge | "both" | null;

interface ActivePhotoView<T extends PhotoPreviewItem> {
  photo: T;
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
  sourceElement: HTMLElement | null;
  sourceRect: PhotoRect;
  onKeyDown: (event: KeyboardEvent) => void;
  onOverlayClick: (event: MouseEvent) => void;
  onSwipePointerCancel: (event: PointerEvent) => void;
  onSwipePointerDown: (event: PointerEvent) => void;
  onSwipePointerMove: (event: PointerEvent) => void;
  onSwipePointerUp: (event: PointerEvent) => void;
  onSwipeTouchCancel: (event: TouchEvent) => void;
  onSwipeTouchEnd: (event: TouchEvent) => void;
  onSwipeTouchMove: (event: TouchEvent) => void;
  onSwipeTouchStart: (event: TouchEvent) => void;
  onViewportChange: () => void;
  swipeResetAnimations: Animation[];
  swipeState: PhotoSwipeState | null;
  closing: boolean;
}

interface PhotoSwipeState {
  allowedEdge: PhotoSwipeAllowedEdge;
  dragY: number;
  dragging: boolean;
  edge: PhotoSwipeEdge | null;
  input: "pointer" | "touch";
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

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function supportsTouchEvents(): boolean {
  return "TouchEvent" in window;
}

function isIOSLike(): boolean {
  return (
    /iP(ad|hone|od)/.test(navigator.platform) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function photoViewDurationMs(): number {
  return isIOSLike() ? PHOTO_VIEW_IOS_DURATION_MS : PHOTO_VIEW_DURATION_MS;
}

function photoViewGeometryEasing(): string {
  return isIOSLike()
    ? PHOTO_VIEW_IOS_GEOMETRY_EASING
    : PHOTO_VIEW_GEOMETRY_EASING;
}

function readRect(rect: DOMRect): PhotoRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
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

function photoHeroTransform(from: PhotoRect, to: PhotoRect): string {
  const scaleX = from.width / Math.max(1, to.width);
  const scaleY = from.height / Math.max(1, to.height);
  const translateX = from.left - to.left;
  const translateY = from.top - to.top;
  return `translate3d(${translateX.toFixed(3)}px, ${translateY.toFixed(3)}px, 0) scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`;
}

function animationFinished(animation: Animation): Promise<void> {
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
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

function defaultDetailsText(photo: PhotoPreviewItem): string {
  return `Photo ${photo.id} · ${Math.round(photo.width)}×${Math.round(photo.height)} · ${photo.aspectRatio.toFixed(2)} ratio`;
}

export function createPhotoPreview<T extends PhotoPreviewItem>(
  options: PhotoPreviewOptions<T>,
): PhotoPreviewController<T> {
  let activePhotoView: ActivePhotoView<T> | null = null;
  const openingPhotoCards = new WeakSet<HTMLElement>();
  const photoPressStates = new WeakMap<HTMLElement, PhotoPressState>();

  function photoDetailsText(photo: T): string {
    return options.detailsText?.(photo) ?? defaultDetailsText(photo);
  }

  function photoViewImageWidth(): number {
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    return Math.round(
      clamp(
        photoViewViewportWidth() * pixelRatio,
        720,
        options.maxPreviewSourceWidth ?? PHOTO_VIEW_MAX_SOURCE_WIDTH,
      ),
    );
  }

  function photoViewImageUrl(photo: T): string {
    return options.previewUrl(photo, photoViewImageWidth());
  }

  function photoViewViewportWidth(): number {
    return window.visualViewport?.width ?? window.innerWidth;
  }

  function photoViewViewportHeight(): number {
    return window.visualViewport?.height ?? window.innerHeight;
  }

  function photoViewImageBox(photo: T): PhotoViewBox {
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
    photo: T,
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

  function photoViewBackdropOpacity(view: ActivePhotoView<T>): string {
    return getComputedStyle(view.overlay)
      .getPropertyValue("--photo-viewer-backdrop-opacity")
      .trim();
  }

  function currentPhotoViewBackdropOpacity(view: ActivePhotoView<T>): string {
    const opacity = Number.parseFloat(getComputedStyle(view.backdrop).opacity);
    return Number.isFinite(opacity)
      ? String(opacity)
      : photoViewBackdropOpacity(view);
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
    if (photoPressStates.get(card) !== state || state.pressedAt !== null)
      return;
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
      await nextFrame();
      await sleep(PHOTO_PRESS_DOWN_MS);
      return;
    }
    if (pressState.pressedAt === null) {
      if (pressState.pressTimer !== null) {
        window.clearTimeout(pressState.pressTimer);
        pressState.pressTimer = null;
      }
      applyPhotoPress(card, pressState);
      await nextFrame();
      await sleep(PHOTO_PRESS_DOWN_MS);
      return;
    }
    const elapsed = performance.now() - pressState.pressedAt;
    if (elapsed < PHOTO_PRESS_DOWN_MS) {
      await sleep(PHOTO_PRESS_DOWN_MS - elapsed);
    }
  }

  async function openPhotoViewWithPressFeedback(
    photo: T,
    card: HTMLElement,
  ): Promise<void> {
    if (openingPhotoCards.has(card)) return;
    openingPhotoCards.add(card);

    try {
      if (!reducedMotion()) {
        await holdPhotoPressForOpen(card);
        await nextFrame();
      }
      if (card.isConnected) await openPhotoView(photo, card);
    } finally {
      clearPhotoPressState(card);
      openingPhotoCards.delete(card);
    }
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

  function findMountedPhotoElement(photoId: number): HTMLElement | null {
    return options.viewport.querySelector<HTMLElement>(
      `.photo-preview-card[data-photo-id="${photoId}"]`,
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

  function cancelPhotoViewOpeningAnimation(view: ActivePhotoView<T>): void {
    for (const animation of view.openingAnimations) {
      animation.cancel();
    }
    view.openingAnimations = [];
  }

  function syncPhotoViewScrollMode(view: ActivePhotoView<T>): void {
    const scrollable = view.scroll.scrollHeight > view.scroll.clientHeight + 1;
    view.scroll.classList.toggle("is-scrollable", scrollable);
  }

  function syncPhotoViewLayout(view: ActivePhotoView<T>): void {
    syncPhotoViewViewportVars(view.overlay, view.photo);
    requestAnimationFrame(() => {
      if (activePhotoView === view) syncPhotoViewScrollMode(view);
    });
  }

  function currentPhotoViewImage(view: ActivePhotoView<T>): HTMLImageElement {
    return view.highResolutionImage.classList.contains("is-loaded")
      ? view.highResolutionImage
      : view.image;
  }

  function cancelPhotoSwipeReset(view: ActivePhotoView<T>): void {
    for (const animation of view.swipeResetAnimations) animation.cancel();
    view.swipeResetAnimations = [];
  }

  function photoViewScrollMax(view: ActivePhotoView<T>): number {
    return Math.max(0, view.scroll.scrollHeight - view.scroll.clientHeight);
  }

  function photoSwipeAllowedEdge(
    view: ActivePhotoView<T>,
  ): PhotoSwipeAllowedEdge {
    const scrollMax = photoViewScrollMax(view);
    if (scrollMax <= PHOTO_SWIPE_EDGE_TOLERANCE_PX) {
      view.scroll.scrollTop = 0;
      return "both";
    }
    if (view.scroll.scrollTop <= PHOTO_SWIPE_EDGE_TOLERANCE_PX) return "top";
    if (view.scroll.scrollTop >= scrollMax - PHOTO_SWIPE_EDGE_TOLERANCE_PX)
      return "bottom";
    return null;
  }

  function photoSwipeEdgeForDelta(
    view: ActivePhotoView<T>,
    allowedEdge: PhotoSwipeAllowedEdge,
    deltaY: number,
  ): PhotoSwipeEdge | null {
    if (!allowedEdge) return null;

    const scrollMax = photoViewScrollMax(view);
    if (allowedEdge === "both") {
      view.scroll.scrollTop = 0;
      return deltaY < 0 ? "bottom" : "top";
    }

    if (
      allowedEdge === "top" &&
      deltaY > 0 &&
      view.scroll.scrollTop <= PHOTO_SWIPE_EDGE_TOLERANCE_PX
    ) {
      view.scroll.scrollTop = 0;
      return "top";
    }

    if (
      allowedEdge === "bottom" &&
      deltaY < 0 &&
      view.scroll.scrollTop >= scrollMax - PHOTO_SWIPE_EDGE_TOLERANCE_PX
    ) {
      view.scroll.scrollTop = scrollMax;
      return "bottom";
    }

    return null;
  }

  function photoSwipeVisualOffset(deltaY: number): number {
    const sign = Math.sign(deltaY);
    const distance = Math.abs(deltaY);
    if (distance <= 240) return sign * distance * 0.62;
    return sign * (148.8 + (distance - 240) * 0.18);
  }

  function applyPhotoSwipe(view: ActivePhotoView<T>, dragY: number): void {
    const distance = Math.abs(dragY);
    const scale = clamp(1 - distance / 2400, 0.94, 1);
    const opacity =
      Number.parseFloat(photoViewBackdropOpacity(view)) *
      (1 - clamp(distance / 320, 0, 0.72));
    view.stage.style.transform = `translate3d(0, ${dragY.toFixed(3)}px, 0) scale(${scale.toFixed(4)})`;
    view.stage.style.willChange = "transform";
    view.backdrop.style.opacity = opacity.toFixed(3);
  }

  function clearPhotoSwipeVisualState(
    view: ActivePhotoView<T>,
    edge: PhotoSwipeEdge | null,
  ): void {
    view.scroll.classList.remove("is-swiping");
    if (edge === "top") view.scroll.scrollTop = 0;
    if (edge === "bottom") view.scroll.scrollTop = photoViewScrollMax(view);
    view.stage.style.transform = "";
    view.stage.style.willChange = "";
    view.backdrop.style.opacity = photoViewBackdropOpacity(view);
  }

  async function resetPhotoSwipe(
    view: ActivePhotoView<T>,
    edge: PhotoSwipeEdge | null,
  ): Promise<void> {
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
    clearPhotoSwipeVisualState(view, edge);
  }

  function startPhotoSwipe(
    view: ActivePhotoView<T>,
    input: "pointer" | "touch",
    pointerId: number,
    clientX: number,
    clientY: number,
  ): void {
    if (view.closing) return;
    cancelPhotoSwipeReset(view);
    view.swipeState = {
      allowedEdge: photoSwipeAllowedEdge(view),
      dragY: 0,
      dragging: false,
      edge: null,
      input,
      lastTime: performance.now(),
      lastY: clientY,
      pointerId,
      startX: clientX,
      startY: clientY,
      velocityY: 0,
    };
  }

  function updatePhotoSwipe(
    view: ActivePhotoView<T>,
    input: "pointer" | "touch",
    pointerId: number,
    clientX: number,
    clientY: number,
  ): boolean {
    const state = view.swipeState;
    if (
      !state ||
      state.input !== input ||
      state.pointerId !== pointerId ||
      view.closing
    )
      return false;

    const deltaX = clientX - state.startX;
    const deltaY = clientY - state.startY;
    const absDeltaY = Math.abs(deltaY);
    if (!state.dragging) {
      if (Math.abs(deltaX) > PHOTO_SWIPE_START_PX * 1.4) {
        view.swipeState = null;
        return false;
      }
      if (
        absDeltaY < PHOTO_SWIPE_START_PX ||
        absDeltaY < Math.abs(deltaX) * 1.2
      )
        return false;
      const edge = photoSwipeEdgeForDelta(view, state.allowedEdge, deltaY);
      if (!edge) {
        return false;
      }
      state.edge = edge;
      state.startX = clientX;
      state.startY = clientY;
      state.lastY = clientY;
      state.lastTime = performance.now();
      state.dragging = true;
      view.scroll.classList.add("is-swiping");
    }

    const now = performance.now();
    const elapsed = Math.max(1, now - state.lastTime);
    state.velocityY = (clientY - state.lastY) / elapsed;
    state.lastTime = now;
    state.lastY = clientY;
    state.dragY = photoSwipeVisualOffset(clientY - state.startY);
    applyPhotoSwipe(view, state.dragY);
    return true;
  }

  function endPhotoSwipe(
    view: ActivePhotoView<T>,
    input: "pointer" | "touch",
    pointerId: number,
  ): boolean {
    const state = view.swipeState;
    if (!state || state.input !== input || state.pointerId !== pointerId)
      return false;
    view.swipeState = null;
    view.scroll.classList.remove("is-swiping");
    if (!state.dragging) return false;

    const dragDistance = Math.abs(state.dragY);
    const shouldClose =
      dragDistance >= PHOTO_SWIPE_CLOSE_DISTANCE_PX ||
      (dragDistance >= 40 &&
        Math.abs(state.velocityY) >= PHOTO_SWIPE_CLOSE_VELOCITY_PX_MS);
    if (shouldClose) {
      void closePhotoView();
      return true;
    }
    view.scroll.classList.add("is-swiping");
    void resetPhotoSwipe(view, state.edge);
    return true;
  }

  function cancelPhotoSwipe(
    view: ActivePhotoView<T>,
    input: "pointer" | "touch",
    pointerId: number,
  ): void {
    const state = view.swipeState;
    if (!state || state.input !== input || state.pointerId !== pointerId)
      return;
    view.swipeState = null;
    if (state.dragging) void resetPhotoSwipe(view, state.edge);
    else view.scroll.classList.remove("is-swiping");
  }

  function changedTouchById(
    event: TouchEvent,
    pointerId: number,
  ): Touch | null {
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const touch = event.changedTouches.item(index);
      if (touch?.identifier === pointerId) return touch;
    }
    return null;
  }

  async function revealHighResolutionImage(
    view: ActivePhotoView<T>,
  ): Promise<void> {
    if (!view.highResolutionImage.src) {
      view.highResolutionImage.src = photoViewImageUrl(view.photo);
    }
    await view.highResolutionImage.decode?.().catch(() => undefined);
    if (activePhotoView !== view || view.closing) return;
    view.highResolutionImage.classList.add("is-loaded");
  }

  function cleanupPhotoView(
    view: ActivePhotoView<T>,
    source: HTMLElement | null,
  ): void {
    document.removeEventListener("keydown", view.onKeyDown);
    view.overlay.removeEventListener("click", view.onOverlayClick);
    view.scroll.removeEventListener("pointercancel", view.onSwipePointerCancel);
    view.scroll.removeEventListener("pointerdown", view.onSwipePointerDown);
    view.scroll.removeEventListener("pointermove", view.onSwipePointerMove);
    view.scroll.removeEventListener("pointerup", view.onSwipePointerUp);
    view.scroll.removeEventListener("touchcancel", view.onSwipeTouchCancel);
    view.scroll.removeEventListener("touchend", view.onSwipeTouchEnd);
    view.scroll.removeEventListener("touchmove", view.onSwipeTouchMove);
    view.scroll.removeEventListener("touchstart", view.onSwipeTouchStart);
    window.removeEventListener("resize", view.onViewportChange);
    window.visualViewport?.removeEventListener("resize", view.onViewportChange);
    window.visualViewport?.removeEventListener("scroll", view.onViewportChange);
    cancelPhotoViewOpeningAnimation(view);
    cancelPhotoSwipeReset(view);
    clearPhotoSwipeVisualState(view, null);
    revealPhotoSource(source);
    if (source !== view.sourceElement) revealPhotoSource(view.sourceElement);
    view.overlay.remove();
    document.documentElement.classList.remove("photo-view-open");
    if (activePhotoView === view) activePhotoView = null;
  }

  async function openPhotoView(
    photo: T,
    sourceElement: HTMLElement,
  ): Promise<void> {
    if (activePhotoView) {
      await closePhotoView(false);
    }

    const sourceImage = sourceElement.querySelector<HTMLImageElement>(
      ".photo-preview-image",
    );
    const sourceSrc =
      sourceImage?.currentSrc ||
      sourceImage?.src ||
      options.thumbnailUrl(photo);
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
    highResolutionImage.className =
      "photo-viewer-image photo-viewer-image-hires";
    highResolutionImage.alt = "";
    highResolutionImage.decoding = "async";
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
    const onSwipePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" && supportsTouchEvents()) return;
      if (view.closing || event.button !== 0 || !event.isPrimary) return;
      if (
        event.target instanceof Node &&
        view.closeButton.contains(event.target)
      )
        return;
      startPhotoSwipe(
        view,
        "pointer",
        event.pointerId,
        event.clientX,
        event.clientY,
      );
      try {
        view.scroll.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be captured by native scrolling.
      }
    };
    const onSwipePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" && supportsTouchEvents()) return;
      if (
        updatePhotoSwipe(
          view,
          "pointer",
          event.pointerId,
          event.clientX,
          event.clientY,
        )
      )
        event.preventDefault();
    };
    const onSwipePointerUp = (event: PointerEvent) => {
      if (event.pointerType === "touch" && supportsTouchEvents()) return;
      if (endPhotoSwipe(view, "pointer", event.pointerId))
        event.preventDefault();
      try {
        view.scroll.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore stale captures after native cancellation.
      }
    };
    const onSwipePointerCancel = (event: PointerEvent) => {
      if (event.pointerType === "touch" && supportsTouchEvents()) return;
      cancelPhotoSwipe(view, "pointer", event.pointerId);
    };
    const onSwipeTouchStart = (event: TouchEvent) => {
      if (view.closing) return;
      const state = view.swipeState;
      if (event.touches.length !== 1) {
        if (state?.input === "touch")
          cancelPhotoSwipe(view, "touch", state.pointerId);
        return;
      }
      if (
        event.target instanceof Node &&
        view.closeButton.contains(event.target)
      )
        return;
      const touch = event.changedTouches.item(0);
      if (!touch) return;
      startPhotoSwipe(
        view,
        "touch",
        touch.identifier,
        touch.clientX,
        touch.clientY,
      );
    };
    const onSwipeTouchMove = (event: TouchEvent) => {
      const state = view.swipeState;
      if (state?.input !== "touch") return;
      const touch = changedTouchById(event, state.pointerId);
      if (!touch) return;
      if (
        updatePhotoSwipe(
          view,
          "touch",
          touch.identifier,
          touch.clientX,
          touch.clientY,
        )
      )
        event.preventDefault();
    };
    const onSwipeTouchEnd = (event: TouchEvent) => {
      const state = view.swipeState;
      if (state?.input !== "touch") return;
      const touch = changedTouchById(event, state.pointerId);
      if (!touch) return;
      if (endPhotoSwipe(view, "touch", touch.identifier))
        event.preventDefault();
    };
    const onSwipeTouchCancel = (event: TouchEvent) => {
      const state = view.swipeState;
      if (state?.input !== "touch") return;
      const touch = changedTouchById(event, state.pointerId);
      cancelPhotoSwipe(view, "touch", touch?.identifier ?? state.pointerId);
    };
    const onViewportChange = () => syncPhotoViewLayout(view);

    const view: ActivePhotoView<T> = {
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
      sourceElement,
      sourceRect,
      onKeyDown,
      onOverlayClick,
      onSwipePointerCancel,
      onSwipePointerDown,
      onSwipePointerMove,
      onSwipePointerUp,
      onSwipeTouchCancel,
      onSwipeTouchEnd,
      onSwipeTouchMove,
      onSwipeTouchStart,
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
    scroll.addEventListener("touchcancel", onSwipeTouchCancel);
    scroll.addEventListener("touchend", onSwipeTouchEnd);
    scroll.addEventListener("touchmove", onSwipeTouchMove, { passive: false });
    scroll.addEventListener("touchstart", onSwipeTouchStart, { passive: true });
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);
    closeButton.addEventListener("click", () => void closePhotoView());

    await image.decode?.().catch(() => undefined);
    await nextFrame();
    if (activePhotoView !== view || view.closing) return;
    hidePhotoSource(sourceElement);
    document.documentElement.classList.add("photo-view-open");
    syncPhotoViewScrollMode(view);
    const viewDuration = photoViewDurationMs();
    const targetRect = readRect(frame.getBoundingClientRect());
    const openingTransform = photoHeroTransform(sourceRect, targetRect);
    setPhotoHeroRadius(frame, "8px");
    frame.style.transform = openingTransform;
    frame.style.transformOrigin = "top left";
    frame.style.willChange = "transform";
    image.classList.add("is-visible");
    overlay.classList.remove("is-preparing");
    const backdropOpacity = photoViewBackdropOpacity(view);

    if (reducedMotion()) {
      backdrop.style.opacity = backdropOpacity;
      setPhotoHeroRadius(frame, "10px");
      frame.style.transform = "";
      frame.style.transformOrigin = "";
      frame.style.willChange = "";
      void revealHighResolutionImage(view);
      return;
    }

    const frameAnimation = frame.animate(
      [
        {
          borderRadius: "8px",
          clipPath: "inset(0 round 8px)",
          transform: openingTransform,
        },
        {
          borderRadius: "10px",
          clipPath: "inset(0 round 10px)",
          transform: "translate3d(0, 0, 0) scale(1)",
        },
      ],
      {
        duration: viewDuration,
        easing: photoViewGeometryEasing(),
        fill: "both",
      },
    );
    const backdropAnimation = backdrop.animate(
      [{ opacity: 0 }, { opacity: backdropOpacity }],
      {
        duration: viewDuration,
        easing: PHOTO_VIEW_FADE_EASING,
        fill: "both",
      },
    );
    view.openingAnimations = [frameAnimation, backdropAnimation];

    await Promise.all([
      animationFinished(frameAnimation),
      animationFinished(backdropAnimation),
    ]);
    if (activePhotoView !== view || view.closing) return;
    backdrop.style.opacity = backdropOpacity;
    setPhotoHeroRadius(frame, "10px");
    frame.style.transform = "translate3d(0, 0, 0) scale(1)";
    frame.style.transformOrigin = "";
    frame.style.willChange = "";
    backdropAnimation.cancel();
    view.openingAnimations = [];
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

    const currentImage = currentPhotoViewImage(view);
    const currentRect = readRect(view.frame.getBoundingClientRect());
    const hero = createPhotoHero(
      currentImage.currentSrc || currentImage.src,
      currentRect,
    );
    cancelPhotoViewOpeningAnimation(view);
    styleFixedRect(hero, currentRect);
    view.overlay.append(hero);
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
    const viewDuration = photoViewDurationMs();
    const heroBorderRadius = currentSource ? "8px" : "10px";
    const heroClipPath = `inset(0 round ${heroBorderRadius})`;
    setPhotoHeroRadius(hero, heroBorderRadius);

    const heroAnimation = currentSource
      ? (() => {
          const initialTransform = photoHeroTransform(currentRect, targetRect);
          styleFixedRect(hero, targetRect);
          hero.style.transform = initialTransform;
          return hero.animate(
            [
              {
                borderRadius: heroBorderRadius,
                clipPath: heroClipPath,
                transform: initialTransform,
              },
              {
                borderRadius: heroBorderRadius,
                clipPath: heroClipPath,
                transform: "translate3d(0, 0, 0) scale(1)",
              },
            ],
            {
              duration: viewDuration,
              easing: photoViewGeometryEasing(),
              fill: "both",
            },
          );
        })()
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
            duration: viewDuration,
            easing: PHOTO_VIEW_FADE_EASING,
            fill: "both",
          },
        );
    const backdropAnimation = view.backdrop.animate(
      [{ opacity: currentPhotoViewBackdropOpacity(view) }, { opacity: 0 }],
      {
        duration: viewDuration,
        easing: PHOTO_VIEW_FADE_EASING,
        fill: "both",
      },
    );
    const scrollAnimation = view.scroll.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      {
        duration: Math.round(viewDuration * 0.72),
        easing: PHOTO_VIEW_FADE_EASING,
        fill: "both",
      },
    );
    const closeButtonAnimation = view.closeButton.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      {
        duration: Math.round(viewDuration * 0.72),
        easing: PHOTO_VIEW_FADE_EASING,
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

  function bind(card: HTMLElement, photo: T): void {
    card.classList.add("photo-preview-card");
    card.dataset.photoId = String(photo.id);
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `View photo ${photo.id}`);
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
  }

  return {
    get active() {
      return activePhotoView !== null;
    },
    bind,
    close: closePhotoView,
  };
}
