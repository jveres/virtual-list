import {
  ChromiumWheelPolicy,
  FirefoxWheelPolicy,
  type ScrollBoundary,
} from "./wheel-policy";

/**
 * The scroll-settle state machine: per-engine heuristics for classifying
 * scrolls as user gestures vs. the library's own programmatic writes, and for
 * deciding when a user gesture has finished — the moment held structural
 * work may commit (`onGestureSettled`).
 *
 * Engines disagree on when (and whether) `scrollend` fires relative to wheel
 * momentum, so each strategy encodes one engine's observed sequencing:
 * chromium's wheel-idle window and boundary-scrollend suppression, firefox's
 * candidate edge release, safari's rubber-band quiet windows, and a
 * plain scrollend+cooldown "default" (explicit opt-in only; an unknown
 * engine falls to the Firefox contract). The controller owns the viewport's
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
 *   (CHROMIUM_QUIET_SETTLE_MS + the cooldown); applying a list update
 *   mid-overscroll after that delay is fine because Chromium repaints the
 *   anchored content without a visible flash.
 * - **Firefox**: a scrollend at a protected edge is a *candidate*
 *   release. Post-scrollend wheel input classifies it: energy growth past
 *   the predecessor, a direction reversal, or any line/page-delta notch
 *   invalidates it (the scrollend was a mid-momentum/mid-hold pause), while
 *   a decaying pixel-mode tail is trailing momentum markers that merely
 *   postpone. Uncontested candidates settle after the short confirmation
 *   window; invalidated ones require a subsequent scrollend, never just
 *   wheel silence. Applying while the engine gesture is alive is unfixable,
 *   verified empirically: besides the visible flash, Firefox's async
 *   scroll machinery keeps the pre-apply scroll-limit snapshot for the
 *   remainder of the gesture — the next scroll bounces against that
 *   "ghost end" — and no main-thread reset clears it (an overflow toggle
 *   with forced reflow and a real-value scrollTop nudge were both tried).
 *   The generic fallback never arms near a protected edge, and a
 *   scrollend-less hold never applies at all: the loading slot keeps
 *   spinning and the next gesture's settle recovers it. A hold that
 *   pauses into an UNCONTESTED scrollend and stays still is observably
 *   identical to a release and will apply after the short window — the
 *   documented latency-versus-certainty trade-off.
 *   Before any wheel/touch/scrollbar input, scroll-only startup movement
 *   can instead be browser history restoration (Firefox sends no scrollend
 *   for it). That initial movement may settle through the quiet fallback;
 *   the first real input cancels that fallback and restores edge protection.
 * - **Safari**: rubber-bands past the scroll range, and any scrollTop write
 *   during native motion kills the momentum animation. The contract is:
 *   never settle while rubber-banded or while any motion — even sub-pixel —
 *   continues; settle from the release scrollend or true quiet. Near an
 *   edge, settling additionally requires SAFARI_EDGE_SETTLE_QUIET_MS of
 *   scroll-event silence: the bounce tail decays through event gaps longer
 *   than the cooldown, and the settle commit's anchor-preserving scrollTop
 *   write (a prepend) snaps the bounce if it lands inside it.
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
const CHROMIUM_QUIET_SETTLE_MS = 450;
// Safari settles near an edge only after this much scroll-event silence: the
// rubber-band bounce decays through event gaps longer than the settle
// cooldown, and a settle commit inside the tail performs the
// anchor-preserving scrollTop write (a prepend) that snaps the animation.
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
// scroll classification. A commit writes once and a glide once per frame,
// and a scroll event matches within a frame or two, so this only guards
// against runaway.
const MAX_PENDING_PROGRAMMATIC_SCROLLS = 8;

export type VirtualListScrollSettleStrategy =
  | "default"
  | "chromium-wheel"
  | "firefox-wheel"
  | "safari-wheel";

/**
 * Engine detection, by rendering engine rather than by browser brand:
 * - Gecko (`Firefox/`; FxiOS is WebKit and carries no such token);
 * - Chromium in every skin, headless included (`HeadlessChrome/`, `Edg/`,
 *   `OPR/`; on iOS these brands run WebKit and use `CriOS/`, `EdgiOS/`);
 * - everything else built on WebKit — Safari itself, and the in-app
 *   browsers and WKWebViews whose user agent has no `Version/… Safari/`
 *   token but rubber-bands exactly like Safari.
 * An engine nobody has characterised gets the Firefox contract: it settles
 * from wheel silence when no scrollend comes and never applies from a
 * timer at a protected edge — the conservative choice. `"default"` (plain
 * scrollend + cooldown) remains available explicitly for a host that knows
 * its engine's scrollend is reliable.
 */
export function detectScrollSettleStrategy(
  userAgent = navigator.userAgent,
): VirtualListScrollSettleStrategy {
  if (/\bFirefox\//.test(userAgent)) return "firefox-wheel";
  if (/\b(?:HeadlessChrome|Chrome|Chromium|Edg|OPR)\//.test(userAgent)) {
    return "chromium-wheel";
  }
  if (/\bAppleWebKit\//.test(userAgent)) return "safari-wheel";
  return "firefox-wheel";
}

/** What the settle controller needs from the virtualizer that owns it. */
interface ScrollSettleHost {
  viewport: HTMLElement;
  strategy: VirtualListScrollSettleStrategy;
  measureEpsilon: number;
  isDisposed(): boolean;
  /** Whether reaching this edge can enqueue boundary growth. */
  canLoadAtBoundary(boundary: ScrollBoundary): boolean;
  /** Cancel an in-flight programmatic smooth scroll — a real user gesture began. */
  cancelActiveSmoothScroll(): void;
  /** False while a programmatic smooth scroll is in flight (a cancelled one counts as gone). */
  noSmoothScrollInFlight(): boolean;
  /** The gesture transitioned idle → active: a scroll phase began. */
  onGestureStarted?(): void;
  /** The gesture fully settled: held work may commit — the one structural moment. */
  onGestureSettled(): void;
  /** Gesture state was reset (settle or cancel). */
  onGestureReset?(): void;
  /** A scroll event landed: reconcile the window; work that needs no scroll write may land. */
  onScrollEventObserved(): void;
}

export interface ScrollSettleController {
  isScrollPhaseActive(): boolean;
  /** At a scroll edge (within the edge tolerance), or past it in a bounce. */
  isNearScrollEdge(): boolean;
  /** Pre-record a programmatic scrollTop write so its event isn't misread as a user scroll. */
  recordProgrammaticScrollTop(target: number): void;
  /** Enter the gesture state machine for a library-driven scroll (no smooth-scroll cancel). */
  beginProgrammaticGesture(): void;
  /** A landed programmatic glide ends its phase: start the settle cooldown. */
  markSettlePending(): void;
  /** Settle the gesture now: reset state, then commit/notify via the host. */
  finishGesture(): void;
  dispose(): void;
}

export function createScrollSettleController(
  host: ScrollSettleHost,
): ScrollSettleController {
  const { viewport, strategy, measureEpsilon } = host;

  let scrollPhaseActive = false;
  let scrollPhaseMoved = false;
  // Lifetime flag, not phase state: after the first input, never mistake
  // a later silent hold or momentum tail for startup scroll restoration.
  let awaitingInitialInput = true;
  let lastScrollSampleTop = viewport.scrollTop;
  let lastScrollSampleAt = performance.now();
  let lastScrollSampleHeight = viewport.clientHeight;
  // Targets written by programmatic scrolls (commands, glide frames, the
  // settle commit's anchor write) that haven't been matched to a scroll
  // event yet. A single frame can write more than once and the browser may
  // emit a scroll event per write, so we match an incoming scroll against
  // ANY pending target instead of a single, easily-clobbered slot. Without
  // this a runtime write's own event can look like a user scroll.
  const programmaticScrollTops: number[] = [];
  let nativeScrollEndPending = false;
  let wheelPendingNativeScrollEndTop: number | null = null;
  const firefox =
    strategy === "firefox-wheel" ? new FirefoxWheelPolicy() : null;
  const chromium =
    strategy === "chromium-wheel" ? new ChromiumWheelPolicy() : null;
  let settleFrame = 0;
  let settleTimer = 0;
  let wheelInputActive = false;
  let wheelInputTimer = 0;
  let chromiumQuietSettleTimer = 0;
  const activePointers = new Set<number>();
  let touchInputActive = false;
  let scrollEventsSinceTouchStart = 0;

  function nativeMaxScrollTop(): number {
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function resetScrollSample(scrollTop = viewport.scrollTop): void {
    lastScrollSampleTop = scrollTop;
    lastScrollSampleAt = performance.now();
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
    scrollEventsSinceTouchStart += 1;
    const previousScrollTop = lastScrollSampleTop;
    const nextScrollTop = viewport.scrollTop;
    const moved = Math.abs(nextScrollTop - previousScrollTop) > measureEpsilon;
    const programmaticScroll = consumeProgrammaticScrollWrite(nextScrollTop);
    // A viewport that grew (a window resize, an in-page composer) shrinks
    // the scroll range, and the engine clamps the position to the new
    // maximum, dispatching that scroll before or after the resize is
    // observed. Layout moved the viewport, not the user: the height is
    // sampled here, at scroll events only, so either order reads the same.
    const clientHeight = viewport.clientHeight;
    const layoutClamp =
      Math.abs(clientHeight - lastScrollSampleHeight) > measureEpsilon &&
      Math.abs(nextScrollTop - nativeMaxScrollTop()) <=
        Math.max(1, measureEpsilon);
    lastScrollSampleHeight = clientHeight;
    const input = moved && !programmaticScroll && !layoutClamp;
    if (strategy === "firefox-wheel" && input) {
      firefox?.protect(loadableBoundaryAtNativeEdge());
    }
    if (!scrollPhaseActive && input) {
      if (!handleScrollPhaseStart()) return;
    }
    resetScrollSample(nextScrollTop);
    if (
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
    if (scrollPhaseActive && moved) {
      scrollPhaseMoved = true;
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
    return firefox?.cancelCommit() ?? false;
  }

  /** Touch and scrollbar input is deliberate; it is never a wheel tail. */
  function cancelPendingReleaseForDirectInput(): void {
    cancelFirefoxEdgeCommitFrame();
    cancelPendingScrollPhaseEnd();
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

  function cancelChromiumQuietSettleTimer(): void {
    if (!chromiumQuietSettleTimer) return;
    window.clearTimeout(chromiumQuietSettleTimer);
    chromiumQuietSettleTimer = 0;
  }

  function usesWheelScrollEndFallback(): boolean {
    return strategy === "firefox-wheel" || strategy === "safari-wheel";
  }

  /** Only the wheel strategies ever set it ("default" receives wheel events but never marks input active). */
  function hasActiveWheelInput(): boolean {
    return wheelInputActive;
  }

  function hasActiveChromiumEdgeWheel(): boolean {
    return chromium?.edge != null;
  }

  /**
   * The native edge the viewport sits within the proximity epsilon of, if
   * any; the top is checked first, so a non-scrollable viewport reads as
   * the top.
   */
  function boundaryAtNativeEdge(): ScrollBoundary | null {
    const scrollTop = viewport.scrollTop;
    if (scrollTop <= EDGE_PROXIMITY_EPSILON_PX) return "top";
    if (nativeMaxScrollTop() - scrollTop <= EDGE_PROXIMITY_EPSILON_PX) {
      return "bottom";
    }
    return null;
  }

  /** The edge a wheel tick pushes outward against, if the viewport is on it. */
  function boundaryForOutwardWheel(event: WheelEvent): ScrollBoundary | null {
    const edge = boundaryAtNativeEdge();
    if (edge === "top" && event.deltaY < 0) return "top";
    if (edge === "bottom" && event.deltaY > 0) return "bottom";
    return null;
  }

  function isNearScrollEdge(): boolean {
    return boundaryAtNativeEdge() !== null;
  }

  function loadableBoundaryAtNativeEdge(): ScrollBoundary | null {
    const edge = boundaryAtNativeEdge();
    return edge !== null && host.canLoadAtBoundary(edge) ? edge : null;
  }

  function hasProtectedFirefoxEdge(): boolean {
    return (
      firefox?.protectedEdge != null || loadableBoundaryAtNativeEdge() !== null
    );
  }

  function canSettleScrollPhase(): boolean {
    return (
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput() &&
      !hasActiveChromiumEdgeWheel() &&
      !chromium?.awaitingEnd &&
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
      host.noSmoothScrollInFlight() &&
      scrollPhaseActive &&
      scrollPhaseMoved &&
      !nativeScrollEndPending &&
      !hasActiveTouchOrPointerInput() &&
      !hasActiveWheelInput() &&
      // Firefox contract: at an edge, only the release scrollend may settle
      // the gesture. A timer-driven settle here applies deferred loads under
      // held fingers, which visibly flashes — and the rest of the gesture
      // routes to the overscroll effect, so the user can't even scroll into
      // the newly applied content until release.
      !(
        strategy === "firefox-wheel" &&
        !awaitingInitialInput &&
        hasProtectedFirefoxEdge()
      )
    );
  }

  function cancelScrollPhaseTimers(): void {
    cancelSettleTimer();
    cancelSettleFrame();
    cancelFirefoxEdgeCommitFrame();
    cancelWheelInputTimer();
    cancelChromiumQuietSettleTimer();
  }

  function resetScrollSettleState(): void {
    wheelInputActive = false;
    chromium?.reset();
    firefox?.resetProtection();
  }

  function cancelPendingScrollPhaseEnd(): void {
    clearPendingNativeScrollEnd();
    chromium?.cancelPendingEnd();
    cancelSettleTimer();
    cancelSettleFrame();
  }

  function resetScrollPhaseState(): void {
    clearPendingNativeScrollEnd();
    scrollPhaseActive = false;
    scrollPhaseMoved = false;
    resetScrollSample();
    if (host.isDisposed()) return;
    host.onGestureReset?.();
  }

  function finishScrollPhase(): void {
    cancelScrollPhase();
    if (host.isDisposed()) return;
    host.onGestureSettled();
  }

  function cancelScrollPhase(): void {
    cancelScrollPhaseTimers();
    resetScrollSettleState();
    resetScrollPhaseState();
  }

  function maybeFinishScrollPhase(): void {
    if (host.isDisposed() || !scrollPhaseActive || !nativeScrollEndPending) {
      return;
    }
    if (!canSettleScrollPhase()) {
      if (
        (usesWheelScrollEndFallback() && hasActiveWheelInput()) ||
        hasActiveChromiumEdgeWheel() ||
        chromium?.awaitingEnd ||
        chromium?.suppressed
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
    finishScrollPhase();
  }

  // Commit Firefox edge growth atomically in a render opportunity after the
  // confirmation window. This keeps the list geometry and its render in one
  // main-thread pass; it is not an acknowledgement from Firefox's APZ thread.
  function scheduleFirefoxEdgeCommit(): void {
    if (host.isDisposed()) return;
    firefox?.scheduleCommit(() => {
      if (
        host.isDisposed() ||
        !hasPendingFirefoxEdgeRelease() ||
        !canSettleScrollPhase()
      ) {
        return;
      }
      finishScrollPhase();
    });
  }

  function schedulePendingSettleCheck(): void {
    if (settleFrame || host.isDisposed()) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      if (host.isDisposed()) return;
      maybeFinishScrollPhase();
    });
  }

  function scheduleSettleCooldown(delayMs = SCROLL_SETTLE_COOLDOWN_MS): void {
    cancelSettleTimer();
    if (host.isDisposed()) return;
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (host.isDisposed()) return;
      maybeFinishScrollPhase();
    }, delayMs);
  }

  function setPendingNativeScrollEnd(
    options: { scrollTop?: number | null; firefoxEdge?: boolean } = {},
  ): void {
    cancelFirefoxEdgeCommitFrame();
    nativeScrollEndPending = true;
    wheelPendingNativeScrollEndTop = options.scrollTop ?? null;
    firefox?.setRelease(options.firefoxEdge === true);
  }

  function clearPendingNativeScrollEnd(): void {
    cancelFirefoxEdgeCommitFrame();
    nativeScrollEndPending = false;
    wheelPendingNativeScrollEndTop = null;
    firefox?.setRelease(false);
  }

  // Preserve the policy chosen when the native scrollend was observed. In
  // particular, pinned scroll events and neutral wheel jitter must not turn a
  // Firefox edge confirmation wait into the generic short cooldown.
  function schedulePendingNativeScrollEnd(): void {
    if (host.isDisposed() || !nativeScrollEndPending) return;
    const delayMs =
      hasPendingFirefoxEdgeRelease() && firefox
        ? firefox.releaseDelay(performance.now())
        : SCROLL_SETTLE_COOLDOWN_MS;
    scheduleSettleCooldown(delayMs);
  }

  function hasPendingFirefoxEdgeRelease(): boolean {
    return nativeScrollEndPending && firefox?.hasRelease === true;
  }

  /** A release with no recorded position: settle after the cooldown. */
  function armPendingNativeScrollEnd(): void {
    setPendingNativeScrollEnd();
    schedulePendingNativeScrollEnd();
  }

  function markPendingWheelScrollEnd(firefoxEdge = false): void {
    setPendingNativeScrollEnd({
      scrollTop: Math.max(
        0,
        Math.min(nativeMaxScrollTop(), viewport.scrollTop),
      ),
      firefoxEdge,
    });
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

  /**
   * After the Chromium quiet delay, arm the release — if the phase is still
   * open, the viewport is in range, and `still` says the situation this
   * timer was armed for still holds (a scrollend that arrived meanwhile
   * settles on its own cooldown; re-arming would only postpone it). Wheel
   * input cancels this timer outright, so it never fires under a live wheel.
   */
  function scheduleChromiumQuietSettle(
    still: () => boolean,
    beforeArming?: () => void,
  ): void {
    cancelChromiumQuietSettleTimer();
    chromiumQuietSettleTimer = window.setTimeout(() => {
      chromiumQuietSettleTimer = 0;
      if (
        host.isDisposed() ||
        !scrollPhaseActive ||
        isRubberBandOverscrolled() ||
        !still()
      ) {
        return;
      }
      beforeArming?.();
      armPendingNativeScrollEnd();
    }, CHROMIUM_QUIET_SETTLE_MS);
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
    scheduleChromiumQuietSettle(() => !nativeScrollEndPending);
  }

  function scheduleChromiumEdgeSettleFallback(boundary: ScrollBoundary): void {
    scheduleChromiumQuietSettle(
      () => chromium?.suppressed === true && chromium.edge === boundary,
      () => chromium?.releaseEdge(),
    );
  }

  function handleScrollEnd(): void {
    if (host.isDisposed() || !host.noSmoothScrollInFlight()) return;

    if (usesWheelScrollEndFallback()) {
      if (!scrollPhaseActive) return;
      if (!scrollPhaseMoved) {
        // A scrollend from a programmatic write (a command's takeover, the
        // settle commit's anchor write) can arrive right after the wheel
        // tick that started a fresh gesture — before that tick's own
        // scroll event. Cancelling here opened an idle gap under live
        // wheel input, and a commit landed in it. While wheel input is
        // live the gesture stays; the wheel-idle timer cancels a gesture
        // that never moved.
        if (hasActiveWheelInput()) return;
        // A replacement can clamp onto a glide's destination before its
        // first frame. Its trailing scrollend then has no movement, but
        // the host still has a command waiting for completion. Silently
        // cancelling here stranded that promise until another user input.
        // Keep the normal cooldown and input guards, and notify on settle.
        armPendingNativeScrollEnd();
        return;
      }
      if (
        firefox?.inputThisPhase &&
        (hasPendingFirefoxEdgeRelease() || hasProtectedFirefoxEdge())
      ) {
        // This may be the release — or a scrollend that slipped into a
        // momentum-wheel gap mid-hold. Honor it only after the confirmation
        // window, unless renewed input invalidates it. Preserve an
        // already-classified edge release even if spinner chrome has since
        // grown the native scroll range.
        markPendingWheelScrollEnd(true);
        return;
      }
      markPendingWheelScrollEnd();
      return;
    }

    setPendingNativeScrollEnd();
    if (strategy === "chromium-wheel" && scrollPhaseActive) {
      chromium?.scrollEnd(hasActiveWheelInput());
    }
    schedulePendingNativeScrollEnd();
  }

  // `isProgrammatic` is set only by the runtime's own glide
  // (beginProgrammaticGesture). A genuine user scroll (everything else) interrupts any
  // in-flight programmatic smooth scroll so the user can actually scroll away,
  // instead of the library re-issuing the animation and pulling them back.
  function handleScrollPhaseStart(isProgrammatic = false): boolean {
    if (host.isDisposed()) return false;
    if (!isProgrammatic) {
      host.cancelActiveSmoothScroll();
      if (host.isDisposed()) return false;
    }
    const wasActive = scrollPhaseActive;
    scrollPhaseActive = true;
    if (!wasActive) {
      clearPendingNativeScrollEnd();
      scrollPhaseMoved = false;
      firefox?.beginPhase();
      resetScrollSample();
      chromium?.beginPhase();
      cancelChromiumQuietSettleTimer();
      host.onGestureStarted?.();
      if (host.isDisposed()) return false;
    } else if (
      strategy !== "firefox-wheel" ||
      !hasPendingFirefoxEdgeRelease()
    ) {
      // Fresh input invalidates an earlier release. Safari can deliver the
      // reversing wheel/touch input before its first scroll event; keeping
      // the old scrollend would let it settle in that gap. Firefox retains
      // only an edge release, classified by the wheel policy below. A
      // command's pending landing is never the new wheel gesture's release.
      cancelPendingScrollPhaseEnd();
    }
    return true;
  }

  /** Wheel input is live until it has been quiet for the idle window. */
  function armWheelIdle(onIdle: () => void): void {
    wheelInputActive = true;
    cancelWheelInputTimer();
    // Dispose cancels this timer synchronously; it never fires disposed.
    wheelInputTimer = window.setTimeout(() => {
      wheelInputTimer = 0;
      wheelInputActive = false;
      onIdle();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleChromiumWheelInput(event: WheelEvent): void {
    if (!chromium) return;
    const outwardBoundary = boundaryForOutwardWheel(event);
    cancelChromiumQuietSettleTimer();
    chromium.wheel(outwardBoundary);
    if (outwardBoundary || nativeScrollEndPending)
      clearPendingNativeScrollEnd();
    armWheelIdle(() => {
      const action = chromium.idle(outwardBoundary);
      if (action === "edge" && outwardBoundary) {
        clearPendingNativeScrollEnd();
        scheduleChromiumEdgeSettleFallback(outwardBoundary);
      } else if (action === "release") {
        setPendingNativeScrollEnd();
      } else {
        scheduleChromiumStallFallback();
      }
      schedulePendingNativeScrollEnd();
    });
  }

  /** `protectedEdge` is Firefox's protected edge; always null elsewhere. */
  function handleWheelInputSettle(
    protectedEdge: ScrollBoundary | null = null,
  ): void {
    armWheelIdle(() => {
      if (protectedEdge !== null) {
        // Firefox contract at an overscrolled edge (see the module header):
        // no settle and no idle notification here, in either branch.
        if (nativeScrollEndPending) {
          // A scrollend already fired and wheels followed it — either
          // trailing momentum-end markers after a real release. Re-arm
          // confirmation; renewed input would have invalidated the release.
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
      if (nativeScrollEndPending) {
        schedulePendingNativeScrollEnd();
        return;
      }
      if (
        scrollPhaseActive &&
        !scrollPhaseMoved &&
        !hasActiveTouchOrPointerInput() &&
        !isRubberBandOverscrolled()
      ) {
        // Wheel input that never moved the viewport (a tick at a pinned
        // edge, or one whose scrollend cancellation was withheld above):
        // the gesture settles when the wheel goes quiet. This must notify
        // the host: a boundary chunk may have finished preparing while the
        // phase was active and otherwise remains held indefinitely.
        finishScrollPhase();
        return;
      }
      scheduleWheelScrollEndFallback();
    });
  }

  function observeInitialInput(): void {
    if (!awaitingInitialInput) return;
    awaitingInitialInput = false;
    // A restoration fallback may already have armed its cooldown. It is
    // not evidence of release for the gesture taking over now.
    if (firefox) cancelPendingScrollPhaseEnd();
  }

  function handleWheel(event: WheelEvent): void {
    if (host.isDisposed()) return;
    observeInitialInput();
    if (usesWheelScrollEndFallback()) {
      // Starting a phase (or cancelling an owned glide) resets its state.
      // Record this wheel only afterward so the first tick belongs to it.
      if (!handleScrollPhaseStart()) return;
      firefox?.recordInput(performance.now());
      const outwardBoundary = boundaryForOutwardWheel(event);
      if (
        firefox &&
        outwardBoundary !== null &&
        host.canLoadAtBoundary(outwardBoundary)
      ) {
        firefox.protect(outwardBoundary);
      }
      // A late decaying marker can arrive between confirmation and the
      // commit frame. Postpone that frame, but let the same delta policy
      // decide whether this invalidates the release or only extends it.
      // Clearing the release here stranded held pages without another end.
      if (event.deltaY !== 0) cancelFirefoxEdgeCommitFrame();
      if (
        firefox?.observeDelta(
          event.deltaY,
          event.deltaMode === WheelEvent.DOM_DELTA_PIXEL,
        )
      ) {
        // A re-grab owns a new release. Cancel the shared pending flag and
        // all its scheduled checks as well as the policy's candidate.
        cancelPendingScrollPhaseEnd();
      }
      // An outward wheel at a loadable edge moves nothing, yet it is a
      // gesture in intent: its phase must settle like one that moved.
      if (outwardBoundary) scrollPhaseMoved = true;
      handleWheelInputSettle(firefox?.protectedEdge ?? null);
      return;
    }

    if (!handleScrollPhaseStart()) return;
    handleChromiumWheelInput(event);
  }

  function handleScrollPhaseMaybeEnd(): void {
    if (hasActiveTouchOrPointerInput()) return;
    maybeFinishScrollPhase();
    if (
      scrollPhaseActive &&
      !scrollPhaseMoved &&
      !nativeScrollEndPending &&
      !isRubberBandOverscrolled()
    ) {
      finishScrollPhase();
    }
  }

  function handleTouchScrollStart(): void {
    observeInitialInput();
    touchInputActive = true;
    scrollEventsSinceTouchStart = 0;
    cancelPendingReleaseForDirectInput();
    handleScrollPhaseStart();
  }

  function handleTouchScrollMove(): void {
    observeInitialInput();
    cancelPendingReleaseForDirectInput();
    handleScrollPhaseStart();
  }

  function handleTouchScrollEnd(event: TouchEvent): void {
    if (event.touches.length === 0) touchInputActive = false;
    // A touch that lands on a decelerating scroller stops it dead (iOS):
    // the touchstart cancelled the pending release, and no scroll event or
    // scrollend follows a touch that never moved the viewport — nothing
    // would ever settle the gesture, and every held update waits for the
    // next real scroll. Re-arm the release; the cooldown and the edge
    // quiet windows still guard it. Firefox keeps its edge contract: at a
    // protected edge only the release scrollend may settle.
    if (
      !touchInputActive &&
      scrollPhaseActive &&
      scrollPhaseMoved &&
      !nativeScrollEndPending &&
      scrollEventsSinceTouchStart === 0 &&
      !isRubberBandOverscrolled() &&
      firefox?.protectedEdge == null
    ) {
      // Through the cooldown, never on the spot: a final clamp scroll can
      // still trail the touchend, and it must extend the release.
      armPendingNativeScrollEnd();
      return;
    }
    handleScrollPhaseMaybeEnd();
    // The last scroll may have arrived while a finger was still down, when
    // fallback timers are forbidden. Releasing without another scroll/end
    // must start the same quiet check as a trailing momentum scroll would.
    scheduleWheelScrollEndFallback();
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
    observeInitialInput();
    cancelPendingReleaseForDirectInput();
    handleScrollPhaseStart();
  }

  function markPointerReleaseScrollEnd(): void {
    if (
      activePointers.size > 0 ||
      !scrollPhaseActive ||
      !scrollPhaseMoved ||
      nativeScrollEndPending ||
      isRubberBandOverscrolled()
    ) {
      return;
    }

    setPendingNativeScrollEnd();
  }

  function handlePointerScrollEnd(event: PointerEvent): void {
    if (event.pointerType === "touch" && supportsTouchEvents) return;
    // Releases are observed on window so an owned drag can end outside the
    // viewport. Unrelated contacts (for example a Pencil tap on a sibling
    // jump button) must not settle this viewport's ongoing momentum.
    if (!activePointers.delete(event.pointerId)) return;
    markPointerReleaseScrollEnd();
    handleScrollPhaseMaybeEnd();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      ![
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key) ||
      (event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ))
    )
      return;
    observeInitialInput();
    cancelPendingReleaseForDirectInput();
    handleScrollPhaseStart();
  }

  viewport.addEventListener("keydown", handleKeydown);
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
    isScrollPhaseActive: () => scrollPhaseActive,
    isNearScrollEdge,
    recordProgrammaticScrollTop,
    beginProgrammaticGesture: () => handleScrollPhaseStart(true),
    markSettlePending: () => {
      if (host.isDisposed()) return;
      armPendingNativeScrollEnd();
    },
    finishGesture: finishScrollPhase,
    dispose: () => {
      cancelScrollPhaseTimers();
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("keydown", handleKeydown);
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
