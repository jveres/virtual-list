import { describe, expect, it, vi } from "vitest";
import {
  createDynamicVirtualizer,
  type DynamicVirtualizer,
  FenwickTree,
} from "./dynamic-virtualizer.js";

function buildFixedHeightItem(height: number) {
  return (index: number): HTMLElement => {
    const element = document.createElement("div");
    element.className = "perf-item";
    element.style.height = `${height}px`;
    element.textContent = String(index);
    return element;
  };
}

function buildFixedHeightPlaceholder(height: number) {
  return (_index: number): HTMLElement => {
    const element = document.createElement("div");
    element.className = "perf-item perf-item-placeholder";
    element.style.height = `${height}px`;
    return element;
  };
}

async function flushRaf(frames = 2): Promise<void> {
  for (let frame = 0; frame < frames; frame++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createViewport(height = 800): HTMLElement {
  const viewport = document.createElement("div");
  viewport.className = "perf-viewport";
  Object.assign(viewport.style, {
    height: `${height}px`,
    width: "640px",
    overflow: "auto",
  });
  document.body.appendChild(viewport);
  return viewport;
}

function disposeViewport(
  viewport: HTMLElement,
  virtualizer: DynamicVirtualizer,
): void {
  virtualizer.dispose();
  viewport.remove();
}

function visiblePlaceholderCount(viewport: HTMLElement): number {
  return viewport.querySelectorAll('[data-placeholder="true"]').length;
}

describe("FenwickTree perf", () => {
  it("resolves prefix sums and offsets at 100k items", () => {
    const sizes = new Float64Array(100_000);
    sizes.fill(50);
    const tree = new FenwickTree(sizes);

    for (let pass = 0; pass < 10_000; pass++) {
      const offset = (pass * 37) % 5_000_000;
      const count = pass % 100_000;

      expect(tree.indexAt(offset)).toBe(Math.floor(offset / 50));
      expect(tree.prefix(count)).toBe(count * 50);
    }
  });

  it("keeps prefix sums and offsets correct after incremental updates", () => {
    const sizes = new Float64Array(10_000);
    sizes.fill(40);
    const tree = new FenwickTree(sizes);

    for (let index = 0; index < 10_000; index++) {
      tree.add(index, 1);
    }

    expect(tree.total()).toBe(410_000);
    expect(tree.prefix(5_000)).toBe(205_000);
    expect(tree.indexAt(0)).toBe(0);
    expect(tree.indexAt(41 * 5_000 - 1)).toBe(4_999);
    expect(tree.indexAt(41 * 5_000)).toBe(5_000);
  });
});

describe("dynamic virtualizer perf", () => {
  it("bounds mounted count while scrolling 100k fixed-height rows", async () => {
    const viewport = createViewport();
    const itemHeight = 50;
    const count = 100_000;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => count,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      buildPlaceholder: buildFixedHeightPlaceholder(itemHeight),
      overscanPx: 200,
    });

    virtualizer.setCount();
    await virtualizer.scrollToOffset(0);

    for (let scrollTop = 0; scrollTop <= 50_000; scrollTop += 500) {
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();
    }

    expect(virtualizer.state.mountedCount).toBeLessThan(80);
    disposeViewport(viewport, virtualizer);
  });

  it("mounts explicit boundary slots without reach callbacks", () => {
    const viewport = createViewport();
    const itemHeight = 40;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 20,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      overscanPx: 80,
    });

    virtualizer.setCount();
    virtualizer.setBoundarySlot("top", {
      key: "loading",
      height: 48,
      build: () => {
        const element = document.createElement("div");
        element.className = "perf-boundary";
        element.textContent = "Loading";
        return element;
      },
    });

    const topBoundary = virtualizer.getBoundaryElement("top");
    expect(topBoundary).not.toBeNull();
    expect(topBoundary?.isConnected).toBe(true);
    expect(topBoundary?.style.height).toBe("48px");

    virtualizer.setBoundarySlot("top", null);

    expect(virtualizer.getBoundaryElement("top")).toBeNull();
    disposeViewport(viewport, virtualizer);
  });

  it("cleans stale mounted indices outside the active range", async () => {
    const viewport = createViewport();
    const itemHeight = 40;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 5_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      overscanPx: 80,
    });

    virtualizer.setCount();
    await virtualizer.scrollToOffset(0);

    viewport.scrollTop = 400;
    viewport.dispatchEvent(new Event("scroll"));
    await flushRaf();

    const indexes = Array.from(
      viewport.querySelectorAll<HTMLElement>(".perf-item"),
    ).map((element) => Number(element.dataset.index));

    expect(indexes.length).toBeGreaterThan(0);
    expect(
      indexes.every((index) => index >= virtualizer.state.range.start),
    ).toBe(true);
    expect(indexes.every((index) => index < virtualizer.state.range.end)).toBe(
      true,
    );
    disposeViewport(viewport, virtualizer);
  });

  it("unmounts off-screen rows when the visible range shifts incrementally", async () => {
    const viewport = createViewport();
    const itemHeight = 40;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 5_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      overscanPx: 80,
    });

    virtualizer.setCount();
    await virtualizer.scrollToOffset(0);

    const removedIndexes: number[] = [];
    const originalRemove = Element.prototype.remove;
    Element.prototype.remove = function remove(this: Element) {
      const index = Number((this as HTMLElement).dataset.index);
      if (Number.isInteger(index)) removedIndexes.push(index);
      return originalRemove.call(this);
    };

    try {
      viewport.scrollTop = 400;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();
    } finally {
      Element.prototype.remove = originalRemove;
    }

    expect(removedIndexes.length).toBeGreaterThan(0);
    expect(removedIndexes.length).toBeLessThan(
      virtualizer.state.mountedCount + 20,
    );
    disposeViewport(viewport, virtualizer);
  });

  it("mounts real items during fast scroll when buildPlaceholder is omitted", async () => {
    const viewport = createViewport();
    const itemHeight = 50;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 10_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      overscanPx: 200,
    });

    virtualizer.setCount();
    await virtualizer.scrollToOffset(0);

    for (let scrollTop = 0; scrollTop <= 20_000; scrollTop += 400) {
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();
    }

    expect(viewport.querySelectorAll('[data-placeholder="true"]').length).toBe(
      0,
    );
    expect(viewport.querySelectorAll(".perf-item").length).toBeGreaterThan(0);
    expect(virtualizer.state.mountedCount).toBeGreaterThan(0);
    disposeViewport(viewport, virtualizer);
  });

  it("does not enter placeholder mode when threshold is infinite", async () => {
    const viewport = createViewport();
    const itemHeight = 50;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 5_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      buildPlaceholder: buildFixedHeightPlaceholder(itemHeight),
      placeholderVelocityThreshold: Number.POSITIVE_INFINITY,
      overscanPx: 200,
    });

    virtualizer.setCount();
    await virtualizer.scrollToOffset(0);

    for (let scrollTop = 0; scrollTop <= 10_000; scrollTop += 200) {
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();
    }

    expect(viewport.querySelectorAll('[data-placeholder="true"]').length).toBe(
      0,
    );
    expect(viewport.querySelectorAll(".perf-item-placeholder").length).toBe(0);
    expect(viewport.querySelectorAll(".perf-item").length).toBeGreaterThan(0);
    disposeViewport(viewport, virtualizer);
  });

  it("does not wait for final scrollend to hydrate desktop wheel placeholders", async () => {
    const userAgentSpy = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      );
    const viewport = createViewport();
    const itemHeight = 50;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 10_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      buildPlaceholder: buildFixedHeightPlaceholder(itemHeight),
      placeholderVelocityThreshold: 8,
      overscanPx: 200,
    });

    try {
      virtualizer.setCount();
      await virtualizer.scrollToOffset(0);

      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 5_000 }));
      viewport.scrollTop = 5_000;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();

      expect(visiblePlaceholderCount(viewport)).toBeGreaterThan(0);

      viewport.dispatchEvent(new Event("scrollend"));
      await flushRaf();

      expect(visiblePlaceholderCount(viewport)).toBeGreaterThan(0);

      viewport.scrollTop = 5_500;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();

      expect(visiblePlaceholderCount(viewport)).toBeGreaterThan(0);

      for (let sample = 0; sample < 4; sample++) {
        await wait(25);
        viewport.scrollTop += 1;
        viewport.dispatchEvent(new Event("scroll"));
        await flushRaf();
      }

      expect(visiblePlaceholderCount(viewport)).toBe(0);
    } finally {
      userAgentSpy.mockRestore();
      disposeViewport(viewport, virtualizer);
    }
  });

  it("preserves Safari wheel scrollend through edge rubber-band overscroll", async () => {
    const userAgentSpy = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      );
    const viewport = createViewport();
    const onScrollEnd = vi.fn();
    const itemHeight = 50;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 1_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      overscanPx: 200,
      onScrollEnd,
    });

    try {
      virtualizer.setCount();
      viewport.scrollTop = 500;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();

      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1_000 }));
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      viewport.scrollTop = -24;
      viewport.dispatchEvent(new Event("scroll"));
      viewport.dispatchEvent(new Event("scrollend"));

      await wait(180);
      await flushRaf();

      expect(onScrollEnd).not.toHaveBeenCalled();

      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      await wait(180);
      await flushRaf();

      expect(onScrollEnd).toHaveBeenCalledTimes(1);
    } finally {
      userAgentSpy.mockRestore();
      disposeViewport(viewport, virtualizer);
    }
  });

  it("falls back when Safari misses native scrollend after wheel input", async () => {
    const userAgentSpy = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      );
    const viewport = createViewport();
    const onScrollEnd = vi.fn();
    const itemHeight = 50;
    const virtualizer = createDynamicVirtualizer({
      viewport,
      getCount: () => 1_000,
      getItemHeight: () => itemHeight,
      buildItem: buildFixedHeightItem(itemHeight),
      overscanPx: 200,
      onScrollEnd,
    });

    try {
      virtualizer.setCount();
      viewport.scrollTop = 500;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();

      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1_000 }));
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));

      await wait(500);
      await flushRaf();

      expect(onScrollEnd).toHaveBeenCalledTimes(1);
    } finally {
      userAgentSpy.mockRestore();
      disposeViewport(viewport, virtualizer);
    }
  });
});
