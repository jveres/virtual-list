/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createVirtualList,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list";

const VIEWPORT_HEIGHT = 100;
const VIEWPORT_WIDTH = 300;
const MODELED_HEIGHT = 50;
const OFFSCREEN_INDEX = 50;
const MEASURED_HEIGHT = 123;
const UPDATED_MEASURED_HEIGHT = 177;

interface Item {
  id: string;
  measuredHeight: number;
}

interface DestroyCall {
  index: number;
  element: HTMLElement;
}

type BuildHook = (index: number, element: HTMLElement, item: Item) => void;
type DestroyHook = (index: number, element: HTMLElement) => void;

interface ReentrancyHarness {
  list: VirtualList;
  viewport: HTMLElement;
  destroyCalls: DestroyCall[];
  rangeChanges: VirtualListState[];
  items: () => readonly Item[];
  setItems: (next: Item[]) => void;
  setBuildHook: (hook: BuildHook | null) => void;
  setDestroyHook: (hook: DestroyHook | null) => void;
}

const liveHarnesses: ReentrancyHarness[] = [];

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    measuredHeight:
      index === OFFSCREEN_INDEX ? MEASURED_HEIGHT : MODELED_HEIGHT,
  }));
}

function measuredRect(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: VIEWPORT_WIDTH,
    top: 0,
    width: VIEWPORT_WIDTH,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function requireElement(
  element: HTMLElement | null,
  label: string,
): HTMLElement {
  expect(element, label).not.toBeNull();
  if (!element) throw new Error(`missing ${label}`);
  return element;
}

function mountReentrantList(initialItems = makeItems(100)): ReentrancyHarness {
  const viewport = document.createElement("div");
  document.body.appendChild(viewport);

  const contentHeight = (): number => {
    const content = viewport.firstElementChild;
    return content instanceof HTMLElement
      ? Number.parseFloat(content.style.height || "0")
      : 0;
  };
  const maxScrollTop = (): number =>
    Math.max(0, Math.max(VIEWPORT_HEIGHT, contentHeight()) - VIEWPORT_HEIGHT);

  let scrollTop = 0;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_HEIGHT },
    clientWidth: { get: () => VIEWPORT_WIDTH },
    offsetWidth: { get: () => VIEWPORT_WIDTH },
    scrollHeight: {
      get: () => Math.max(VIEWPORT_HEIGHT, contentHeight()),
    },
    scrollTop: {
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.max(0, Math.min(maxScrollTop(), next));
      },
    },
  });
  (
    viewport as unknown as { scrollTo: (options: ScrollToOptions) => void }
  ).scrollTo = (options) => {
    if (options.top !== undefined) viewport.scrollTop = options.top;
  };

  let items = initialItems;
  let buildHook: BuildHook | null = null;
  let destroyHook: DestroyHook | null = null;
  let buildSequence = 0;
  const destroyCalls: DestroyCall[] = [];
  const rangeChanges: VirtualListState[] = [];

  const list = createVirtualList({
    viewport,
    getCount: () => items.length,
    getItemHeight: () => MODELED_HEIGHT,
    overscanPx: 0,
    scrollSettleStrategy: "default",
    buildItem: (index) => {
      const item = items[index];
      if (!item) throw new Error(`cannot build missing item ${index}`);

      const element = document.createElement("div");
      element.dataset.identity = item.id;
      element.dataset.buildSequence = String(buildSequence++);
      Object.defineProperty(element, "getBoundingClientRect", {
        value: () => measuredRect(item.measuredHeight),
      });
      buildHook?.(index, element, item);
      return element;
    },
    destroyItem: (index, element) => {
      destroyCalls.push({ index, element });
      destroyHook?.(index, element);
    },
    onRangeChange: (state) => rangeChanges.push(state),
  });

  const harness: ReentrancyHarness = {
    list,
    viewport,
    destroyCalls,
    rangeChanges,
    items: () => items,
    setItems: (next) => {
      items = next;
    },
    setBuildHook: (hook) => {
      buildHook = hook;
    },
    setDestroyHook: (hook) => {
      destroyHook = hook;
    },
  };
  liveHarnesses.push(harness);
  return harness;
}

function modeledHeightAt(list: VirtualList, index: number): number {
  return list.getItemOffset(index + 1) - list.getItemOffset(index);
}

function destroyCountFor(
  calls: readonly DestroyCall[],
  element: HTMLElement,
): number {
  return calls.filter((call) => call.element === element).length;
}

afterEach(() => {
  for (const harness of liveHarnesses.splice(0)) {
    harness.list.dispose();
    harness.viewport.remove();
  }
});

describe("refreshIndex callback reentrancy", () => {
  it("retries a direct mounted refresh superseded by nested layout", () => {
    const harness = mountReentrantList();
    const targetIndex = 0;
    const next = [...harness.items()];
    next[targetIndex] = {
      id: "updated-after-direct-retry",
      measuredHeight: MODELED_HEIGHT,
    };
    harness.setItems(next);
    let targetBuilds = 0;
    harness.setBuildHook((index) => {
      if (index !== targetIndex) return;
      targetBuilds++;
      if (targetBuilds === 1) harness.list.syncLayout();
    });

    harness.list.refreshIndex(targetIndex);

    expect(targetBuilds).toBe(2);
    expect(harness.list.getMountedElement(targetIndex)?.dataset.identity).toBe(
      "updated-after-direct-retry",
    );
  });

  it("retries a direct offscreen refresh superseded by nested layout", () => {
    const harness = mountReentrantList();
    let targetBuilds = 0;
    harness.setBuildHook((index) => {
      if (index !== OFFSCREEN_INDEX) return;
      targetBuilds++;
      if (targetBuilds === 1) harness.list.syncLayout();
    });

    harness.list.refreshIndex(OFFSCREEN_INDEX);

    expect(targetBuilds).toBe(2);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(
      MEASURED_HEIGHT,
    );
  });

  it("retries a direct suffix refresh superseded by nested layout", () => {
    const harness = mountReentrantList();
    const next = [...harness.items()];
    next[0] = {
      id: "updated-after-suffix-retry",
      measuredHeight: MODELED_HEIGHT,
    };
    harness.setItems(next);
    let firstRowBuilds = 0;
    harness.setBuildHook((index) => {
      if (index !== 0) return;
      firstRowBuilds++;
      if (firstRowBuilds === 1) harness.list.syncLayout();
    });

    harness.list.refreshFrom(0);

    expect(firstRowBuilds).toBe(2);
    expect(harness.list.getMountedElement(0)?.dataset.identity).toBe(
      "updated-after-suffix-retry",
    );
  });

  it.each([
    {
      api: "refreshIndex",
      reenter: (list: VirtualList, index: number) => list.refreshIndex(index),
    },
    {
      api: "refreshFrom",
      reenter: (list: VirtualList, index: number) => list.refreshFrom(index),
    },
  ])("replays a colliding $api after rebuilding a mounted row", ({
    api,
    reenter,
  }) => {
    const harness = mountReentrantList();
    const targetIndex = 0;
    const previous = requireElement(
      harness.list.getMountedElement(targetIndex),
      "mounted refresh target",
    );
    const rebuiltElements: HTMLElement[] = [];
    let targetBuilds = 0;
    harness.setBuildHook((index, element) => {
      if (index !== targetIndex) return;
      targetBuilds++;
      rebuiltElements.push(element);
      if (targetBuilds === 1) {
        const next = [...harness.items()];
        next[targetIndex] = {
          id: `updated-by-${api}`,
          measuredHeight: MODELED_HEIGHT,
        };
        harness.setItems(next);
      }
      reenter(harness.list, targetIndex);
    });

    harness.list.refreshIndex(targetIndex);

    const mounted = requireElement(
      harness.list.getMountedElement(targetIndex),
      "replayed refresh target",
    );
    expect(targetBuilds).toBe(2);
    expect(mounted).toBe(rebuiltElements[1]);
    expect(mounted.dataset.identity).toBe(`updated-by-${api}`);
    expect(destroyCountFor(harness.destroyCalls, previous)).toBe(1);
    expect(destroyCountFor(harness.destroyCalls, rebuiltElements[0]!)).toBe(1);
  });

  it.each([
    {
      api: "refreshIndex",
      reenter: (list: VirtualList, index: number) => list.refreshIndex(index),
    },
    {
      api: "refreshFrom",
      reenter: (list: VirtualList, index: number) => list.refreshFrom(index),
    },
  ])("replays a colliding $api after measuring an offscreen row", ({
    api,
    reenter,
  }) => {
    const harness = mountReentrantList();
    const changesBeforeRefresh = harness.rangeChanges.length;
    const temporaryElements: HTMLElement[] = [];
    let targetBuilds = 0;
    harness.setBuildHook((index, element) => {
      if (index !== OFFSCREEN_INDEX) return;
      targetBuilds++;
      temporaryElements.push(element);
      if (targetBuilds === 1) {
        const next = [...harness.items()];
        next[OFFSCREEN_INDEX] = {
          id: `updated-by-${api}`,
          measuredHeight: UPDATED_MEASURED_HEIGHT,
        };
        harness.setItems(next);
      }
      reenter(harness.list, OFFSCREEN_INDEX);
    });

    harness.list.refreshIndex(OFFSCREEN_INDEX);

    expect(targetBuilds).toBe(2);
    expect(harness.list.state.measuredCount).toBe(1);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(
      UPDATED_MEASURED_HEIGHT,
    );
    expect(harness.list.getMountedElement(OFFSCREEN_INDEX)).toBeNull();
    for (const element of temporaryElements) {
      expect(destroyCountFor(harness.destroyCalls, element)).toBe(1);
    }
    const refreshChanges = harness.rangeChanges.slice(changesBeforeRefresh);
    const staleTotalSize =
      harness.items().length * MODELED_HEIGHT +
      MEASURED_HEIGHT -
      MODELED_HEIGHT;
    expect(
      refreshChanges.some((state) => state.totalSize === staleTotalSize),
    ).toBe(false);
    expect(refreshChanges.at(-1)?.totalSize).toBe(
      harness.items().length * MODELED_HEIGHT +
        UPDATED_MEASURED_HEIGHT -
        MODELED_HEIGHT,
    );
  });

  it("replays a queued refresh after the owning build fails", () => {
    const harness = mountReentrantList();
    const queuedTarget = 1;
    const previousQueuedTarget = requireElement(
      harness.list.getMountedElement(queuedTarget),
      "queued refresh target",
    );
    harness.setBuildHook((index) => {
      if (index !== 0) return;
      harness.list.refreshIndex(queuedTarget);
      throw new Error("owner build failed");
    });

    expect(() => harness.list.refreshIndex(0)).toThrow("owner build failed");

    expect(harness.list.getMountedElement(queuedTarget)).not.toBe(
      previousQueuedTarget,
    );
    expect(destroyCountFor(harness.destroyCalls, previousQueuedTarget)).toBe(1);
  });

  it("continues later queued refreshes after an earlier replay fails", () => {
    const harness = mountReentrantList();
    const laterTarget = 2;
    const previousLaterTarget = requireElement(
      harness.list.getMountedElement(laterTarget),
      "later queued refresh target",
    );
    harness.setBuildHook((index) => {
      if (index === 0) {
        harness.list.refreshIndex(1);
        harness.list.refreshIndex(laterTarget);
      }
      if (index === 1) throw new Error("first replay failed");
    });

    expect(() => harness.list.refreshIndex(0)).toThrow("first replay failed");

    expect(harness.list.getMountedElement(laterTarget)).not.toBe(
      previousLaterTarget,
    );
    expect(destroyCountFor(harness.destroyCalls, previousLaterTarget)).toBe(1);
  });

  it("retries a stale exact replay once", () => {
    const harness = mountReentrantList();
    const exactTarget = 2;
    let exactTargetBuilds = 0;
    harness.setBuildHook((index) => {
      if (index === 0) {
        harness.list.refreshIndex(exactTarget);
        return;
      }
      if (index !== exactTarget) return;
      exactTargetBuilds++;
      if (exactTargetBuilds !== 1) return;
      const next = [...harness.items()];
      next[exactTarget] = {
        id: "updated-during-exact-replay",
        measuredHeight: MODELED_HEIGHT,
      };
      harness.setItems(next);
      harness.list.syncLayout({ apply: () => true });
    });

    harness.list.refreshIndex(0);

    expect(exactTargetBuilds).toBe(2);
    expect(harness.list.getMountedElement(exactTarget)?.dataset.identity).toBe(
      "updated-during-exact-replay",
    );
  });

  it("carries a post-append exact refresh into a new count snapshot", () => {
    const harness = mountReentrantList();
    const appendedIndex = harness.items().length;
    let firstRowBuilds = 0;
    let appendedBuilds = 0;
    harness.setBuildHook((index) => {
      if (index === 0) {
        firstRowBuilds++;
        if (firstRowBuilds === 1) {
          harness.list.refreshIndex(0);
        } else if (firstRowBuilds === 2) {
          harness.list.syncLayout({
            apply: () => {
              harness.setItems([
                ...harness.items(),
                {
                  id: "appended-during-replay",
                  measuredHeight: MEASURED_HEIGHT,
                },
              ]);
              return true;
            },
          });
          harness.list.refreshIndex(appendedIndex);
        }
      } else if (index === appendedIndex) {
        appendedBuilds++;
      }
    });

    harness.list.refreshIndex(0);

    expect(harness.list.state.count).toBe(appendedIndex + 1);
    expect(appendedBuilds).toBe(1);
    expect(modeledHeightAt(harness.list, appendedIndex)).toBe(MEASURED_HEIGHT);
  });

  it("replays a refresh requested by exact-target teardown", () => {
    const harness = mountReentrantList();
    const exactTarget = 2;
    let exactTargetBuilds = 0;
    let updatedFromTeardown = false;
    harness.setBuildHook((index) => {
      if (index === 0) {
        harness.list.refreshIndex(exactTarget);
      } else if (index === exactTarget) {
        exactTargetBuilds++;
      }
    });
    harness.setDestroyHook((index) => {
      if (index !== exactTarget || updatedFromTeardown) return;
      updatedFromTeardown = true;
      const next = [...harness.items()];
      next[exactTarget] = {
        id: "updated-from-exact-teardown",
        measuredHeight: MODELED_HEIGHT,
      };
      harness.setItems(next);
      harness.list.refreshIndex(exactTarget);
    });

    harness.list.refreshIndex(0);

    expect(exactTargetBuilds).toBe(2);
    expect(harness.list.getMountedElement(exactTarget)?.dataset.identity).toBe(
      "updated-from-exact-teardown",
    );
  });

  it("remeasures an offscreen row refreshed by temporary teardown", () => {
    const harness = mountReentrantList();
    let targetBuilds = 0;
    let firstTemporary: HTMLElement | null = null;
    harness.setBuildHook((index, element) => {
      if (index !== OFFSCREEN_INDEX) return;
      targetBuilds++;
      firstTemporary ??= element;
    });
    harness.setDestroyHook((_index, element) => {
      if (element !== firstTemporary) return;
      const next = [...harness.items()];
      next[OFFSCREEN_INDEX] = {
        id: "updated-from-measurement-teardown",
        measuredHeight: UPDATED_MEASURED_HEIGHT,
      };
      harness.setItems(next);
      harness.list.refreshIndex(OFFSCREEN_INDEX);
    });

    harness.list.refreshIndex(OFFSCREEN_INDEX);

    expect(targetBuilds).toBe(2);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(
      UPDATED_MEASURED_HEIGHT,
    );
  });

  it("defers measurement invalidation raised by a refresh candidate", () => {
    const harness = mountReentrantList();
    const targetIndex = 0;
    const next = [...harness.items()];
    next[targetIndex] = {
      id: "updated-before-invalidation",
      measuredHeight: MODELED_HEIGHT,
    };
    harness.setItems(next);
    let invalidated = false;
    harness.setBuildHook((index) => {
      if (index !== targetIndex || invalidated) return;
      invalidated = true;
      harness.list.invalidateMeasurements();
    });

    harness.list.refreshIndex(targetIndex);

    expect(invalidated).toBe(true);
    expect(harness.list.getMountedElement(targetIndex)?.dataset.identity).toBe(
      "updated-before-invalidation",
    );
  });

  it("replays an exact row not reached by a failing suffix refresh", () => {
    const harness = mountReentrantList();
    const exactTarget = 2;
    const previousExactTarget = requireElement(
      harness.list.getMountedElement(exactTarget),
      "exact refresh target",
    );
    let firstRowBuilds = 0;
    harness.setBuildHook((index) => {
      if (index === 0) {
        firstRowBuilds++;
        if (firstRowBuilds === 1) {
          harness.list.refreshFrom(0);
        } else {
          harness.list.refreshIndex(exactTarget);
        }
      }
      if (index === 1 && firstRowBuilds > 1) {
        throw new Error("suffix replay failed");
      }
    });

    expect(() => harness.list.refreshIndex(0)).toThrow("suffix replay failed");

    expect(harness.list.getMountedElement(exactTarget)).not.toBe(
      previousExactTarget,
    );
    expect(destroyCountFor(harness.destroyCalls, previousExactTarget)).toBe(1);
  });

  it("retries an exact row whose suffix candidate becomes stale", () => {
    const harness = mountReentrantList();
    const exactTarget = 2;
    let firstRowBuilds = 0;
    let exactTargetBuilds = 0;
    harness.setBuildHook((index) => {
      if (index === 0) {
        firstRowBuilds++;
        if (firstRowBuilds === 1) {
          harness.list.refreshFrom(0);
        } else {
          const next = [...harness.items()];
          next[exactTarget] = {
            id: "updated-after-stale-suffix",
            measuredHeight: MODELED_HEIGHT,
          };
          harness.setItems(next);
          harness.list.refreshIndex(exactTarget);
        }
        return;
      }
      if (index !== exactTarget) return;
      exactTargetBuilds++;
      if (exactTargetBuilds === 1) harness.list.syncLayout();
    });

    harness.list.refreshIndex(0);

    expect(exactTargetBuilds).toBe(2);
    expect(harness.list.getMountedElement(exactTarget)?.dataset.identity).toBe(
      "updated-after-stale-suffix",
    );
  });

  it.each([
    {
      api: "refreshIndex",
      reenter: (list: VirtualList) => list.refreshIndex(0),
    },
    {
      api: "refreshFrom",
      reenter: (list: VirtualList) => list.refreshFrom(0),
    },
  ])("replays a finite $api back-edge from a later suffix row", ({
    reenter,
  }) => {
    const harness = mountReentrantList();
    let firstRowBuilds = 0;
    let backEdgeQueued = false;
    harness.setBuildHook((index) => {
      if (index === 0) {
        firstRowBuilds++;
        if (firstRowBuilds === 1) harness.list.refreshFrom(0);
        return;
      }
      if (index !== 1 || firstRowBuilds < 2 || backEdgeQueued) return;
      backEdgeQueued = true;
      const next = [...harness.items()];
      next[0] = {
        id: "updated-from-later-row",
        measuredHeight: MODELED_HEIGHT,
      };
      harness.setItems(next);
      reenter(harness.list);
    });

    harness.list.refreshIndex(0);

    expect(firstRowBuilds).toBe(3);
    expect(harness.list.getMountedElement(0)?.dataset.identity).toBe(
      "updated-from-later-row",
    );
  });

  it.each([
    {
      scenario: "same-count identity replacement",
      expectedCount: 100,
      mutate: (harness: ReentrancyHarness) => {
        harness.list.syncLayout({
          apply: () => {
            const next = [...harness.items()];
            next[OFFSCREEN_INDEX] = {
              id: "replacement-50",
              measuredHeight: MODELED_HEIGHT,
            };
            harness.setItems(next);
            return true;
          },
        });
      },
    },
    {
      scenario: "prepend",
      expectedCount: 101,
      mutate: (harness: ReentrancyHarness) => {
        harness.list.syncLayout({
          addedBefore: 1,
          apply: () => {
            harness.setItems([
              { id: "prepended", measuredHeight: MODELED_HEIGHT },
              ...harness.items(),
            ]);
            return true;
          },
        });
      },
    },
  ])("does not commit an offscreen height after a reentrant $scenario", ({
    expectedCount,
    mutate,
  }) => {
    const harness = mountReentrantList();
    expect(harness.list.getMountedElement(OFFSCREEN_INDEX)).toBeNull();

    let temporary: HTMLElement | null = null;
    harness.setBuildHook((index, element) => {
      if (index !== OFFSCREEN_INDEX || temporary) return;
      temporary = element;
      harness.setBuildHook(null);
      mutate(harness);
    });

    harness.list.refreshIndex(OFFSCREEN_INDEX);

    const temporaryElement = requireElement(
      temporary,
      "temporary measurement element",
    );
    expect(temporaryElement.dataset.identity).toBe("item-50");
    expect(harness.items()).toHaveLength(expectedCount);
    expect(harness.list.state.measuredCount).toBe(0);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(MODELED_HEIGHT);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX + 1)).toBe(
      MODELED_HEIGHT,
    );
    expect(harness.list.getMountedElement(OFFSCREEN_INDEX)).toBeNull();
    expect(destroyCountFor(harness.destroyCalls, temporaryElement)).toBe(1);
    expect(temporaryElement.isConnected).toBe(false);
  });

  it("does not commit an offscreen height after temporary teardown disposes the list", () => {
    const harness = mountReentrantList();
    const initiallyMounted = Array.from(
      { length: harness.items().length },
      (_, index) => harness.list.getMountedElement(index),
    ).filter((element): element is HTMLElement => element !== null);
    expect(harness.list.getMountedElement(0)).not.toBeNull();
    expect(initiallyMounted).toHaveLength(harness.list.state.mountedCount);
    expect(harness.list.getMountedElement(OFFSCREEN_INDEX)).toBeNull();

    let temporary: HTMLElement | null = null;
    let disposedFromTemporary = false;
    harness.setBuildHook((index, element) => {
      if (index === OFFSCREEN_INDEX) temporary = element;
    });
    harness.setDestroyHook((_index, element) => {
      if (element !== temporary || disposedFromTemporary) return;
      disposedFromTemporary = true;
      harness.list.dispose();
    });

    harness.list.refreshIndex(OFFSCREEN_INDEX);

    const temporaryElement = requireElement(
      temporary,
      "temporary measurement element",
    );
    expect(disposedFromTemporary).toBe(true);
    expect(destroyCountFor(harness.destroyCalls, temporaryElement)).toBe(1);
    for (const element of initiallyMounted) {
      expect(destroyCountFor(harness.destroyCalls, element)).toBe(1);
    }
    expect(harness.list.state.measuredCount).toBe(0);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(MODELED_HEIGHT);
    expect(harness.list.getMountedElement(0)).toBeNull();
    expect(harness.list.getMountedElement(OFFSCREEN_INDEX)).toBeNull();
    expect(temporaryElement.isConnected).toBe(false);
  });

  it("defers an offscreen commit when refresh runs inside another teardown", () => {
    const harness = mountReentrantList();
    const previous = requireElement(
      harness.list.getMountedElement(0),
      "outer refresh target",
    );
    let temporary: HTMLElement | null = null;

    harness.setBuildHook((index, element) => {
      if (index === OFFSCREEN_INDEX) temporary = element;
    });
    harness.setDestroyHook((_index, element) => {
      if (element === previous) {
        harness.list.refreshIndex(OFFSCREEN_INDEX);
        return;
      }
      if (element !== temporary) return;
      harness.list.syncLayout({
        apply: () => {
          const next = [...harness.items()];
          next[OFFSCREEN_INDEX] = {
            id: "replacement-from-teardown",
            measuredHeight: MODELED_HEIGHT,
          };
          harness.setItems(next);
          return true;
        },
      });
    });

    harness.list.refreshIndex(0);

    const temporaryElement = requireElement(
      temporary,
      "nested temporary measurement element",
    );
    expect(harness.list.state.measuredCount).toBe(0);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(MODELED_HEIGHT);
    expect(destroyCountFor(harness.destroyCalls, temporaryElement)).toBe(1);
  });

  it("drops an offscreen measurement queued before a deferred append", () => {
    const harness = mountReentrantList();
    harness.viewport.scrollTop = 4_000;
    harness.viewport.dispatchEvent(new Event("scroll"));

    harness.list.refreshIndex(OFFSCREEN_INDEX);
    harness.list.syncLayout({
      apply: () => {
        harness.setItems([
          ...harness.items(),
          { id: "appended", measuredHeight: MODELED_HEIGHT },
        ]);
        return true;
      },
    });
    harness.list.interruptScroll();

    expect(harness.items()).toHaveLength(101);
    expect(harness.list.state.count).toBe(101);
    expect(harness.list.state.measuredCount).toBe(0);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(MODELED_HEIGHT);
  });

  it("preserves queued offscreen measurements across unrelated refreshes", () => {
    const harness = mountReentrantList();
    const secondIndex = OFFSCREEN_INDEX + 1;
    const next = [...harness.items()];
    next[secondIndex] = {
      id: `item-${secondIndex}`,
      measuredHeight: UPDATED_MEASURED_HEIGHT,
    };
    harness.setItems(next);
    harness.viewport.scrollTop = 4_000;
    harness.viewport.dispatchEvent(new Event("scroll"));

    harness.list.refreshIndex(OFFSCREEN_INDEX);
    harness.list.refreshIndex(secondIndex);
    harness.list.interruptScroll();

    expect(harness.list.state.measuredCount).toBe(2);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(
      MEASURED_HEIGHT,
    );
    expect(modeledHeightAt(harness.list, secondIndex)).toBe(
      UPDATED_MEASURED_HEIGHT,
    );
  });

  it.each([
    {
      scenario: "no-op layout",
      update: () => ({}),
    },
    {
      scenario: "canceled host update",
      update: () => ({ apply: () => false }),
    },
  ])("preserves a queued measurement across a $scenario", ({ update }) => {
    const harness = mountReentrantList();
    harness.viewport.scrollTop = 4_000;
    harness.viewport.dispatchEvent(new Event("scroll"));

    harness.list.refreshIndex(OFFSCREEN_INDEX);
    harness.list.syncLayout(update());
    harness.list.interruptScroll();

    expect(harness.list.state.measuredCount).toBe(1);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(
      MEASURED_HEIGHT,
    );
  });

  it("invalidates a queued measurement after same-count setCount replacement", () => {
    const harness = mountReentrantList();
    harness.viewport.scrollTop = 4_000;
    harness.viewport.dispatchEvent(new Event("scroll"));
    harness.list.refreshIndex(OFFSCREEN_INDEX);
    const next = [...harness.items()];
    next[OFFSCREEN_INDEX] = {
      id: "same-count-replacement",
      measuredHeight: MODELED_HEIGHT,
    };
    harness.setItems(next);

    harness.list.setCount();
    harness.list.interruptScroll();

    expect(harness.list.state.measuredCount).toBe(0);
    expect(modeledHeightAt(harness.list, OFFSCREEN_INDEX)).toBe(MODELED_HEIGHT);
  });

  it("cleans a mounted refresh candidate when its build callback disposes the list", () => {
    const harness = mountReentrantList();
    const targetIndex = 2;
    const initiallyMounted = Array.from(
      { length: harness.items().length },
      (_, index) => harness.list.getMountedElement(index),
    ).filter((element): element is HTMLElement => element !== null);
    const previous = requireElement(
      harness.list.getMountedElement(targetIndex),
      "mounted target",
    );

    let candidate: HTMLElement | null = null;
    harness.setBuildHook((index, element) => {
      if (index !== targetIndex || candidate) return;
      candidate = element;
      harness.list.dispose();
    });

    harness.list.refreshIndex(targetIndex);

    const candidateElement = requireElement(candidate, "refresh candidate");
    expect(candidateElement).not.toBe(previous);
    expect(candidateElement.isConnected).toBe(false);
    expect(harness.list.getMountedElement(targetIndex)).toBeNull();
    for (const element of initiallyMounted) {
      expect(destroyCountFor(harness.destroyCalls, element)).toBe(1);
    }
    expect(destroyCountFor(harness.destroyCalls, candidateElement)).toBe(1);
  });
});
