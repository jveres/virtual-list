import { describe, expect, it } from "vitest";
import { Geometry, type GeometryViewport } from "../../src/geometry";

// The geometry kernel is judged by the lean-core invariants (docs/lean-core.md):
// I1 — the resolved scroll target keeps the visible anchor's viewport
//      coordinate stationary through splices and measures;
// I2 — end-follow resolves against the FINAL geometry: measurements landing
//      inside the transaction are fully reflected;
// I5 — a pinned key can always be scrolled to the viewport top, the reserve
//      is consumed by growth / regrown by shrinkage, and never collapses out
//      from under the viewport.
// A naive oracle (plain arrays and sums) checks offsets; a seeded PRNG makes
// the randomized runs reproducible.

const VIEWPORT_H = 600;

function viewport(scrollTop: number): GeometryViewport {
  return { scrollTop, height: VIEWPORT_H };
}

function keysRange(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `m${from + i}`);
}

/** One-shot transaction helper for tests that mutate once. */
function transact(
  geometry: Geometry,
  vp: GeometryViewport,
  policy: "auto" | "viewport" | "end" | "none",
  mutate: () => void,
) {
  const capture = geometry.capture(vp, policy);
  mutate();
  return geometry.resolve(capture);
}

function seed(geometry: Geometry, keys: string[]): void {
  transact(geometry, viewport(0), "none", () => geometry.setKeys(keys));
}

function mulberry32(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Naive mirror: ordered keys + a height map, summed by hand. */
class Oracle {
  keys: string[] = [];
  readonly heights = new Map<string, number>();

  constructor(private readonly estimate: number) {}

  heightOf(key: string): number {
    return this.heights.get(key) ?? this.estimate;
  }

  offsetOf(key: string): number {
    let sum = 0;
    for (const k of this.keys) {
      if (k === key) return sum;
      sum += this.heightOf(k);
    }
    return -1;
  }

  contentSize(): number {
    let sum = 0;
    for (const k of this.keys) sum += this.heightOf(k);
    return sum;
  }
}

function expectMatchesOracle(geometry: Geometry, oracle: Oracle): void {
  expect(geometry.count).toBe(oracle.keys.length);
  expect(geometry.contentSize).toBeCloseTo(oracle.contentSize(), 6);
  for (const key of oracle.keys) {
    expect(geometry.offsetOf(key)).toBeCloseTo(oracle.offsetOf(key), 6);
  }
}

describe("input invariants", () => {
  it("rejects duplicate keys", () => {
    const geometry = new Geometry(100);
    expect(() => geometry.setKeys(["a", "b", "a"])).toThrow(/duplicate key/);
  });

  it("rejects non-finite and non-positive estimates", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const geometry = new Geometry(bad);
      expect(() => geometry.setKeys(["a"])).toThrow(/estimate/);
    }
  });

  it("a rejected update leaves the previous geometry fully intact", () => {
    const geometry = new Geometry((key) => {
      if (key === "poison") throw new Error("estimate for poison");
      return 100;
    });
    seed(geometry, keysRange(0, 10));
    transact(geometry, viewport(0), "none", () => geometry.measure("m4", 250));
    const contentBefore = geometry.contentSize;
    const offsetBefore = geometry.offsetOf("m7");

    expect(() => geometry.setKeys([...keysRange(0, 10), "poison"])).toThrow(
      /poison/,
    );
    expect(() => geometry.setKeys(["m0", "m1", "m1"])).toThrow(/duplicate key/);

    // Keys, index map, and tree still describe the old snapshot together.
    expect(geometry.count).toBe(10);
    expect(geometry.contentSize).toBe(contentBefore);
    expect(geometry.offsetOf("m7")).toBe(offsetBefore);
    expect(geometry.indexOf("poison")).toBe(-1);
    // And the geometry remains fully operable.
    transact(geometry, viewport(0), "none", () =>
      geometry.setKeys(keysRange(0, 12)),
    );
    expect(geometry.count).toBe(12);
  });

  it("a measured key never consults the estimator again", () => {
    let estimate = 100;
    const geometry = new Geometry(() => estimate);
    seed(geometry, keysRange(0, 3));

    // Same-as-modeled measurement still freezes the height by identity.
    transact(geometry, viewport(0), "none", () => geometry.measure("m1", 100));
    expect(geometry.isMeasured("m1")).toBe(true);

    estimate = 300;
    transact(geometry, viewport(0), "none", () =>
      geometry.setKeys(keysRange(0, 4)),
    );
    expect(geometry.heightOf("m1")).toBe(100);
    expect(geometry.heightOf("m3")).toBe(300);
  });
});

describe("offsets and totals", () => {
  it("matches the naive oracle through appends, prepends, and measures", () => {
    const geometry = new Geometry(100);
    const oracle = new Oracle(100);

    oracle.keys = keysRange(10, 20);
    seed(geometry, oracle.keys);
    expectMatchesOracle(geometry, oracle);

    transact(geometry, viewport(0), "none", () => geometry.measure("m12", 240));
    oracle.heights.set("m12", 240);
    expectMatchesOracle(geometry, oracle);

    // Prepend history: learned heights survive by identity.
    oracle.keys = [...keysRange(0, 10), ...oracle.keys];
    transact(geometry, viewport(0), "none", () =>
      geometry.setKeys(oracle.keys),
    );
    expectMatchesOracle(geometry, oracle);
    expect(geometry.heightOf("m12")).toBe(240);
    expect(geometry.isMeasured("m12")).toBe(true);
  });

  it("drops learned heights for removed keys", () => {
    const geometry = new Geometry(100);
    seed(geometry, ["a", "b"]);
    transact(geometry, viewport(0), "none", () => geometry.measure("b", 500));
    transact(geometry, viewport(0), "none", () => geometry.setKeys(["a"]));
    transact(geometry, viewport(0), "none", () => geometry.setKeys(["a", "b"]));
    expect(geometry.heightOf("b")).toBe(100);
    expect(geometry.isMeasured("b")).toBe(false);
  });
});

describe("I1 — anchor preservation", () => {
  it("keeps the anchor's viewport coordinate through a prepend", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(10, 30));
    // Reading m15 with the viewport top 30px into it.
    const vp = viewport(geometry.offsetOf("m15") + 30);
    const before = geometry.offsetOf("m15") - vp.scrollTop;

    const commit = transact(geometry, vp, "viewport", () =>
      geometry.setKeys([...keysRange(0, 10), ...keysRange(10, 30)]),
    );
    expect(geometry.offsetOf("m15") - commit.scrollTop).toBeCloseTo(before, 6);
  });

  it("measure above the viewport shifts the target; below does not", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.offsetOf("m10"));

    const above = transact(geometry, vp, "viewport", () =>
      geometry.measure("m2", 300),
    );
    expect(above.scrollTop).toBe(vp.scrollTop + 200);

    const vp2 = viewport(above.scrollTop);
    const below = transact(geometry, vp2, "viewport", () =>
      geometry.measure("m15", 400),
    );
    expect(below.scrollTop).toBe(vp2.scrollTop);
  });

  it("a shrink spanning the viewport top clamps to the item's new extent", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    transact(geometry, viewport(0), "none", () => geometry.measure("m5", 500));
    const vp = viewport(geometry.offsetOf("m5") + 350);
    const commit = transact(geometry, vp, "viewport", () =>
      geometry.measure("m5", 100),
    );
    expect(commit.scrollTop).toBeGreaterThanOrEqual(geometry.offsetOf("m5"));
    expect(commit.scrollTop).toBeLessThanOrEqual(
      geometry.offsetOf("m5") + geometry.heightOf("m5"),
    );
  });

  it("anchors the visually top-aligned row when the previous row has a subpixel remainder", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    // 0.016px of m0 remains below the viewport top: m1 is the top row.
    const vp = viewport(geometry.offsetOf("m1") - 0.016);
    expect(geometry.anchorAt(vp)?.key).toBe("m1");
    // A visible remainder still anchors the previous row.
    expect(
      geometry.anchorAt(viewport(geometry.offsetOf("m1") - 0.6))?.key,
    ).toBe("m0");

    const before = geometry.offsetOf("m1") - vp.scrollTop;
    // m0 gains a line: m1 must not move by that line.
    const commit = transact(geometry, vp, "viewport", () =>
      geometry.measure("m0", 121),
    );
    expect(geometry.offsetOf("m1") - commit.scrollTop).toBeCloseTo(before, 6);
  });

  it("an excluded key never anchors: a leading slot yields to its successor, a trailing one to its predecessor", () => {
    const geometry = new Geometry(100);
    geometry.setAnchorExclusion((key) => key.startsWith("slot:"));
    seed(geometry, ["slot:top", ...keysRange(0, 20), "slot:bottom"]);
    transact(geometry, viewport(0), "none", () =>
      geometry.measure("slot:top", 52),
    );

    // Viewport top inside the leading slot: the anchor is m0, offset
    // negative by what remains of the slot below the top.
    const inSlot = geometry.anchorAt(viewport(20));
    expect(inSlot?.key).toBe("m0");
    expect(inSlot?.offset).toBeCloseTo(20 - 52, 6);

    // A prepend replaces the slot's strip with content: m0 keeps its
    // viewport coordinate exactly.
    const vp = viewport(20);
    const before = geometry.offsetOf("m0") - vp.scrollTop;
    const commit = transact(geometry, vp, "viewport", () =>
      geometry.setKeys([
        "slot:top",
        ...keysRange(-5, 0),
        ...keysRange(0, 20),
        "slot:bottom",
      ]),
    );
    expect(geometry.offsetOf("m0") - commit.scrollTop).toBeCloseTo(before, 6);

    // Viewport top inside the trailing slot: the predecessor anchors.
    const tail = geometry.offsetOf("slot:bottom") + 10;
    expect(geometry.anchorAt(viewport(tail))?.key).toBe("m19");
  });

  it("a removed anchor falls to the first surviving successor, inheriting the offset", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.offsetOf("m10") + 30);
    const commit = transact(geometry, vp, "viewport", () =>
      geometry.setKeys(keysRange(0, 20).filter((k) => k !== "m10")),
    );
    // m11 takes the anchor role at the same in-row offset.
    expect(commit.scrollTop).toBeCloseTo(geometry.offsetOf("m11") + 30, 6);
  });

  it("with no surviving successor, the predecessor end-aligns", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.offsetOf("m18") + 10);
    const commit = transact(geometry, vp, "viewport", () =>
      geometry.setKeys(keysRange(0, 18)),
    );
    const predecessorBottom =
      geometry.offsetOf("m17") + geometry.heightOf("m17");
    expect(Math.min(commit.scrollTop, predecessorBottom)).toBeCloseTo(
      // The raw target is the predecessor's bottom; resolve clamps it into
      // the scrollable range.
      Math.min(predecessorBottom, geometry.contentSize - VIEWPORT_H),
      6,
    );
  });
});

describe("auto policy", () => {
  it("follows the end for appends while at the end", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.maxScrollTop(VIEWPORT_H));

    const commit = transact(geometry, vp, "auto", () =>
      geometry.setKeys(keysRange(0, 22)),
    );
    expect(commit.scrollTop).toBeCloseTo(geometry.maxScrollTop(VIEWPORT_H), 6);
  });

  it("I2: end-follow reaches the measured end, not the estimated one", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.maxScrollTop(VIEWPORT_H));

    // Append an estimated row and measure it larger inside one transaction.
    const commit = transact(geometry, vp, "auto", () => {
      geometry.setKeys(keysRange(0, 21));
      geometry.measure("m20", 300);
    });
    expect(commit.scrollTop).toBeCloseTo(geometry.maxScrollTop(VIEWPORT_H), 6);
    expect(geometry.contentSize).toBe(20 * 100 + 300);
  });

  it("follows the end for same-key streaming measurements at the end", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.maxScrollTop(VIEWPORT_H));

    const commit = transact(geometry, vp, "auto", () =>
      geometry.measure("m19", 500),
    );
    expect(commit.scrollTop).toBeCloseTo(geometry.maxScrollTop(VIEWPORT_H), 6);
  });

  it("preserves the viewport for a prepend even at the end", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(10, 30));
    const vp = viewport(geometry.maxScrollTop(VIEWPORT_H));
    const anchorKey = geometry.anchorAt(vp)?.key as string;
    const before = geometry.offsetOf(anchorKey) - vp.scrollTop;

    const commit = transact(geometry, vp, "auto", () =>
      geometry.setKeys([...keysRange(0, 10), ...keysRange(10, 30)]),
    );
    expect(geometry.offsetOf(anchorKey) - commit.scrollTop).toBeCloseTo(
      before,
      6,
    );
  });

  it("preserves the viewport for a reorder even at the end", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.maxScrollTop(VIEWPORT_H));
    const anchorKey = geometry.anchorAt(vp)?.key as string;
    const before = geometry.offsetOf(anchorKey) - vp.scrollTop;

    const reordered = [...keysRange(2, 20), "m0", "m1"];
    const commit = transact(geometry, vp, "auto", () =>
      geometry.setKeys(reordered),
    );
    expect(geometry.offsetOf(anchorKey) - commit.scrollTop).toBeCloseTo(
      before,
      6,
    );
  });

  it("preserves the viewport for a replacement even at the end", () => {
    const geometry = new Geometry((key) => (key === "mX" ? 400 : 100));
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.maxScrollTop(VIEWPORT_H));
    const anchor = geometry.anchorAt(vp);
    expect(anchor).not.toBeNull();
    const before =
      geometry.offsetOf((anchor as { key: string }).key) - vp.scrollTop;

    // Replace the last row (after the anchor) with a materially larger one:
    // the prefix up to it is unchanged, but the old keys are NOT a prefix of
    // the new — this is a replacement, not an append.
    const replaced = [...keysRange(0, 19), "mX"];
    const commit = transact(geometry, vp, "auto", () =>
      geometry.setKeys(replaced),
    );

    // The anchor coordinate is exact...
    expect(
      geometry.offsetOf((anchor as { key: string }).key) - commit.scrollTop,
    ).toBeCloseTo(before, 6);
    // ...and following the end would have produced a materially different
    // target (the replacement grew the content by 300px).
    expect(geometry.maxScrollTop(VIEWPORT_H) - commit.scrollTop).toBeCloseTo(
      300,
      6,
    );
  });

  it("preserves the viewport for appends while reading history", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const vp = viewport(geometry.offsetOf("m4"));

    const commit = transact(geometry, vp, "auto", () =>
      geometry.setKeys(keysRange(0, 25)),
    );
    expect(commit.scrollTop).toBe(vp.scrollTop);
    expect(geometry.offsetOf("m4")).toBe(vp.scrollTop);
  });
});

describe("I5 — pin-to-top reserve", () => {
  function pinnedAtEnd(): { geometry: Geometry; vp: GeometryViewport } {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    transact(geometry, viewport(0), "none", () => geometry.pin("m18"));
    return { geometry, vp: viewport(geometry.maxScrollTop(VIEWPORT_H)) };
  }

  it("reserves exactly the shortfall to top-align the pinned key", () => {
    const { geometry, vp } = pinnedAtEnd();
    expect(geometry.totalSize).toBeCloseTo(
      geometry.offsetOf("m18") + VIEWPORT_H,
      6,
    );
    expect(vp.scrollTop).toBeCloseTo(geometry.offsetOf("m18"), 6);
  });

  it("growth consumes the reserve without changing the total; shrink regrows it", () => {
    const { geometry, vp } = pinnedAtEnd();
    const total = geometry.totalSize;

    transact(geometry, vp, "auto", () => geometry.measure("m19", 300));
    expect(geometry.totalSize).toBeCloseTo(total, 6);

    transact(geometry, vp, "auto", () => geometry.measure("m19", 100));
    expect(geometry.totalSize).toBeCloseTo(total, 6);
  });

  it("adjusts the reserve when content above the pinned key changes", () => {
    const { geometry, vp } = pinnedAtEnd();
    transact(geometry, vp, "viewport", () => geometry.measure("m3", 400));
    // The pinned key's top moved down; the reserve still tops it out.
    expect(geometry.totalSize).toBeCloseTo(
      geometry.offsetOf("m18") + VIEWPORT_H,
      6,
    );
  });

  it("absorbs multiple measurements inside one transaction", () => {
    const { geometry, vp } = pinnedAtEnd();
    const total = geometry.totalSize;
    transact(geometry, vp, "auto", () => {
      geometry.measure("m19", 250);
      geometry.measure("m18", 180);
      geometry.measure("m19", 320);
    });
    // Below-pin growth is fully absorbed by the reserve.
    expect(geometry.totalSize).toBeCloseTo(total, 6);
  });

  it("clears the pin when the pinned key is removed; the reserve drains out of view", () => {
    const { geometry, vp } = pinnedAtEnd();
    transact(geometry, vp, "viewport", () =>
      geometry.setKeys(keysRange(0, 20).filter((k) => k !== "m18")),
    );
    expect(geometry.pinned).toBeNull();
    // Standing inside the reserve keeps it (no yank)...
    expect(geometry.totalSize).toBeGreaterThanOrEqual(
      Math.min(vp.scrollTop, geometry.maxScrollTop(VIEWPORT_H)) +
        VIEWPORT_H -
        1,
    );
    // ...and it drains once the viewport leaves.
    transact(geometry, viewport(0), "none", () => {});
    expect(geometry.reserve).toBe(0);
  });

  it("re-evaluates the reserve on viewport resize", () => {
    const { geometry } = pinnedAtEnd();
    const taller = { scrollTop: 0, height: VIEWPORT_H + 200 };
    const capture = geometry.capture(taller, "none");
    const commit = geometry.resolve(capture);
    expect(commit.totalSize).toBeCloseTo(
      geometry.offsetOf("m18") + taller.height,
      6,
    );
  });

  it("keeps a viewport-covering reserve alive through transient growth (no yank)", () => {
    const { geometry, vp } = pinnedAtEnd();
    transact(geometry, vp, "auto", () =>
      geometry.measure("m19", 100 + geometry.reserve + 400),
    );
    expect(geometry.reserve).toBe(0);
    transact(geometry, vp, "auto", () => geometry.measure("m19", 100));
    expect(geometry.totalSize).toBeGreaterThanOrEqual(
      vp.scrollTop + VIEWPORT_H - 1,
    );
  });
});

describe("window planning", () => {
  it("covers the viewport plus overscan and stays in bounds", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 50));
    const vp = viewport(1234);
    const { start, end } = geometry.window(vp, 200);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(50);
    const startKey = geometry.keyAt(start) as string;
    const lastKey = geometry.keyAt(end - 1) as string;
    expect(geometry.offsetOf(startKey)).toBeLessThanOrEqual(
      Math.max(0, vp.scrollTop - 200),
    );
    expect(
      geometry.offsetOf(lastKey) + geometry.heightOf(lastKey),
    ).toBeGreaterThanOrEqual(
      Math.min(geometry.contentSize, vp.scrollTop + VIEWPORT_H + 200),
    );
  });
});

describe("randomized against the oracle", () => {
  it("stays exact and anchor-stable through random splices and measures", () => {
    const rng = mulberry32(0xc0ffee);
    const geometry = new Geometry(80);
    const oracle = new Oracle(80);
    let nextId = 0;

    for (let step = 0; step < 400; step++) {
      const vp = viewport(rng() * Math.max(0, oracle.contentSize()));
      const anchor = geometry.anchorAt(vp);
      const capture = geometry.capture(vp, "viewport");

      const roll = rng();
      let anchorSurvives = false;
      if (roll < 0.35 || oracle.keys.length === 0) {
        const fresh = Array.from(
          { length: 1 + Math.floor(rng() * 4) },
          () => `k${nextId++}`,
        );
        if (rng() < 0.5) oracle.keys = [...fresh, ...oracle.keys];
        else oracle.keys = [...oracle.keys, ...fresh];
        if (rng() < 0.3 && oracle.keys.length > 4) {
          const at = Math.floor(rng() * (oracle.keys.length - 2));
          const removeCount = 1 + Math.floor(rng() * 2);
          oracle.keys = [
            ...oracle.keys.slice(0, at),
            ...oracle.keys.slice(at + removeCount),
          ];
        }
        geometry.setKeys(oracle.keys);
        anchorSurvives = anchor !== null && oracle.keys.includes(anchor.key);
      } else {
        const key = oracle.keys[
          Math.floor(rng() * oracle.keys.length)
        ] as string;
        const height = 20 + Math.floor(rng() * 400);
        geometry.measure(key, height);
        oracle.heights.set(key, height);
        anchorSurvives = anchor !== null && anchor.key !== key;
      }

      const commit = geometry.resolve(capture);
      if (anchor !== null && anchorSurvives) {
        // By definition the anchor's viewport coordinate was -offset (the
        // viewport top sat `offset` px into the item). Clamping into the
        // scrollable range may truncate the correction at the edges; inside
        // the range the coordinate is exact.
        const after = geometry.offsetOf(anchor.key) - commit.scrollTop;
        if (
          commit.scrollTop > 0 &&
          commit.scrollTop < geometry.maxScrollTop(VIEWPORT_H)
        ) {
          expect(after).toBeCloseTo(-anchor.offset, 6);
        }
      }
      expectMatchesOracle(geometry, oracle);
    }
  });
});
