import "./photo-preview.css";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PHOTO_VIEW_INLINE_PADDING = 24;
const PHOTO_VIEW_BLOCK_PADDING = 0;
const PHOTO_VIEW_MAX_WIDTH = 1280;
const PHOTO_VIEW_MAX_SOURCE_WIDTH = 1800;
const PHOTO_VIEW_DURATION_MS = 420;
const PHOTO_NAV_INITIAL_HIDE_MS = 1500;
/** Longest wait for the opening image to decode before the zoom starts. */
const OPENING_DECODE_WAIT_MS = 200;
const PHOTO_NAV_AFTER_NAVIGATION_HIDE_MS = 3000;
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
  /** Height divided by width (the original preview's convention). */
  aspectRatio: number;
  width: number;
  height: number;
}

export interface PhotoPreviewOptions<T extends PhotoPreviewItem> {
  viewport: HTMLElement;
  thumbnailUrl: (photo: T) => string;
  previewUrl: (photo: T, width: number) => string;
  detailsText?: (photo: T) => string;
  getAdjacentPhoto?: (photo: T, direction: -1 | 1) => T | null;
  /** Native Save/Copy menus; "preview-on-ios" disables the source's iOS callout. */
  nativeImageMenu?: boolean | "preview-on-ios";
  /** Set false to keep square image corners, including the hero animation. */
  roundedCorners?: boolean;
  /** Optional host focus destination after closing, without scrolling it. */
  closeFocusTarget?: HTMLElement;
}

export interface PhotoPreviewController<T extends PhotoPreviewItem> {
  bind(card: HTMLElement, photo: T): void;
  close(animate?: boolean): Promise<void>;
  unbind(card: HTMLElement): void;
  dispose(): void;
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
  previousButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  navigationImage: HTMLImageElement | null;
  navigationLoading: HTMLElement;
  navigationHideTimer: number | null;
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
  background: { element: HTMLElement; inert: boolean }[];
  previousFocus: HTMLElement | null;
  suppressClick: boolean;
  swipeScrollTop: number;
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

interface PhotoBinding {
  events: AbortController;
  attributes: Map<string, string | null>;
  classes: Map<string, boolean>;
  hadClassAttribute: boolean;
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

function stylePhotoRect(element: HTMLElement, rect: PhotoRect): void {
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
  const sourceRadius = options.roundedCorners === false ? "0px" : "8px";
  const previewRadius = options.roundedCorners === false ? "0px" : "10px";
  const nativeSourceMenu =
    options.nativeImageMenu === true ||
    (options.nativeImageMenu === "preview-on-ios" && !isIOSLike());
  let activePhotoView: ActivePhotoView<T> | null = null;
  let disposed = false;
  const bindings = new Map<HTMLElement, PhotoBinding>();
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
        PHOTO_VIEW_MAX_SOURCE_WIDTH,
      ),
    );
  }

  function photoViewImageUrl(photo: T): string {
    return options.previewUrl(photo, photoViewImageWidth());
  }

  function photoViewViewportWidth(): number {
    // Pinch zoom changes the visual viewport, not the image's layout box.
    // Refitting to it would counteract native magnification mid-gesture.
    return document.documentElement.clientWidth;
  }

  function photoViewViewportHeight(): number {
    return document.documentElement.clientHeight;
  }

  function photoViewZoom(): number {
    return window.visualViewport?.scale || 1;
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
    if (card.classList.contains("is-photo-pressed"))
      setPhotoClass(card, "is-photo-pressed", false);
  }

  function applyPhotoPress(card: HTMLElement, state: PhotoPressState): void {
    if (reducedMotion()) return;
    if (photoPressStates.get(card) !== state || state.pressedAt !== null)
      return;
    state.pressTimer = null;
    state.pressedAt = performance.now();
    setPhotoClass(card, "is-photo-pressed", true);
  }

  function startPhotoPress(card: HTMLElement, event: PointerEvent): void {
    clearPhotoPressState(card);

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
    if (disposed || activePhotoView || openingPhotoCards.has(card)) return;
    const binding = bindings.get(card);
    if (!binding) return;
    openingPhotoCards.add(card);

    try {
      if (!reducedMotion()) {
        await holdPhotoPressForOpen(card);
        await nextFrame();
      }
      if (
        !disposed &&
        !activePhotoView &&
        bindings.get(card) === binding &&
        card.isConnected
      )
        await openPhotoView(photo, card);
    } finally {
      if (bindings.get(card) === binding) clearPhotoPressState(card);
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

  // Masonry can draw one photo in multiple clipped bands. Its full-size
  // drawings share geometry, so press/visibility changes must affect all of them.
  function setPhotoClass(
    element: HTMLElement | null,
    className: string,
    enabled: boolean,
  ): void {
    element?.classList.toggle(className, enabled);
    if (!element) return;
    for (const card of options.viewport.querySelectorAll<HTMLElement>(
      ".photo-preview-card",
    )) {
      if (card.dataset.photoId === element.dataset.photoId)
        card.classList.toggle(className, enabled);
    }
  }

  function revealPhotoSource(element: HTMLElement | null): void {
    setPhotoClass(element, "is-photo-view-source", false);
  }

  function hidePhotoSource(element: HTMLElement | null): void {
    setPhotoClass(element, "is-photo-view-source", true);
  }

  function createPhotoHero(src: string, rect: PhotoRect): HTMLElement {
    const hero = document.createElement("div");
    hero.className = "photo-viewer-hero";
    hero.style.backgroundImage = `url(${JSON.stringify(src)})`;
    stylePhotoRect(hero, rect);
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
    if (
      view.overlay.style.getPropertyValue("--photo-viewer-width") ===
        `${photoViewViewportWidth()}px` &&
      view.overlay.style.getPropertyValue("--photo-viewer-height") ===
        `${photoViewViewportHeight()}px`
    )
      return;
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
    if (edge === null) view.scroll.scrollTop = view.swipeScrollTop;
    view.backdrop.style.opacity = photoViewBackdropOpacity(view);
  }

  async function resetPhotoSwipe(
    view: ActivePhotoView<T>,
    edge: PhotoSwipeEdge | null,
  ): Promise<void> {
    cancelPhotoSwipeReset(view);
    if (reducedMotion()) {
      clearPhotoSwipeVisualState(view, edge);
      return;
    }
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
    if (view.closing || photoViewZoom() > 1.01) return;
    view.suppressClick = false;
    cancelPhotoSwipeReset(view);
    view.swipeScrollTop = view.scroll.scrollTop;
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
      // Mouse/pen dragging is a dismissal gesture, not native scrolling.
      // Wheel/trackpad scrolling can leave the photo anywhere in its range.
      // Touch still scrolls the image normally until an outward edge gesture.
      if (input === "touch") {
        const edge = photoSwipeEdgeForDelta(view, state.allowedEdge, deltaY);
        if (!edge) return false;
        state.edge = edge;
      }
      state.startX = clientX;
      state.startY = clientY;
      state.lastY = clientY;
      state.lastTime = performance.now();
      state.dragging = true;
      view.suppressClick = true;
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
    const photo = view.photo;
    if (!view.highResolutionImage.src) {
      view.highResolutionImage.src = photoViewImageUrl(view.photo);
    }
    try {
      await view.highResolutionImage.decode();
    } catch {
      return; // Keep the thumbnail when the larger source cannot be loaded.
    }
    if (activePhotoView !== view || view.closing || view.photo !== photo)
      return;
    view.highResolutionImage.classList.add("is-loaded");
  }

  function updateNavigation(view: ActivePhotoView<T>): void {
    const focused = document.activeElement;
    const previous = options.getAdjacentPhoto?.(view.photo, -1);
    const next = options.getAdjacentPhoto?.(view.photo, 1);
    view.previousButton.hidden = view.nextButton.hidden = !previous && !next;
    view.previousButton.disabled = !previous || !!view.navigationImage;
    view.nextButton.disabled = !next || !!view.navigationImage;
    view.overlay.setAttribute("aria-busy", String(!!view.navigationImage));
    view.navigationLoading.hidden = !view.navigationImage;
    view.overlay.dataset.photoId = String(view.photo.id);
    if (
      focused instanceof HTMLButtonElement &&
      (focused === view.previousButton || focused === view.nextButton) &&
      (focused.disabled || focused.hidden)
    ) {
      // Disabling a focused button can send focus back to the inert page.
      // Keep a usable keyboard target inside the dialog while decoding.
      view.closeButton.focus({ preventScroll: true });
    }
  }

  function cancelNavigationHide(view: ActivePhotoView<T>): void {
    if (view.navigationHideTimer === null) return;
    window.clearTimeout(view.navigationHideTimer);
    view.navigationHideTimer = null;
  }

  function setNavigationVisible(
    view: ActivePhotoView<T>,
    visible: boolean,
  ): void {
    cancelNavigationHide(view);
    if (
      !visible &&
      (document.activeElement === view.previousButton ||
        document.activeElement === view.nextButton)
    ) {
      view.closeButton.focus({ preventScroll: true });
    }
    view.overlay.classList.toggle("is-navigation-hidden", !visible);
    view.previousButton.inert = view.nextButton.inert = !visible;
  }

  function scheduleNavigationHide(
    view: ActivePhotoView<T>,
    delayMs: number,
  ): void {
    cancelNavigationHide(view);
    view.navigationHideTimer = window.setTimeout(() => {
      view.navigationHideTimer = null;
      if (activePhotoView === view && !view.closing)
        setNavigationVisible(view, false);
    }, delayMs);
  }

  async function navigatePhoto(
    view: ActivePhotoView<T>,
    direction: -1 | 1,
  ): Promise<void> {
    if (view.closing || view.navigationImage) return;
    const target = options.getAdjacentPhoto?.(view.photo, direction);
    if (!target) return;
    const loaded = new Image();
    view.navigationImage = loaded;
    updateNavigation(view);
    loaded.src = photoViewImageUrl(target);
    try {
      await loaded.decode();
    } catch {
      if (activePhotoView !== view || view.closing) return;
      view.navigationImage = null;
      view.details.textContent = `${photoDetailsText(view.photo)} — Unable to load image. Try again.`;
      updateNavigation(view);
      return;
    }
    if (activePhotoView !== view || view.closing) return;
    cancelPhotoViewOpeningAnimation(view);
    cancelPhotoSwipeReset(view);
    view.swipeState = null;
    clearPhotoSwipeVisualState(view, null);
    revealPhotoSource(view.sourceElement);
    view.photo =
      target.width && target.height
        ? target
        : {
            ...target,
            width: loaded.naturalWidth,
            height: loaded.naturalHeight,
            aspectRatio: loaded.naturalHeight / loaded.naturalWidth,
          };
    view.sourceElement = findMountedPhotoElement(target.id);
    if (view.sourceElement)
      view.sourceRect = readRect(view.sourceElement.getBoundingClientRect());
    hidePhotoSource(view.sourceElement);
    const box = syncPhotoViewViewportVars(view.overlay, view.photo);
    view.highResolutionImage.classList.remove("is-loaded");
    view.highResolutionImage.removeAttribute("src");
    view.image.src = loaded.src;
    view.image.width = view.highResolutionImage.width = box.width;
    view.image.height = view.highResolutionImage.height = box.height;
    view.frame.style.transform = "translate3d(0, 0, 0) scale(1)";
    view.frame.style.transformOrigin = "";
    view.frame.style.willChange = "";
    setPhotoHeroRadius(view.frame, previewRadius);
    view.scroll.scrollTop = 0;
    view.details.textContent = photoDetailsText(view.photo);
    view.overlay.setAttribute("aria-label", `Photo ${target.id}`);
    view.navigationImage = null;
    updateNavigation(view);
    syncPhotoViewScrollMode(view);
  }

  function cleanupPhotoView(
    view: ActivePhotoView<T>,
    source: HTMLElement | null,
  ): void {
    if (!view.overlay.isConnected) return;
    cancelNavigationHide(view);
    view.navigationImage?.removeAttribute("src");
    view.navigationImage = null;
    document.removeEventListener("keydown", view.onKeyDown, true);
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
    view.image.removeAttribute("src");
    view.highResolutionImage.removeAttribute("src");
    for (const entry of view.background) entry.element.inert = entry.inert;
    document.documentElement.classList.remove("photo-view-open");
    if (activePhotoView === view) activePhotoView = null;
    const focus = options.closeFocusTarget?.isConnected
      ? options.closeFocusTarget
      : source?.isConnected
        ? source
        : view.previousFocus;
    if (!disposed && focus?.isConnected) focus.focus({ preventScroll: true });
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
    overlay.classList.toggle("native-image-menu", !!options.nativeImageMenu);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `Photo ${photo.id}`);
    const imageBox = syncPhotoViewViewportVars(overlay, photo);

    const backdrop = document.createElement("div");
    backdrop.className = "photo-viewer-backdrop";
    backdrop.style.opacity = "0";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "photo-viewer-close";
    closeButton.setAttribute("aria-label", "Close photo");
    // Lucide's x icon: https://lucide.dev/icons/x (see public/lucide-license.txt).
    closeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"
      width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
    </svg>`;

    const details = document.createElement("div");
    details.className = "photo-viewer-details";
    details.setAttribute("aria-live", "polite");
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
    image.draggable = false;
    image.src = sourceSrc;
    image.width = imageBox.width;
    image.height = imageBox.height;

    const highResolutionImage = document.createElement("img");
    highResolutionImage.className =
      "photo-viewer-image photo-viewer-image-hires";
    highResolutionImage.alt = "";
    highResolutionImage.decoding = "async";
    highResolutionImage.draggable = false;
    highResolutionImage.width = imageBox.width;
    highResolutionImage.height = imageBox.height;

    frame.append(image, highResolutionImage);
    stage.append(frame, details);
    scroll.append(stage);
    const navigationButton = (direction: -1 | 1): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `photo-viewer-nav photo-viewer-${direction === -1 ? "previous" : "next"}`;
      button.setAttribute(
        "aria-label",
        direction === -1 ? "Previous image" : "Next image",
      );
      button.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${direction === -1 ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"}"/></svg>`;
      button.addEventListener("click", () => {
        setNavigationVisible(view, true);
        scheduleNavigationHide(view, PHOTO_NAV_AFTER_NAVIGATION_HIDE_MS);
        void navigatePhoto(view, direction);
      });
      return button;
    };
    const previousButton = navigationButton(-1);
    const nextButton = navigationButton(1);
    const navigationLoading = document.createElement("div");
    navigationLoading.className = "photo-viewer-loading";
    navigationLoading.setAttribute("role", "status");
    navigationLoading.setAttribute("aria-label", "Loading image");
    navigationLoading.hidden = true;
    overlay.append(
      backdrop,
      scroll,
      previousButton,
      nextButton,
      closeButton,
      navigationLoading,
    );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        setNavigationVisible(view, true);
        const buttons = [previousButton, nextButton, closeButton].filter(
          (button) => !button.hidden && !button.disabled,
        );
        const index =
          document.activeElement instanceof HTMLButtonElement
            ? buttons.indexOf(document.activeElement)
            : -1;
        buttons[
          (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
        ]?.focus({ preventScroll: true });
      }
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setNavigationVisible(view, true);
        scheduleNavigationHide(view, PHOTO_NAV_AFTER_NAVIGATION_HIDE_MS);
        void navigatePhoto(view, event.key === "ArrowLeft" ? -1 : 1);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void closePhotoView();
      }
    };
    const onOverlayClick = (event: MouseEvent) => {
      if (view.closing) return;
      if (view.suppressClick) {
        view.suppressClick = false;
        return;
      }
      if (!(event.target instanceof Node)) return;
      if (
        view.closeButton.contains(event.target) ||
        view.previousButton.contains(event.target) ||
        view.nextButton.contains(event.target)
      ) {
        return;
      }
      if (pointInsideElement(view.frame, event.clientX, event.clientY)) {
        const reveal = view.overlay.classList.contains("is-navigation-hidden");
        setNavigationVisible(view, reveal);
        if (reveal) scheduleNavigationHide(view, PHOTO_NAV_INITIAL_HIDE_MS);
        return;
      }
      if (photoViewZoom() > 1.01) return;
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
      if (!view.swipeState) return;
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
    const activeSwipeTouch = (event: TouchEvent): Touch | null => {
      const state = view.swipeState;
      return state?.input === "touch"
        ? changedTouchById(event, state.pointerId)
        : null;
    };
    const onSwipeTouchMove = (event: TouchEvent) => {
      const touch = activeSwipeTouch(event);
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
      const touch = activeSwipeTouch(event);
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
    const onViewportChange = () => {
      const state = view.swipeState;
      if (photoViewZoom() > 1.01) {
        if (state) cancelPhotoSwipe(view, state.input, state.pointerId);
      }
      syncPhotoViewLayout(view);
    };

    const view: ActivePhotoView<T> = {
      photo,
      overlay,
      backdrop,
      closeButton,
      previousButton,
      nextButton,
      navigationImage: null,
      navigationLoading,
      navigationHideTimer: null,
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
      background: Array.from(document.body.children).flatMap((element) =>
        element instanceof HTMLElement
          ? [{ element, inert: element.inert }]
          : [],
      ),
      previousFocus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      suppressClick: false,
      swipeScrollTop: 0,
    };

    activePhotoView = view;
    updateNavigation(view);
    document.body.append(overlay);
    // The modal owns Escape before background document shortcuts see it.
    document.addEventListener("keydown", onKeyDown, true);
    overlay.addEventListener("click", onOverlayClick);
    // Native drag/selection must not steal the swipe before its threshold.
    // Leave touchstart and contextmenu alone for pinch zoom and Save/Copy.
    scroll.addEventListener("dragstart", (event) => event.preventDefault());
    scroll.addEventListener("selectstart", (event) => event.preventDefault());
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

    // Hiding the source before the async-decoded opening image is ready
    // leaves neither on screen for a few frames: a flash. A source without a
    // preview image (a bound <img>) opens from a different URL.
    await Promise.race([
      image.decode().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, OPENING_DECODE_WAIT_MS)),
    ]);
    await nextFrame();
    if (activePhotoView !== view || view.closing) return;
    hidePhotoSource(sourceElement);
    document.documentElement.classList.add("photo-view-open");
    syncPhotoViewScrollMode(view);
    const viewDuration = photoViewDurationMs();
    const targetRect = readRect(frame.getBoundingClientRect());
    const openingTransform = photoHeroTransform(sourceRect, targetRect);
    setPhotoHeroRadius(frame, sourceRadius);
    frame.style.transform = openingTransform;
    frame.style.transformOrigin = "top left";
    frame.style.willChange = "transform";
    image.classList.add("is-visible");
    overlay.classList.remove("is-preparing");
    scheduleNavigationHide(view, PHOTO_NAV_INITIAL_HIDE_MS);
    for (const entry of view.background) entry.element.inert = true;
    closeButton.focus({ preventScroll: true });
    const backdropOpacity = photoViewBackdropOpacity(view);

    if (reducedMotion()) {
      backdrop.style.opacity = backdropOpacity;
      setPhotoHeroRadius(frame, previewRadius);
      frame.style.transform = "";
      frame.style.transformOrigin = "";
      frame.style.willChange = "";
      void revealHighResolutionImage(view);
      return;
    }

    const frameAnimation = frame.animate(
      [
        {
          borderRadius: sourceRadius,
          clipPath: `inset(0 round ${sourceRadius})`,
          transform: openingTransform,
        },
        {
          borderRadius: previewRadius,
          clipPath: `inset(0 round ${previewRadius})`,
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
    if (activePhotoView !== view || view.closing || view.photo !== photo)
      return;
    backdrop.style.opacity = backdropOpacity;
    setPhotoHeroRadius(frame, previewRadius);
    frame.style.transform = "translate3d(0, 0, 0) scale(1)";
    frame.style.transformOrigin = "";
    frame.style.willChange = "";
    frameAnimation.cancel();
    backdropAnimation.cancel();
    view.openingAnimations = [];
    void revealHighResolutionImage(view);
  }

  async function closePhotoView(animate = true): Promise<void> {
    const view = activePhotoView;
    if (!view) return;
    if (view.closing) {
      if (!animate) cleanupPhotoView(view, view.sourceElement);
      return;
    }
    view.closing = true;
    view.navigationLoading.hidden = true;
    cancelNavigationHide(view);
    view.navigationImage?.removeAttribute("src");
    view.previousButton.hidden = view.nextButton.hidden = true;
    view.swipeState = null;
    cancelPhotoSwipeReset(view);

    const currentSource =
      (view.sourceElement?.isConnected &&
      view.sourceElement.dataset.photoId === String(view.photo.id)
        ? view.sourceElement
        : null) ?? findMountedPhotoElement(view.photo.id);
    hidePhotoSource(currentSource);

    // Use one coordinate space for the frame and its closing hero. In Safari,
    // zoomed client rectangles need not have the fixed-position origin.
    const overlayRect = view.overlay.getBoundingClientRect();
    const withinOverlay = (rect: PhotoRect): PhotoRect => ({
      ...rect,
      left: rect.left - overlayRect.left,
      top: rect.top - overlayRect.top,
    });
    const currentImage = currentPhotoViewImage(view);
    const currentRect = withinOverlay(
      readRect(view.frame.getBoundingClientRect()),
    );
    const hero = createPhotoHero(
      currentImage.currentSrc || currentImage.src,
      currentRect,
    );
    cancelPhotoViewOpeningAnimation(view);
    view.overlay.append(hero);
    view.frame.style.visibility = "hidden";
    view.image.classList.remove("is-visible");
    view.highResolutionImage.classList.remove("is-loaded");

    if (!animate || reducedMotion()) {
      cleanupPhotoView(view, currentSource);
      return;
    }

    const targetRect = withinOverlay(
      currentSource
        ? readRect(currentSource.getBoundingClientRect())
        : view.sourceRect,
    );
    const viewDuration = photoViewDurationMs();
    const heroBorderRadius = currentSource ? sourceRadius : previewRadius;
    const heroClipPath = `inset(0 round ${heroBorderRadius})`;
    setPhotoHeroRadius(hero, heroBorderRadius);

    const heroAnimation = currentSource
      ? (() => {
          const initialTransform = photoHeroTransform(currentRect, targetRect);
          stylePhotoRect(hero, targetRect);
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

    view.openingAnimations = [
      heroAnimation,
      backdropAnimation,
      scrollAnimation,
      closeButtonAnimation,
    ];
    await Promise.all([
      animationFinished(heroAnimation),
      animationFinished(backdropAnimation),
      animationFinished(scrollAnimation),
      animationFinished(closeButtonAnimation),
    ]);
    if (activePhotoView !== view || !view.overlay.isConnected) return;
    // Give the clipped thumbnail drawings a paint opportunity underneath the
    // settled hero before removing it. Firefox can otherwise flash at handoff.
    revealPhotoSource(currentSource);
    if (currentSource !== view.sourceElement)
      revealPhotoSource(view.sourceElement);
    await nextFrame();
    await nextFrame();
    if (activePhotoView !== view || !view.overlay.isConnected) return;
    cleanupPhotoView(view, currentSource);
  }

  function bind(card: HTMLElement, photo: T): void {
    if (disposed || bindings.has(card)) return;
    const events = new AbortController();
    bindings.set(card, {
      events,
      attributes: new Map(
        ["role", "tabindex", "aria-label", "data-photo-id", "draggable"].map(
          (name) => [name, card.getAttribute(name)],
        ),
      ),
      classes: new Map(
        [
          "photo-preview-card",
          "native-image-menu",
          "is-photo-pressed",
          "is-photo-view-source",
        ].map((name) => [name, card.classList.contains(name)]),
      ),
      hadClassAttribute: card.hasAttribute("class"),
    });
    let suppressClick = false;
    card.classList.add("photo-preview-card");
    card.classList.toggle("native-image-menu", nativeSourceMenu);
    if (!nativeSourceMenu && card instanceof HTMLImageElement)
      card.draggable = false;
    card.dataset.photoId = String(photo.id);
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `View photo ${photo.id}`);
    card.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.isPrimary || event.button !== 0 || activePhotoView) return;
        if (nativeSourceMenu && event.ctrlKey) return;
        suppressClick = false;
        // Let the browser distinguish a tap from its native image long-press.
        // Scaling under the finger competes with the iOS callout animation;
        // a confirmed tap's click still gets press feedback before opening.
        if (nativeSourceMenu && event.pointerType === "touch") {
          releasePhotoPress(card);
          return;
        }
        startPhotoPress(card, event);
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "pointermove",
      (event) => {
        const pressState = photoPressStates.get(card);
        if (!pressState || pressState.pointerId !== event.pointerId) return;
        if (pointerMovedPastTapTolerance(pressState, event)) {
          suppressClick = true;
          releasePhotoPress(card);
        }
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "pointerup",
      (event) => {
        const pressState = photoPressStates.get(card);
        if (!event.isPrimary || !pressState) return;
        if (isPhotoTapRelease(card, pressState, event)) {
          void openPhotoViewWithPressFeedback(photo, card);
        } else {
          suppressClick = true;
          releasePhotoPress(card);
        }
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "pointercancel",
      () => {
        suppressClick = true;
        releasePhotoPress(card);
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "contextmenu",
      (event) => {
        suppressClick = true;
        releasePhotoPress(card);
        if (nativeSourceMenu) {
          return;
        }
        event.preventDefault();
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "dragstart",
      (event) => {
        if (nativeSourceMenu) return;
        event.preventDefault();
        suppressClick = true;
        releasePhotoPress(card);
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "click",
      (event) => {
        if (event.button !== 0 || (nativeSourceMenu && event.ctrlKey)) return;
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (openingPhotoCards.has(card) || photoPressStates.has(card)) return;
        void openPhotoViewWithPressFeedback(photo, card);
      },
      { signal: events.signal },
    );
    card.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void openPhotoViewWithPressFeedback(photo, card);
      },
      { signal: events.signal },
    );
  }

  function unbind(card: HTMLElement): void {
    const binding = bindings.get(card);
    if (!binding) return;
    binding.events.abort();
    clearPhotoPressState(card);
    if (card.classList.contains("is-photo-view-source"))
      revealPhotoSource(card);
    for (const [name, value] of binding.attributes) {
      if (value === null) card.removeAttribute(name);
      else card.setAttribute(name, value);
    }
    for (const [name, present] of binding.classes)
      card.classList.toggle(name, present);
    if (!binding.hadClassAttribute && card.classList.length === 0)
      card.removeAttribute("class");
    bindings.delete(card);
  }

  return {
    bind,
    close: closePhotoView,
    unbind,
    dispose() {
      disposed = true;
      void closePhotoView(false);
      for (const card of bindings.keys()) unbind(card);
    },
  };
}
