/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFollowBottomController,
  type FollowBottomController,
  type FollowBottomHost,
} from "../../src/follow-bottom";
import { createMeasurementQueue } from "../../src/measurement-queue";

interface FollowHarness {
  controller: FollowBottomController;
  queueMeasurement(): void;
  setDisposed(disposed: boolean): void;
  renders(): number;
  drains(): number;
  scrollTop(): number;
}

function createHarness(
  changesGeometry: boolean,
  correctsToBottom = false,
  suppressSubpixelWrite = false,
): FollowHarness {
  const viewport = document.createElement("div");
  let scrollHeight = 1_000;
  let scrollTop = changesGeometry && !correctsToBottom ? 200 : 800;
  const clientHeight = 200;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => clientHeight },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(scrollHeight - clientHeight, value));
      },
    },
  });

  let controller: FollowBottomController | null = null;
  let disposed = false;
  let renderCount = 0;
  let drainCount = 0;
  const measurementQueue = createMeasurementQueue({
    isDisposed: () => disposed,
    isUserScrollActive: () => false,
    itemCount: () => 1,
    followLoopDrains: () => controller?.isActive() ?? false,
    wakeFollowLoop: () => controller?.wake(),
    drain: () => {
      drainCount++;
      if (changesGeometry) {
        scrollHeight = 1_200;
        if (correctsToBottom) {
          viewport.scrollTop = suppressSubpixelWrite ? 999.75 : 1_000;
        }
      }
      return changesGeometry;
    },
    render: () => {
      renderCount++;
    },
  });
  const host: FollowBottomHost = {
    viewport,
    defaultSmoothDuration: 300,
    defaultSnapThreshold: suppressSubpixelWrite ? 0 : 1,
    isDisposed: () => disposed,
    isUserScrollActive: () => false,
    hasContent: () => true,
    syncContentHeight: () => {},
    flushMeasurementsNow: () =>
      measurementQueue.flushNow({ deferRender: true }).needsRender,
    writeScrollTop: (top) => {
      const previous = scrollTop;
      if (Math.abs(top - previous) <= 0.5) return false;
      viewport.scrollTop = top;
      return scrollTop !== previous;
    },
    renderNow: () => {
      renderCount++;
    },
    onStopped: () => {},
  };
  controller = createFollowBottomController(host);

  return {
    controller,
    queueMeasurement: () => measurementQueue.queue(0, 50),
    setDisposed: (next) => {
      disposed = next;
    },
    renders: () => renderCount,
    drains: () => drainCount,
    scrollTop: () => scrollTop,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bottom follow frame", () => {
  it("should stay inactive when follow is requested after disposal", () => {
    const harness = createHarness(false);
    harness.setDisposed(true);

    harness.controller.follow();
    vi.advanceTimersByTime(17);

    expect(harness.controller.isActive()).toBe(false);
    expect(harness.drains()).toBe(0);
    expect(harness.renders()).toBe(0);
  });

  it("should coalesce measurement growth and a scroll write into one render", () => {
    const harness = createHarness(true);
    harness.controller.follow();
    harness.queueMeasurement();

    vi.advanceTimersByTime(17);

    expect(harness.drains()).toBe(1);
    expect(harness.scrollTop()).toBe(1_000);
    expect(harness.renders()).toBe(1);
    harness.controller.stop();
  });

  it("should skip rendering an unchanged measurement at the settled bottom", () => {
    const harness = createHarness(false);
    harness.controller.follow();
    harness.queueMeasurement();

    vi.advanceTimersByTime(17);

    expect(harness.drains()).toBe(1);
    expect(harness.scrollTop()).toBe(800);
    expect(harness.renders()).toBe(0);
    harness.controller.stop();
  });

  it("should render growth already corrected to the new bottom", () => {
    const harness = createHarness(true, true);
    harness.controller.follow();
    harness.queueMeasurement();

    vi.advanceTimersByTime(17);

    expect(harness.drains()).toBe(1);
    expect(harness.scrollTop()).toBe(1_000);
    expect(harness.renders()).toBe(1);
    harness.controller.stop();
  });

  it("should render changed geometry when a smooth write is subpixel", () => {
    const harness = createHarness(true, true, true);
    harness.controller.follow();
    harness.queueMeasurement();

    vi.advanceTimersByTime(17);

    expect(harness.drains()).toBe(1);
    expect(harness.scrollTop()).toBe(999.75);
    expect(harness.renders()).toBe(1);
    harness.controller.stop();
  });
});
