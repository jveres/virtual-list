/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let downloads: HTMLImageElement[];

  beforeEach(() => {
    downloads = [];
    vi.useFakeTimers();
    // biome-ignore lint/complexity/useArrowFunction: Image is invoked as a constructor.
    vi.spyOn(window, "Image").mockImplementation(function () {
      const img = document.createElement("img");
      downloads.push(img);
      return img;
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function download(src: string): HTMLImageElement {
    const img = downloads.find((image) => image.getAttribute("src") === src);
    if (!img) throw new Error(`No download started for ${src}`);
    return img;
  }

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
    download("u-first").dispatchEvent(new Event("load"));
    expect(download("u-near").getAttribute("fetchpriority")).toBe("high");
    expect(below.getAttribute("src")).toBeNull();
    download("u-near").dispatchEvent(new Event("load"));
    expect(download("u-below").getAttribute("fetchpriority")).toBe("low");
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
    download("u-busy").dispatchEvent(new Event("load"));
    expect(download("u-b").getAttribute("fetchpriority")).toBe("high");
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
    const abandoned = download("u-a");
    loader.remove(a);
    expect(abandoned.getAttribute("src")).toBeNull();
    download("u-b").dispatchEvent(new Event("load")); // The slot passed on.
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

  it("should skip the entrance fade only for already fetched sources", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const first = imageAt(0);
    loader.add(first, "u-photo");
    download("u-photo").dispatchEvent(new Event("load"));
    const remounted = imageAt(100);

    loader.add(remounted, "u-photo");

    expect(first.classList.contains("cached")).toBe(false);
    expect(remounted.classList.contains("cached")).toBe(true);
    expect(remounted.classList.contains("loaded")).toBe(true);
    expect(remounted.getAttribute("src")).toBe("u-photo");

    loader.add(remounted, "u-new-photo");

    expect(remounted.classList.contains("cached")).toBe(false);
    expect(remounted.classList.contains("loaded")).toBe(false);
    expect(remounted.getAttribute("src")).toBeNull();
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
    loader.add(second, "u-x");
    expect(loader.metrics().queued).toBe(1);
    download("u-busy").dispatchEvent(new Event("load"));
    expect(second.getAttribute("src")).toBeNull();
    expect(loader.metrics().inFlight).toBe(1);
    download("u-x").dispatchEvent(new Event("load"));
    expect(first.getAttribute("src")).toBe("u-x");
    expect(second.getAttribute("src")).toBe("u-x");
    // busy and first arrived; second was served from the first's fetch.
    expect(loader.metrics()).toMatchObject({
      loaded: 2,
      reused: 1,
      inFlight: 0,
    });
  });

  it("should keep the original download when its first tile leaves and forget removed subscribers", () => {
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
    const original = download("u-x");
    loader.remove(gone);
    loader.remove(leader);
    expect(original.getAttribute("src")).toBe("u-x");
    expect(downloads).toHaveLength(1);
    expect(loader.metrics()).toMatchObject({
      cancelled: 0,
      inFlight: 1,
      queued: 0,
    });
    original.dispatchEvent(new Event("load"));
    expect(follower.getAttribute("src")).toBe("u-x");
    expect(gone.getAttribute("src")).toBeNull();
    expect(leader.getAttribute("src")).toBeNull();
    expect(loader.metrics()).toMatchObject({
      cancelled: 0,
      loaded: 1,
      inFlight: 0,
    });
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
      const stalled = download("u-slow");
      vi.advanceTimersByTime(15_000);
      expect(stalled.getAttribute("src")).toBeNull();
      expect(slow.classList.contains("failed")).toBe(true);
      expect(twin.classList.contains("failed")).toBe(true);
      expect(download("u-next").getAttribute("src")).toBe("u-next");
      expect(loader.metrics()).toMatchObject({ failed: 1, inFlight: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("should cancel only after the last subscriber leaves and ignore late events", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const first = imageAt(0);
    const second = imageAt(200);
    const next = imageAt(300);
    loader.add(first, "shared");
    loader.add(second, "shared");
    loader.add(next, "next");
    const original = download("shared");

    loader.remove(first);
    loader.remove(second);
    loader.remove(second);
    original.dispatchEvent(new Event("load"));
    original.dispatchEvent(new Event("error"));

    expect(original.getAttribute("src")).toBeNull();
    expect(download("next").getAttribute("src")).toBe("next");
    expect(loader.metrics()).toMatchObject({
      cancelled: 1,
      loaded: 0,
      failed: 0,
      inFlight: 1,
    });
    expect(first.getAttribute("src")).toBeNull();
    expect(second.getAttribute("src")).toBeNull();
  });

  it("should use the nearest queued subscriber and update priority when it leaves", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const busy = imageAt(0);
    const far = imageAt(2000);
    const near = imageAt(100);
    const middle = imageAt(900);
    loader.add(busy, "busy");
    loader.add(far, "shared");
    loader.add(near, "shared");
    loader.add(near, "shared");
    loader.add(middle, "middle");

    loader.remove(near);
    download("busy").dispatchEvent(new Event("load"));

    expect(download("middle").getAttribute("src")).toBe("middle");
    expect(loader.metrics()).toMatchObject({
      queued: 1,
      inFlight: 1,
      cancelled: 0,
    });
    loader.remove(far);
    expect(loader.metrics().queued).toBe(0);
  });

  it("should prioritize a shared source when a nearer subscriber joins its queue", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    loader.add(imageAt(0), "busy");
    loader.add(imageAt(2000), "shared");
    loader.add(imageAt(900), "middle");
    loader.add(imageAt(100), "shared");

    download("busy").dispatchEvent(new Event("load"));

    expect(download("shared").getAttribute("fetchpriority")).toBe("high");
    expect(loader.metrics()).toMatchObject({ queued: 1, inFlight: 1 });
  });

  it("should isolate a reused tile from completion of its previous source", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 2,
    });
    const tile = imageAt(0);
    const remaining = imageAt(100);
    loader.add(tile, "old");
    loader.add(remaining, "old");

    loader.add(tile, "new");
    download("old").dispatchEvent(new Event("load"));

    expect(remaining.getAttribute("src")).toBe("old");
    expect(tile.getAttribute("src")).toBeNull();
    download("new").dispatchEvent(new Event("load"));
    expect(tile.getAttribute("src")).toBe("new");
    expect(loader.metrics()).toMatchObject({
      loaded: 2,
      cancelled: 0,
      inFlight: 0,
    });
  });

  it("should fail remaining subscribers after the first tile leaves and allow retry", () => {
    const loader = createImageLoader({
      viewport: viewportAt(0, 600),
      concurrency: 1,
    });
    const first = imageAt(0);
    const second = imageAt(200);
    loader.add(first, "shared");
    loader.add(second, "shared");
    loader.remove(first);

    download("shared").dispatchEvent(new Event("error"));

    expect(first.classList.contains("failed")).toBe(false);
    expect(second.classList.contains("failed")).toBe(true);
    expect(loader.metrics()).toMatchObject({
      failed: 1,
      cancelled: 0,
      inFlight: 0,
    });
    loader.add(second, "shared");
    expect(second.classList.contains("failed")).toBe(false);
    const retry = downloads[1];
    if (!retry) throw new Error("Retry did not start");
    retry.dispatchEvent(new Event("load"));
    expect(second.getAttribute("src")).toBe("shared");
    expect(loader.metrics()).toMatchObject({
      failed: 1,
      loaded: 1,
      inFlight: 0,
    });
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
    expect(download("u-b").getAttribute("src")).toBe("u-b");
    expect(loader.metrics()).toMatchObject({ inFlight: 2, concurrency: 2 });
  });
});
