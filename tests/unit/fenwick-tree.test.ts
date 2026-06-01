import { describe, expect, it } from "vitest";
import { FenwickTree } from "../../src/virtual-list";

// The Fenwick tree is the offset engine: prefix() gives the content-space top of
// an index, total() the full height, and indexAt() maps a pixel offset back to
// the item that owns it. Everything the virtualizer does with scroll geometry
// rides on these three being exact.

const tree = (values: readonly number[]): FenwickTree =>
  new FenwickTree(Float64Array.from(values));

describe("FenwickTree.prefix / total", () => {
  it("returns cumulative sums at each boundary", () => {
    const t = tree([10, 20, 30, 40]);
    expect(t.prefix(0)).toBe(0);
    expect(t.prefix(1)).toBe(10);
    expect(t.prefix(2)).toBe(30);
    expect(t.prefix(3)).toBe(60);
    expect(t.prefix(4)).toBe(100);
    expect(t.total()).toBe(100);
  });

  it("clamps the count to [0, size]", () => {
    const t = tree([10, 20, 30]);
    expect(t.prefix(-5)).toBe(0);
    expect(t.prefix(99)).toBe(60);
  });

  it("handles an empty tree", () => {
    const t = tree([]);
    expect(t.size).toBe(0);
    expect(t.total()).toBe(0);
    expect(t.prefix(3)).toBe(0);
    expect(t.indexAt(50)).toBe(0);
  });

  it("supports zero-height items", () => {
    const t = tree([0, 0, 25, 0, 25]);
    expect(t.total()).toBe(50);
    expect(t.prefix(2)).toBe(0);
    expect(t.prefix(3)).toBe(25);
  });
});

describe("FenwickTree.indexAt", () => {
  it("maps an offset to the item that contains it", () => {
    const t = tree([10, 10, 10]); // boundaries at 0, 10, 20, 30
    expect(t.indexAt(0)).toBe(0);
    expect(t.indexAt(5)).toBe(0);
    expect(t.indexAt(9.999)).toBe(0);
    // A boundary belongs to the next item: offset 10 is the top of item 1.
    expect(t.indexAt(10)).toBe(1);
    expect(t.indexAt(19)).toBe(1);
    expect(t.indexAt(20)).toBe(2);
  });

  it("clamps past-the-end offsets to the last index", () => {
    const t = tree([10, 10, 10]);
    expect(t.indexAt(30)).toBe(2);
    expect(t.indexAt(1000)).toBe(2);
  });

  it("skips leading zero-height items", () => {
    const t = tree([0, 0, 30]); // boundaries at 0, 0, 0, 30
    // Offset 0 lands on the last item whose prefix is still <= 0.
    expect(t.indexAt(0)).toBe(2);
    expect(t.indexAt(10)).toBe(2);
  });
});

describe("FenwickTree.add", () => {
  it("reflects updates in subsequent prefix sums", () => {
    const t = tree([10, 10, 10]);
    t.add(1, 5); // item 1 grows from 10 to 15
    expect(t.prefix(1)).toBe(10);
    expect(t.prefix(2)).toBe(25);
    expect(t.total()).toBe(35);
    expect(t.indexAt(24)).toBe(1);
    expect(t.indexAt(25)).toBe(2);
  });

  it("exposes size and a power-of-two maxBit", () => {
    expect(tree([1, 1, 1, 1, 1]).size).toBe(5);
    expect(tree([1, 1, 1, 1]).maxBit).toBe(4);
    expect(tree([1, 1, 1, 1, 1]).maxBit).toBe(4);
    expect(tree([1, 1, 1, 1, 1, 1, 1, 1]).maxBit).toBe(8);
  });
});
