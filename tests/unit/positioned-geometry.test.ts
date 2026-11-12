import { describe, expect, it } from "vitest";
import { Geometry } from "../../src/geometry";
import {
  PositionedGeometry,
  type PositionedItem,
} from "../../src/positioned-geometry";

describe("positioned geometry", () => {
  it("should preserve fractional boundaries at large coordinates", () => {
    const top = 2 ** 25 + 0.25;
    const layout = new PositionedGeometry([
      { top, height: 0.5, lane: Number.MAX_SAFE_INTEGER },
      { top: top + 0.75, height: 0.25, lane: 0 },
    ]);

    expect(layout.top(0)).toBe(top);
    expect(layout.top(-1)).toBe(-1);
    expect(layout.top(0.5)).toBe(-1);
    expect(layout.top(2)).toBe(-1);
    expect(layout.totalSize).toBe(top + 1);
    expect(layout.window(top, top + 0.25).indices).toEqual([0]);
    expect(layout.window(top + 0.5, top + 0.75).indices).toEqual([]);
    expect(layout.window(top + 0.75, top + 1).indices).toEqual([1]);
    expect(layout.anchorAt(top + 0.25, () => false, true)).toBe(0);
  });

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

  it.each([1, 2, 5])(
    "should match source-order anchor lookup across %i lanes, permutations and exclusions",
    (lanes) => {
      const items = Array.from({ length: 48 }, (_, index) => ({
        top: Math.floor(index / lanes) * 31.25 + (index % lanes) * 3.5,
        height: 45.5,
        lane: index % lanes,
      }));
      const queries = [
        -1,
        0,
        ...items.flatMap(({ top, height }) => [
          top,
          top + 0.25,
          top + height - 0.25,
          top + height,
        ]),
        2000,
      ];
      const permutations = [
        items,
        [...items].reverse(),
        [...items.filter((_, i) => i % 2), ...items.filter((_, i) => !(i % 2))],
      ];

      for (const permutation of permutations) {
        const layout = new PositionedGeometry(permutation);
        for (const divisor of [1, 3, 7, 49]) {
          const excluded = (index: number) => (index + 1) % divisor === 0;
          for (const top of queries) {
            const expected = layout.anchorAt(top, excluded);

            expect(layout.anchorAt(top, excluded, true)).toBe(expected);
          }
        }
      }
    },
  );

  it.each([1, 4, 7])(
    "should match source-order anchors across gaps and nested intervals in %i lanes",
    (lanes) => {
      const items = Array.from({ length: 96 }, (_, index) => ({
        top: Math.floor(index / 4) * 32.25,
        height: index % 13 === 0 ? 257.5 : 9.5 + (index % 3) * 6.125,
        lane: index % lanes,
      }));
      const queries = [
        -1,
        ...items.flatMap(({ top, height }) => [
          top,
          top + height - 0.125,
          top + height,
          top + height + 0.125,
        ]),
        5000,
      ];
      const permutations = [
        items,
        [...items].reverse(),
        [...items.filter((_, i) => i % 2), ...items.filter((_, i) => !(i % 2))],
      ];

      for (const permutation of permutations) {
        const layout = new PositionedGeometry(permutation);
        for (const divisor of [1, 3, 13, 97]) {
          const excluded = (index: number) => (index + 1) % divisor === 0;
          for (const top of queries) {
            const expected = layout.anchorAt(top, excluded);

            expect(layout.anchorAt(top, excluded, true)).toBe(expected);
          }
        }
      }
    },
  );

  it.each([
    { excluded: [], expected: 1 },
    { excluded: [1], expected: 2 },
    { excluded: [1, 2], expected: 3 },
    { excluded: [1, 2, 3], expected: 0 },
    { excluded: [0, 1, 2, 3], expected: -1 },
  ])(
    "should choose anchor $expected in source order with exclusions $excluded",
    ({ excluded, expected }) => {
      const layout = new PositionedGeometry([
        { top: 400, height: 30, lane: 0 },
        { top: 120, height: 100, lane: 1 },
        { top: 110, height: 100, lane: 0 },
        { top: 100, height: 100, lane: 1 },
      ]);

      const anchor = layout.anchorAt(
        150,
        (index) => excluded.includes(index),
        true,
      );

      expect(anchor).toBe(expected);
    },
  );

  it.each([
    { top: 20.25, expected: 0 },
    { top: 20.5, expected: 1 },
    { top: 40, expected: 1 },
  ])(
    "should preserve inclusive tops and exclusive bottoms at $top",
    ({ top, expected }) => {
      const layout = new PositionedGeometry([
        { top: 0, height: 20.5, lane: 0 },
        { top: 20.5, height: 19.5, lane: 0 },
        { top: 0, height: 20.5, lane: 1 },
        { top: 20.5, height: 19.5, lane: 1 },
      ]);

      const anchor = layout.anchorAt(top, () => false, true);

      expect(anchor).toBe(expected);
    },
  );

  it.each([
    { top: 0, expected: 1 },
    { top: 70, expected: 3 },
    { top: 210, expected: 0 },
    { top: -Infinity, expected: 1 },
    { top: Infinity, expected: 0 },
    { top: Number.NaN, expected: 0 },
  ])(
    "should preserve source-order fallback ties at $top",
    ({ top, expected }) => {
      const layout = new PositionedGeometry([
        { top: 200, height: 10, lane: 1 },
        { top: 50, height: 20, lane: 2 },
        { top: 50, height: 20, lane: 1 },
        { top: 100, height: 110, lane: 2 },
      ]);

      const anchor = layout.anchorAt(top, () => false, true);

      expect(anchor).toBe(expected);
    },
  );

  it.each([
    { top: 110, excluded: [], expected: 0 },
    { top: 250, excluded: [], expected: 1 },
    { top: 510, excluded: [], expected: 1 },
    { top: 150, excluded: [1], expected: 2 },
    { top: 350, excluded: [1], expected: 2 },
    { top: 110, excluded: [0, 1, 2], expected: -1 },
  ])(
    "should preserve nested-overlap anchor $expected at $top with exclusions $excluded",
    ({ top, excluded, expected }) => {
      const layout = new PositionedGeometry([
        { top: 100, height: 20, lane: 0 },
        { top: 0, height: 500, lane: 0 },
        { top: 300, height: 20, lane: 0 },
      ]);

      const anchor = layout.anchorAt(
        top,
        (index) => excluded.includes(index),
        true,
      );

      expect(anchor).toBe(expected);
    },
  );

  it.each([0, -Infinity, Infinity, Number.NaN])(
    "should return no anchor for an empty layout at %s",
    (top) => {
      const layout = new PositionedGeometry([]);

      const anchor = layout.anchorAt(top, () => false, true);

      expect(anchor).toBe(-1);
    },
  );

  it("should leave cached visibility and its incremental cursors unchanged during anchor lookup", () => {
    const layout = new PositionedGeometry(
      Array.from({ length: 12 }, (_, index) => ({
        top: Math.floor(index / 2) * 100,
        height: 90,
        lane: index % 2,
      })),
    );
    const first = layout.window(100, 300);

    const anchor = layout.anchorAt(450, () => false, true);
    const repeated = layout.window(100, 300);
    const advanced = layout.window(200, 400);

    expect(anchor).toBe(8);
    expect(repeated).toBe(first);
    expect(first.indices).toEqual([2, 3, 4, 5]);
    expect(advanced.indices).toEqual([4, 5, 6, 7]);
    expect(advanced.delta?.from).toBe(first.indices);
    expect(advanced.delta?.entering).toEqual([6, 7]);
    expect(advanced.delta?.leaving).toEqual([2, 3]);
  });

  it.each([
    { excluded: [], expected: 1, visited: [0, 1] },
    { excluded: [1, 2, 3], expected: 0, visited: [0, 1, 2, 3] },
  ])(
    "should preserve callback effects in source order by default with exclusions $excluded",
    ({ excluded, expected, visited }) => {
      const layout = new PositionedGeometry([
        { top: 400, height: 30, lane: 0 },
        { top: 120, height: 100, lane: 1 },
        { top: 110, height: 100, lane: 0 },
        { top: 100, height: 100, lane: 1 },
      ]);
      const effects: number[] = [];

      const anchor = layout.anchorAt(150, (index) => {
        effects.push(index);
        return excluded.includes(index);
      });

      expect(anchor).toBe(expected);
      expect(effects).toEqual(visited);
    },
  );

  it("should propagate a default predicate failure before the containing item", () => {
    const layout = new PositionedGeometry([
      { top: 0, height: 100, lane: 0 },
      { top: 100, height: 100, lane: 0 },
    ]);
    const failure = new Error("earlier exclusion failed");

    expect(() =>
      layout.anchorAt(150, (index) => {
        if (index === 0) throw failure;
        return false;
      }),
    ).toThrow(failure);
  });

  it("should preserve keyed predicate effects when replacing a pure exclusion", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(["future", "reading", "other", "earlier"]);
    geometry.setPositioned(
      new PositionedGeometry([
        { top: 400, height: 30, lane: 0 },
        { top: 120, height: 100, lane: 1 },
        { top: 110, height: 100, lane: 0 },
        { top: 100, height: 100, lane: 1 },
      ]),
    );
    geometry.setAnchorExclusion(() => false, true);
    const effects: string[] = [];
    geometry.setAnchorExclusion((key) => {
      effects.push(key);
      return false;
    });

    const anchor = geometry.anchorAt({ scrollTop: 150, height: 100 });

    expect(anchor).toEqual({ key: "reading", offset: 30 });
    expect(effects).toEqual(["future", "reading"]);
  });

  it("should propagate a keyed predicate failure before the containing item", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(["earlier", "reading"]);
    geometry.setPositioned(
      new PositionedGeometry([
        { top: 0, height: 100, lane: 0 },
        { top: 100, height: 100, lane: 0 },
      ]),
    );
    const failure = new Error("earlier keyed exclusion failed");
    geometry.setAnchorExclusion((key) => {
      if (key === "earlier") throw failure;
      return false;
    });

    expect(() => geometry.anchorAt({ scrollTop: 150, height: 100 })).toThrow(
      failure,
    );
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

  it("should build identical geometry from columnar buffers across dense and sparse lanes", () => {
    const items = [
      { top: 0, height: 80, lane: 0 },
      { top: 10, height: 90, lane: 63 },
      { top: 20, height: 70, lane: 64 },
      { top: 30, height: 60, lane: 1000 },
      { top: 90, height: 50, lane: 0 },
      { top: 110, height: 40, lane: 1000 },
    ];
    const expected = new PositionedGeometry(items);
    const fromCols = PositionedGeometry.fromColumns(
      Float64Array.from(items.map((item) => item.top)),
      Float64Array.from(items.map((item) => item.height)),
      Float64Array.from(items.map((item) => item.lane)),
    );

    expect(fromCols.totalSize).toBe(expected.totalSize);
    for (let index = 0; index < items.length; index++) {
      expect(fromCols.top(index)).toBe(expected.top(index));
    }
    for (let top = 0; top <= 150; top += 15) {
      expect(fromCols.window(top, top + 30).indices).toEqual(
        expected.window(top, top + 30).indices,
      );
    }
    expect(() =>
      PositionedGeometry.fromColumns(
        Float64Array.from([0]),
        Float64Array.from([0]),
        Float64Array.from([0]),
      ),
    ).toThrow(/height/);
    expect(() =>
      PositionedGeometry.fromColumns(
        Float64Array.from([0]),
        Float64Array.from([40]),
        Float64Array.from([1.5]),
      ),
    ).toThrow(/lane/);
  });

  it("should match linear interval scans on nested overlapping lanes and gaps", () => {
    const items: PositionedItem[] = [];
    for (let i = 0; i < 180; i++) {
      const lane = i % 3;
      const top = i * 18 + (i % 7 === 0 ? 0 : 12);
      const height = i % 11 === 0 ? 420 : 26 + (i % 5) * 9;
      items.push({ top, height, lane });
    }
    const layout = new PositionedGeometry(items);

    for (let y = 0; y <= layout.totalSize + 40; y += 29.5) {
      const win = layout.window(y, y + 180);
      const expected = items.flatMap((item, index) =>
        item.top < y + 180 && item.top + item.height > y ? [index] : [],
      );
      expect(win.indices).toEqual(expected);

      const anchor = layout.anchorAt(y, (index) => index % 4 === 0, true);
      const covering = items.flatMap((item, index) =>
        index % 4 !== 0 && item.top <= y && item.top + item.height > y
          ? [index]
          : [],
      );
      if (covering.length > 0) {
        expect(anchor).toBe(covering[0]);
      } else {
        let bestAfter = -1;
        let bestAfterTop = Infinity;
        for (let i = 0; i < items.length; i++) {
          if (i % 4 === 0) continue;
          const item = items[i] as PositionedItem;
          if (item.top + item.height > y && item.top < bestAfterTop) {
            bestAfterTop = item.top;
            bestAfter = i;
          }
        }
        if (bestAfter >= 0) {
          expect(anchor).toBe(bestAfter);
        }
      }
    }
  });

  it("should update monotone single-card heights in place and reject order-breaking moves", () => {
    const layout = new PositionedGeometry([
      { top: 0, height: 80, lane: 0 },
      { top: 0, height: 90, lane: 1 },
      { top: 90, height: 80, lane: 0 },
      { top: 100, height: 70, lane: 1 },
    ]);

    expect(layout.canUpdateInPlace(0, 0, 85, 0)).toBe(true);
    // Changing lane or pushing bottom past successor's bottom must reject in-place update.
    expect(layout.canUpdateInPlace(0, 0, 85, 1)).toBe(false);
    expect(layout.canUpdateInPlace(0, 0, 180, 0)).toBe(false);
    expect(layout.canUpdateInPlace(2, 95, 120, 0)).toBe(true);

    layout.applyUpdateInPlace(2, 95, 120);
    expect(layout.top(2)).toBe(95);
    expect(layout.totalSize).toBe(215);
    expect(layout.window(180, 210).indices).toEqual([2]);
  });
});
