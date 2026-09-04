/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createImageLoader } from "../../demos/gallery/image-loader";

function viewportAt(top: number, height: number): HTMLElement {
  const viewport = document.createElement("div");
  viewport.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height }) as DOMRect;
  return viewport;
}

function imageAt(top: number, height = 100): HTMLImageElement {
  const img = document.createElement("img");
  img.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height }) as DOMRect;
  return img;
}

describe("image loader", () => {
  it("starts the nearest queued image first, and follows the queue as it drains", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const first = imageAt(0);
    const far = imageAt(2000);
    const below = imageAt(900);
    const near = imageAt(100);
    loader.add(first, "u-first"); // Takes the one slot.
    loader.add(far, "u-far");
    loader.add(below, "u-below");
    loader.add(near, "u-near");
    expect(loader.metrics()).toMatchObject({ queued: 3, inFlight: 1 });
    first.dispatchEvent(new Event("load"));
    expect(near.getAttribute("src")).toBe("u-near");
    expect(below.getAttribute("src")).toBeNull();
    near.dispatchEvent(new Event("load"));
    expect(below.getAttribute("src")).toBe("u-below");
    expect(far.getAttribute("src")).toBeNull();
    expect(loader.metrics()).toMatchObject({
      loaded: 2,
      inFlight: 1,
      queued: 1,
      peakQueued: 3,
    });
  });

  it("re-orders the queue when the viewport moves", () => {
    const viewport = viewportAt(0, 600);
    const loader = createImageLoader({ viewport, concurrency: 1 });
    const busy = imageAt(0);
    const a = imageAt(1000);
    const b = imageAt(3000);
    loader.add(busy, "u-busy");
    loader.add(a, "u-a");
    loader.add(b, "u-b");
    viewport.getBoundingClientRect = () =>
      ({ top: 2800, bottom: 3400, height: 600 }) as DOMRect;
    loader.reprioritize();
    busy.dispatchEvent(new Event("load"));
    expect(b.getAttribute("src")).toBe("u-b");
    expect(a.getAttribute("src")).toBeNull();
  });

  it("abandons an image that leaves the scroller and reuses what it has fetched", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const a = imageAt(0);
    const b = imageAt(200);
    loader.add(a, "u-a");
    loader.add(b, "u-b");
    expect(a.getAttribute("src")).toBe("u-a");
    loader.remove(a);
    expect(a.getAttribute("src")).toBeNull();
    expect(b.getAttribute("src")).toBe("u-b"); // The slot passed on.
    b.dispatchEvent(new Event("load"));
    const twin = imageAt(300);
    loader.add(twin, "u-b");
    expect(twin.getAttribute("src")).toBe("u-b");
    expect(twin.classList.contains("loaded")).toBe(true);
    expect(loader.metrics()).toMatchObject({
      cancelled: 1,
      loaded: 1,
      reused: 1,
    });
  });

  it("a second drawing of a source follows the fetch in flight, or the one it is queued behind", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const busy = imageAt(0);
    const first = imageAt(100);
    const second = imageAt(480);
    loader.add(busy, "u-busy");
    loader.add(first, "u-x");
    loader.add(second, "u-x"); // Queued twice: fetched once.
    busy.dispatchEvent(new Event("load"));
    expect(first.getAttribute("src")).toBe("u-x");
    expect(second.getAttribute("src")).toBeNull();
    expect(loader.metrics().inFlight).toBe(1);
    first.dispatchEvent(new Event("load"));
    expect(second.getAttribute("src")).toBe("u-x");
    // busy and first arrived; second was served from the first's fetch.
    expect(loader.metrics()).toMatchObject({
      loaded: 2,
      reused: 1,
      inFlight: 0,
    });
  });

  it("a cancelled leader's followers go back to the queue; a removed follower is forgotten", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const leader = imageAt(0);
    const follower = imageAt(300);
    const gone = imageAt(400);
    loader.add(leader, "u-x");
    loader.add(follower, "u-x");
    loader.add(gone, "u-x");
    loader.remove(gone);
    loader.remove(leader);
    // The follower took the slot with the same source.
    expect(follower.getAttribute("src")).toBe("u-x");
    expect(gone.getAttribute("src")).toBeNull();
    expect(loader.metrics()).toMatchObject({ cancelled: 1, inFlight: 1 });
  });

  it("a stalled download is abandoned: the slot and its followers fail, the next image starts", () => {
    vi.useFakeTimers();
    try {
      const loader = createImageLoader({
        viewport: viewportAt(0, 600),
        concurrency: 1,
      });
      const slow = imageAt(0);
      const twin = imageAt(200);
      const next = imageAt(300);
      loader.add(slow, "u-slow");
      loader.add(twin, "u-slow");
      loader.add(next, "u-next");
      vi.advanceTimersByTime(15_000);
      expect(slow.getAttribute("src")).toBeNull();
      expect(slow.classList.contains("failed")).toBe(true);
      expect(twin.classList.contains("failed")).toBe(true);
      expect(next.getAttribute("src")).toBe("u-next");
      expect(loader.metrics()).toMatchObject({ failed: 1, inFlight: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("raising the concurrency starts more at once", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const a = imageAt(0);
    const b = imageAt(100);
    loader.add(a, "u-a");
    loader.add(b, "u-b");
    expect(b.getAttribute("src")).toBeNull();
    loader.setConcurrency(2);
    expect(b.getAttribute("src")).toBe("u-b");
    expect(loader.metrics()).toMatchObject({ inFlight: 2, concurrency: 2 });
  });
});
