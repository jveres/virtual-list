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
 * - **Firefox**: at an overscrolled edge, settle only from a scrollend after
 *   an extended last-input stability window — never from a bare timer.
 *   Firefox emits a scrollend whenever scrolling pauses, so
 *   one can land inside a momentum-wheel gap mid-hold; wheels arriving
 *   inside the stability window postpone the settle (trailing momentum markers
 *   after a real release delay it briefly, a continuing gesture pushes it
 *   to its own release scrollend). Applying while the engine gesture is
 *   alive is unfixable, verified empirically: besides the visible flash,
 *   Firefox's async scroll machinery keeps the pre-apply scroll-limit
 *   snapshot for the remainder of the gesture — the next scroll bounces
 *   against that "ghost end" — and no main-thread reset clears it (an
 *   overflow toggle with forced reflow and a real-value scrollTop nudge
 *   were both tried). The generic 280ms fallback never arms near an edge
 *   either, and a scrollend-less hold never applies at all: the loading
 *   slot keeps spinning and the next gesture's settle recovers it. A
 *   mid-hold scrollend followed by a motionless hold longer than the window
 *   remains indistinguishable from a release and will apply then.
 * - **Safari**: rubber-bands past the scroll range, and any scrollTop write
 *   during native motion kills the momentum animation. The contract is:
 *   never settle while rubber-banded or while any motion — even sub-pixel —
 *   continues; settle from the release scrollend or true quiet. Near an
 *   edge, settling additionally requires SAFARI_EDGE_SETTLE_QUIET_MS of
 *   scroll-event silence: the bounce tail decays through event gaps longer
 *   than the cooldown, and the settle's anchor-preserving writes (a bottom
 *   load trims the retained top, which writes scrollTop) snap the bounce if
 *   they land inside it.
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
// Firefox publishes range growth to APZ asynchronously after the main-thread
// commit. A rapid re-grab can otherwise join the pre-growth overscroll state
// and bounce at a ghost edge. There is no content-visible APZ acknowledgement,
// so keep a quiet window from the latest DOM wheel signal. This is a race
// buffer, not an engine transaction constant.
//
// V2 DEVIATION (two windows instead of main's one; lab-verified traces):
// a pending Firefox edge release is CONTESTED when wheel input arrives
// after its scrollend — that scrollend was a mid-momentum/mid-hold pause,
// not the release (main honored it on this single 1600ms timer, which
// committed under held fingers). An UNCONTESTED scrollend (no wheels after
// it) is a clean release signature and settles after the short
// confirmation window (~0.3s after the scrollend; main's 1600ms made
// every normal edge load wait ~1.5s). A contested one falls back to the
// full stability window from the last wheel: active motion keeps pushing
// it, a decaying momentum tail at a pinned edge (which emits no second
// scrollend) still recovers instead of hanging, and only ≥1600ms of TOTAL
// stillness — observably identical to a release, the platform's genuine
// ambiguity — can commit under resting fingers.
const FIREFOX_EDGE_RELEASE_CONFIRM_MS = 450;
const FIREFOX_EDGE_STABILITY_QUIET_MS = 1600;
// Post-scrollend wheels at or below this magnitude, and not growing past
// their predecessor, are trailing momentum-end markers (a release whose
// scrollend landed inside the decaying tail), not a continuing gesture —
// they postpone the short confirm window but do not contest the release.
// A momentum tail decays (…6,5,5,4,3,2,1); a continuing gesture adds
// energy (3 → 4 → 7 in the mid-hold lab trace). Growth beyond the small
// jitter allowance, or any large delta, contests.
const FIREFOX_TRAILING_MARKER_MAX_DELTA = 2;
// Safari settles near an edge only after this much scroll-event silence: the
// rubber-band bounce decays through event gaps longer than the settle
// cooldown, and a settle inside the tail performs anchor-preserving
// scrollTop writes (window trims, prepends) that snap the animation.
const SAFARI_EDGE_SETTLE_QUIET_MS = 350;
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
  /** Whether reaching this edge can enqueue boundary growth. */
  canLoadAtBoundary(boundary: ScrollBoundary): boolean;
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
  let pendingNativeScrollEndDelayMs = SCROLL_SETTLE_COOLDOWN_MS;
  let pendingFirefoxEdgeRelease = false;
  // Wheel input arrived after the pending edge scrollend: it was a pause,
  // not the release. Contested releases use the full stability window.
  let firefoxEdgeReleaseContested = false;
  let lastFirefoxWheelMagnitude = 0;
  let lastFirefoxWheelInputAt = Number.NEGATIVE_INFINITY;
  let firefoxProtectedEdge: ScrollBoundary | null = null;
  let settleFrame = 0;
  let firefoxEdgeCommitFrame = 0;
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
    if (host.isDisposed()) return;
    const previousScrollTop = lastScrollSampleTop;
    const nextScrollTop = viewport.scrollTop;
    const moved = Math.abs(nextScrollTop - previousScrollTop) > measureEpsilon;
    const programmaticScroll = consumeProgrammaticScrollWrite(nextScrollTop);
    if (strategy === "firefox-wheel" && moved && !programmaticScroll) {
      firefoxProtectedEdge ??= loadableBoundaryAtNativeEdge();
    }
    if (!userScrollActive && moved && !programmaticScroll) {
      if (!handleUserScrollStart()) return;
    }
    updateScrollVelocity(nextScrollTop);
    if (
      (strategy === "firefox-wheel" || strategy === "safari-wheel") &&
      nativeScrollEndPending &&
      wheelPendingNativeScrollEndTop !== null &&
      !programmaticScroll &&
      !isRubberBandOverscrolled() &&
      Math.abs(nextScrollTop - wheelPendingNativeScrollEndTop) >
        SETTLE_MOTION_EPSILON_PX
    ) {
      clearPendingNativeScrollEnd();
      cancelSettleTimer();
      cancelSettleFrame();
    }
    if (userScrollActive && moved) {
      userScrollMoved = true;
    }
    if (nativeScrollEndPending) {
      schedulePendingNativeScrollEnd();
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

  function cancelFirefoxEdgeCommitFrame(): boolean {
    if (!firefoxEdgeCommitFrame) return false;
    cancelAnimationFrame(firefoxEdgeCommitFrame);
    firefoxEdgeCommitFrame = 0;
    return true;
  }

  function cancelFirefoxEdgeCommitForInput(): void {
    if (!cancelFirefoxEdgeCommitFrame()) return;
    // Input after the entire stability window is a new gesture, not a trailing
    // momentum marker. Require this gesture's own scrollend before growth.
    cancelPendingUserScrollEnd();
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

  function loadableBoundaryAtNativeEdge(): ScrollBoundary | null {
    const scrollTop = viewport.scrollTop;
    if (
      host.canLoadAtBoundary("top") &&
      scrollTop <= EDGE_PROXIMITY_EPSILON_PX
    ) {
      return "top";
    }
    const maxScrollTop = nativeMaxScrollTop();
    if (
      host.canLoadAtBoundary("bottom") &&
      maxScrollTop > EDGE_PROXIMITY_EPSILON_PX &&
      maxScrollTop - scrollTop <= EDGE_PROXIMITY_EPSILON_PX
    ) {
      return "bottom";
    }
    return null;
  }

  function isNearProtectedFirefoxEdge(): boolean {
    return (
      firefoxProtectedEdge !== null || loadableBoundaryAtNativeEdge() !== null
    );
  }

  function canSettleUserScroll(): boolean {
    return (
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput() &&
      !hasActiveChromiumEdgeWheel() &&
      !chromiumWheelAwaitingFinalScrollEnd &&
      !isRubberBandOverscrolled() &&
      // Safari bounce tails deliver scroll events at gaps longer than the
      // settle cooldown; wait for genuine event silence near an edge so the
      // settle's scrollTop writes can't snap a live bounce. maybeFinish's
      // pending-check rAF loop re-tests this every frame, so the settle
      // lands right when the silence window closes.
      !(
        strategy === "safari-wheel" &&
        isNearScrollEdge() &&
        performance.now() - lastScrollSampleAt < SAFARI_EDGE_SETTLE_QUIET_MS
      )
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
      !(strategy === "firefox-wheel" && isNearProtectedFirefoxEdge())
    );
  }

  function cancelUserScrollTimers(): void {
    cancelSettleTimer();
    cancelSettleFrame();
    cancelFirefoxEdgeCommitFrame();
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
    firefoxProtectedEdge = null;
  }

  function cancelPendingUserScrollEnd(): void {
    clearPendingNativeScrollEnd();
    chromiumWheelSawNativeScrollEnd = false;
    cancelSettleTimer();
    cancelSettleFrame();
  }

  function resetUserScrollState(): void {
    clearPendingNativeScrollEnd();
    userScrollActive = false;
    userScrollMoved = false;
    resetScrollVelocity();
    if (host.isDisposed()) return;
    host.onGestureReset();
  }

  function finishUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
    if (host.isDisposed()) return;
    host.onGestureSettled();
  }

  function cancelUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
  }

  function maybeFinishUserScroll(): void {
    if (host.isDisposed() || !userScrollActive || !nativeScrollEndPending) {
      return;
    }
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
    if (hasPendingFirefoxEdgeRelease()) {
      scheduleFirefoxEdgeCommit();
      return;
    }
    finishUserScroll();
  }

  // Commit Firefox edge growth atomically in a render opportunity after the
  // stability window. This keeps the list geometry and its render in one
  // main-thread pass; it is not an acknowledgement from Firefox's APZ thread.
  function scheduleFirefoxEdgeCommit(): void {
    if (firefoxEdgeCommitFrame || host.isDisposed()) return;
    firefoxEdgeCommitFrame = requestAnimationFrame(() => {
      firefoxEdgeCommitFrame = 0;
      if (
        host.isDisposed() ||
        !hasPendingFirefoxEdgeRelease() ||
        !canSettleUserScroll()
      ) {
        return;
      }
      finishUserScroll();
    });
  }

  function schedulePendingSettleCheck(): void {
    if (settleFrame || host.isDisposed()) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      if (host.isDisposed()) return;
      maybeFinishUserScroll();
    });
  }

  function scheduleSettleCooldown(delayMs = SCROLL_SETTLE_COOLDOWN_MS): void {
    cancelSettleTimer();
    if (host.isDisposed()) return;
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (host.isDisposed()) return;
      maybeFinishUserScroll();
    }, delayMs);
  }

  function setPendingNativeScrollEnd(
    options: {
      delayMs?: number;
      scrollTop?: number | null;
      firefoxEdge?: boolean;
    } = {},
  ): void {
    cancelFirefoxEdgeCommitFrame();
    nativeScrollEndPending = true;
    pendingNativeScrollEndDelayMs =
      options.delayMs ?? SCROLL_SETTLE_COOLDOWN_MS;
    wheelPendingNativeScrollEndTop = options.scrollTop ?? null;
    pendingFirefoxEdgeRelease = options.firefoxEdge === true;
    firefoxEdgeReleaseContested = false;
  }

  function clearPendingNativeScrollEnd(): void {
    cancelFirefoxEdgeCommitFrame();
    nativeScrollEndPending = false;
    pendingNativeScrollEndDelayMs = SCROLL_SETTLE_COOLDOWN_MS;
    wheelPendingNativeScrollEndTop = null;
    pendingFirefoxEdgeRelease = false;
    firefoxEdgeReleaseContested = false;
  }

  // Preserve the policy chosen when the native scrollend was observed. In
  // particular, pinned scroll events and neutral wheel jitter must not turn a
  // Firefox edge stability wait into the generic short cooldown.
  function schedulePendingNativeScrollEnd(): void {
    if (host.isDisposed() || !nativeScrollEndPending) return;
    const firefoxEdgeWindowMs = firefoxEdgeReleaseContested
      ? FIREFOX_EDGE_STABILITY_QUIET_MS
      : FIREFOX_EDGE_RELEASE_CONFIRM_MS;
    const delayMs = hasPendingFirefoxEdgeRelease()
      ? Math.max(
          0,
          firefoxEdgeWindowMs - (performance.now() - lastFirefoxWheelInputAt),
        )
      : pendingNativeScrollEndDelayMs;
    scheduleSettleCooldown(
      Number.isFinite(delayMs) ? delayMs : FIREFOX_EDGE_STABILITY_QUIET_MS,
    );
  }

  function hasPendingFirefoxEdgeRelease(): boolean {
    return (
      strategy === "firefox-wheel" &&
      nativeScrollEndPending &&
      pendingFirefoxEdgeRelease
    );
  }

  function hydratePlaceholdersAfterNativeScrollEnd(): void {
    if (!nativeScrollEndPending) return;
    // Placeholder hydration swaps mounted DOM just like a layout flush. Keep
    // it behind the same Firefox stability wait instead of hydrating when
    // neutral wheel jitter merely goes idle.
    if (hasPendingFirefoxEdgeRelease()) return;
    if (!canSettleUserScroll()) return;
    host.onNativeScrollEndIdle();
  }

  function markPendingWheelScrollEnd(): void {
    setPendingNativeScrollEnd({
      scrollTop: Math.max(
        0,
        Math.min(nativeMaxScrollTop(), viewport.scrollTop),
      ),
    });
    hydratePlaceholdersAfterNativeScrollEnd();
    schedulePendingNativeScrollEnd();
  }

  function scheduleWheelScrollEndFallback(): void {
    if (host.isDisposed() || !canScheduleWheelScrollEndFallback()) return;
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (host.isDisposed() || !canScheduleWheelScrollEndFallback()) return;
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
      setPendingNativeScrollEnd();
      schedulePendingNativeScrollEnd();
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
      setPendingNativeScrollEnd();
      schedulePendingNativeScrollEnd();
    }, EDGE_SETTLE_QUIET_MS);
  }

  function handleScrollEnd(): void {
    if (host.isDisposed()) return;
    const smoothScrollReachedTarget = host.smoothScrollReachedTarget();
    if (host.isDisposed() || !smoothScrollReachedTarget) return;

    if (strategy === "firefox-wheel" || strategy === "safari-wheel") {
      if (!userScrollActive) return;
      if (!userScrollMoved) {
        cancelUserScroll();
        return;
      }
      if (
        strategy === "firefox-wheel" &&
        (hasPendingFirefoxEdgeRelease() || isNearProtectedFirefoxEdge())
      ) {
        // This may be the release — or a scrollend that slipped into a
        // momentum-wheel gap mid-hold. Honor it only after the stability
        // window. Preserve an already-classified edge release even if spinner
        // chrome has since grown the native scroll range.
        setPendingNativeScrollEnd({
          scrollTop: Math.max(
            0,
            Math.min(nativeMaxScrollTop(), viewport.scrollTop),
          ),
          firefoxEdge: true,
        });
        schedulePendingNativeScrollEnd();
        return;
      }
      markPendingWheelScrollEnd();
      return;
    }

    setPendingNativeScrollEnd();
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
    schedulePendingNativeScrollEnd();
  }

  // `isProgrammatic` is set only by the library's own smooth-scroll driver
  // (scrollToNativeTop). A genuine user scroll (everything else) interrupts any
  // in-flight programmatic smooth scroll so the user can actually scroll away,
  // instead of the library re-issuing the animation and pulling them back.
  function handleUserScrollStart(isProgrammatic = false): boolean {
    if (host.isDisposed()) return false;
    if (!isProgrammatic) {
      host.cancelActiveSmoothScroll();
      if (host.isDisposed()) return false;
    }
    host.onGestureActivity();
    if (host.isDisposed()) return false;
    const wasActive = userScrollActive;
    userScrollActive = true;
    if (!wasActive) {
      clearPendingNativeScrollEnd();
      userScrollMoved = false;
      resetScrollVelocity();
      chromiumWheelSawNativeScrollEnd = false;
      chromiumWheelAwaitingFinalScrollEnd = false;
      chromiumEdgeWheelSuppressed = false;
      cancelChromiumEdgeSettleTimer();
      host.onGestureStarted();
      if (host.isDisposed()) return false;
    } else if (strategy !== "firefox-wheel" && strategy !== "safari-wheel") {
      cancelPendingUserScrollEnd();
    }
    return true;
  }

  function handleChromiumWheelInput(event: WheelEvent): void {
    if (strategy !== "chromium-wheel") return;
    const outwardBoundary = boundaryForOutwardWheel(event);
    chromiumWheelAwaitingFinalScrollEnd = false;
    cancelChromiumEdgeSettleTimer();
    if (outwardBoundary) {
      chromiumEdgeWheelSuppressed = true;
      clearPendingNativeScrollEnd();
      chromiumWheelAwaitingFinalScrollEnd = true;
    } else if (nativeScrollEndPending) {
      clearPendingNativeScrollEnd();
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
      if (host.isDisposed()) return;
      wheelInputActive = false;
      if (outwardBoundary) {
        chromiumEdgeWheelIdle = true;
        chromiumWheelAwaitingFinalScrollEnd = true;
        clearPendingNativeScrollEnd();
        scheduleChromiumEdgeSettleFallback(outwardBoundary);
      } else if (chromiumWheelSawNativeScrollEnd) {
        setPendingNativeScrollEnd();
        chromiumWheelAwaitingFinalScrollEnd = false;
        chromiumEdgeWheelSuppressed = false;
      } else {
        scheduleChromiumStallFallback();
      }
      hydratePlaceholdersAfterNativeScrollEnd();
      schedulePendingNativeScrollEnd();
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
      if (host.isDisposed()) return;
      wheelInputActive = false;
      if (strategy === "firefox-wheel" && outwardBoundary !== null) {
        // Firefox contract at an overscrolled edge (see the module header):
        // skipping placeholder hydration here is deliberate in both branches
        // — it swaps DOM and flashes just like a layout apply would.
        if (nativeScrollEndPending) {
          // A scrollend already fired and wheels followed it — either
          // trailing momentum-end markers after a real release, or the
          // gesture continuing past a momentum-gap scrollend. Re-arm the
          // full stability window; only sustained wheel silence settles.
          schedulePendingNativeScrollEnd();
          return;
        }
        // No scrollend yet: fingers may still be down, and Firefox defers
        // scrollend until the gesture truly ends — wait for it, with no
        // timer backstop (see the module header: timer applies mid-hold are
        // unfixable, they flash and leave a ghost end). A missed scrollend
        // recovers at the next gesture's settle.
        return;
      }
      hydratePlaceholdersAfterNativeScrollEnd();
      if (nativeScrollEndPending) {
        schedulePendingNativeScrollEnd();
        return;
      }
      scheduleWheelScrollEndFallback();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleWheel(event: WheelEvent): void {
    if (host.isDisposed()) return;
    if (strategy === "firefox-wheel" || strategy === "safari-wheel") {
      if (strategy === "firefox-wheel") {
        lastFirefoxWheelInputAt = performance.now();
      }
      const outwardBoundary = boundaryForOutwardWheel(event);
      if (
        strategy === "firefox-wheel" &&
        outwardBoundary !== null &&
        host.canLoadAtBoundary(outwardBoundary)
      ) {
        firefoxProtectedEdge ??= outwardBoundary;
      }
      if (event.deltaY !== 0) cancelFirefoxEdgeCommitForInput();
      // V2 DEVIATION (see the window constants): wheel input after an edge
      // scrollend that ADDS ENERGY proves the gesture continued past it —
      // that scrollend was a mid-momentum/mid-hold pause, not the release.
      // Mark the pending release CONTESTED: it may only settle after the
      // full stability window of wheel silence, never the short
      // release-confirm window. Decaying trailing markers (small, not
      // growing) are a release whose scrollend landed inside the momentum
      // tail; they merely postpone the confirm window. (Dropping contested
      // releases entirely was tried and hangs: a decaying tail at a pinned
      // edge emits no second scrollend.)
      if (event.deltaY !== 0) {
        const magnitude = Math.abs(event.deltaY);
        if (
          hasPendingFirefoxEdgeRelease() &&
          magnitude >
            Math.max(
              FIREFOX_TRAILING_MARKER_MAX_DELTA,
              lastFirefoxWheelMagnitude + 1,
            )
        ) {
          firefoxEdgeReleaseContested = true;
        }
        lastFirefoxWheelMagnitude = magnitude;
      }
      if (!handleUserScrollStart()) return;
      if (outwardBoundary) userScrollMoved = true;
      handleWheelInputSettle(
        strategy === "firefox-wheel" ? firefoxProtectedEdge : outwardBoundary,
      );
      return;
    }

    if (!handleUserScrollStart()) return;
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
    cancelFirefoxEdgeCommitForInput();
    handleUserScrollStart();
  }

  function handleTouchScrollMove(): void {
    cancelFirefoxEdgeCommitForInput();
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
    cancelFirefoxEdgeCommitForInput();
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

    setPendingNativeScrollEnd();
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
      if (host.isDisposed()) return;
      setPendingNativeScrollEnd();
      schedulePendingNativeScrollEnd();
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
