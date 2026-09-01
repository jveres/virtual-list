/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glideDuration, startGlide } from "../../src/lean/glide";

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
