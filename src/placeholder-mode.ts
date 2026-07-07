/**
 * The placeholder fast-mode state machine: while the user scrolls faster than
 * the configured velocity threshold, newly mounted rows build as cheap
 * placeholders instead of real content. Exit needs several consecutive
 * slow scroll samples (hysteresis at half the enter velocity), and a rAF
 * hydration loop swaps surviving placeholders back to real rows once the
 * mode releases them.
 */

export const DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD = 8;
const PLACEHOLDER_VELOCITY_EXIT_RATIO = 0.5;
const PLACEHOLDER_EXIT_SAMPLE_COUNT = 3;

/** What the placeholder controller needs from the virtualizer that owns it. */
export interface PlaceholderModeHost {
  /** Placeholder rows are possible at all (virtual mode + buildPlaceholder). */
  canMountPlaceholders(): boolean;
  /** Configured enter velocity (px/ms); +Infinity disables fast mode. */
  velocityThreshold(): number;
  currentVelocity(): number;
  lastSampleDelta(): number;
  /** Scroll-sample noise floor (the measure epsilon). */
  sampleEpsilon: number;
  isDisposed(): boolean;
  atNativeScrollBoundary(): boolean;
  hasPlaceholderMounts(): boolean;
  /** Swap surviving placeholders for real rows; true when any swapped. */
  refreshMountedPlaceholders(): boolean;
  renderNow(): void;
}

export interface PlaceholderModeController {
  /**
   * Advance the state machine from the current scroll velocity; returns
   * whether newly mounted rows should build as placeholders.
   */
  update(): boolean;
  /** Hydration is deferred: placeholders must not swap to real rows yet. */
  isHydrationBlocked(): boolean;
  /** A placeholder mounted: keep the hydration loop armed. */
  scheduleHydrationCheck(): void;
  /** Reset the mode state without touching mounted placeholders. */
  clear(): void;
  /** Reset the mode and swap survivors now; true when any swapped. */
  forceHydrate(): boolean;
  dispose(): void;
}

export function createPlaceholderModeController(
  host: PlaceholderModeHost,
): PlaceholderModeController {
  let fastMode = false;
  let hydrationBlocked = false;
  let lowVelocitySamples = 0;
  let hydrationFrame = 0;

  function enterVelocity(): number {
    const value = host.velocityThreshold();
    if (!Number.isFinite(value)) {
      return value === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : DEFAULT_PLACEHOLDER_VELOCITY_THRESHOLD;
    }
    return Math.max(0, value);
  }

  function cancelHydrationCheck(): void {
    if (!hydrationFrame) return;
    cancelAnimationFrame(hydrationFrame);
    hydrationFrame = 0;
  }

  function needsHydrationCheck(): boolean {
    return host.hasPlaceholderMounts() && (fastMode || hydrationBlocked);
  }

  function scheduleHydrationCheck(): void {
    if (hydrationFrame || host.isDisposed()) return;
    if (!needsHydrationCheck()) return;

    hydrationFrame = requestAnimationFrame(() => {
      hydrationFrame = 0;
      if (host.isDisposed() || !needsHydrationCheck()) return;

      host.renderNow();
      if (needsHydrationCheck()) {
        scheduleHydrationCheck();
      }
    });
  }

  function clear(): void {
    fastMode = false;
    hydrationBlocked = false;
    lowVelocitySamples = 0;
  }

  function disable(): boolean {
    const hadPlaceholderMounts = host.hasPlaceholderMounts();
    const wasActive = fastMode || hydrationBlocked || hadPlaceholderMounts;
    clear();
    return wasActive ? host.refreshMountedPlaceholders() : false;
  }

  function forceHydrate(): boolean {
    clear();
    return host.refreshMountedPlaceholders();
  }

  function update(): boolean {
    if (!host.canMountPlaceholders()) {
      disable();
      return false;
    }

    const enter = enterVelocity();
    if (enter === Number.POSITIVE_INFINITY) {
      disable();
      return false;
    }

    const velocity = host.currentVelocity();

    if (host.atNativeScrollBoundary()) {
      disable();
      return false;
    }

    if (velocity >= enter) {
      hydrationBlocked = true;
      fastMode = true;
      lowVelocitySamples = 0;
      scheduleHydrationCheck();
    } else if (fastMode) {
      const exitVelocity = enter * PLACEHOLDER_VELOCITY_EXIT_RATIO;
      if (
        host.lastSampleDelta() > host.sampleEpsilon &&
        velocity <= exitVelocity
      ) {
        lowVelocitySamples++;
      } else if (host.lastSampleDelta() > host.sampleEpsilon) {
        lowVelocitySamples = 0;
      }
      if (lowVelocitySamples >= PLACEHOLDER_EXIT_SAMPLE_COUNT) {
        hydrationBlocked = false;
        fastMode = false;
        lowVelocitySamples = 0;
      } else {
        scheduleHydrationCheck();
      }
    } else {
      fastMode = false;
    }

    return fastMode;
  }

  return {
    update,
    isHydrationBlocked: () => hydrationBlocked,
    scheduleHydrationCheck,
    clear,
    forceHydrate,
    dispose: cancelHydrationCheck,
  };
}
