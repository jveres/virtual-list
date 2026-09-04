import { describe, expect, it } from "vitest";
import {
  ChromiumWheelPolicy,
  FirefoxWheelPolicy,
} from "../../src/wheel-policy";

describe("Firefox wheel release policy", () => {
  it("postpones a decaying tail without contesting its release", () => {
    const policy = new FirefoxWheelPolicy();
    policy.recordInput(0);
    policy.observeDelta(6, true);
    policy.setRelease(true);
    policy.recordInput(100);
    policy.observeDelta(4, true);
    expect(policy.releaseDelay(200)).toBe(350);
    expect(policy.releaseDelay(550)).toBe(0);
  });

  it.each([
    [8, true],
    [-4, true],
    [1, false],
  ] as const)(
    "invalidates the release after delta %s in pixel mode %s",
    (delta, pixelMode) => {
      const policy = new FirefoxWheelPolicy();
      policy.observeDelta(4, true);
      policy.setRelease(true);
      policy.recordInput(100);
      expect(policy.observeDelta(delta, pixelMode)).toBe(true);
      expect(policy.hasRelease).toBe(false);
      policy.setRelease(true);
      expect(policy.releaseDelay(200)).toBe(350);
    },
  );
});

describe("Chromium wheel release policy", () => {
  it("suppresses an edge release until the edge is released", () => {
    const policy = new ChromiumWheelPolicy();
    policy.wheel("bottom");
    policy.scrollEnd(true);
    expect(policy.idle("bottom")).toBe("edge");
    expect(policy.awaitingEnd).toBe(true);
    expect(policy.suppressed).toBe(true);
    policy.releaseEdge();
    expect(policy.awaitingEnd).toBe(false);
    expect(policy.suppressed).toBe(false);
    expect(policy.edge).toBeNull();
  });

  it("chooses the stall fallback when input consumed the only scrollend", () => {
    const policy = new ChromiumWheelPolicy();
    policy.scrollEnd(true);
    policy.cancelPendingEnd();
    policy.wheel(null);
    expect(policy.idle(null)).toBe("stall");
    policy.scrollEnd(false);
    expect(policy.idle(null)).toBe("release");
  });
});
