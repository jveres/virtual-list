/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createVirtualList, type VirtualList } from "../../src/virtual-list";

interface DestroyRecord {
  index: number;
  element: HTMLElement;
}

interface LifecycleHarness {
  list: VirtualList;
  viewport: HTMLElement;
  destroyed: DestroyRecord[];
  setRows(rows: readonly string[]): void;
}

type DestroyHandler = (
  index: number,
  element: HTMLElement,
  list: VirtualList,
) => void;

const liveHarnesses: LifecycleHarness[] = [];

function mountLifecycleList(
  initialRows: readonly string[],
  onDestroy?: DestroyHandler,
): LifecycleHarness {
  const viewport = document.createElement("div");
  document.body.appendChild(viewport);

  let rows = [...initialRows];
  let activeList: VirtualList | null = null;
  const destroyed: DestroyRecord[] = [];
  const list = createVirtualList({
    viewport,
    renderMode: "full",
    getCount: () => rows.length,
    getItemHeight: () => 50,
    buildItem: (index) => {
      const row = rows[index];
      if (row === undefined) throw new Error(`missing row ${index}`);
      const element = document.createElement("div");
      element.dataset.row = row;
      return element;
    },
    destroyItem: (index, element) => {
      destroyed.push({ index, element });
      if (!onDestroy) return;
      if (!activeList) throw new Error("list unavailable during destroyItem");
      onDestroy(index, element, activeList);
    },
  });
  activeList = list;

  const harness: LifecycleHarness = {
    list,
    viewport,
    destroyed,
    setRows(nextRows) {
      rows = [...nextRows];
    },
  };
  liveHarnesses.push(harness);
  return harness;
}

function mountedElements(list: VirtualList, count: number): HTMLElement[] {
  return Array.from({ length: count }, (_, index) => {
    const element = list.getMountedElement(index);
    if (!element) throw new Error(`missing mounted element ${index}`);
    return element;
  });
}

afterEach(() => {
  for (const { list, viewport } of liveHarnesses.splice(0)) {
    list.dispose();
    viewport.remove();
  }
});

describe("destroyItem lifecycle reentrancy", () => {
  it("should expose committed remove-before state to refresh and sync reentry", () => {
    let trigger: HTMLElement | null = null;
    let observedAtRemovedIndex: HTMLElement | null = null;
    let reentered = false;
    const harness = mountLifecycleList(
      ["0", "1", "2", "3", "4", "5"],
      (index, element, list) => {
        if (element !== trigger || reentered) return;
        reentered = true;
        observedAtRemovedIndex = list.getMountedElement(index);
        list.refreshIndex(index);
        list.syncLayout();
      },
    );
    const before = mountedElements(harness.list, 6);
    trigger = before[0] ?? null;

    harness.setRows(["2", "3", "4", "5"]);
    expect(() => harness.list.setCount({ removedBefore: 2 })).not.toThrow();

    expect(observedAtRemovedIndex).toBe(before[2]);
    expect(harness.list.state.count).toBe(4);
    expect(
      Array.from(
        { length: 4 },
        (_, index) =>
          harness.list.getMountedElement(index)?.dataset.row ?? null,
      ),
    ).toStrictEqual(["2", "3", "4", "5"]);
    expect(harness.list.getMountedElement(0)).not.toBe(before[2]);
    expect(harness.list.getMountedElement(1)).toBe(before[3]);
    expect(harness.list.getMountedElement(2)).toBe(before[4]);
    expect(harness.list.getMountedElement(3)).toBe(before[5]);
    expect(harness.destroyed.map(({ element }) => element)).toStrictEqual([
      before[0],
      before[1],
      before[2],
    ]);
  });

  it("should destroy each mounted row once when dispose reenters dispose", () => {
    let trigger: HTMLElement | null = null;
    let reentered = false;
    const harness = mountLifecycleList(
      ["0", "1", "2"],
      (_index, element, list) => {
        if (element !== trigger || reentered) return;
        reentered = true;
        list.dispose();
      },
    );
    const before = mountedElements(harness.list, 3);
    trigger = before[0] ?? null;

    expect(() => harness.list.dispose()).not.toThrow();

    expect(harness.destroyed.map(({ element }) => element)).toStrictEqual(
      before,
    );
    expect(
      Array.from({ length: 3 }, (_, index) =>
        harness.list.getMountedElement(index),
      ),
    ).toStrictEqual([null, null, null]);
    harness.list.dispose();
    expect(harness.destroyed.map(({ element }) => element)).toStrictEqual(
      before,
    );
  });

  it("should destroy every row once when count-shrink teardown disposes the list", () => {
    let trigger: HTMLElement | null = null;
    let disposedFromTeardown = false;
    const harness = mountLifecycleList(
      ["0", "1", "2", "3", "4"],
      (_index, element, list) => {
        if (element !== trigger || disposedFromTeardown) return;
        disposedFromTeardown = true;
        list.dispose();
      },
    );
    const before = mountedElements(harness.list, 5);
    trigger = before[3] ?? null;
    harness.setRows(["0", "1", "2"]);

    expect(() => harness.list.setCount()).not.toThrow();

    const destroyedElements = harness.destroyed.map(({ element }) => element);
    expect(destroyedElements).toHaveLength(before.length);
    expect(new Set(destroyedElements)).toStrictEqual(new Set(before));
    expect(
      Array.from({ length: 5 }, (_, index) =>
        harness.list.getMountedElement(index),
      ),
    ).toStrictEqual([null, null, null, null, null]);
    expect(harness.viewport.querySelector(".vl-content")).toBeNull();
  });

  it("should deliver nested teardown before the nested layout after callback", () => {
    const events: string[] = [];
    let trigger: HTMLElement | null = null;
    let nested = false;
    let harness: LifecycleHarness;
    harness = mountLifecycleList(
      ["0", "1", "2", "3", "4"],
      (index, element, list) => {
        events.push(`destroy:${element.dataset.row}`);
        if (element !== trigger || nested) return;
        nested = true;
        harness.setRows(["0", "1", "2"]);
        list.syncLayout({
          after: () => events.push("after:nested"),
        });
        expect(index).toBe(4);
      },
    );
    trigger = harness.list.getMountedElement(4);
    harness.setRows(["0", "1", "2", "3"]);

    harness.list.setCount();

    expect(events).toStrictEqual(["destroy:4", "destroy:3", "after:nested"]);
  });

  it("should preserve both a build failure and post-commit teardown failure", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let failRefresh = false;
    const list = createVirtualList({
      viewport,
      renderMode: "full",
      getCount: () => 2,
      getItemHeight: () => 50,
      buildItem: (index) => {
        if (failRefresh && index === 1) throw new Error("build failure");
        return document.createElement("div");
      },
      destroyItem: (index) => {
        if (failRefresh && index === 0) throw new Error("destroy failure");
      },
    });
    liveHarnesses.push({
      list,
      viewport,
      destroyed: [],
      setRows: () => {},
    });
    failRefresh = true;

    let caught: unknown;
    try {
      list.refreshFrom(0);
    } catch (error) {
      caught = error;
    } finally {
      failRefresh = false;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors.map((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(messages).toStrictEqual(["build failure", "destroy failure"]);
  });

  it("should continue later deferred layouts after an earlier teardown fails", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    (
      viewport as unknown as { scrollTo: (options: ScrollToOptions) => void }
    ).scrollTo = () => {};
    let count = 3;
    let failFirstTeardown = true;
    let secondApplied = false;
    let scrollEnded = false;
    const list = createVirtualList({
      viewport,
      renderMode: "full",
      getCount: () => count,
      getItemHeight: () => 50,
      buildItem: () => document.createElement("div"),
      destroyItem: (index) => {
        if (index !== 2 || !failFirstTeardown) return;
        failFirstTeardown = false;
        throw new Error("first teardown failed");
      },
      onScrollEnd: () => {
        scrollEnded = true;
      },
    });
    liveHarnesses.push({
      list,
      viewport,
      destroyed: [],
      setRows: () => {},
    });

    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 8 }));
    list.syncLayout({
      apply: () => {
        count = 2;
        return true;
      },
    });
    list.syncLayout({
      apply: () => {
        count = 4;
        secondApplied = true;
        return true;
      },
    });

    let caught: unknown;
    try {
      list.interruptScroll();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("first teardown failed");
    expect(secondApplied).toBe(true);
    expect(scrollEnded).toBe(true);
    expect(list.state.count).toBe(4);
    expect(list.getMountedElement(3)).not.toBeNull();
  });
});
