// The gesture sensor: per-engine heuristics for classifying scrolls as user
// gestures vs. the library's own programmatic writes, and for deciding when
// a user gesture has truly finished — the moment deferred structural updates
// may flush and the viewport may be written again.
//
// This is the proven browser-adaptive lifecycle carried over from the old
// runtime (a preserved asset, not a re-derivation): engines disagree on when
// (and whether) `scrollend` fires relative to wheel momentum, so each
// strategy encodes one engine's observed sequencing — chromium's wheel-idle
// window and boundary-scrollend suppression, firefox's early scrollend
// during a glide, safari's rubber-band tails, and a plain
// scrollend+cooldown default. The sensor owns the viewport's
// scroll/scrollend/wheel/pointer/touch listeners and all gesture state.
//
// ## The per-engine gesture contract at overscrolled edges
//
// Deferred list updates (boundary loads, prepends/appends) must apply only
// when the gesture settles, and each engine bounds what "settled" can mean:
//
// - **Chromium**: touchpad release is NOT detectable during overscroll — the
//   engine emits one scrollend per scroll sequence (often early, at the
//   edge) and momentum wheel events are indistinguishable from fingers-down
//   input. The accepted contract is settling after a quiet delay
//   (EDGE_SETTLE_QUIET_MS + the cooldown); applying a list update
//   mid-overscroll after that delay is fine because Chromium repaints the
//   anchored content without a visible flash.
// - **Firefox**: at an overscrolled edge, settle only from a scrollend after
//   an extended last-input stability window — never from a bare timer.
//   Firefox emits a scrollend whenever scrolling pauses, so one can land
//   inside a momentum-wheel gap mid-hold; wheels arriving inside the
//   stability window postpone the settle. Applying while the engine gesture
//   is alive is unfixable, verified empirically: besides the visible flash,
//   Firefox's async scroll machinery keeps the pre-apply scroll-limit
//   snapshot for the remainder of the gesture — the next scroll bounces
//   against that "ghost end" — and no main-thread reset clears it. The
//   generic 280ms fallback never arms near an edge either, and a
//   scrollend-less hold never applies at all: the next gesture's settle
//   recovers it.
// - **Safari**: rubber-bands past the scroll range, and any scrollTop write
//   during native motion kills the momentum animation. The contract is:
//   never settle while rubber-banded or while any motion — even sub-pixel —
//   continues; settle from the release scrollend or true quiet. Near an
//   edge, settling additionally requires SAFARI_EDGE_SETTLE_QUIET_MS of
//   scroll-event silence.
//
// Two tolerances make this robust: EDGE_PROXIMITY_EPSILON_PX accepts the
// fractional gap (up to ~1px, more under zoom) engines leave between a
// pinned scroll position and the exact limit, and SETTLE_MOTION_EPSILON_PX
// cancels a pending settle on any real movement so decaying momentum can't
// be settled into.
//
// An explicit command takes ownership back via interrupt(): native momentum
// is genuinely cancelled (clamped write + overflow toggle + forced reflow),
// then the gesture settles immediately.

const MEASURE_EPSILON_PX = 0.5;
const SCROLL_SETTLE_COOLDOWN_MS = 140;
const WHEEL_INPUT_IDLE_MS = SCROLL_SETTLE_COOLDOWN_MS;
// Quiet window for settling a chromium gesture whose release is not directly
// observable: no wheel activity for this long at an edge means the fingers
// are gone (or motionless, which is indistinguishable).
const EDGE_SETTLE_QUIET_MS = 450;
// Firefox publishes range growth to APZ asynchronously after the main-thread
// commit. A rapid re-grab can otherwise join the pre-growth overscroll state
// and bounce at a ghost edge. There is no content-visible APZ
// acknowledgement, so keep a conservative, empirically verified quiet window
// from the latest DOM wheel signal.
const FIREFOX_EDGE_STABILITY_QUIET_MS = 1600;
// Safari settles near an edge only after this much scroll-event silence: the
// rubber-band bounce decays through event gaps longer than the settle
// cooldown, and a settle inside the tail performs anchor-preserving
// scrollTop writes that snap the animation.
const SAFARI_EDGE_SETTLE_QUIET_MS = 350;
// Engines pin an overscrolled position up to ~1px (more under zoom/DPI
// scaling) shy of the exact scroll limit; a fractional miss here sends a
// held-at-the-edge gesture down the wrong settle path.
const EDGE_PROXIMITY_EPSILON_PX = 2;
// Any real movement at or above this cancels a pending wheel settle; decaying
// momentum moves in sub-0.5px steps that must still count as motion.
const SETTLE_MOTION_EPSILON_PX = 0.05;
// Upper bound on unmatched programmatic scroll targets kept for user-vs-self
// classification. One frame writes at most a few times; this only guards
// against runaway.
const MAX_PENDING_WRITES = 8;

export type GestureStrategy =
  | "default"
  | "chromium-wheel"
  | "firefox-wheel"
  | "safari-wheel";

type ScrollBoundary = "top" | "bottom";

export function detectGestureStrategy(
  userAgent = navigator.userAgent,
): GestureStrategy {
  if (/\bFirefox\//.test(userAgent)) return "firefox-wheel";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) {
    return "safari-wheel";
  }
  return /\b(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
    ? "chromium-wheel"
    : "default";
}

export interface GestureSensorHooks {
  /** The gesture transitioned idle → active. */
  onStart?: () => void;
  /** The gesture truly settled: deferred work may flush. */
  onSettle?: () => void;
  /** Whether reaching this edge can grow the list (guards edge protection). */
  canLoadAtBoundary?: (boundary: ScrollBoundary) => boolean;
  /** Cancel an in-flight programmatic glide — a real user gesture began. */
  cancelSmoothScroll?: () => void;
  /** True while a programmatic glide is still short of its target. */
  smoothScrollActive?: () => boolean;
}

export interface GestureSensor {
  readonly active: boolean;
  /** Record an upcoming self-inflicted scroll so it is not misread. */
  expectWrite(scrollTop: number): void;
  /**
   * Explicit-command takeover: genuinely cancel native momentum, then
   * settle the gesture NOW (onSettle fires synchronously).
   */
  interrupt(): void;
  dispose(): void;
}

export function createGestureSensor(
  viewport: HTMLElement,
  hooks: GestureSensorHooks = {},
  strategy: GestureStrategy = detectGestureStrategy(),
): GestureSensor {
  let disposed = false;
  let userScrollActive = false;
  let userScrollMoved = false;
  let lastScrollSampleTop = viewport.scrollTop;
  let lastScrollSampleAt = performance.now();
  const expected: number[] = [];
  let nativeScrollEndPending = false;
  let wheelPendingNativeScrollEndTop: number | null = null;
  let pendingNativeScrollEndDelayMs = SCROLL_SETTLE_COOLDOWN_MS;
  let pendingFirefoxEdgeRelease = false;
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

  function canLoadAtBoundary(boundary: ScrollBoundary): boolean {
    return hooks.canLoadAtBoundary?.(boundary) ?? false;
  }

  function recordSample(scrollTop = viewport.scrollTop): void {
    lastScrollSampleTop = scrollTop;
    lastScrollSampleAt = performance.now();
  }

  function expectWrite(target: number): void {
    expected.push(target);
    if (expected.length > MAX_PENDING_WRITES) expected.shift();
  }

  function consumeProgrammaticScrollWrite(scrollTop: number): boolean {
    if (expected.length === 0) return false;
    const tolerance = Math.max(1, MEASURE_EPSILON_PX);
    const matchIndex = expected.findIndex(
      (target) => Math.abs(scrollTop - target) <= tolerance,
    );
    if (matchIndex === -1) {
      // The scroll landed on no pending programmatic target — a real user
      // scroll took over. Drop the stale targets so they can't shadow later
      // events.
      expected.length = 0;
      return false;
    }
    // Discard this target and any older ones it superseded; keep newer
    // writes for their own events.
    expected.splice(0, matchIndex + 1);
    return true;
  }

  function handleScroll(): void {
    if (disposed) return;
    const previousScrollTop = lastScrollSampleTop;
    const nextScrollTop = viewport.scrollTop;
    const moved =
      Math.abs(nextScrollTop - previousScrollTop) > MEASURE_EPSILON_PX;
    const programmaticScroll = consumeProgrammaticScrollWrite(nextScrollTop);
    if (strategy === "firefox-wheel" && moved && !programmaticScroll) {
      firefoxProtectedEdge ??= loadableBoundaryAtNativeEdge();
    }
    if (!userScrollActive && moved && !programmaticScroll) {
      if (!handleUserScrollStart()) return;
    }
    recordSample(nextScrollTop);
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
  }

  function hasActiveTouchOrPointerInput(): boolean {
    return touchInputActive || activePointers.size > 0;
  }

  function isRubberBandOverscrolled(): boolean {
    const scrollTop = viewport.scrollTop;
    const maxScrollTop = nativeMaxScrollTop();
    return (
      scrollTop < -MEASURE_EPSILON_PX ||
      scrollTop - maxScrollTop > MEASURE_EPSILON_PX
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
    // Input after the entire stability window is a new gesture, not a
    // trailing momentum marker. Require this gesture's own scrollend before
    // growth.
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
    if (canLoadAtBoundary("top") && scrollTop <= EDGE_PROXIMITY_EPSILON_PX) {
      return "top";
    }
    const maxScrollTop = nativeMaxScrollTop();
    if (
      canLoadAtBoundary("bottom") &&
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
      // settle's scrollTop writes can't snap a live bounce.
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
      // routes to the overscroll effect.
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
    recordSample();
  }

  function finishUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
    if (disposed) return;
    hooks.onSettle?.();
  }

  function cancelUserScroll(): void {
    cancelUserScrollTimers();
    resetScrollSettleState();
    resetUserScrollState();
  }

  function maybeFinishUserScroll(): void {
    if (disposed || !userScrollActive || !nativeScrollEndPending) {
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
    if (firefoxEdgeCommitFrame || disposed) return;
    firefoxEdgeCommitFrame = requestAnimationFrame(() => {
      firefoxEdgeCommitFrame = 0;
      if (
        disposed ||
        !hasPendingFirefoxEdgeRelease() ||
        !canSettleUserScroll()
      ) {
        return;
      }
      finishUserScroll();
    });
  }

  function schedulePendingSettleCheck(): void {
    if (settleFrame || disposed) return;
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      if (disposed) return;
      maybeFinishUserScroll();
    });
  }

  function scheduleSettleCooldown(delayMs = SCROLL_SETTLE_COOLDOWN_MS): void {
    cancelSettleTimer();
    if (disposed) return;
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (disposed) return;
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
  }

  function clearPendingNativeScrollEnd(): void {
    cancelFirefoxEdgeCommitFrame();
    nativeScrollEndPending = false;
    pendingNativeScrollEndDelayMs = SCROLL_SETTLE_COOLDOWN_MS;
    wheelPendingNativeScrollEndTop = null;
    pendingFirefoxEdgeRelease = false;
  }

  // Preserve the policy chosen when the native scrollend was observed. In
  // particular, pinned scroll events and neutral wheel jitter must not turn
  // a Firefox edge stability wait into the generic short cooldown.
  function schedulePendingNativeScrollEnd(): void {
    if (disposed || !nativeScrollEndPending) return;
    const delayMs = hasPendingFirefoxEdgeRelease()
      ? Math.max(
          0,
          FIREFOX_EDGE_STABILITY_QUIET_MS -
            (performance.now() - lastFirefoxWheelInputAt),
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

  function markPendingWheelScrollEnd(): void {
    setPendingNativeScrollEnd({
      scrollTop: Math.max(
        0,
        Math.min(nativeMaxScrollTop(), viewport.scrollTop),
      ),
    });
    schedulePendingNativeScrollEnd();
  }

  function scheduleWheelScrollEndFallback(): void {
    if (disposed || !canScheduleWheelScrollEndFallback()) return;
    cancelSettleTimer();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (disposed || !canScheduleWheelScrollEndFallback()) return;
      markPendingWheelScrollEnd();
    }, SCROLL_SETTLE_COOLDOWN_MS);
  }

  // Close the wheel-idle dead-end: when the last wheel of a gesture is judged
  // neither outward (no edge fallback) nor preceded by an unconsumed
  // scrollend (no cooldown), nothing else would ever settle the gesture —
  // chromium fires only one scrollend per scroll sequence, and a trailing
  // wheel consumed it. Without this, the gesture stays active forever and
  // deferred boundary loads sit unapplied until the user scrolls again.
  function scheduleChromiumStallFallback(): void {
    cancelChromiumEdgeSettleTimer();
    chromiumEdgeSettleTimer = window.setTimeout(() => {
      chromiumEdgeSettleTimer = 0;
      if (
        disposed ||
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
        disposed ||
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
    if (disposed) return;
    // Ignore scrollends produced while our own glide is still mid-flight.
    if (hooks.smoothScrollActive?.() === true) return;

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
        // window. Preserve an already-classified edge release even if
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
    schedulePendingNativeScrollEnd();
  }

  // A genuine user scroll interrupts any in-flight programmatic glide so the
  // user can actually scroll away, instead of the library re-issuing the
  // animation and pulling them back.
  function handleUserScrollStart(): boolean {
    if (disposed) return false;
    hooks.cancelSmoothScroll?.();
    if (disposed) return false;
    const wasActive = userScrollActive;
    userScrollActive = true;
    if (!wasActive) {
      clearPendingNativeScrollEnd();
      userScrollMoved = false;
      recordSample();
      chromiumWheelSawNativeScrollEnd = false;
      chromiumWheelAwaitingFinalScrollEnd = false;
      chromiumEdgeWheelSuppressed = false;
      cancelChromiumEdgeSettleTimer();
      hooks.onStart?.();
      if (disposed) return false;
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
      if (disposed) return;
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
      if (disposed) return;
      wheelInputActive = false;
      if (strategy === "firefox-wheel" && outwardBoundary !== null) {
        // Firefox contract at an overscrolled edge (see the header).
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
        // timer backstop (timer applies mid-hold are unfixable: they flash
        // and leave a ghost end). A missed scrollend recovers at the next
        // gesture's settle.
        return;
      }
      if (nativeScrollEndPending) {
        schedulePendingNativeScrollEnd();
        return;
      }
      scheduleWheelScrollEndFallback();
    }, WHEEL_INPUT_IDLE_MS);
  }

  function handleWheel(event: WheelEvent): void {
    if (disposed) return;
    if (strategy === "firefox-wheel" || strategy === "safari-wheel") {
      if (strategy === "firefox-wheel") {
        lastFirefoxWheelInputAt = performance.now();
      }
      const outwardBoundary = boundaryForOutwardWheel(event);
      if (
        strategy === "firefox-wheel" &&
        outwardBoundary !== null &&
        canLoadAtBoundary(outwardBoundary)
      ) {
        firefoxProtectedEdge ??= outwardBoundary;
      }
      if (event.deltaY !== 0) cancelFirefoxEdgeCommitForInput();
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

  /**
   * Genuinely stop the browser-owned scroll animation: write the clamped
   * current position, then force an overflow toggle through a reflow —
   * merely clearing timers would leave APZ momentum alive and its trailing
   * events would masquerade as a new gesture.
   */
  function cancelNativeMomentum(): void {
    const currentTop = Math.max(
      0,
      Math.min(viewport.scrollTop, nativeMaxScrollTop()),
    );
    expectWrite(currentTop);
    viewport.scrollTop = currentTop;
    const previousOverflowY = viewport.style.overflowY;
    viewport.style.overflowY = "hidden";
    void viewport.offsetHeight;
    viewport.style.overflowY = previousOverflowY;
    viewport.scrollTop = currentTop;
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
    get active() {
      return userScrollActive;
    },
    expectWrite,
    interrupt(): void {
      if (disposed || !userScrollActive) return;
      cancelNativeMomentum();
      finishUserScroll();
    },
    dispose(): void {
      disposed = true;
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
