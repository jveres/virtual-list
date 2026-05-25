import { describe, expect, it } from "vitest";
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

describe("FenwickTree perf", () => {
  it("keeps prefix and indexAt fast at 100k items", () => {
    const sizes = new Float64Array(100_000);
    sizes.fill(50);
    const tree = new FenwickTree(sizes);

    const start = performance.now();
    for (let pass = 0; pass < 10_000; pass++) {
      tree.indexAt((pass * 37) % 5_000_000);
      tree.prefix(pass % 100_000);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it("keeps incremental updates fast at 10k items", () => {
    const sizes = new Float64Array(10_000);
    sizes.fill(40);
    const tree = new FenwickTree(sizes);

    const start = performance.now();
    for (let index = 0; index < 10_000; index++) {
      tree.add(index, 1);
      tree.indexAt(index * 40);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
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

    const start = performance.now();
    for (let scrollTop = 0; scrollTop <= 50_000; scrollTop += 500) {
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRaf();
    }
    const elapsed = performance.now() - start;

    expect(virtualizer.state.mountedCount).toBeLessThan(80);
    expect(elapsed).toBeLessThan(4_000);
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
});
