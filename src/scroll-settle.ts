/**
 * The scroll-settle state machine: per-engine heuristics for classifying
 * scrolls as user gestures vs. the library's own programmatic writes, and for
 * deciding when a user gesture has finished — the moment deferred layout
 * updates and measurements may flush and `onScrollEnd` may fire.
 *
 * Engines disagree on when (and whether) `scrollend` fires relative to wheel
 * momentum, so each strategy encodes one engine's observed sequencing:
 * chromium's wheel-idle window and boundary-scrollend suppression, firefox's
 * early scrollend during a glide, safari's similar wheel behavior, and a
 * plain scrollend+cooldown default. The controller owns the viewport's
 * scroll/scrollend/wheel/pointer/touch listeners and all gesture state; the
 * virtualizer supplies everything else through {@link ScrollSettleHost}.
 *
 * ## The per-engine gesture contract at overscrolled edges
 *
 * Deferred list updates (boundary loads, prepends/appends) must apply only
 * when the gesture settles, and each engine bounds what "settled" can mean:
 *
 * - **Chromium**: touchpad release is NOT detectable during overscroll — the
 *   engine emits one scrollend per scroll sequence (often early, at the edge)
 *   and momentum wheel events are indistinguishable from fingers-down input.
 *   The accepted contract is settling after a quiet delay
 *   (EDGE_SETTLE_QUIET_MS + the cooldown); applying a list update
 *   mid-overscroll after that delay is fine because Chromium repaints the
 *   anchored content without a visible flash.
 * - **Firefox**: applying a list update during an active overscroll visibly
 *   flashes the content — even when the fingers are motionless — and the
 *   remainder of the gesture routes to the overscroll effect, making the
 *   applied content unreachable until release. Firefox implements scrollend
 *   spec-faithfully: it is deferred until the gesture truly ends (fingers
 *   off, momentum spent), which makes the scrollend the authoritative
 *   release signal. The contract: at an outward edge, never settle from a
 *   short timer — the generic 280ms fallback never arms near an edge, and a
 *   pending settle set by the release scrollend survives the trailing
 *   momentum-end wheels that follow it (settling one cooldown after they go
 *   idle). A long last-resort (FIREFOX_EDGE_LAST_RESORT_MS) guards against
 *   a missing scrollend stranding a deferred load; it is expected to lose
 *   the race to the release scrollend in practice. Structurally this makes
 *   firefox the chromium strategy with a much longer quiet window plus a
 *   fast path on the (reliable) release scrollend — if Firefox's overscroll
 *   rendering ever stops flashing on content growth, the two strategies can
 *   collapse into one by dropping the scrollend fast path and shortening
 *   the window to EDGE_SETTLE_QUIET_MS.
 * - **Safari**: rubber-bands past the scroll range, and any scrollTop write
 *   during native motion kills the momentum animation. The contract is:
 *   never settle while rubber-banded or while any motion — even sub-pixel —
 *   continues; settle from the release scrollend or true quiet.
 *
 * Two tolerances make this robust: EDGE_PROXIMITY_EPSILON_PX accepts the
 * fractional gap (up to ~1px, more under zoom) engines leave between a pinned
 * scroll position and the exact limit, and SETTLE_MOTION_EPSILON_PX cancels a
 * pending settle on any real movement so decaying momentum can't be settled
 * into.
 */

const SCROLL_SETTLE_COOLDOWN_MS = 140;
const WHEEL_INPUT_IDLE_MS = SCROLL_SETTLE_COOLDOWN_MS;
// Quiet window for settling a chromium gesture whose release is not directly
// observable: no wheel activity for this long at an edge means the fingers
// are gone (or motionless, which is indistinguishable). Long enough to
// outlast the gaps in a decaying momentum-wheel tail.
const EDGE_SETTLE_QUIET_MS = 450;
// Firefox last resort: Firefox defers scrollend until the gesture truly ends
// (fingers off, momentum spent), so the release scrollend is expected to
// settle every edge gesture. Any timer-driven apply during a held overscroll
// visibly flashes, so this stays long — it exists only so a missing
// scrollend can't strand a deferred load behind a spinner forever.
const FIREFOX_EDGE_LAST_RESORT_MS = 2000;
// Engines pin an overscrolled position up to ~1px (more under zoom/DPI
// scaling) shy of the exact scroll limit, so edge proximity must be judged
// looser than the 0.5px measurement epsilon — a fractional miss here sends a
// held-at-the-edge gesture down the wrong settle path (see the contract
// above; this was the root of mid-overscroll flashes and wedged loads).
const EDGE_PROXIMITY_EPSILON_PX = 2;
// Any real movement at or above this cancels a pending wheel settle; decaying
// momentum moves in sub-0.5px steps that must still count as motion, or the
// settle (and its scrollTop write) lands mid-animation and kills it.
const SETTLE_MOTION_EPSILON_PX = 0.05;

// Upper bound on unmatched programmatic scroll targets kept for user-vs-self
// scroll classification. One follow frame writes at most twice, and a scroll
// event matches within a frame or two, so this only guards against runaway.
const MAX_PENDING_PROGRAMMATIC_SCROLLS = 8;

export type VirtualListScrollSettleStrategy =
  | "default"
  | "chromium-wheel"
  | "firefox-wheel"
  | "safari-wheel";

type ScrollBoundary = "top" | "bottom";

export function detectScrollSettleStrategy(
  userAgent = navigator.userAgent,
): VirtualListScrollSettleStrategy {
  if (/\bFirefox\//.test(userAgent)) return "firefox-wheel";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) {
    return "safari-wheel";
  }
  return /\b(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
    ? "chromium-wheel"
    : "default";
}

/** What the settle controller needs from the virtualizer that owns it. */
export interface ScrollSettleHost {
  viewport: HTMLElement;
  strategy: VirtualListScrollSettleStrategy;
  measureEpsilon: number;
  isDisposed(): boolean;
  /** Cancel an in-flight programmatic smooth scroll — a real user gesture began. */
  cancelActiveSmoothScroll(): void;
  /** False only while a programmatic smooth scroll is still short of its target. */
  smoothScrollReachedTarget(): boolean;
  /** Any gesture signal: stop auto-follow and drop the sub-pixel scroll residual. */
  onGestureActivity(): void;
  /** The gesture transitioned idle → active: arm boundaries, fire onScrollStart. */
  onGestureStarted(): void;
  /** The gesture fully settled: flush deferred work, re-render, fire onScrollEnd. */
  onGestureSettled(): void;
  /** Gesture state was reset (settle or cancel): clear placeholder fast mode. */
  onGestureReset(): void;
  /** A scroll event landed: schedule a render pass. */
  onScrollEventObserved(): void;
  /** A native scroll end arrived and the gesture is quiet: placeholders may hydrate. */
  onNativeScrollEndIdle(): void;
}

export interface ScrollSettleController {
  isUserScrollActive(): boolean;
  /** Instantaneous scroll speed (px/ms), damped by the time since the last sample. */
  currentVelocity(): number;
  /** Absolute scrollTop delta of the most recent scroll sample. */
  lastSampleDelta(): number;
  resetVelocity(scrollTop?: number): void;
  /** Pre-record a programmatic scrollTop write so its event isn't misread as a user scroll. */
  recordProgrammaticScrollTop(target: number): void;
  /** Enter the gesture state machine for a library-driven scroll (no smooth-scroll cancel). */
  beginProgrammaticGesture(): void;
  /** Mark the native scroll as ended and start the settle cooldown. */
  markSettlePending(): void;
  /** Settle the gesture now: reset state, then flush/render/notify via the host. */
  finishGesture(): void;
  /** Abandon the gesture: reset state without the settle side effects. */
  cancelGesture(): void;
  dispose(): void;
}

export function createScrollSettleController(
  host: ScrollSettleHost,
): ScrollSettleController {
  const { viewport, strategy, measureEpsilon } = host;

  let userScrollActive = false;
  let userScrollMoved = false;
  let scrollVelocity = 0;
  let lastScrollSampleDelta = 0;
  let lastScrollSampleTop = viewport.scrollTop;
  let lastScrollSampleAt = performance.now();
  // Targets written by programmatic scrolls (follow, scrollToIndex, measurement
  // corrections) that haven't been matched to a scroll event yet. A single frame
  // can write more than once (e.g. a measurement correction plus a follow chase)
  // and the browser may emit a scroll event per write, so we match an incoming
  // scroll against ANY pending target instead of a single, easily-clobbered slot.
  // Without this a follow-scroll's own event can look like a user scroll and tear
  // down auto-follow mid-stream.
  const programmaticScrollTops: number[] = [];
  let nativeScrollEndPending = false;
  let wheelPendingNativeScrollEndTop: number | null = null;
  let settleFrame = 0;
  let settleTimer = 0;
  let wheelInputActive = false;
  let wheelInputTimer = 0;
  let chromiumEdgeWheelActive: ScrollBoundary | null = null;
  let chromiumEdgeWheelIdle = false;
  let chromiumWheelSawNativeScrollEnd = false;
  let chromiumWheelAwaitingFinalScrollEnd = false;
  let chromiumEdgeWheelSuppressed = false;
  let chromiumEdgeSettleTimer = 0;
  const activePointers = new Set<number>();
  let touchInputActive = false;

  function nativeMaxScrollTop(): number {
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function resetScrollVelocity(scrollTop = viewport.scrollTop): void {
    scrollVelocity = 0;
    lastScrollSampleDelta = 0;
    lastScrollSampleTop = scrollTop;
    lastScrollSampleAt = performance.now();
  }

  function updateScrollVelocity(scrollTop = viewport.scrollTop): void {
    const now = performance.now();
    const elapsed = now - lastScrollSampleAt;
    lastScrollSampleDelta = Math.abs(scrollTop - lastScrollSampleTop);
    if (elapsed > 0) {
      scrollVelocity = lastScrollSampleDelta / elapsed;
    }
    lastScrollSampleTop = scrollTop;
    lastScrollSampleAt = now;
  }

  function currentScrollVelocity(): number {
    if (lastScrollSampleDelta <= 0) return scrollVelocity;
    const elapsed = performance.now() - lastScrollSampleAt;
    if (elapsed <= 0) return scrollVelocity;
    return Math.min(scrollVelocity, lastScrollSampleDelta / elapsed);
  }

  function recordProgrammaticScrollTop(target: number): void {
    programmaticScrollTops.push(target);
    // Bound the buffer; pending writes are matched within a frame or two, so a
    // few entries is plenty. Drop the oldest if it somehow accumulates.
    if (programmaticScrollTops.length > MAX_PENDING_PROGRAMMATIC_SCROLLS) {
      programmaticScrollTops.shift();
    }
  }

  function consumeProgrammaticScrollWrite(scrollTop: number): boolean {
    if (programmaticScrollTops.length === 0) return false;
    const tolerance = Math.max(1, measureEpsilon);
    const matchIndex = programmaticScrollTops.findIndex(
      (target) => Math.abs(scrollTop - target) <= tolerance,
    );
    if (matchIndex === -1) {
      // The scroll landed on no pending programmatic target — a real user scroll
      // took over. Drop the stale targets so they can't shadow later events.
      programmaticScrollTops.length = 0;
      return false;
    }
    // Discard this target and any older ones it superseded (the scroll has caught
    // up to here); keep newer writes for their own events.
    programmaticScrollTops.splice(0, matchIndex + 1);
    return true;
  }

  function handleScroll(): void {
    const previousScrollTop = lastScrollSampleTop;
    const nextScrollTop = viewport.scrollTop;
    const moved = Math.abs(nextScrollTop - previousScrollTop) > measureEpsilon;
    const programmaticScroll = consumeProgrammaticScrollWrite(nextScrollTop);
    if (!userScrollActive && moved && !programmaticScroll) {
      handleUserScrollStart();
    }
    updateScrollVelocity(nextScrollTop);
    if (
      (strategy === "firefox-wheel" || strategy === "safari-wheel") &&
      nativeScrollEndPending &&
      wheelPendingNativeScrollEndTop !== null &&
      !isRubberBandOverscrolled() &&
      Math.abs(nextScrollTop - wheelPendingNativeScrollEndTop) >
        SETTLE_MOTION_EPSILON_PX
    ) {
      nativeScrollEndPending = false;
      wheelPendingNativeScrollEndTop = null;
      cancelSettleTimer();
      cancelSettleFrame();
    }
    if (userScrollActive && moved) {
      userScrollMoved = true;
    }
    if (nativeScrollEndPending) {
      scheduleSettleCooldown();
    } else {
      scheduleWheelScrollEndFallback();
    }
    host.onScrollEventObserved();
  }

  function hasActiveTouchOrPointerInput(): boolean {
    return touchInputActive || activePointers.size > 0;
  }

  function isRubberBandOverscrolled(): boolean {
    const scrollTop = viewport.scrollTop;
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop < -measureEpsilon || scrollTop - maxScrollTop > measureEpsilon
    );
  }

  function cancelSettleFrame(): void {
    if (!settleFrame) return;
    cancelAnimationFrame(settleFrame);
    settleFrame = 0;
  }

  function cancelSettleTimer(): void {
    if (!settleTimer) return;
    window.clearTimeout(settleTimer);
    settleTimer = 0;
  }

  function cancelWheelInputTimer(): void {
    if (!wheelInputTimer) return;
    window.clearTimeout(wheelInputTimer);
    wheelInputTimer = 0;
  }

  function cancelChromiumEdgeSettleTimer(): void {
    if (!chromiumEdgeSettleTimer) return;
    window.clearTimeout(chromiumEdgeSettleTimer);
    chromiumEdgeSettleTimer = 0;
  }

  function usesWheelInputSettle(): boolean {
    return (
      strategy === "chromium-wheel" ||
      strategy === "firefox-wheel" ||
      strategy === "safari-wheel"
    );
  }

  function usesWheelScrollEndFallback(): boolean {
    return strategy === "firefox-wheel" || strategy === "safari-wheel";
  }

  function hasActiveWheelInput(): boolean {
    return usesWheelInputSettle() && wheelInputActive;
  }

  function hasActiveChromiumEdgeWheel(): boolean {
    return strategy === "chromium-wheel" && chromiumEdgeWheelActive !== null;
  }

  function boundaryForOutwardWheel(event: WheelEvent): ScrollBoundary | null {
    const scrollTop = viewport.scrollTop;
    if (event.deltaY < 0 && scrollTop <= EDGE_PROXIMITY_EPSILON_PX) {
      return "top";
    }
    if (event.deltaY <= 0) return null;

    const maxScrollTop = nativeMaxScrollTop();
    if (
      maxScrollTop > EDGE_PROXIMITY_EPSILON_PX &&
      maxScrollTop - scrollTop <= EDGE_PROXIMITY_EPSILON_PX
    ) {
      return "bottom";
    }
    return null;
  }

  function isNearScrollEdge(): boolean {
    const scrollTop = viewport.scrollTop;
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop <= EDGE_PROXIMITY_EPSILON_PX ||
      maxScrollTop - scrollTop <= EDGE_PROXIMITY_EPSILON_PX
    );
  }

  function canSettleUserScroll(): boolean {
    return (
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput() &&
      !hasActiveChromiumEdgeWheel() &&
      !chromiumWheelAwaitingFinalScrollEnd &&
      !isRubberBandOverscrolled()
    );
  }

  function canScheduleWheelScrollEndFallback(): boolean {
    return (
      usesWheelScrollEndFallback() &&
      userScrollActive &&
      userScrollMoved &&
      !nativeScrollEndPending &&
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput() &&
      // Firefox contract: at an edge, only the release scrollend may settle
      // the gesture. A timer-driven settle here applies deferred loads under
      // held fingers, which visibly flashes — and the rest of the gesture
      // routes to the overscroll effect, so the user can't even scroll into
      // the newly applied content until release.
      !(strategy === "firefox-wheel" && isNearScrollEdge())
    );
  }

  function cancelUserScrollTimers(): void {
    cancelSettleTimer();
    cancelSettleFrame();
    cancelWheelInputTimer();
    cancelChromiumEdgeSettleTimer();
  }

  function resetScrollSettleState(): void {
    wheelInputActive = false;
    chromiumEdgeWheelActive = null;
    chromiumEdgeWheelIdle = false;
    chromiumWheelSawNativeScrollEnd = false;
    chromiumWheelAwaitingFinalScrollEnd = false;
    chromiumEdgeWheelSuppressed = false;
  }

  function cancelPendingUserScrollEnd(): void {
    nativeScrollEndPending = false;
    wheelPendingNativeScrollEndTop = null;
    chromiumWheelSawNativeScrollEnd = false;
    cancelSettleTimer();
    cancelSettleFrame();
  }

  function resetUserScrollState(): void {
    nativeScrollEndPending = false;
    wheelPendingNativeScrollEndTop = null;
    userScrollActive = false;
    userScrollMoved = false;
    resetScrollVelocity();
    host.onGestureReset();
  }

  function finishUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
    host.onGestureSettled();
  }

  function cancelUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
  }

  function maybeFinishUserScroll(): void {
    if (!userScrollActive || !nativeScrollEndPending) return;
    if (!canSettleUserScroll()) {
      if (
        ((strategy === "firefox-wheel" || strategy === "safari-wheel") &&
          wheelInputActive) ||
        hasActiveChromiumEdgeWheel() ||
        (strategy === "chromium-wheel" &&
          (chromiumWheelAwaitingFinalScrollEnd || chromiumEdgeWheelSuppressed))
      ) {
        return;
      }
      schedulePendingSettleCheck();
      return;
    }
    finishUserScroll();
  }

  function schedulePendingSettleCheck(): void {
    if (settleFrame || host.isDisposed()) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      maybeFinishUserScroll();
    });
  }

  function scheduleSettleCooldown(): void {
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      maybeFinishUserScroll();
    }, SCROLL_SETTLE_COOLDOWN_MS);
  }

  function hydratePlaceholdersAfterNativeScrollEnd(): void {
    if (!nativeScrollEndPending) return;
    if (!canSettleUserScroll()) return;
    host.onNativeScrollEndIdle();
  }

  function markPendingWheelScrollEnd(): void {
    nativeScrollEndPending = true;
    wheelPendingNativeScrollEndTop = Math.max(
      0,
      Math.min(nativeMaxScrollTop(), viewport.scrollTop),
    );
    hydratePlaceholdersAfterNativeScrollEnd();
    scheduleSettleCooldown();
  }

  function scheduleWheelScrollEndFallback(): void {
    if (!canScheduleWheelScrollEndFallback()) return;
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (!canScheduleWheelScrollEndFallback()) return;
      markPendingWheelScrollEnd();
    }, SCROLL_SETTLE_COOLDOWN_MS);
  }

  // Close the wheel-idle dead-end: when the last wheel of a gesture is judged
  // neither outward (no edge fallback) nor preceded by an unconsumed scrollend
  // (no cooldown), nothing else would ever settle the gesture — chromium fires
  // only one scrollend per scroll sequence, and a trailing wheel consumed it.
  // Without this, the gesture stays active forever and deferred boundary loads
  // sit unapplied until the user scrolls again ("stuck" loads). Settling after
  // the same quiet delay as the edge fallback matches the accepted chromium
  // contract (see the module header).
  // Firefox at an outward edge with no scrollend yet: the release scrollend
  // is expected to settle the gesture (see the module header). This long
  // last-resort exists only so a missing scrollend can't strand a deferred
  // load behind a spinner forever; each wheel-idle restarts it.
  function scheduleFirefoxEdgeSettleFallback(): void {
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (
        host.isDisposed() ||
        !userScrollActive ||
        wheelInputActive ||
        nativeScrollEndPending ||
        isRubberBandOverscrolled()
      ) {
        return;
      }
      nativeScrollEndPending = true;
      wheelPendingNativeScrollEndTop = Math.max(
        0,
        Math.min(nativeMaxScrollTop(), viewport.scrollTop),
      );
      maybeFinishUserScroll();
    }, FIREFOX_EDGE_LAST_RESORT_MS);
  }

  function scheduleChromiumStallFallback(): void {
    cancelChromiumEdgeSettleTimer();
    chromiumEdgeSettleTimer = window.setTimeout(() => {
      chromiumEdgeSettleTimer = 0;
      if (
        host.isDisposed() ||
        !userScrollActive ||
        wheelInputActive ||
        nativeScrollEndPending ||
        isRubberBandOverscrolled()
      ) {
        return;
      }
      nativeScrollEndPending = true;
      scheduleSettleCooldown();
    }, EDGE_SETTLE_QUIET_MS);
  }

  function scheduleChromiumEdgeSettleFallback(boundary: ScrollBoundary): void {
    cancelChromiumEdgeSettleTimer();
    chromiumEdgeSettleTimer = window.setTimeout(() => {
      chromiumEdgeSettleTimer = 0;
      if (
        host.isDisposed() ||
        !userScrollActive ||
        wheelInputActive ||
        !chromiumEdgeWheelSuppressed ||
        chromiumEdgeWheelActive !== boundary ||
        isRubberBandOverscrolled()
      ) {
        return;
      }
      chromiumWheelAwaitingFinalScrollEnd = false;
      chromiumEdgeWheelSuppressed = false;
      chromiumEdgeWheelActive = null;
      chromiumEdgeWheelIdle = false;
      nativeScrollEndPending = true;
      scheduleSettleCooldown();
    }, EDGE_SETTLE_QUIET_MS);
  }

  function handleScrollEnd(): void {
    if (!host.smoothScrollReachedTarget()) return;

    if (strategy === "firefox-wheel" || strategy === "safari-wheel") {
      if (!userScrollActive) return;
      if (!userScrollMoved) {
        cancelUserScroll();
        return;
      }
      markPendingWheelScrollEnd();
      return;
    }

    nativeScrollEndPending = true;
    if (strategy === "chromium-wheel" && userScrollActive) {
      chromiumWheelSawNativeScrollEnd = true;
      if (!wheelInputActive && chromiumWheelAwaitingFinalScrollEnd) {
        chromiumWheelAwaitingFinalScrollEnd = false;
        chromiumEdgeWheelActive = null;
        chromiumEdgeWheelIdle = false;
      }
    }
    if (
      strategy === "chromium-wheel" &&
      chromiumEdgeWheelActive &&
      chromiumEdgeWheelIdle
    ) {
      chromiumEdgeWheelActive = null;
      chromiumEdgeWheelIdle = false;
    }
    hydratePlaceholdersAfterNativeScrollEnd();
    scheduleSettleCooldown();
  }

  // `isProgrammatic` is set only by the library's own smooth-scroll driver
  // (scrollToNativeTop). A genuine user scroll (everything else) interrupts any
  // in-flight programmatic smooth scroll so the user can actually scroll away,
  // instead of the library re-issuing the animation and pulling them back.
  function handleUserScrollStart(isProgrammatic = false): void {
    if (!isProgrammatic) {
      host.cancelActiveSmoothScroll();
    }
    host.onGestureActivity();
    const wasActive = userScrollActive;
    userScrollActive = true;
    if (!wasActive) {
      nativeScrollEndPending = false;
      wheelPendingNativeScrollEndTop = null;
      userScrollMoved = false;
      resetScrollVelocity();
      chromiumWheelSawNativeScrollEnd = false;
      chromiumWheelAwaitingFinalScrollEnd = false;
      chromiumEdgeWheelSuppressed = false;
      cancelChromiumEdgeSettleTimer();
      host.onGestureStarted();
    } else if (strategy !== "firefox-wheel" && strategy !== "safari-wheel") {
      cancelPendingUserScrollEnd();
    }
  }

  function handleChromiumWheelInput(event: WheelEvent): void {
    if (strategy !== "chromium-wheel") return;
    const outwardBoundary = boundaryForOutwardWheel(event);
    chromiumWheelAwaitingFinalScrollEnd = false;
    cancelChromiumEdgeSettleTimer();
    if (outwardBoundary) {
      chromiumEdgeWheelSuppressed = true;
      nativeScrollEndPending = false;
      chromiumWheelAwaitingFinalScrollEnd = true;
    } else if (nativeScrollEndPending) {
      nativeScrollEndPending = false;
    }
    if (!outwardBoundary) {
      chromiumEdgeWheelActive = null;
      chromiumEdgeWheelIdle = false;
    } else {
      chromiumEdgeWheelActive = outwardBoundary;
      chromiumEdgeWheelIdle = false;
    }
    wheelInputActive = true;
    cancelWheelInputTimer();
    wheelInputTimer = window.setTimeout(() => {
      wheelInputTimer = 0;
      wheelInputActive = false;
      if (outwardBoundary) {
        chromiumEdgeWheelIdle = true;
        chromiumWheelAwaitingFinalScrollEnd = true;
        nativeScrollEndPending = false;
        scheduleChromiumEdgeSettleFallback(outwardBoundary);
      } else if (chromiumWheelSawNativeScrollEnd) {
        nativeScrollEndPending = true;
        chromiumWheelAwaitingFinalScrollEnd = false;
        chromiumEdgeWheelSuppressed = false;
      } else {
        scheduleChromiumStallFallback();
      }
      hydratePlaceholdersAfterNativeScrollEnd();
      if (nativeScrollEndPending) scheduleSettleCooldown();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleWheelInputSettle(
    outwardBoundary: ScrollBoundary | null = null,
  ): void {
    if (strategy !== "firefox-wheel" && strategy !== "safari-wheel") {
      return;
    }
    wheelInputActive = true;
    cancelWheelInputTimer();
    wheelInputTimer = window.setTimeout(() => {
      wheelInputTimer = 0;
      wheelInputActive = false;
      if (strategy === "firefox-wheel" && outwardBoundary !== null) {
        // Firefox contract at an overscrolled edge (see the module header):
        // skipping placeholder hydration here is deliberate in both branches
        // — it swaps DOM and flashes just like a layout apply would.
        if (nativeScrollEndPending) {
          // The release scrollend already fired; these were the trailing
          // momentum-end wheels that follow it. The gesture is over.
          scheduleSettleCooldown();
          return;
        }
        // No scrollend yet: fingers may still be down, and Firefox defers
        // scrollend until the gesture truly ends — wait for it. Arm only the
        // long last-resort so a missing scrollend can't strand the load.
        scheduleFirefoxEdgeSettleFallback();
        return;
      }
      hydratePlaceholdersAfterNativeScrollEnd();
      if (nativeScrollEndPending) {
        scheduleSettleCooldown();
        return;
      }
      scheduleWheelScrollEndFallback();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleWheel(event: WheelEvent): void {
    if (strategy === "firefox-wheel" || strategy === "safari-wheel") {
      const outwardBoundary = boundaryForOutwardWheel(event);
      handleUserScrollStart();
      if (outwardBoundary) userScrollMoved = true;
      handleWheelInputSettle(outwardBoundary);
      return;
    }

    handleUserScrollStart();
    handleChromiumWheelInput(event);
  }

  function handleUserScrollMaybeEnd(): void {
    if (hasActiveTouchOrPointerInput()) return;
    maybeFinishUserScroll();
    if (
      userScrollActive &&
      !userScrollMoved &&
      !nativeScrollEndPending &&
      !isRubberBandOverscrolled()
    ) {
      finishUserScroll();
    }
  }

  function handleTouchScrollStart(): void {
    touchInputActive = true;
    handleUserScrollStart();
  }

  function handleTouchScrollMove(): void {
    handleUserScrollStart();
  }

  function handleTouchScrollEnd(event: TouchEvent): void {
    if (event.touches.length === 0) touchInputActive = false;
    handleUserScrollMaybeEnd();
  }

  function isLikelyScrollbarPointer(event: PointerEvent): boolean {
    if (event.pointerType !== "mouse") return false;

    const scrollbarGutterWidth = Math.max(
      0,
      viewport.offsetWidth - viewport.clientWidth,
    );
    if (scrollbarGutterWidth <= 0) return event.target === viewport;

    // The client area spans [left + clientLeft, + clientWidth) of the border
    // box; anything outside it horizontally is scrollbar gutter (or border).
    // Bounding at the client edges — rather than offsetting the combined gutter
    // width from each border-box edge — keeps borders and the opposite edge's
    // gutter from widening the zones into the content.
    const rect = viewport.getBoundingClientRect();
    const clientLeftEdge = rect.left + viewport.clientLeft;
    const clientRightEdge = clientLeftEdge + viewport.clientWidth;
    return event.clientX < clientLeftEdge || event.clientX >= clientRightEdge;
  }

  function handlePointerScrollStart(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    if (event.pointerType === "mouse" && !isLikelyScrollbarPointer(event)) {
      return;
    }
    activePointers.add(event.pointerId);
    handleUserScrollStart();
  }

  function settlePointerScrollWithoutNativeScrollEnd(): void {
    if (
      activePointers.size > 0 ||
      !userScrollActive ||
      !userScrollMoved ||
      nativeScrollEndPending ||
      isRubberBandOverscrolled()
    ) {
      return;
    }

    nativeScrollEndPending = true;
    wheelPendingNativeScrollEndTop = null;
  }

  function handlePointerScrollEnd(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    if (event.pointerType === "mouse" && !activePointers.has(event.pointerId)) {
      return;
    }
    activePointers.delete(event.pointerId);
    settlePointerScrollWithoutNativeScrollEnd();
    handleUserScrollMaybeEnd();
  }

  viewport.addEventListener("scroll", handleScroll, { passive: true });
  viewport.addEventListener("scrollend", handleScrollEnd, { passive: true });
  viewport.addEventListener("wheel", handleWheel, { passive: true });
  const supportsPointerEvents = "PointerEvent" in window;
  const supportsTouchEvents = "TouchEvent" in window;
  if (supportsPointerEvents) {
    viewport.addEventListener("pointerdown", handlePointerScrollStart, {
      passive: true,
    });
    window.addEventListener("pointerup", handlePointerScrollEnd, {
      passive: true,
    });
    window.addEventListener("pointercancel", handlePointerScrollEnd, {
      passive: true,
    });
  }
  if (supportsTouchEvents) {
    viewport.addEventListener("touchstart", handleTouchScrollStart, {
      passive: true,
    });
    viewport.addEventListener("touchmove", handleTouchScrollMove, {
      passive: true,
    });
    viewport.addEventListener("touchend", handleTouchScrollEnd, {
      passive: true,
    });
    viewport.addEventListener("touchcancel", handleTouchScrollEnd, {
      passive: true,
    });
  }

  return {
    isUserScrollActive: () => userScrollActive,
    currentVelocity: currentScrollVelocity,
    lastSampleDelta: () => lastScrollSampleDelta,
    resetVelocity: resetScrollVelocity,
    recordProgrammaticScrollTop,
    beginProgrammaticGesture: () => handleUserScrollStart(true),
    markSettlePending: () => {
      nativeScrollEndPending = true;
      scheduleSettleCooldown();
    },
    finishGesture: finishUserScroll,
    cancelGesture: cancelUserScroll,
    dispose: () => {
      cancelUserScrollTimers();
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("scrollend", handleScrollEnd);
      viewport.removeEventListener("wheel", handleWheel);
      if (supportsPointerEvents) {
        viewport.removeEventListener("pointerdown", handlePointerScrollStart);
        window.removeEventListener("pointerup", handlePointerScrollEnd);
        window.removeEventListener("pointercancel", handlePointerScrollEnd);
      }
      if (supportsTouchEvents) {
        viewport.removeEventListener("touchstart", handleTouchScrollStart);
        viewport.removeEventListener("touchmove", handleTouchScrollMove);
        viewport.removeEventListener("touchend", handleTouchScrollEnd);
        viewport.removeEventListener("touchcancel", handleTouchScrollEnd);
      }
    },
  };
}
