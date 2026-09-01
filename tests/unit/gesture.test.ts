/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGestureSensor, detectGestureStrategy } from "../../src/gesture";

// jsdom exercises only the classification core and the default
// (scrollend + cooldown) settle path; the chromium/firefox/safari wheel
// lifecycles encode empirically verified engine behavior and are validated
// at the real-browser gauntlet — jsdom cannot model momentum or overscroll.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function makeViewport(contentHeight = 10_000): HTMLElement {
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "clientHeight", { get: () => 600 });
  Object.defineProperty(viewport, "scrollHeight", {
    get: () => contentHeight,
  });
  document.body.appendChild(viewport);
  return viewport;
}

function scrollTo(viewport: HTMLElement, top: number): void {
  viewport.scrollTop = top;
  viewport.dispatchEvent(new Event("scroll"));
}

function scrollEnd(viewport: HTMLElement): void {
  viewport.dispatchEvent(new Event("scrollend"));
}

describe("gesture sensor (default strategy)", () => {
  it("detects engine strategies from the user agent", () => {
    expect(detectGestureStrategy("Mozilla/5.0 Firefox/130.0")).toBe(
      "firefox-wheel",
    );
    expect(
      detectGestureStrategy("Mozilla/5.0 Version/18.0 Safari/605.1.15"),
    ).toBe("safari-wheel");
    expect(detectGestureStrategy("Mozilla/5.0 Chrome/128.0")).toBe(
      "chromium-wheel",
    );
    expect(detectGestureStrategy("Mozilla/5.0 jsdom/24.0")).toBe("default");
  });

  it("does not treat pre-announced programmatic writes as gestures", () => {
    const viewport = makeViewport();
    const sensor = createGestureSensor(viewport, {}, "default");
    sensor.expectWrite(500);
    scrollTo(viewport, 500);
    expect(sensor.active).toBe(false);
    sensor.dispose();
  });

  it("starts on an unmatched scroll and settles after scrollend + cooldown", () => {
    const viewport = makeViewport();
    let started = 0;
    let settled = 0;
    const sensor = createGestureSensor(
      viewport,
      {
        onStart: () => {
          started += 1;
        },
        onSettle: () => {
          settled += 1;
        },
      },
      "default",
    );

    scrollTo(viewport, 700);
    expect(sensor.active).toBe(true);
    expect(started).toBe(1);
    expect(settled).toBe(0);

    scrollEnd(viewport);
    expect(settled).toBe(0); // The cooldown has not elapsed.
    vi.advanceTimersByTime(200);
    expect(settled).toBe(1);
    expect(sensor.active).toBe(false);
    sensor.dispose();
  });

  it("never settles while rubber-band overscrolled", () => {
    const viewport = makeViewport(1000); // max scrollTop = 400
    const sensor = createGestureSensor(viewport, {}, "default");

    scrollTo(viewport, 450); // Past the range: rubber-banded.
    scrollEnd(viewport);
    vi.advanceTimersByTime(1000);
    expect(sensor.active).toBe(true); // Held open until the position is sane.
    sensor.dispose();
  });

  it("interrupt() cancels the gesture and settles synchronously", () => {
    const viewport = makeViewport();
    let settled = 0;
    const sensor = createGestureSensor(
      viewport,
      {
        onSettle: () => {
          settled += 1;
        },
      },
      "default",
    );

    scrollTo(viewport, 700);
    expect(sensor.active).toBe(true);

    sensor.interrupt();
    expect(sensor.active).toBe(false);
    expect(settled).toBe(1);

    // The momentum-cancel write was pre-announced: its scroll event must
    // not restart the gesture.
    viewport.dispatchEvent(new Event("scroll"));
    expect(sensor.active).toBe(false);

    // interrupt with no active gesture is a no-op.
    sensor.interrupt();
    expect(settled).toBe(1);
    sensor.dispose();
  });

  it("a user scroll cancels an in-flight glide via the hook", () => {
    const viewport = makeViewport();
    let cancelled = 0;
    const sensor = createGestureSensor(
      viewport,
      {
        cancelSmoothScroll: () => {
          cancelled += 1;
        },
      },
      "default",
    );

    scrollTo(viewport, 700);
    expect(cancelled).toBe(1);
    sensor.dispose();
  });

  it("ignores scrollends while a programmatic glide is mid-flight", () => {
    const viewport = makeViewport();
    let settled = 0;
    let glideActive = true;
    const sensor = createGestureSensor(
      viewport,
      {
        onSettle: () => {
          settled += 1;
        },
        smoothScrollActive: () => glideActive,
      },
      "default",
    );

    scrollTo(viewport, 700); // Gesture starts (cancels the glide in real use).
    scrollEnd(viewport); // Emitted mid-glide: not the user's release.
    vi.advanceTimersByTime(1000);
    expect(settled).toBe(0);
    expect(sensor.active).toBe(true);

    glideActive = false;
    scrollEnd(viewport); // The real release.
    vi.advanceTimersByTime(200);
    expect(settled).toBe(1);
    sensor.dispose();
  });
});
