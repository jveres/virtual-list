import { describe, expect, it } from "vitest";
import { FenwickTree } from "../../src/fenwick";
import {
  planRenderRange,
  type RenderRange,
  slotCoverageVisible,
} from "../../src/layout-kernel";

// Direct coverage for the pure layout kernel. The render-range planner was
// previously factory-internal (computeRange) and only exercised indirectly.

const uniformTree = (count: number, height: number): FenwickTree =>
  new FenwickTree(new Float64Array(count).fill(height));

function range(
  tree: FenwickTree,
  options: {
    full?: boolean;
    itemScrollTop?: number;
    viewportHeight?: number;
    overscanPx?: number;
  } = {},
): RenderRange {
  const target = { start: 0, end: 0 };
  planRenderRange(
    target,
    tree,
    options.full ?? false,
    options.itemScrollTop ?? 0,
    options.viewportHeight ?? 300,
    options.overscanPx ?? 0,
  );
  return target;
}

describe("planRenderRange", () => {
  it("covers the viewport rows plus the fixed buffer rows", () => {
    const tree = uniformTree(100, 50);
    // Viewport [500, 800): rows 10..15 visible; buffer widens by 1 above and
    // (via the exclusive end) 2 below.
    expect(range(tree, { itemScrollTop: 500 })).toEqual({
      start: 9,
      end: 18,
    });
  });

  it("extends by overscan pixels on both sides", () => {
    const tree = uniformTree(100, 50);
    // Overscan 100px = 2 rows each side on top of the buffer rows.
    expect(range(tree, { itemScrollTop: 500, overscanPx: 100 })).toEqual({
      start: 7,
      end: 20,
    });
  });

  it("clamps at the content edges", () => {
    const tree = uniformTree(10, 50);
    expect(range(tree, { itemScrollTop: 0, overscanPx: 900 })).toEqual({
      start: 0,
      end: 10,
    });
    expect(range(tree, { itemScrollTop: 400 })).toEqual({
      start: 7,
      end: 10,
    });
  });

  it("mounts everything in full render mode regardless of geometry", () => {
    const tree = uniformTree(7, 50);
    expect(range(tree, { full: true, itemScrollTop: 99999 })).toEqual({
      start: 0,
      end: 7,
    });
  });

  it("returns an empty range for an empty list", () => {
    const tree = uniformTree(0, 50);
    expect(range(tree, { itemScrollTop: 123 })).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("respects variable heights via the tree", () => {
    const tree = new FenwickTree(Float64Array.from([10, 200, 10, 200, 10]));
    // Row tops: 0, 10, 210, 220, 420. Viewport [15, 215) spans rows 1..2;
    // the buffer widens to start 0 and exclusive end 2 + 2 = 4.
    expect(range(tree, { itemScrollTop: 15, viewportHeight: 200 })).toEqual({
      start: 0,
      end: 4,
    });
  });
});

describe("slotCoverageVisible", () => {
  const THRESHOLD = 0.01;

  it("reports a fully visible slot", () => {
    expect(slotCoverageVisible(0, 52, 0, 300, THRESHOLD)).toBe(true);
  });

  it("reports an off-screen slot as covered", () => {
    // Slot at content top, viewport scrolled past it.
    expect(slotCoverageVisible(0, 52, 60, 300, THRESHOLD)).toBe(false);
    // Slot below the fold.
    expect(slotCoverageVisible(5000, 52, 0, 300, THRESHOLD)).toBe(false);
  });

  it("applies the coverage-ratio threshold at the crossover", () => {
    // 100px slot at top: visible height is (100 - scrollTop).
    expect(slotCoverageVisible(0, 100, 99, 300, THRESHOLD)).toBe(true); // 1%
    expect(slotCoverageVisible(0, 100, 99.5, 300, THRESHOLD)).toBe(false); // 0.5%
  });

  it("treats sub-1px slots against a 1px floor", () => {
    expect(slotCoverageVisible(0, 0.5, 0, 300, THRESHOLD)).toBe(true);
  });
});
