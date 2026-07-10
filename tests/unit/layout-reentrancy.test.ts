/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createVirtualList,
  createVirtualListItemMeasurer,
  type VirtualList,
} from "../../src/virtual-list";

interface MountedList {
  list: VirtualList;
  viewport: HTMLElement;
}

const mountedLists: MountedList[] = [];

function track(list: VirtualList, viewport: HTMLElement): VirtualList {
  mountedLists.push({ list, viewport });
  return list;
}

afterEach(() => {
  for (const { list, viewport } of mountedLists.splice(0)) {
    list.dispose();
    viewport.remove();
  }
});

describe("layout callback reentrancy", () => {
  it("does not publish stale modeled sizes after getItemHeight reenters layout", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let count = 2;
    let triggerNestedLayout = true;
    let activeList: VirtualList | null = null;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => count,
        getItemHeight: (index) => {
          if (index === 2 && triggerNestedLayout && activeList) {
            triggerNestedLayout = false;
            count = 4;
            activeList.setCount();
          }
          return 50;
        },
        buildItem: (index) => {
          const element = document.createElement("div");
          element.textContent = `item ${index}`;
          return element;
        },
      }),
      viewport,
    );
    activeList = list;

    count = 3;
    list.setCount();

    expect(list.state.count).toBe(4);
    expect(list.state.totalSize).toBe(200);
    expect(list.getItemOffset(4)).toBe(200);
    expect(list.getMountedElement(3)?.textContent).toBe("item 3");
  });

  it("keeps a newer boundary slot built by a nested layout", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => 1,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );
    const outerChild = document.createElement("div");
    outerChild.textContent = "outer";

    list.setBoundarySlot("top", {
      key: "outer",
      height: 20,
      build: () => {
        list.setBoundarySlot("top", {
          key: "nested",
          height: 30,
          build: () => {
            const child = document.createElement("div");
            child.textContent = "nested";
            return child;
          },
        });
        return outerChild;
      },
    });

    const boundary = list.getBoundaryElement("top");
    expect(boundary?.textContent).toBe("nested");
    expect(boundary?.style.height).toBe("30px");
    expect(outerChild.isConnected).toBe(false);
  });

  it("commits a boundary slot before replaying its nested row refresh", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let rowBuilds = 0;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => 1,
        getItemHeight: () => 50,
        buildItem: () => {
          rowBuilds++;
          return document.createElement("div");
        },
      }),
      viewport,
    );
    const child = document.createElement("div");
    child.textContent = "top slot";

    list.setBoundarySlot("top", {
      key: "top",
      height: 20,
      build: () => {
        list.refreshIndex(0);
        return child;
      },
    });

    expect(list.getBoundaryElement("top")?.textContent).toBe("top slot");
    expect(child.isConnected).toBe(true);
    expect(rowBuilds).toBe(2);
  });

  it("reconciles an appended row after an apply callback queues a refresh", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let count = 1;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => count,
        getItemHeight: () => 50,
        buildItem: (index) => {
          const element = document.createElement("div");
          element.textContent = `item ${index}`;
          return element;
        },
      }),
      viewport,
    );

    list.syncLayout({
      apply: () => {
        count = 2;
        list.refreshIndex(0);
        return true;
      },
    });

    expect(list.state.count).toBe(2);
    expect(list.getMountedElement(0)?.textContent).toBe("item 0");
    expect(list.getMountedElement(1)?.textContent).toBe("item 1");
  });

  it("replays a row refresh queued inside a committed host mutation", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let item = "old";
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => 1,
        getItemHeight: () => 50,
        buildItem: () => {
          const element = document.createElement("div");
          element.textContent = item;
          return element;
        },
      }),
      viewport,
    );

    list.syncLayout({
      apply: () => {
        item = "new";
        list.refreshIndex(0);
        return true;
      },
    });

    expect(list.getMountedElement(0)?.textContent).toBe("new");
  });

  it("carries a post-append suffix refresh into a new count snapshot", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const items = ["zero"];
    let rowZeroBuilds = 0;
    let activeList: VirtualList | null = null;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => items.length,
        getItemHeight: () => 50,
        buildItem: (index) => {
          const element = document.createElement("div");
          element.textContent = items[index] ?? "missing";
          if (index === 0 && activeList) {
            rowZeroBuilds++;
            if (rowZeroBuilds === 1) {
              activeList.refreshIndex(0);
            } else if (rowZeroBuilds === 2) {
              activeList.syncLayout({
                apply: () => {
                  items.push("one");
                  return true;
                },
              });
              items[1] = "updated one";
              activeList.refreshFrom(1);
            }
          }
          return element;
        },
      }),
      viewport,
    );
    activeList = list;

    list.refreshIndex(0);

    expect(list.state.count).toBe(2);
    expect(list.getMountedElement(1)?.textContent).toBe("updated one");
  });

  it("commits an apply update before deferred measurement invalidation", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let count = 1;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => count,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );

    list.syncLayout({
      apply: () => {
        count = 2;
        list.invalidateMeasurements();
        return true;
      },
    });

    expect(list.state.count).toBe(2);
    expect(list.getItemOffset(2)).toBe(100);
    expect(list.getMountedElement(1)).not.toBeNull();
  });

  it("commits a boundary slot before deferred measurement invalidation", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => 1,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );
    const child = document.createElement("div");
    child.textContent = "measured top slot";

    list.setBoundarySlot("top", {
      key: "measured-top",
      height: 20,
      build: () => {
        list.invalidateMeasurements();
        return child;
      },
    });

    expect(list.getBoundaryElement("top")?.textContent).toBe(
      "measured top slot",
    );
    expect(child.isConnected).toBe(true);
  });

  it("retries measurement invalidation after nested layout supersedes a pass", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let modeledHeight = 50;
    let triggerNestedLayout = false;
    let activeList: VirtualList | null = null;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => 1,
        getItemHeight: () => {
          if (triggerNestedLayout && activeList) {
            triggerNestedLayout = false;
            activeList.setBoundarySlot("top", {
              key: "nested-measurement-slot",
              height: 20,
              build: () => document.createElement("div"),
            });
          }
          return modeledHeight;
        },
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );
    activeList = list;
    modeledHeight = 100;
    triggerNestedLayout = true;

    list.invalidateMeasurements();

    expect(list.getBoundaryElement("top")).not.toBeNull();
    expect(list.getItemOffset(1) - list.getItemOffset(0)).toBe(100);
    expect(list.state.totalSize).toBe(120);
  });

  it("keeps a newer empty-list placeholder built by nested layout", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const list = track(
      createVirtualList({
        viewport,
        getCount: () => 0,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );
    const outerChild = document.createElement("div");
    outerChild.textContent = "outer";

    list.setPlaceholderSlot({
      key: "outer",
      build: () => {
        list.setPlaceholderSlot({
          key: "nested",
          build: () => {
            const child = document.createElement("div");
            child.textContent = "nested";
            return child;
          },
        });
        return outerChild;
      },
    });

    expect(list.getPlaceholderElement()?.textContent).toBe("nested");
    expect(outerChild.isConnected).toBe(false);
  });

  it("does not recursively rebuild an in-progress placeholder", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const list = track(
      createVirtualList({
        viewport,
        getCount: () => 0,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );
    let builds = 0;
    list.setPlaceholderSlot({
      key: "empty",
      build: () => {
        builds++;
        if (builds === 1) {
          list.setBoundarySlot("bottom", {
            key: "nested-boundary",
            height: 20,
            build: () => document.createElement("div"),
          });
        }
        const element = document.createElement("div");
        element.textContent = "empty";
        return element;
      },
    });

    expect(builds).toBe(1);
    expect(list.getPlaceholderElement()).toBeNull();

    list.syncLayout();
    expect(builds).toBe(2);
    expect(list.getPlaceholderElement()?.textContent).toBe("empty");
  });

  it("does not publish an empty boundary shell from stale construction", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const list = track(
      createVirtualList({
        viewport,
        getCount: () => 1,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );

    list.setBoundarySlot("top", {
      key: "stale-top",
      height: 20,
      build: () => {
        list.setBoundarySlot("bottom", {
          key: "nested-bottom",
          height: 30,
          build: () => document.createElement("div"),
        });
        return document.createElement("div");
      },
    });

    expect(list.getBoundaryElement("top")).toBeNull();
    expect(list.getBoundaryElement("bottom")?.style.height).toBe("30px");
  });

  it("does not recursively build a missing row during reentrant layout", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let count = 1;
    let rowBuilds = 0;
    let activeList: VirtualList | null = null;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => count,
        getItemHeight: () => 50,
        buildItem: (index) => {
          if (index === 1) {
            rowBuilds++;
            if (rowBuilds === 1 && activeList) {
              activeList.setBoundarySlot("bottom", {
                key: "nested",
                height: 20,
                build: () => document.createElement("div"),
              });
            }
          }
          return document.createElement("div");
        },
      }),
      viewport,
    );
    activeList = list;

    count = 2;
    list.setCount();

    expect(rowBuilds).toBe(1);
    expect(list.getMountedElement(1)).toBeNull();

    list.syncLayout();
    expect(rowBuilds).toBe(2);
    expect(list.getMountedElement(1)).not.toBeNull();
  });

  it("does not recursively recycle a missing row during reentrant layout", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let count = 2;
    let recycleCalls = 0;
    let activeList: VirtualList | null = null;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => count,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
        recycleItem: (index) => {
          if (index !== 1) return;
          recycleCalls++;
          if (recycleCalls === 1 && activeList) {
            activeList.setBoundarySlot("bottom", {
              key: "nested",
              height: 20,
              build: () => document.createElement("div"),
            });
          }
        },
      }),
      viewport,
    );
    activeList = list;
    count = 1;
    list.setCount();

    count = 2;
    list.setCount();

    expect(recycleCalls).toBe(1);
    expect(list.getMountedElement(1)).toBeNull();

    list.syncLayout();
    expect(recycleCalls).toBe(2);
    expect(list.getMountedElement(1)).not.toBeNull();
  });

  it("does not resume an update whose apply callback disposes the list", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let count = 2;
    let afterCalled = false;
    const list = track(
      createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => count,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      }),
      viewport,
    );

    list.syncLayout({
      apply: () => {
        count = 3;
        list.dispose();
        return true;
      },
      after: () => {
        afterCalled = true;
      },
    });

    expect(list.state.count).toBe(2);
    expect(afterCalled).toBe(false);
    expect(viewport.querySelector(".vl-content")).toBeNull();
  });

  it("drops a queued row measurement across a same-count host mutation", async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    const callbacks: ResizeObserverCallback[] = [];
    class CapturingResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = CapturingResizeObserver;

    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let list: VirtualList | null = null;
    try {
      list = createVirtualList({
        viewport,
        renderMode: "full",
        getCount: () => 1,
        getItemHeight: () => 50,
        buildItem: () => document.createElement("div"),
      });
      const row = list.getMountedElement(0);
      if (!row) throw new Error("missing measured row");
      const itemObserverCallback = callbacks[0];
      if (!itemObserverCallback) throw new Error("missing item observer");
      itemObserverCallback(
        [
          {
            target: row,
            borderBoxSize: [{ blockSize: 123, inlineSize: 300 }],
            contentRect: { height: 123 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );

      list.syncLayout({ apply: () => true });
      await list.scrollToBottom();

      expect(list.state.measuredCount).toBe(0);
      expect(list.getItemOffset(1)).toBe(50);
    } finally {
      list?.dispose();
      viewport.remove();
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });

  it("preserves standalone measurement and teardown failures", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const measurer = createVirtualListItemMeasurer({
      viewport,
      buildItem: () => {
        const element = document.createElement("div");
        element.getBoundingClientRect = () => {
          throw new Error("measurement failure");
        };
        return element;
      },
      destroyItem: () => {
        throw new Error("teardown failure");
      },
    });

    let caught: unknown;
    try {
      measurer.measure(0);
    } catch (error) {
      caught = error;
    } finally {
      measurer.dispose();
      viewport.remove();
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors.map((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(messages).toStrictEqual(["measurement failure", "teardown failure"]);
  });
});
