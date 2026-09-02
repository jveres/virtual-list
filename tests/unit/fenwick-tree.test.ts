import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../demos/shared/lab";
import { FenwickTree } from "../../src/fenwick";

// The Fenwick tree is the offset engine: prefix() gives the content-space top of
// an index, total() the full height, indexAt() maps a pixel offset back to the
// item that owns it, and lowerBound() finds the first index whose prefix
// reaches an offset. Everything the virtualizer does with scroll geometry
// rides on these four being exact.

const tree = (values: readonly number[]): FenwickTree =>
  new FenwickTree(Float64Array.from(values));

// Deterministic PRNG (mulberry32) + naive oracle so the property test is
// reproducible run-to-run — no fast-check dependency, no wall-clock seed.

const oraclePrefix = (values: readonly number[], count: number): number => {
  const safe = Math.max(0, Math.min(values.length, count));
  let sum = 0;
  for (let i = 0; i < safe; i++) sum += values[i] ?? 0;
  return sum;
};

const oracleIndexAt = (values: readonly number[], offset: number): number => {
  if (values.length === 0) return 0;
  let index = 0;
  for (let i = 1; i <= values.length; i++) {
    if (oraclePrefix(values, i) <= offset) index = i;
    else break;
  }
  return Math.max(0, Math.min(values.length - 1, index));
};

const oracleLowerBound = (
  values: readonly number[],
  offset: number,
): number => {
  if (Number.isNaN(offset) || offset <= 0) return 0;
  for (let count = 1; count <= values.length; count++) {
    if (oraclePrefix(values, count) >= offset) return count;
  }
  return values.length;
};

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
    expect(t.prefix(2.9)).toBe(30);
    expect(t.prefix(99)).toBe(60);
  });

  it("handles an empty tree", () => {
    const t = tree([]);
    expect(t.size).toBe(0);
    expect(t.total()).toBe(0);
    expect(t.prefix(3)).toBe(0);
    expect(t.indexAt(50)).toBe(0);
  });

  it("should reject a non-finite initial value", () => {
    expect(() => tree([10, Number.NaN])).toThrow(/finite/);
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

describe("FenwickTree.lowerBound", () => {
  it("maps a pixel boundary to the exclusive item count", () => {
    const t = tree([10, 20, 30]);
    expect(t.lowerBound(0)).toBe(0);
    expect(t.lowerBound(1)).toBe(1);
    expect(t.lowerBound(10)).toBe(1);
    expect(t.lowerBound(10.001)).toBe(2);
    expect(t.lowerBound(30)).toBe(2);
    expect(t.lowerBound(60)).toBe(3);
    expect(t.lowerBound(1000)).toBe(3);
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

  it("exposes its size", () => {
    expect(tree([1, 1, 1, 1, 1]).size).toBe(5);
    expect(tree([]).size).toBe(0);
  });

  it("should ignore invalid indices and non-finite deltas", () => {
    const t = tree([10, 20, 30]);
    t.add(-1, 5);
    t.add(1.5, 5);
    t.add(3, 5);
    t.add(1, Number.NaN);
    expect([t.prefix(1), t.prefix(2), t.prefix(3)]).toEqual([10, 30, 60]);
    expect(t.total()).toBe(60);
  });
});

describe("FenwickTree edge cases", () => {
  it("reflects a negative delta (row shrink) in prefix sums", () => {
    const t = tree([10, 10, 10]);
    t.add(1, -4); // item 1 shrinks from 10 to 6
    expect(t.prefix(2)).toBe(16);
    expect(t.total()).toBe(26);
    expect(t.indexAt(15)).toBe(1);
    expect(t.indexAt(16)).toBe(2);
  });

  it("handles a single-element tree", () => {
    const t = tree([42]);
    expect(t.size).toBe(1);
    expect(t.total()).toBe(42);
    expect(t.indexAt(0)).toBe(0);
    expect(t.indexAt(1000)).toBe(0);
  });

  it("accumulates fractional heights", () => {
    const t = tree([0.5, 1.5, 2.25]);
    expect(t.prefix(2)).toBeCloseTo(2.0, 10);
    expect(t.total()).toBeCloseTo(4.25, 10);
  });
});
describe("FenwickTree property: matches a naive oracle", () => {
  it("property: prefix, total, indexAt, and lowerBound agree with the oracle across random trees and updates", () => {
    const rng = mulberry32(0x1234_abcd);
    const randInt = (bound: number): number => Math.floor(rng() * bound);

    for (let iteration = 0; iteration < 300; iteration++) {
      const size = 1 + randInt(40);
      // Integer heights keep indexAt boundaries unambiguous (no float rounding).
      const values = Array.from({ length: size }, () => randInt(200));
      const t = new FenwickTree(Float64Array.from(values));

      const assertAgreement = (): void => {
        expect(t.total()).toBe(oraclePrefix(values, size));
        for (let probe = 0; probe < 6; probe++) {
          const k = randInt(size + 2);
          expect(t.prefix(k)).toBe(oraclePrefix(values, k));
          const offset = randInt(oraclePrefix(values, size) + 40);
          expect(t.indexAt(offset)).toBe(oracleIndexAt(values, offset));
          expect(t.lowerBound(offset)).toBe(oracleLowerBound(values, offset));
        }
      };

      assertAgreement();

      // Apply a few non-negative-preserving updates (a measured row changing
      // height) and re-check, mirroring how the runtime mutates sizes.
      for (let update = 0; update < 4; update++) {
        const index = randInt(size);
        const nextHeight = randInt(200);
        t.add(index, nextHeight - (values[index] ?? 0));
        values[index] = nextHeight;
        assertAgreement();
      }
    }
  });
});
