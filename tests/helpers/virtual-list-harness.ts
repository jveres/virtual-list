import {
  createVirtualList,
  type VirtualList,
  type VirtualListConfig,
} from "../../src/virtual-list";

// A deterministic createVirtualList harness for the layout-independent contract
// tests. renderMode "full" mounts every row regardless of geometry, and the
// ResizeObserver stub (tests/setup.ts) never fires, so heights stay at their
// modeled getItemHeight values — the build/reuse/destroy bookkeeping is fully
// observable without a real browser.

export interface ListHarness {
  list: VirtualList;
  viewport: HTMLElement;
  /** Indices passed to buildItem, in call order. */
  builds: number[];
  /** Indices passed to destroyItem, in call order. */
  destroys: number[];
  /** Indices passed to recycleItem, in call order (only when recycle: true). */
  recycles: number[];
  /** Set the value getCount() returns; follow with list.setCount()/syncLayout. */
  setCountValue: (next: number) => void;
  /** Mounted element per index for the current count (null when unmounted). */
  mountedElements: () => Array<HTMLElement | null>;
}

interface HarnessOptions {
  itemHeight?: (index: number) => number;
  recycle?: boolean;
}

const liveHarnesses: ListHarness[] = [];

export function mountFullList(
  initialCount: number,
  options: HarnessOptions = {},
): ListHarness {
  const viewport = document.createElement("div");
  document.body.appendChild(viewport);

  let count = initialCount;
  const builds: number[] = [];
  const destroys: number[] = [];
  const recycles: number[] = [];
  const itemHeight = options.itemHeight ?? (() => 50);

  const config: VirtualListConfig = {
    viewport,
    renderMode: "full",
    getCount: () => count,
    getItemHeight: itemHeight,
    buildItem: (index) => {
      builds.push(index);
      const element = document.createElement("div");
      element.dataset.index = String(index);
      element.textContent = `item ${index}`;
      return element;
    },
    destroyItem: (index) => {
      destroys.push(index);
    },
  };

  if (options.recycle) {
    config.recycleItem = (index, element) => {
      recycles.push(index);
      element.dataset.index = String(index);
      element.textContent = `item ${index}`;
    };
  }

  const list = createVirtualList(config);
  const harness: ListHarness = {
    list,
    viewport,
    builds,
    destroys,
    recycles,
    setCountValue: (next) => {
      count = next;
    },
    mountedElements: () =>
      Array.from({ length: count }, (_, index) =>
        list.getMountedElement(index),
      ),
  };
  liveHarnesses.push(harness);
  return harness;
}

// Dispose is idempotent, so calling this in afterEach is safe even for tests
// that already disposed their own list.
export function cleanupHarnesses(): void {
  for (const harness of liveHarnesses.splice(0)) {
    harness.list.dispose();
    harness.viewport.remove();
  }
}
