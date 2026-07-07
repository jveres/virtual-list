/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlaceholderModeController,
  type PlaceholderModeController,
  type PlaceholderModeHost,
} from "../../src/placeholder-mode";

// The placeholder fast-mode state machine in isolation: enter at the velocity
// threshold, exit through the slow-sample hysteresis, disable rules, and the
// rAF hydration loop — driven through a fake host.

interface HostState {
  canMount: boolean;
  threshold: number;
  velocity: number;
  sampleDelta: number;
  disposed: boolean;
  atBoundary: boolean;
  placeholderMounts: number;
}

function makeMode(overrides: Partial<HostState> = {}): {
  mode: PlaceholderModeController;
  state: HostState;
  refreshes: () => number;
  renders: () => number;
} {
  const state: HostState = {
    canMount: true,
    threshold: 8,
    velocity: 0,
    sampleDelta: 10,
    disposed: false,
    atBoundary: false,
    placeholderMounts: 0,
    ...overrides,
  };
  const refreshMountedPlaceholders = vi.fn(() => state.placeholderMounts > 0);
  const renderNow = vi.fn();
  const host: PlaceholderModeHost = {
    canMountPlaceholders: () => state.canMount,
    velocityThreshold: () => state.threshold,
    currentVelocity: () => state.velocity,
    lastSampleDelta: () => state.sampleDelta,
    sampleEpsilon: 0.5,
    isDisposed: () => state.disposed,
    atNativeScrollBoundary: () => state.atBoundary,
    hasPlaceholderMounts: () => state.placeholderMounts > 0,
    refreshMountedPlaceholders,
    renderNow,
  };
  return {
    mode: createPlaceholderModeController(host),
    state,
    refreshes: () => refreshMountedPlaceholders.mock.calls.length,
    renders: () => renderNow.mock.calls.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("placeholder fast mode", () => {
  it("enters at the velocity threshold and blocks hydration", () => {
    const { mode, state } = makeMode();
    state.velocity = 7.9;
    expect(mode.update()).toBe(false);
    state.velocity = 8;
    expect(mode.update()).toBe(true);
    expect(mode.isHydrationBlocked()).toBe(true);
  });

  it("exits only after three consecutive slow samples (hysteresis at half)", () => {
    const { mode, state } = makeMode();
    state.velocity = 20;
    expect(mode.update()).toBe(true);

    // Below enter (8) but above exit (4): stays in fast mode indefinitely.
    state.velocity = 6;
    expect(mode.update()).toBe(true);
    expect(mode.update()).toBe(true);

    // At or below the exit velocity: two samples are not enough...
    state.velocity = 3;
    expect(mode.update()).toBe(true);
    expect(mode.update()).toBe(true);
    // ...the third releases the mode and unblocks hydration.
    expect(mode.update()).toBe(false);
    expect(mode.isHydrationBlocked()).toBe(false);
  });

  it("ignores noise samples and resets the exit count on a fast sample", () => {
    const { mode, state } = makeMode();
    state.velocity = 20;
    mode.update();

    state.velocity = 3;
    mode.update();
    mode.update(); // two slow samples

    state.sampleDelta = 0.2; // sub-epsilon: neither counts nor resets
    mode.update();
    state.sampleDelta = 10;

    state.velocity = 6; // moving again above exit: resets the count
    mode.update();
    state.velocity = 3;
    mode.update();
    mode.update();
    expect(mode.update()).toBe(false); // third consecutive slow sample
  });

  it("disables at a native scroll boundary and hydrates survivors", () => {
    const { mode, state, refreshes } = makeMode();
    state.velocity = 20;
    expect(mode.update()).toBe(true);

    state.atBoundary = true;
    state.placeholderMounts = 3;
    expect(mode.update()).toBe(false);
    expect(refreshes()).toBe(1);
    expect(mode.isHydrationBlocked()).toBe(false);
  });

  it("disables when placeholders are impossible or the threshold is Infinity", () => {
    const impossible = makeMode({ canMount: false, velocity: 100 });
    expect(impossible.mode.update()).toBe(false);

    const disabled = makeMode({
      threshold: Number.POSITIVE_INFINITY,
      velocity: 100,
    });
    expect(disabled.mode.update()).toBe(false);
  });

  it("falls back to the default threshold for non-finite non-Infinity values", () => {
    const { mode, state } = makeMode({ threshold: Number.NaN });
    state.velocity = 8; // the documented default
    expect(mode.update()).toBe(true);
  });

  it("runs the hydration loop while placeholders survive under a block", () => {
    const { mode, state, renders } = makeMode();
    state.velocity = 20;
    state.placeholderMounts = 2;
    mode.update();
    mode.scheduleHydrationCheck();

    vi.advanceTimersByTime(17);
    expect(renders()).toBe(1); // renderNow gets a chance to hydrate
    vi.advanceTimersByTime(17);
    expect(renders()).toBe(2); // still mounted and blocked: keeps checking

    state.placeholderMounts = 0; // all hydrated
    vi.advanceTimersByTime(50);
    // The in-flight frame re-checks at fire time and skips the wasted render.
    expect(renders()).toBe(2);
    vi.advanceTimersByTime(100);
    expect(renders()).toBe(2);
  });

  it("forceHydrate clears the mode and swaps survivors immediately", () => {
    const { mode, state, refreshes } = makeMode();
    state.velocity = 20;
    state.placeholderMounts = 2;
    expect(mode.update()).toBe(true);

    expect(mode.forceHydrate()).toBe(true);
    expect(mode.isHydrationBlocked()).toBe(false);
    expect(refreshes()).toBe(1);
  });

  it("dispose cancels a scheduled hydration frame", () => {
    const { mode, state, renders } = makeMode();
    state.velocity = 20;
    state.placeholderMounts = 1;
    mode.update();
    mode.scheduleHydrationCheck();
    mode.dispose();
    vi.advanceTimersByTime(100);
    expect(renders()).toBe(0);
  });
});
