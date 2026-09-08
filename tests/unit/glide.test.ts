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
  it("should expose the landing leg and reset it when the target rebases", () => {
    const host = harness(6000, 0, false);
    let target = 0;
    host.target = () => target;
    const glide = startGlide(host, glidePace(600), () => {});
    expect(glide.landing).toBe(false);

    for (let frame = 0; frame < 150 && !glide.landing; frame++)
      vi.advanceTimersByTime(16);
    expect(glide.active).toBe(true);
    expect(glide.landing).toBe(true);
    expect(host.top).toBeLessThanOrEqual(600);

    target = 9000;
    vi.advanceTimersByTime(16);
    expect(glide.landing).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(host.top).toBe(9000);
    expect(glide.active).toBe(false);
    expect(glide.landing).toBe(false);
  });

  it("should clear a short glide's landing state on cancellation", () => {
    const host = harness(500, 0, false);
    const glide = startGlide(host, glidePace(600), () => {});
    vi.advanceTimersByTime(16);
    expect(glide.landing).toBe(true);

    glide.cancel();

    expect(glide.landing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { start: 9554, target: 0, floorWrites: false },
    { start: 0, target: 9554, floorWrites: false },
    { start: 9554, target: 0, floorWrites: true },
    { start: 0, target: 9554, floorWrites: true },
  ])(
    "should finish the last 100px promptly from $start to $target (floored: $floorWrites)",
    ({ start, target, floorWrites }) => {
      const host = harness(start, target, floorWrites);
      const samples: { at: number; remaining: number }[] = [];
      const completed: boolean[] = [];
      const write = host.write;
      host.write = (value) => {
        write(value);
        samples.push({
          at: performance.now(),
          remaining: Math.abs(target - host.top),
        });
      };

      startGlide(host, glidePace(811), (done) => completed.push(done));
      vi.advanceTimersByTime(2000);

      expect(host.top).toBe(target);
      expect(completed).toEqual([true]);
      const tail = samples.find((sample) => sample.remaining <= 100);
      const last = samples.at(-1);
      if (!tail || !last) throw new Error("missing landing samples");
      expect(last.at - tail.at).toBeLessThanOrEqual(200);
      // Shorter does not mean an abrupt snap or a reversal at the join.
      const steps = samples.slice(1).map((sample, index) => {
        const previous = samples[index];
        if (!previous) throw new Error("missing previous sample");
        const step = previous.remaining - sample.remaining;
        // A floored engine can reach the exact target before the final
        // confirming write. Only motion before arrival must keep advancing.
        if (previous.remaining > 0) expect(step).toBeGreaterThan(0);
        return step;
      });
      for (let index = 1; index < steps.length; index++) {
        const step = steps[index];
        const previous = steps[index - 1];
        if (step === undefined || previous === undefined)
          throw new Error("missing step");
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(previous + 1);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("should ease off the braking through a short landing", () => {
    const host = harness(811, 0, false);
    const positions: number[] = [];
    const write = host.write;
    host.write = (top) => {
      write(top);
      positions.push(top);
    };
    startGlide(host, glidePace(811), () => {});

    vi.advanceTimersByTime(300);

    expect(host.top).toBe(0);
    const steps = positions.slice(1).map((top, index) => {
      const previous = positions[index];
      if (previous === undefined) throw new Error("missing position");
      return previous - top;
    });
    // Exclude the startup's minimum step and the final exact landing.
    const braking = steps.slice(2, -2).map((step, index) => {
      const previous = steps[index + 1];
      if (previous === undefined) throw new Error("missing step");
      return previous - step;
    });
    expect(braking.length).toBeGreaterThan(5);
    for (let index = 1; index < braking.length; index++) {
      const deceleration = braking[index];
      const previous = braking[index - 1];
      if (deceleration === undefined || previous === undefined)
        throw new Error("missing braking sample");
      expect(deceleration).toBeGreaterThan(0);
      expect(deceleration).toBeLessThan(previous);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["read", "target", "write"] as const)(
    "should finish an interrupted glide when %s throws",
    (callback) => {
      const failure = new Error("scroll observer failed");
      const completed: boolean[] = [];
      const host = harness(0, 500, false);
      const glide = startGlide(host, 320, (result) => completed.push(result));
      host[callback] = () => {
        throw failure;
      };

      expect(() => vi.advanceTimersByTime(16)).toThrow(failure);

      expect(glide.active).toBe(false);
      expect(completed).toEqual([false]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("should stop inside a cancelled write without touching the host again", () => {
    const host = harness(0, 500, false);
    const completed: boolean[] = [];
    const glide = startGlide(host, 320, (result) => completed.push(result));
    host.write = () => {
      glide.cancel();
      host.read = () => {
        throw new Error("read after cancellation");
      };
    };

    vi.advanceTimersByTime(16);

    expect(glide.active).toBe(false);
    expect(completed).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should release the glide and preserve both errors when cleanup also throws", () => {
    const failure = new Error("write failed");
    const cleanupFailure = new Error("cleanup failed");
    const host = harness(0, 500, false);
    const glide = startGlide(host, 320, () => {
      throw cleanupFailure;
    });
    host.write = () => {
      throw failure;
    };

    let caught: unknown;
    try {
      vi.advanceTimersByTime(16);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([
      failure,
      cleanupFailure,
    ]);
    expect(glide.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

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
    // Nominal: 800ms approach cap + 280ms landing; the landing snaps to
    // the target within a pixel a little before its nominal end.
    expect(doneAt - t0).toBeLessThanOrEqual(1080 + 32);
    expect(doneAt - t0).toBeGreaterThanOrEqual(960);
  });

  it("a long trip never stops slowing down: the approach brakes straight into the landing", () => {
    // Twenty viewports: an approach and the landing. Frame steps must fall
    // monotonically from the first to the last — the seam between the legs
    // is invisible (an asymptotic approach once held a constant speed for
    // its last third, then the landing braked hard).
    const host = harness(0, 14_000, false);
    const writes: number[] = [];
    const write = host.write;
    host.write = (top) => {
      write(top);
      writes.push(top);
    };
    startGlide(host, glidePace(700), () => {});
    vi.advanceTimersByTime(3_000);
    expect(host.top).toBe(14_000);
    const steps = writes.slice(1).map((top, i) => top - (writes[i] as number));
    // The first frame starts the clock; from the second on, each step is no
    // larger than the one before it (a pixel of slack for rounding).
    for (let i = 2; i < steps.length; i++) {
      expect(
        steps[i],
        `frame ${i}: ${steps.slice(i - 3, i + 1).join(",")}`,
      ).toBeLessThanOrEqual((steps[i - 1] as number) + 1);
    }
    expect(steps[1]).toBeGreaterThan(steps[steps.length - 2] as number);
  });
});
