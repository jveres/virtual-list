import { describe, expect, it } from "vitest";
import { Geometry } from "../../src/geometry";
import {
  PositionedGeometry,
  type PositionedItem,
} from "../../src/positioned-geometry";

describe("positioned geometry", () => {
  it("should preserve exact membership and deltas through reversals, resizing, gaps and jumps", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      top: Math.floor(i / 5) * 113.25 + (i % 5) * 9.5,
      height: 70.5 + (i % 5) * 7,
      lane: i % 5,
    })).reverse();
    const layout = new PositionedGeometry(items);
    const queries = [
      [0, 600],
      [100, 700],
      [200, 800],
      [150, 650],
      [150, 350],
      [150, 1000],
      [4000, 4600],
      [3900, 4500],
      [0, 30],
      [80, 90],
      [82, 88],
      [0, 0],
      [5000, 5500],
      [4900, 5300],
      [0, 600],
      ...Array.from({ length: 60 }, (_, i) => [i * 31.25, i * 31.25 + 600]),
      ...Array.from({ length: 60 }, (_, i) => [
        1800 - i * 31.25,
        2400 - i * 31.25,
      ]),
    ];
    let previous = layout.window(0, 600);
    const snapshots: { indices: readonly number[]; copy: number[] }[] = [];

    for (const query of queries) {
      const top = query[0] as number;
      const bottom = query[1] as number;
      const current = layout.window(top, bottom);
      const expected = items.flatMap((item, index) =>
        item.top < bottom && item.top + item.height > top ? [index] : [],
      );
      expect(current.indices).toEqual(expected);
      expect(current.start).toBe(expected[0] ?? items.length);
      expect(current.end).toBe(
        expected.length ? (expected.at(-1) as number) + 1 : items.length,
      );
      if (current !== previous && current.delta) {
        expect(current.delta.from).toBe(previous.indices);
        expect(current.delta.entering).toEqual(
          expected.filter((i) => !previous.indices?.includes(i)),
        );
        expect(current.delta.leaving).toEqual(
          previous.indices?.filter((i) => !expected.includes(i)),
        );
      }
      if (current.indices)
        snapshots.push({
          indices: current.indices,
          copy: [...current.indices],
        });
      previous = current;
    }
    for (const snapshot of snapshots)
      expect(snapshot.indices).toEqual(snapshot.copy);
  });

  it("should retain containing cards when bottom ordering prevents incremental lane ranges", () => {
    const items = [
      { top: 0, height: 5000, lane: 0 },
      ...Array.from({ length: 40 }, (_, i) => ({
        top: i * 100,
        height: 30,
        lane: 0,
      })),
    ];
    const layout = new PositionedGeometry(items);

    for (const top of [0, 100, 250, 300, 200, 50, 4500, 4900, 300]) {
      expect(layout.window(top, top + 250).indices).toEqual(
        items.flatMap((item, index) =>
          item.top < top + 250 && item.top + item.height > top ? [index] : [],
        ),
      );
    }
  });

  it("should keep a tall card visible without mounting the intervening source items", () => {
    const layout = new PositionedGeometry([
      { top: 0, height: 2000, lane: 0 },
      ...Array.from({ length: 20 }, (_, i) => ({
        top: i * 100,
        height: 90,
        lane: 1,
      })),
    ]);

    expect(layout.window(1000, 1200)).toEqual({
      start: 0,
      end: 13,
      indices: [0, 11, 12],
    });
    expect(layout.totalSize).toBe(2000);
    expect(layout.window(1050, 1190)).toBe(layout.window(1000, 1200));
  });

  it.each([1, 2, 5, 7])(
    "should match interval intersection across %i lanes and fractional boundaries",
    (columns) => {
      const items: PositionedItem[] = [];
      const tops = Array<number>(columns).fill(0);
      for (let i = 0; i < 160; i++) {
        const lane = i % columns;
        const top = tops[lane] as number;
        const height = 11.25 + ((i * 17) % 37) * 6.4;
        items.push({ lane, top, height });
        tops[lane] = top + height + 6;
      }
      const layout = new PositionedGeometry(items);

      for (let top = 0; top < layout.totalSize; top += 73.75) {
        const expected = items.flatMap((item, index) =>
          item.top < top + 600 && item.top + item.height > top ? [index] : [],
        );
        expect(layout.window(top, top + 600).indices).toEqual(expected);
      }
    },
  );

  it("should handle unordered and overlapping inputs without losing covering cards", () => {
    const layout = new PositionedGeometry([
      { top: 100, height: 20, lane: 0 },
      { top: 0, height: 500, lane: 0 },
      { top: 300, height: 20, lane: 0 },
    ]);

    expect(layout.window(250, 350).indices).toEqual([1, 2]);
    expect(layout.anchorAt(510, () => false)).toBe(1);
  });

  it("should anchor to content around gaps and excluded loaders", () => {
    const layout = new PositionedGeometry([
      { top: 0, height: 50, lane: 2 },
      { top: 50, height: 100, lane: 0 },
      { top: 50, height: 200, lane: 1 },
      { top: 160, height: 100, lane: 0 },
      { top: 260, height: 50, lane: 2 },
    ]);
    const excluded = (index: number) => index === 0 || index === 4;

    expect(layout.anchorAt(0, excluded)).toBe(1);
    expect(layout.anchorAt(150, excluded)).toBe(2);
    expect(layout.anchorAt(260, excluded)).toBe(3);
    expect(layout.anchorAt(50, () => true)).toBe(-1);
  });

  it.each([
    { top: -1, height: 10, lane: 0 },
    { top: Number.NaN, height: 10, lane: 0 },
    { top: Infinity, height: 10, lane: 0 },
    { top: 0, height: 0, lane: 0 },
    { top: 0, height: Infinity, lane: 0 },
    { top: 0, height: 10, lane: -1 },
    { top: 0, height: 10, lane: 0.5 },
  ])("should reject invalid placement $top/$height/$lane", (item) => {
    expect(() => new PositionedGeometry([item])).toThrow(
      "positioned items need",
    );
  });

  it("should own its inputs and represent an empty surface", () => {
    const item = { top: 0, height: 100, lane: 0 };
    const layout = new PositionedGeometry([item]);
    item.top = 200;

    expect(layout.top(0)).toBe(0);
    expect(layout.window(0, 1).indices).toEqual([0]);
    expect(new PositionedGeometry([]).window(0, 100)).toEqual({
      start: 0,
      end: 0,
      indices: [],
    });
  });

  it("should reuse a buffered window while covering every requested interval", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      top: i * 20,
      height: 18,
      lane: 0,
    }));
    const geometry = new Geometry(18);
    geometry.setKeys(items.map((_, i) => String(i)));
    geometry.setPositioned(new PositionedGeometry(items));
    const first = geometry.window({ scrollTop: 401, height: 300 }, 200);

    expect(geometry.window({ scrollTop: 420, height: 300 }, 200)).toBe(first);
    for (let scrollTop = 400; scrollTop < 1200; scrollTop += 13) {
      const indices = geometry.window({ scrollTop, height: 300 }, 200).indices;
      expect(indices).toEqual(
        items.flatMap((item, i) =>
          item.top < Math.ceil((scrollTop + 500) / 200) * 200 &&
          item.top + item.height > Math.floor((scrollTop - 200) / 200) * 200
            ? [i]
            : [],
        ),
      );
    }
    expect(geometry.window({ scrollTop: 401, height: 300 }, 0).indices).toEqual(
      items.flatMap((item, i) =>
        item.top < 701 && item.top + item.height > 401 ? [i] : [],
      ),
    );
  });

  it("should preserve the keyed anchor through a positioned geometry transaction", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(["a", "b", "c", "d"]);
    geometry.setPositioned(
      new PositionedGeometry([
        { top: 0, height: 100, lane: 0 },
        { top: 0, height: 100, lane: 1 },
        { top: 100, height: 100, lane: 0 },
        { top: 100, height: 100, lane: 1 },
      ]),
    );
    const capture = geometry.capture(
      { scrollTop: 120, height: 50 },
      "viewport",
    );
    geometry.setPositioned(
      new PositionedGeometry([
        { top: 0, height: 100, lane: 0 },
        { top: 100, height: 100, lane: 0 },
        { top: 200, height: 100, lane: 0 },
        { top: 300, height: 100, lane: 0 },
      ]),
    );

    expect(geometry.resolve(capture).scrollTop).toBe(220);
    expect(geometry.offsetOf("c")).toBe(200);
    expect(geometry.contentSize).toBe(400);
    geometry.setPositioned(null);
    expect(geometry.window({ scrollTop: 0, height: 100 }, 0)).toEqual({
      start: 0,
      end: 1,
    });
  });
});
