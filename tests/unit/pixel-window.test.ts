import { describe, expect, it } from "vitest";
import {
  planVirtualListPixelWindowFromEnd,
  planVirtualListPixelWindowFromStart,
} from "../../src/virtual-list";

// The planners pick which slice of a long transcript to keep loaded: walk out
// from an edge accumulating row heights until a pixel budget (minimumPx) is met,
// honoring minItems / maxItems clamps. These are the off-by-one-prone bits the
// retained-window demos lean on, so the edge cases get pinned down here.

const uniform = (height: number) => (): number => height;

describe("planVirtualListPixelWindowFromEnd", () => {
  it("walks back from the end until the pixel budget is met", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 10,
      minimumPx: 250,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 7, end: 10, count: 3, height: 300 });
  });

  it("stops exactly when height reaches minimumPx", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 10,
      minimumPx: 300,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 7, end: 10, count: 3, height: 300 });
  });

  it("collects everything when the list is shorter than the budget", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 3,
      minimumPx: 10000,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 0, end: 3, count: 3, height: 300 });
  });

  it("returns an empty window for an empty list", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 0,
      minimumPx: 500,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 0, end: 0, count: 0, height: 0 });
  });

  it("never exceeds maxItems even when the budget is unmet", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 10,
      minimumPx: 100000,
      maxItems: 2,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 8, end: 10, count: 2, height: 200 });
  });

  it("always collects at least minItems", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 10,
      minimumPx: 0,
      minItems: 4,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 6, end: 10, count: 4, height: 400 });
  });

  it("starts the walk from a clamped end index", () => {
    const plan = planVirtualListPixelWindowFromEnd({
      count: 5,
      end: 3,
      minimumPx: 100000,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 0, end: 3, count: 3, height: 300 });
  });

  it("accumulates variable row heights", () => {
    const heights = [50, 100, 150, 200, 250];
    const plan = planVirtualListPixelWindowFromEnd({
      count: 5,
      minimumPx: 300,
      getItemHeight: (index) => heights[index] ?? 0,
    });
    expect(plan).toEqual({ start: 3, end: 5, count: 2, height: 450 });
  });
});

describe("planVirtualListPixelWindowFromStart", () => {
  it("walks forward from the start until the pixel budget is met", () => {
    const plan = planVirtualListPixelWindowFromStart({
      count: 10,
      minimumPx: 250,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 0, end: 3, count: 3, height: 300 });
  });

  it("starts the walk from a given start index", () => {
    const plan = planVirtualListPixelWindowFromStart({
      count: 10,
      start: 4,
      minimumPx: 250,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 4, end: 7, count: 3, height: 300 });
  });

  it("clamps a start past the end to an empty window", () => {
    const plan = planVirtualListPixelWindowFromStart({
      count: 5,
      start: 7,
      minimumPx: 250,
      getItemHeight: uniform(100),
    });
    expect(plan).toEqual({ start: 5, end: 5, count: 0, height: 0 });
  });
});
