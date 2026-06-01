/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createVirtualList, type VirtualList } from "../../src/virtual-list";

// refreshFrom is the branch-switch primitive: rebuild the mounted tail at or
// after an index, leave the prefix untouched. "Untouched" means the very same
// DOM nodes — that's what lets a chat keep the messages above a switched version
// from repainting. renderMode "full" mounts every row regardless of layout, so
// the reuse-vs-rebuild contract is observable in jsdom without real geometry.

interface Harness {
  list: VirtualList;
  builds: number[];
  destroys: number[];
  mountedElements: () => (HTMLElement | null)[];
}

const created: Array<{ list: VirtualList; viewport: HTMLElement }> = [];

function mountList(count: number): Harness {
  const viewport = document.createElement("div");
  document.body.appendChild(viewport);
  const builds: number[] = [];
  const destroys: number[] = [];
  const list = createVirtualList({
    viewport,
    renderMode: "full",
    getCount: () => count,
    getItemHeight: () => 50,
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
  });
  created.push({ list, viewport });
  return {
    list,
    builds,
    destroys,
    mountedElements: () =>
      Array.from({ length: count }, (_, index) =>
        list.getMountedElement(index),
      ),
  };
}

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start }, (_, i) => start + i);

afterEach(() => {
  for (const { list, viewport } of created.splice(0)) {
    list.dispose();
    viewport.remove();
  }
});

describe("createVirtualList in full render mode", () => {
  it("mounts every item once on init", () => {
    const { builds, mountedElements } = mountList(6);
    expect([...builds].sort((a, b) => a - b)).toEqual(range(0, 6));
    expect(mountedElements().every((element) => element !== null)).toBe(true);
  });
});

describe("refreshFrom", () => {
  it("rebuilds only the suffix and reuses the prefix by reference", () => {
    const harness = mountList(8);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;
    const destroysBefore = harness.destroys.length;

    harness.list.refreshFrom(5);

    const after = harness.mountedElements();
    const rebuilt = harness.builds.slice(buildsBefore);
    const destroyed = harness.destroys.slice(destroysBefore);

    // Prefix: same DOM nodes, never re-built or destroyed.
    for (const index of range(0, 5)) {
      expect(after[index]).toBe(before[index]);
    }
    // Suffix: fresh nodes, and the old ones were torn down.
    for (const index of range(5, 8)) {
      expect(after[index]).not.toBe(before[index]);
      expect(after[index]).not.toBeNull();
    }
    expect([...rebuilt].sort((a, b) => a - b)).toEqual(range(5, 8));
    expect([...destroyed].sort((a, b) => a - b)).toEqual(range(5, 8));
  });

  it("is a no-op at or beyond the count", () => {
    const harness = mountList(5);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;

    harness.list.refreshFrom(5);
    harness.list.refreshFrom(99);

    expect(harness.builds.length).toBe(buildsBefore);
    expect(harness.mountedElements()).toEqual(before);
  });

  it("rebuilds the whole list at index 0, matching refreshMounted", () => {
    const harness = mountList(4);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;

    harness.list.refreshFrom(0);

    const rebuilt = harness.builds.slice(buildsBefore);
    expect([...rebuilt].sort((a, b) => a - b)).toEqual(range(0, 4));
    for (const index of range(0, 4)) {
      expect(harness.mountedElements()[index]).not.toBe(before[index]);
    }
  });

  it("refreshMounted rebuilds every mounted row", () => {
    const harness = mountList(4);
    const buildsBefore = harness.builds.length;

    harness.list.refreshMounted();

    const rebuilt = harness.builds.slice(buildsBefore);
    expect([...rebuilt].sort((a, b) => a - b)).toEqual(range(0, 4));
  });
});
