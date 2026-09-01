/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glideDuration, startGlide } from "../../src/glide";

// The glide's contractual behaviors (I2): exact landing, and at least one
// whole pixel of progress per frame — WebKit floors scrollTop writes, and a
// sub-pixel step parks an exponential approach short of the target forever.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function harness(start: number, target: number, floorWrites: boolean) {
  let top = start;
  return {
    read: () => top,
    write: (value: number) => {
      top = floorWrites ? Math.floor(value) : value;
    },
    target: () => target,
    get top() {
      return top;
    },
  };
}

describe("glide", () => {
  it("lands exactly on the target", () => {
    const host = harness(0, 500, false);
    let completed = false;
    startGlide(host, 320, (done) => {
      completed = done;
    });
    vi.advanceTimersByTime(1000);
    expect(host.top).toBe(500);
    expect(completed).toBe(true);
  });

  it("converges exactly on engines that floor scrollTop writes", () => {
    const host = harness(796, 800, true);
    let completed = false;
    startGlide(host, 300, (done) => {
      completed = done;
    });
    vi.advanceTimersByTime(1000);
    expect(host.top).toBe(800);
    expect(completed).toBe(true);
  });

  it("follows a moving target (streaming growth)", () => {
    let target = 400;
    let top = 0;
    const host = {
      read: () => top,
      write: (value: number) => {
        top = value;
      },
      target: () => target,
    };
    startGlide(host, 320, () => {});
    vi.advanceTimersByTime(150);
    target = 900; // The end moved while gliding.
    vi.advanceTimersByTime(2000);
    expect(top).toBe(900);
  });

  it("rebases when the position moves externally — no full-distance snap", () => {
    // The top-navigation scenario: mid-glide toward 0, an anchor-preserving
    // prepend jumps the position far down. The old curve would snap back in
    // one frame; the rebased curve continues smoothly from the new position.
    let top = 84;
    const steps: number[] = [];
    const host = {
      read: () => top,
      write: (value: number) => {
        steps.push(value - top);
        top = value;
      },
      target: () => 0,
    };
    startGlide(
      host,
      (distance) => glideDuration(distance, 600),
      () => {},
    );
    vi.advanceTimersByTime(48);

    top += 3760; // External anchor-preserving jump (prepend).
    steps.length = 0;
    vi.advanceTimersByTime(4000);

    expect(top).toBe(0); // Still lands exactly.
    // Every post-jump frame moves toward the target...
    expect(steps.every((step) => step <= 0)).toBe(true);
    // ...and no single frame snaps a dominant share of the distance.
    const largest = Math.max(...steps.map((step) => Math.abs(step)));
    expect(largest).toBeLessThan(0.5 * 3844);
  });

  it("rebases when the live target jumps — no full-distance snap", () => {
    let top = 0;
    let target = 400;
    const steps: number[] = [];
    const host = {
      read: () => top,
      write: (value: number) => {
        steps.push(value - top);
        top = value;
      },
      target: () => target,
    };
    startGlide(
      host,
      (distance) => glideDuration(distance, 600),
      () => {},
    );
    vi.advanceTimersByTime(150);

    target = 4000; // A snapshot moved the end far away.
    steps.length = 0;
    vi.advanceTimersByTime(4000);

    expect(top).toBe(4000);
    expect(steps.every((step) => step >= 0)).toBe(true);
    const largest = Math.max(...steps.map((step) => Math.abs(step)));
    expect(largest).toBeLessThan(0.5 * 4000);
  });

  it("cancel stops without landing", () => {
    const host = harness(0, 500, false);
    let doneArg: boolean | null = null;
    const glide = startGlide(host, 320, (done) => {
      doneArg = done;
    });
    vi.advanceTimersByTime(48);
    glide.cancel();
    const at = host.top;
    vi.advanceTimersByTime(1000);
    expect(host.top).toBe(at);
    expect(doneArg).toBe(false);
    expect(glide.active).toBe(false);
  });

  it("derives bounded durations from distance", () => {
    expect(glideDuration(10, 600)).toBe(320);
    expect(glideDuration(1_000_000, 600)).toBe(1400);
    const mid = glideDuration(3_000, 600);
    expect(mid).toBeGreaterThan(320);
    expect(mid).toBeLessThan(1400);
  });
});
