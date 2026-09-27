/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeGlide } from "../../src/native-glide";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(start = 0, destination = 1000) {
  const viewport = document.createElement("div");
  viewport.scrollTop = start;
  viewport.scrollTo = vi.fn();
  const complete = vi.fn();
  let target = destination;
  const glide = startNativeGlide(viewport, () => target, complete);
  return {
    viewport,
    complete,
    glide,
    target(value: number) {
      target = value;
    },
    move(value: number) {
      viewport.scrollTop = value;
      viewport.dispatchEvent(new Event("scroll"));
    },
    end() {
      viewport.dispatchEvent(new Event("scrollend"));
    },
    start() {
      vi.advanceTimersByTime(16);
    },
  };
}

describe("native glide completion", () => {
  it("should stop the old browser destination when the live target arrives first", () => {
    const h = setup();
    h.start();
    h.target(400);
    h.move(400);
    vi.advanceTimersByTime(120);

    expect(h.complete).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.viewport.scrollTo).toHaveBeenLastCalledWith({
      top: 400,
      behavior: "instant",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should complete a no-op asynchronously without issuing an animation", () => {
    const h = setup(1000);
    expect(h.complete).not.toHaveBeenCalled();
    h.start();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.viewport.scrollTo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should retain the original failure if stopping also fails", () => {
    const h = setup();
    const requestError = new Error("request failed");
    const stopError = new Error("stop failed");
    vi.mocked(h.viewport.scrollTo)
      .mockImplementation(() => {
        throw stopError;
      })
      .mockImplementationOnce(() => {
        throw requestError;
      });

    let failure: unknown;
    try {
      h.start();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ errors: [requestError, stopError] });
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.glide.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should wait for the actual destination despite stale and premature ends", () => {
    const h = setup();
    h.start();
    h.end();
    h.move(400);
    h.end();
    vi.advanceTimersByTime(140);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 1000,
      behavior: "smooth",
    });
    h.move(1000);
    h.end();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(true);
    h.end();
    vi.advanceTimersByTime(3000);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should confirm arrival without scrollend, including fractional flooring", () => {
    const h = setup(0, 1000.25);
    h.start();
    h.move(1000);
    vi.advanceTimersByTime(120);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should follow a moved destination after the current leg ends", () => {
    const h = setup();
    h.start();
    h.target(1500);
    h.move(1000);
    h.end();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.viewport.scrollTo).toHaveBeenLastCalledWith({
      top: 1500,
      behavior: "smooth",
    });
    h.move(1500);
    h.end();
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("should reject a stationary unfinished command instead of declaring success", () => {
    const h = setup();
    h.start();
    vi.advanceTimersByTime(2200);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.viewport.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      behavior: "instant",
    });
    expect(h.glide.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should cancel before the first frame without issuing a scroll", () => {
    const h = setup();
    h.glide.cancel();
    vi.advanceTimersByTime(3000);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.viewport.scrollTo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should cancel the native animation and ignore its trailing events", () => {
    const h = setup();
    h.start();
    h.move(400);
    h.glide.cancel();
    h.end();
    h.move(1000);
    vi.advanceTimersByTime(3000);
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.viewport.scrollTo).toHaveBeenLastCalledWith({
      top: 400,
      behavior: "instant",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
