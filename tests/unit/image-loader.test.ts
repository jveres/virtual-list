/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
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
  it("loads nearest first under the concurrency limit, and follows the queue as it drains", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 2,
    });
    const far = imageAt(2000);
    const near = imageAt(100);
    const below = imageAt(900);
    loader.add(far, "u-far");
    loader.add(near, "u-near");
    loader.add(below, "u-below");
    expect([far, near, below].map((i) => i.getAttribute("src"))).toEqual([
      "u-far", // Queued before any other: started at once.
      "u-near",
      null,
    ]);
    expect(loader.metrics()).toMatchObject({
      queued: 1,
      inFlight: 2,
      peakQueued: 1,
      peakInFlight: 2,
    });
    near.dispatchEvent(new Event("load"));
    expect(below.getAttribute("src")).toBe("u-below");
    expect(loader.metrics()).toMatchObject({
      loaded: 1,
      inFlight: 2,
      queued: 0,
    });
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

  it("a second drawing of a source in flight follows it instead of fetching again", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 4,
    });
    const first = imageAt(0);
    const second = imageAt(480);
    loader.add(first, "u-x");
    loader.add(second, "u-x");
    expect(second.getAttribute("src")).toBeNull();
    expect(loader.metrics().inFlight).toBe(1);
    first.dispatchEvent(new Event("load"));
    expect(second.getAttribute("src")).toBe("u-x");
    expect(loader.metrics()).toMatchObject({ loaded: 1, reused: 1 });
  });
});
