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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
    photo: T,
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

  function cancelPhotoViewOpeningAnimation(
    view: ActivePhotoView<T>,
    removeHero = true,
  ): void {
    for (const animation of view.openingAnimations) {
      animation.cancel();
    }
    view.openingAnimations = [];
    if (removeHero) view.openingHero?.remove();
    view.openingHero = null;
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

  function canStartPhotoSwipe(view: ActivePhotoView<T>): boolean {
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

  function clearPhotoSwipeVisualState(view: ActivePhotoView<T>): void {
    view.scroll.classList.remove("is-swiping");
    view.scroll.scrollTop = 0;
    view.stage.style.transform = "";
    view.stage.style.willChange = "";
    view.backdrop.style.opacity = photoViewBackdropOpacity(view);
  }

  async function resetPhotoSwipe(view: ActivePhotoView<T>): Promise<void> {
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

  function startPhotoSwipe(
    view: ActivePhotoView<T>,
    event: PointerEvent,
  ): void {
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

  function updatePhotoSwipe(
    view: ActivePhotoView<T>,
    event: PointerEvent,
  ): void {
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
      if (
        absDeltaY < PHOTO_SWIPE_START_PX ||
        absDeltaY < Math.abs(deltaX) * 1.2
      )
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

  function endPhotoSwipe(view: ActivePhotoView<T>, event: PointerEvent): void {
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

  function cancelPhotoSwipe(
    view: ActivePhotoView<T>,
    event: PointerEvent,
  ): void {
    const state = view.swipeState;
    if (!state || state.pointerId !== event.pointerId) return;
    view.swipeState = null;
    if (state.dragging) void resetPhotoSwipe(view);
    else view.scroll.classList.remove("is-swiping");
  }

  async function revealHighResolutionImage(
    view: ActivePhotoView<T>,
  ): Promise<void> {
    await view.highResolutionImage.decode?.().catch(() => undefined);
    if (activePhotoView !== view || view.closing) return;
    view.highResolutionImage.classList.add("is-loaded");
    if (view.highResolutionImage.naturalWidth > 0) {
      view.details.textContent = `${photoDetailsText(view.photo)} · source ${view.highResolutionImage.naturalWidth}×${view.highResolutionImage.naturalHeight}`;
      syncPhotoViewScrollMode(view);
    }
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
    const onSwipePointerUp = (event: PointerEvent) =>
      endPhotoSwipe(view, event);
    const onSwipePointerCancel = (event: PointerEvent) =>
      cancelPhotoSwipe(view, event);
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
