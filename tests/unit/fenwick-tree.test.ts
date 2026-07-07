import { describe, expect, it } from "vitest";
import { FenwickTree } from "../../src/virtual-list";

// The Fenwick tree is the offset engine: prefix() gives the content-space top of
// an index, total() the full height, and indexAt() maps a pixel offset back to
// the item that owns it. Everything the virtualizer does with scroll geometry
// rides on these three being exact.

const tree = (values: readonly number[]): FenwickTree =>
  new FenwickTree(Float64Array.from(values));

// Deterministic PRNG (mulberry32) + naive oracle so the property test is
// reproducible run-to-run — no fast-check dependency, no wall-clock seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    expect(t.maxBit).toBe(1);
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

describe("FenwickTree capacity / append", () => {
  it("defaults capacity to the value count", () => {
    expect(tree([10, 20, 30]).capacity).toBe(3);
    expect(tree([]).capacity).toBe(0);
  });

  it("appends into spare capacity without disturbing existing sums", () => {
    const t = new FenwickTree(Float64Array.from([10, 20]), 5);
    expect(t.size).toBe(2);
    expect(t.capacity).toBe(5);
    expect(t.total()).toBe(30);

    t.append(30);
    expect(t.size).toBe(3);
    expect(t.prefix(2)).toBe(30);
    expect(t.prefix(3)).toBe(60);
    expect(t.total()).toBe(60);
    expect(t.indexAt(59)).toBe(2);

    t.append(40);
    t.append(50);
    expect(t.size).toBe(5);
    expect(t.total()).toBe(150);
    expect(t.indexAt(99)).toBe(3);
    // A boundary belongs to the next item: offset 100 is the top of item 4.
    expect(t.indexAt(100)).toBe(4);
    expect(t.indexAt(1000)).toBe(4);
  });

  it("keeps maxBit the largest power of two <= size as appends grow it", () => {
    const t = new FenwickTree(Float64Array.from([1, 1, 1]), 8);
    expect(t.maxBit).toBe(2);
    t.append(1); // size 4
    expect(t.maxBit).toBe(4);
    t.append(1); // size 5
    expect(t.maxBit).toBe(4);
    t.append(1);
    t.append(1);
    t.append(1); // size 8
    expect(t.maxBit).toBe(8);
  });

  it("supports add() on rows that were appended", () => {
    const t = new FenwickTree(Float64Array.from([10]), 4);
    t.append(10);
    t.add(1, 5); // appended row grows from 10 to 15
    expect(t.prefix(2)).toBe(25);
    expect(t.indexAt(24)).toBe(1);
  });

  it("appends from an empty tree with capacity", () => {
    const t = new FenwickTree(new Float64Array(0), 4);
    expect(t.size).toBe(0);
    expect(t.total()).toBe(0);
    t.append(7);
    expect(t.size).toBe(1);
    expect(t.total()).toBe(7);
    expect(t.indexAt(0)).toBe(0);
  });

  it("throws when appending past capacity", () => {
    const t = new FenwickTree(Float64Array.from([1, 2]));
    expect(() => t.append(3)).toThrow(/capacity/);
  });

  it("property: appended trees agree with the oracle", () => {
    const rng = mulberry32(0x51ab_7e11);
    const randInt = (bound: number): number => Math.floor(rng() * bound);

    for (let iteration = 0; iteration < 100; iteration++) {
      const initial = randInt(20);
      const appended = 1 + randInt(20);
      const capacity = initial + appended + randInt(8);
      const values = Array.from({ length: initial }, () => randInt(200));
      const t = new FenwickTree(Float64Array.from(values), capacity);

      for (let i = 0; i < appended; i++) {
        const value = randInt(200);
        t.append(value);
        values.push(value);
      }

      const size = values.length;
      expect(t.size).toBe(size);
      expect(t.total()).toBe(oraclePrefix(values, size));
      for (let probe = 0; probe < 6; probe++) {
        const k = randInt(size + 2);
        expect(t.prefix(k)).toBe(oraclePrefix(values, k));
        const offset = randInt(oraclePrefix(values, size) + 40);
        expect(t.indexAt(offset)).toBe(oracleIndexAt(values, offset));
      }
    }
  });
});

describe("FenwickTree.valueAt / toValues", () => {
  it("recovers individual values, including after add() updates", () => {
    const t = tree([10, 20, 30, 40]);
    expect(t.valueAt(0)).toBe(10);
    expect(t.valueAt(2)).toBe(30);
    t.add(2, 5); // 30 -> 35
    expect(t.valueAt(2)).toBe(35);
    expect(t.valueAt(3)).toBe(40);
  });

  it("extracts all logical values, ignoring capacity padding", () => {
    const t = new FenwickTree(Float64Array.from([10, 20, 30]), 8);
    t.append(40);
    t.add(1, -5); // 20 -> 15
    expect(Array.from(t.toValues())).toEqual([10, 15, 30, 40]);
    expect(t.toValues().length).toBe(4);
  });

  it("handles empty trees", () => {
    expect(tree([]).toValues().length).toBe(0);
  });

  it("property: valueAt and toValues agree with the oracle across random trees", () => {
    const rng = mulberry32(0x7e57_ab1e);
    const randInt = (bound: number): number => Math.floor(rng() * bound);

    for (let iteration = 0; iteration < 200; iteration++) {
      const size = 1 + randInt(40);
      const capacity = size + randInt(8);
      const values = Array.from({ length: size }, () => randInt(200));
      const t = new FenwickTree(Float64Array.from(values), capacity);

      for (let update = 0; update < 3; update++) {
        const index = randInt(size);
        const nextHeight = randInt(200);
        t.add(index, nextHeight - (values[index] ?? 0));
        values[index] = nextHeight;
      }

      expect(Array.from(t.toValues())).toEqual(values);
      for (let probe = 0; probe < 5; probe++) {
        const k = randInt(size);
        expect(t.valueAt(k)).toBe(values[k]);
      }
    }
  });
});

describe("FenwickTree property: matches a naive oracle", () => {
  it("property: prefix, total, and indexAt agree with the oracle across random trees and updates", () => {
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
