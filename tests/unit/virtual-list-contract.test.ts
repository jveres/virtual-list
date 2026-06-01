/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHarnesses,
  mountFullList,
} from "../helpers/virtual-list-harness";

// Layout-independent contracts of createVirtualList: the modeled offset model,
// the build/reuse/destroy lifecycle across count changes and window shifts, and
// dispose/recycle bookkeeping. These are the foundations under "scroll stays put
// on prepend/append" — the pixel-stability half lives in the (deferred) browser
// tier; here we pin the DOM-graph half that is observable without geometry.

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start }, (_, i) => start + i);

const ascending = (values: number[]): number[] =>
  [...values].sort((a, b) => a - b);

afterEach(cleanupHarnesses);

describe("getItemOffset", () => {
  it("should return the modeled prefix offset for each index", () => {
    const { list } = mountFullList(5, { itemHeight: () => 50 });
    expect(list.getItemOffset(0)).toBe(0);
    expect(list.getItemOffset(1)).toBe(50);
    expect(list.getItemOffset(3)).toBe(150);
  });

  it("should return the content bottom at index === count", () => {
    const { list } = mountFullList(5, { itemHeight: () => 50 });
    expect(list.getItemOffset(5)).toBe(250);
  });

  it("should clamp out-of-range indices to the content edges", () => {
    const { list } = mountFullList(5, { itemHeight: () => 50 });
    expect(list.getItemOffset(-5)).toBe(0);
    expect(list.getItemOffset(99)).toBe(250);
  });

  it("should accumulate variable row heights", () => {
    const heights = [10, 20, 30, 40];
    const { list } = mountFullList(4, {
      itemHeight: (index) => heights[index] ?? 0,
    });
    expect(list.getItemOffset(2)).toBe(30);
    expect(list.getItemOffset(4)).toBe(100);
  });
});

describe("count changes at the end", () => {
  it("should build the new tail when the count grows", () => {
    const harness = mountFullList(4);
    const before = harness.mountedElements();
    const buildsBefore = harness.builds.length;

    harness.setCountValue(6);
    harness.list.setCount();

    expect(ascending(harness.builds.slice(buildsBefore))).toEqual([4, 5]);
    expect(harness.destroys).toEqual([]);
    // Existing rows are untouched.
    for (const index of range(0, 4)) {
      expect(harness.list.getMountedElement(index)).toBe(before[index]);
    }
    expect(harness.list.getMountedElement(5)).not.toBeNull();
  });

  it("should destroy the trimmed tail when the count shrinks", () => {
    const harness = mountFullList(6);
    const before = harness.mountedElements();

    harness.setCountValue(4);
    harness.list.setCount();

    expect(ascending(harness.destroys)).toEqual([4, 5]);
    expect(harness.list.getMountedElement(4)).toBeNull();
    expect(harness.list.getMountedElement(5)).toBeNull();
    for (const index of range(0, 4)) {
      expect(harness.list.getMountedElement(index)).toBe(before[index]);
    }
  });
});

describe("window shifts (prepend / remove-before)", () => {
  it("should preserve existing row elements by reference when items are prepended", () => {
    const harness = mountFullList(4);
    const before = harness.mountedElements();

    harness.setCountValue(6);
    harness.list.setCount({ addedBefore: 2 });

    // The rows that were 0..3 are now 2..5 — same DOM nodes, none destroyed.
    expect(harness.list.getMountedElement(2)).toBe(before[0]);
    expect(harness.list.getMountedElement(3)).toBe(before[1]);
    expect(harness.list.getMountedElement(4)).toBe(before[2]);
    expect(harness.list.getMountedElement(5)).toBe(before[3]);
    expect(harness.destroys).toEqual([]);
  });

  it("should destroy leading rows and reindex survivors when items are removed from the front", () => {
    const harness = mountFullList(6);
    const before = harness.mountedElements();

    harness.setCountValue(4);
    harness.list.setCount({ removedBefore: 2 });

    // Rows 0,1 are gone; the former 2..5 are now 0..3 — same DOM nodes.
    expect(ascending(harness.destroys)).toEqual([0, 1]);
    expect(harness.list.getMountedElement(0)).toBe(before[2]);
    expect(harness.list.getMountedElement(1)).toBe(before[3]);
    expect(harness.list.getMountedElement(2)).toBe(before[4]);
    expect(harness.list.getMountedElement(3)).toBe(before[5]);
  });
});

describe("dispose", () => {
  it("should destroy every mounted row", () => {
    const harness = mountFullList(4);
    harness.list.dispose();
    expect(ascending(harness.destroys)).toEqual(range(0, 4));
  });

  it("should be safe to dispose twice without re-destroying rows", () => {
    const harness = mountFullList(3);
    harness.list.dispose();
    const afterFirst = [...harness.destroys];
    expect(() => harness.list.dispose()).not.toThrow();
    expect(harness.destroys).toEqual(afterFirst);
  });
});

describe("recycleItem", () => {
  it("should reuse pooled elements instead of rebuilding when rows remount", () => {
    const harness = mountFullList(6, { recycle: true });
    const buildsAfterMount = [...harness.builds];

    // Shrink pools rows 4,5; growing back should rebind them via recycleItem.
    harness.setCountValue(4);
    harness.list.setCount();
    harness.setCountValue(6);
    harness.list.setCount();

    expect(ascending(harness.recycles)).toEqual([4, 5]);
    // No rebuilds and no destroys: the pooled nodes were reused.
    expect(harness.builds).toEqual(buildsAfterMount);
    expect(harness.destroys).toEqual([]);
  });
});
