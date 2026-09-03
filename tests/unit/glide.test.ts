/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glidePace, startGlide } from "../../src/glide";

// The glide's contractual behaviors (I2): exact landing, and at least one
// whole pixel of progress per frame — WebKit floors scrollTop writes, and a
// sub-pixel step would round back to the previous position: a stalled frame.

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

  it("converges exactly on engines that floor scrollTop writes, never stalling a frame", () => {
    // A slow enough glide that the curve creeps by fractions of a pixel per
    // frame through its tail — where a floored write would stall without
    // the rule.
    const host = harness(0, 1000, true);
    let completed = false;
    const seen: number[] = [host.top];
    const write = host.write;
    host.write = (top) => {
      write(top);
      seen.push(host.top);
    };
    startGlide(host, 3000, (done) => {
      completed = done;
    });
    vi.advanceTimersByTime(4000);
    expect(host.top).toBe(1000);
    expect(completed).toBe(true);
    // Every frame moved the floored position by at least a pixel.
    for (let i = 1; i < seen.length; i += 1) {
      expect(
        (seen[i] as number) - (seen[i - 1] as number),
      ).toBeGreaterThanOrEqual(1);
    }
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
    startGlide(host, glidePace(600), () => {});
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
    startGlide(host, glidePace(600), () => {});
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

  it("lands the same way from one viewport away and from across the list", () => {
    // The landing leg — the last viewport of travel — is the same
    // position-over-time whatever the trip: sample both trips relative to
    // their targets over the final landing window.
    // 640ms: the long trip's approach is capped at exactly forty 16ms frames,
    // so both landings start on a frame and their samples align.
    const pace = glidePace(600, 640);
    const run = (distance: number): Map<number, number> => {
      let top = 0;
      const samples = new Map<number, number>();
      let doneAt = -1;
      startGlide(
        {
          read: () => top,
          write: (next) => {
            top = next;
          },
          target: () => distance,
        },
        pace,
        () => {
          doneAt = performance.now();
        },
      );
      const t0 = performance.now();
      while (doneAt < 0 && performance.now() - t0 < 5000) {
        vi.advanceTimersByTime(16);
        samples.set(performance.now() - t0, distance - top);
      }
      // Re-key by time before landing so the two trips align at the end.
      const byTimeToEnd = new Map<number, number>();
      for (const [at, remaining] of samples) {
        byTimeToEnd.set(Math.round(doneAt - t0 - at), remaining);
      }
      return byTimeToEnd;
    };
    const short = run(600);
    const long = run(12_000);
    let compared = 0;
    for (const [timeToEnd, remaining] of short) {
      // Inside the landing window. The ease-out reaches the target within
      // a pixel before its nominal end, so the window is shorter than the
      // landing's 640ms; the last 450ms are comfortably inside it.
      if (timeToEnd > 450) continue;
      const other = long.get(timeToEnd);
      if (other === undefined) continue;
      expect(Math.abs(other - remaining)).toBeLessThanOrEqual(2);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(15);
  });

  it("bounds a long trip by the approach cap plus the landing", () => {
    let top = 0;
    let doneAt = -1;
    startGlide(
      {
        read: () => top,
        write: (next) => {
          top = next;
        },
        target: () => 100_000,
      },
      glidePace(600),
      () => {
        doneAt = performance.now();
      },
    );
    const t0 = performance.now();
    vi.advanceTimersByTime(2000);
    expect(top).toBe(100_000);
    // Nominal: 800ms approach cap + 600ms landing; the landing snaps to
    // the target within a pixel a little before its nominal end.
    expect(doneAt - t0).toBeLessThanOrEqual(1400 + 32);
    expect(doneAt - t0).toBeGreaterThanOrEqual(1200);
  });
});
