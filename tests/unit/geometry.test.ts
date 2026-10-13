import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../demos/shared/lab";
import {
  type AnchorPolicy,
  Geometry,
  type GeometryViewport,
} from "../../src/geometry";
import { KeyIndex } from "../../src/key-index";

// The geometry kernel is judged by the core invariants (docs/core-contract.md):
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
  policy: AnchorPolicy,
  mutate: () => void,
) {
  const capture = geometry.capture(vp, policy);
  mutate();
  return geometry.resolve(capture);
}

function seed(geometry: Geometry, keys: string[]): void {
  transact(geometry, viewport(0), "none", () => geometry.setKeys(keys));
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
    expect(() =>
      geometry.setKeys(new KeyIndex([...keysRange(0, 10), "poison"])),
    ).toThrow(/poison/);
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

  it("should share key order without sharing measurements or later replacements", () => {
    const keys = ["a", "b"];
    const order = new KeyIndex(keys);
    const first = new Geometry(100);
    const second = new Geometry(200);
    first.setKeys(order);
    second.setKeys(order);
    keys.reverse();
    first.measure("a", 10.25);
    second.measure("b", 20.5);

    first.setKeys(new KeyIndex(["b", "c"]));

    expect(first.offsetOf("b")).toBe(0);
    expect(first.heightOf("b")).toBe(100);
    expect(first.contentSize).toBe(200);
    expect(second.offsetOf("b")).toBe(200);
    expect(second.contentSize).toBe(220.5);
    expect(second.keyIndex.matches(["a", "b"])).toBe(true);
    expect(second.indexOf("c")).toBe(-1);
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

describe("append fast path", () => {
  it("consults the estimator only for appended keys", () => {
    const estimated: string[] = [];
    const geometry = new Geometry((key) => {
      estimated.push(key);
      return 100;
    });
    seed(geometry, keysRange(0, 10));
    // Measure the anchor row so the next capture does not estimate it.
    transact(geometry, viewport(0), "none", () => geometry.measure("m0", 100));
    estimated.length = 0;
    transact(geometry, viewport(0), "none", () =>
      geometry.setKeys(keysRange(0, 13)),
    );
    expect(estimated).toEqual(["m10", "m11", "m12"]);
    expect(geometry.count).toBe(13);
    expect(geometry.offsetOf("m12")).toBe(1200);
  });

  it("matches a fresh geometry after appends by array and by KeyIndex", () => {
    const appended = new Geometry(100);
    const fresh = new Geometry(100);
    seed(appended, keysRange(0, 10));
    transact(appended, viewport(0), "none", () => appended.measure("m4", 250));
    transact(appended, viewport(0), "none", () =>
      appended.setKeys(keysRange(0, 25)),
    );
    transact(appended, viewport(0), "none", () =>
      appended.setKeys(new KeyIndex(keysRange(0, 40))),
    );
    seed(fresh, keysRange(0, 40));
    transact(fresh, viewport(0), "none", () => fresh.measure("m4", 250));
    expect(appended.contentSize).toBe(fresh.contentSize);
    for (const key of keysRange(0, 40)) {
      expect(appended.offsetOf(key)).toBe(fresh.offsetOf(key));
      expect(appended.heightOf(key)).toBe(fresh.heightOf(key));
      expect(appended.indexOf(key)).toBe(fresh.indexOf(key));
    }
    expect(appended.window(viewport(1234), 300)).toEqual(
      fresh.window(viewport(1234), 300),
    );
    expect(appended.anchorAt(viewport(1234))).toEqual(
      fresh.anchorAt(viewport(1234)),
    );
  });

  it("rejects duplicates in the appended tail and leaves geometry intact", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 10));
    expect(() => geometry.setKeys([...keysRange(0, 10), "m3"])).toThrow(
      /duplicate key/,
    );
    expect(() => geometry.setKeys([...keysRange(0, 10), "x", "x"])).toThrow(
      /duplicate key/,
    );
    expect(geometry.count).toBe(10);
    expect(geometry.contentSize).toBe(1000);
    expect(geometry.indexOf("x")).toBe(-1);
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

  it("should preserve fractional learned heights by identity when measured and estimated rows exchange indices", () => {
    let estimate = 80;
    const geometry = new Geometry(() => estimate);
    geometry.setKeys(["small", "unseen", "large"]);
    geometry.measure("small", 0.125);
    geometry.measure("large", 2 ** 24 + 0.25);

    estimate = 90;
    geometry.setKeys(["large", "small", "unseen", "new"]);

    expect(geometry.heightOf("large")).toBe(2 ** 24 + 0.25);
    expect(geometry.heightOf("small")).toBe(0.125);
    expect(geometry.offsetOf("unseen")).toBe(2 ** 24 + 0.375);
    expect(geometry.isMeasured("unseen")).toBe(false);
    expect(geometry.isMeasured("new")).toBe(false);
    expect(geometry.isMeasured("absent")).toBe(false);
    expect(geometry.contentSize).toBe(2 ** 24 + 180.375);

    estimate = 100;
    expect(geometry.heightOf("unseen")).toBe(100);
    expect(geometry.heightOf("absent")).toBe(100);
    geometry.setKeys(["unseen", "new"]);
    geometry.setKeys(["small", "new", "large"]);
    expect(geometry.isMeasured("small")).toBe(false);
    expect(geometry.heightOf("large")).toBe(100);
    expect(geometry.contentSize).toBe(300);
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

  it("skips consecutive excluded keys and has no anchor when every key is excluded", () => {
    const geometry = new Geometry(10);
    geometry.setAnchorExclusion((key) => key.startsWith("slot:"));
    geometry.setKeys(["slot:start", "slot:end", "m0"]);
    expect(geometry.anchorAt(viewport(0))?.key).toBe("m0");

    // Excluded keys at the end: the anchor falls back to the last content
    // key before them.
    geometry.setKeys(["m0", "slot:a", "slot:b"]);
    expect(geometry.anchorAt(viewport(25))?.key).toBe("m0");

    geometry.setKeys(["slot:start", "slot:end"]);
    expect(geometry.anchorAt(viewport(0))).toBeNull();
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
    const vp = viewport(geometry.offsetOf("m10") + 30); // Anchor m10, 30px in.
    // The anchor and every old successor go; the rows after m9 are new keys,
    // not survivors, and there is plenty of range below (no clamp).
    const commit = transact(geometry, vp, "viewport", () =>
      geometry.setKeys([...keysRange(0, 10), ...keysRange(100, 112)]),
    );
    const predecessorBottom = geometry.offsetOf("m9") + geometry.heightOf("m9");
    expect(predecessorBottom).toBeLessThan(geometry.maxScrollTop(VIEWPORT_H));
    // Not the removed anchor's coordinate carried over (predecessorBottom +
    // 30), which a missing branch would fall back to.
    expect(commit.scrollTop).toBe(predecessorBottom);
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
    // Not end-compatible, so anchor mode (the runtime would otherwise
    // follow the end with a glide instead of the atomic anchor write).
    expect(commit.mode).toBe("anchor");
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
  it("should not create a pin from an explicit anchor when no pin existed", () => {
    const geometry = new Geometry(100);
    seed(geometry, ["prefix", "old"]);
    const target = { key: "new", offset: 44 };
    const capture = geometry.capture(viewport(0), "viewport", target);

    geometry.setKeys(["prefix", "new"], target);
    geometry.resolve(capture);

    expect(geometry.pinned).toBeNull();
    // A reading anchor can require temporary space without becoming a pin.
    expect(geometry.reserve).toBe(456);
  });
  it("should retain a surviving pin when a different explicit anchor is supplied", () => {
    const { geometry } = pinnedAtEnd();

    geometry.setKeys([...keysRange(0, 20), "new"], { key: "new", offset: 44 });

    expect(geometry.pinned).toBe("m18");
  });
  it("should clear a removed pin when its explicit replacement is absent", () => {
    const { geometry } = pinnedAtEnd();

    geometry.setKeys(keysRange(0, 17), { key: "missing", offset: 44 });

    expect(geometry.pinned).toBeNull();
  });
  it("should transfer a pin to an explicit replacement across header changes and regrow its reserve", () => {
    const geometry = new Geometry(100);
    seed(geometry, ["prefix", "today", "v3", "reply3"]);
    transact(geometry, viewport(0), "none", () => geometry.pin("v3", 44));
    let vp = viewport(geometry.maxScrollTop(VIEWPORT_H));
    const second = { key: "v2", offset: 44 };
    const capture = geometry.capture(vp, "viewport", second);

    geometry.setKeys(["prefix", "v2", "reply2"], second);
    geometry.measure("reply2", VIEWPORT_H);
    const result = geometry.resolve(capture);

    expect(geometry.pinned).toBe("v2");
    expect(geometry.offsetOf("v2") - result.scrollTop).toBe(44);
    expect(geometry.reserve).toBe(0);

    vp = viewport(result.scrollTop);
    const first = { key: "v1", offset: 44 };
    const shorter = geometry.capture(vp, "viewport", first);
    geometry.setKeys(["prefix", "v1", "reply1"], first);
    geometry.measure("v1", 100);
    geometry.measure("reply1", 100);
    const restored = geometry.resolve(shorter);

    expect(geometry.pinned).toBe("v1");
    expect(geometry.offsetOf("v1") - restored.scrollTop).toBe(44);
    expect(geometry.reserve).toBe(VIEWPORT_H - 244);
  });
  it("includes a host inset in the pinned end position", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 20));
    const commit = transact(geometry, viewport(0), "none", () =>
      geometry.pin("m18", 44),
    );
    expect(commit.scrollTop).toBe(0);

    const target = geometry.offsetOf("m18") - 44;
    expect(geometry.maxScrollTop(VIEWPORT_H)).toBe(target);
    expect(geometry.reserve).toBe(target + VIEWPORT_H - geometry.contentSize);
  });

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

  it.each(["none", "auto", "viewport"] as const)(
    "should consume reserve during bottom overscroll with %s policy",
    (policy) => {
      const { geometry, vp } = pinnedAtEnd();
      const total = geometry.totalSize;

      for (let height = 110; height <= 180; height += 10) {
        const bounced = viewport(geometry.maxScrollTop(VIEWPORT_H) + 24);
        const result = transact(geometry, bounced, policy, () =>
          geometry.measure("m19", height),
        );

        expect(result.totalSize).toBe(total);
        expect(result.scrollTop).toBe(vp.scrollTop);
      }
    },
  );

  it("passes the pin to a row replacing the pinned one in place; another removal drops it", () => {
    const { geometry, vp } = pinnedAtEnd();
    const total = geometry.totalSize;
    // A version switch: the pinned prompt and its reply are other rows now.
    const switched = [...keysRange(0, 18), "m18b", "m19b"];
    transact(geometry, vp, "auto", () => geometry.setKeys(switched));
    expect(geometry.pinned).toBe("m18b");
    expect(geometry.totalSize).toBeCloseTo(total, 6);
    // The replacement's reply is taller, then the first version returns:
    // the reserve regrows and the pinned position holds.
    transact(geometry, vp, "auto", () => geometry.measure("m19b", 300));
    expect(geometry.totalSize).toBeCloseTo(total, 6);
    transact(geometry, vp, "auto", () => geometry.setKeys(keysRange(0, 20)));
    expect(geometry.pinned).toBe("m18");
    expect(geometry.totalSize).toBeCloseTo(total, 6);
    expect(geometry.maxScrollTop(VIEWPORT_H)).toBeCloseTo(
      geometry.offsetOf("m18"),
      6,
    );
    // A removal that shifts the rows before it is not a replacement.
    transact(geometry, vp, "auto", () =>
      geometry.setKeys([...keysRange(0, 17), "x", "m19"]),
    );
    expect(geometry.pinned).toBeNull();
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
    const reserveBefore = geometry.reserve;
    transact(geometry, vp, "viewport", () => {
      geometry.setKeys(keysRange(0, 20).filter((k) => k !== "m18"));
      expect(geometry.pinned).toBeNull(); // Cleared by the key change itself.
    });
    expect(geometry.pinned).toBeNull();
    // Standing inside the reserve keeps it whole (no yank): the pin's target
    // is gone, but the floor holds what the viewport still stands on.
    expect(reserveBefore).toBeGreaterThan(0);
    expect(geometry.reserve).toBe(reserveBefore);
    // ...and it drains once the viewport leaves.
    transact(geometry, viewport(0), "none", () => {});
    expect(geometry.reserve).toBe(0);
  });

  it("should retain a pin whose key reaches the start and later moves down", () => {
    const { geometry } = pinnedAtEnd(); // m18 pinned, reserve 400.
    expect(geometry.pinned).toBe("m18");
    expect(geometry.reserve).toBeGreaterThan(0);
    // Everything above the pinned key goes: it is the first row now, and
    // anchoring the start needs no new reserve, but the key is still pinned.
    transact(geometry, viewport(0), "viewport", () =>
      geometry.setKeys(keysRange(18, 20)),
    );
    expect(geometry.pinned).toBe("m18");
    // The floor keeps the two rows under the 600px viewport covered.
    expect(geometry.reserve).toBe(VIEWPORT_H - 2 * 100);
    transact(geometry, viewport(0), "viewport", () =>
      geometry.setKeys(keysRange(0, 20)),
    );
    expect(geometry.maxScrollTop(VIEWPORT_H)).toBe(1800);
    expect(geometry.pinned).toBe("m18");
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
});

describe("window planning", () => {
  it.each([0, 4400])(
    "keeps the edge window stable through a bounce at %s",
    (edge) => {
      const geometry = new Geometry(100);
      seed(geometry, keysRange(0, 50));
      const settled = geometry.window(viewport(edge), 200);
      const direction = edge === 0 ? -1 : 1;
      for (const distance of [1, 75, 150, 250, 150, 75, 1, 0]) {
        expect(
          geometry.window(viewport(edge + direction * distance), 200),
        ).toEqual(settled);
      }
    },
  );

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
      // Reading anchors live in the legal range; elastic offsets are covered
      // separately and must not become positions preserved across updates.
      const vp = viewport(
        rng() * Math.max(0, oracle.contentSize() - VIEWPORT_H),
      );
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

describe("host-named anchor", () => {
  it.each([false, true])(
    "should retire old reading reserve for an explicit end request (pin=%s)",
    (pinned) => {
      const geometry = new Geometry(100);
      seed(geometry, [...keysRange(0, 10), "prompt", "reply", "later"]);
      geometry.measure("later", 1000);
      if (pinned) geometry.pin("prompt", 40);
      const before = { scrollTop: 1150, height: 600 };
      const reading = geometry.capture(before, "viewport", {
        key: "reply",
        offset: -50,
      });
      geometry.setKeys([...keysRange(0, 10), "prompt", "reply"]);
      geometry.resolve(reading);
      expect(geometry.reserve).toBe(550);

      const result = geometry.resolve(geometry.capture(before, "end"));

      expect(result.scrollTop).toBe(pinned ? 960 : 600);
      expect(geometry.reserve).toBe(pinned ? 360 : 0);
    },
  );
  it.each([
    { pinned: true, atEnd: true, expected: 960 },
    { pinned: true, atEnd: false, expected: 960 },
    { pinned: false, atEnd: true, expected: 1113 },
  ])(
    "should reveal a clipped collapsed pin throughout its scroll range: %j",
    ({ pinned, atEnd, expected }) => {
      const geometry = new Geometry(100);
      seed(geometry, [...keysRange(0, 10), "prompt", "reply"]);
      geometry.measure("prompt", 540);
      geometry.measure("reply", 386);
      if (pinned) geometry.pin("prompt", 40);
      const capture = geometry.capture(
        { scrollTop: atEnd ? 1113 : 1093, height: 813 },
        "viewport",
      );

      geometry.measure("prompt", 220);
      const result = geometry.resolve(capture);

      expect(result.scrollTop).toBe(expected);
      expect(geometry.offsetOf("prompt") - result.scrollTop).toBe(
        1000 - expected,
      );
    },
  );
  it("should clamp internal viewport reflow without creating reading reserve", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 10));
    const capture = geometry.capture(
      { scrollTop: 500, height: 500 },
      "viewport",
      null,
      false,
    );

    geometry.measure("m9", 20);
    const result = geometry.resolve(capture);

    expect(result.scrollTop).toBe(420);
    expect(result.totalSize).toBe(920);
    expect(geometry.reserve).toBe(0);
  });
  it("should create reserve for a viewport-preserving collapse beyond the pin", () => {
    const geometry = new Geometry(100);
    seed(geometry, [...keysRange(0, 10), "prompt", "reply"]);
    geometry.measure("prompt", 540);
    geometry.measure("reply", 268);
    geometry.pin("prompt", 40);
    const before = { scrollTop: 995, height: 813 };
    geometry.resolve(geometry.capture(before, "none"));
    expect(geometry.reserve).toBe(0);
    const capture = geometry.capture(before, "viewport");

    geometry.measure("prompt", 220);
    const result = geometry.resolve(capture);

    expect(result.scrollTop).toBe(995);
    expect(geometry.reserve).toBe(320);
    expect(
      geometry.resolve(geometry.capture(before, "viewport")).scrollTop,
    ).toBe(995);
    // The extra reading space drains after the reader moves away; the pin remains.
    geometry.resolve(geometry.capture({ ...before, scrollTop: 0 }, "viewport"));
    expect(geometry.reserve).toBe(285);
  });
  it.each([
    { offset: -24, height: 148, expected: 352 },
    { offset: -24, height: 64, expected: 436 },
    { offset: -500, height: 100, expected: 400 },
    { offset: 30, height: 10, expected: 490 },
    { offset: 30, height: 100, expected: 400 },
    { offset: 650, height: 100, expected: 400 },
  ])(
    "should retain or reveal a measured replacement: $offset / $height",
    ({ offset, height, expected }) => {
      const geometry = new Geometry(100);
      seed(geometry, [...keysRange(0, 20), "old", "reply"]);
      geometry.measure("old", 1000);
      const anchor = { key: "new", offset, visibilityInset: 40 };
      const captured = geometry.capture(
        viewport(2000 - offset),
        "viewport",
        anchor,
      );
      geometry.setKeys([...keysRange(0, 20), "new", "reply"], anchor);
      geometry.measure("new", height);

      const result = geometry.resolve(captured);

      expect(geometry.offsetOf("new") - result.scrollTop).toBe(expected);
      expect(
        geometry.resolve(
          geometry.capture(viewport(result.scrollTop), "viewport"),
        ).scrollTop,
      ).toBe(result.scrollTop);
    },
  );
  it.each([
    { replyHeight: 100, inset: 0, expected: 0 },
    { replyHeight: 100, inset: 40, expected: 40 },
    { replyHeight: 412, inset: 40, expected: 40 },
    { replyHeight: 413, inset: 40, expected: 39 },
    { replyHeight: 900, inset: 40, expected: -24 },
  ])(
    "should reveal a clipped replacement when its remaining tail fits: $replyHeight / $inset",
    ({ replyHeight, inset, expected }) => {
      const geometry = new Geometry(100);
      const prefix = keysRange(0, 10);
      seed(geometry, [...prefix, "expanded", "old-reply"]);
      geometry.measure("expanded", 1000);
      geometry.pin("expanded", inset);
      const target = { key: "short", offset: -24, visibilityInset: inset };
      const capture = geometry.capture(viewport(1024), "viewport", target);

      geometry.setKeys([...prefix, "short", "new-reply"], target);
      geometry.measure("short", 148);
      geometry.measure("new-reply", replyHeight);
      const result = geometry.resolve(capture);

      expect(geometry.offsetOf("short") - result.scrollTop).toBe(expected);
      expect(
        geometry.resolve(
          geometry.capture(viewport(result.scrollTop), "viewport"),
        ).scrollTop,
      ).toBe(result.scrollTop);
      if (expected === inset)
        expect(geometry.maxScrollTop(VIEWPORT_H)).toBe(1000 - inset);
    },
  );
  it.each([0, 40])(
    "should bottom-align a shorter final replacement without extra reading space (inset %i)",
    (inset) => {
      const geometry = new Geometry(100);
      const prefix = keysRange(0, 10);
      seed(geometry, [...prefix, "lead", "short"]);
      geometry.measure("lead", 400);
      geometry.measure("short", 200);
      geometry.pin("lead", inset);
      let before = geometry.resolve(geometry.capture(viewport(0), "end"));

      for (const [from, to, height] of [
        ["short", "long", 1200],
        ["long", "short", 200],
        ["short", "long", 1200],
        ["long", "short", 200],
      ] as const) {
        const target = {
          key: to,
          offset: geometry.offsetOf(from) - before.scrollTop,
          visibilityInset: inset,
        };
        const capture = geometry.capture(
          viewport(before.scrollTop),
          "viewport",
          target,
        );
        geometry.setKeys([...prefix, "lead", to], target);
        geometry.measure(to, height);
        const result = geometry.resolve(capture);

        if (to === "short") {
          expect(result.scrollTop).toBe(1000);
          expect(geometry.offsetOf(to) + height - result.scrollTop).toBe(
            VIEWPORT_H,
          );
          expect(geometry.reserve).toBe(0);
          expect(
            geometry.resolve(
              geometry.capture(viewport(result.scrollTop), "viewport"),
            ).scrollTop,
          ).toBe(1000);
        }
        // Read to the bottom of each version before switching back.
        before = geometry.resolve(
          geometry.capture(viewport(result.scrollTop), "end"),
        );
      }
    },
  );
  it.each([0, 44, 144])(
    "should preserve a replacement at offset %i when a long tail becomes short",
    (offset) => {
      const geometry = new Geometry(100);
      seed(geometry, [...keysRange(0, 10), "prompt", "long"]);
      geometry.measure("long", 2000);
      geometry.pin("prompt", 44);
      geometry.resolve(geometry.capture(viewport(0), "none"));
      const target = { key: "short", offset };
      const before = viewport(geometry.offsetOf("long") - offset);
      const capture = geometry.capture(before, "viewport", target);

      geometry.setKeys([...keysRange(0, 10), "prompt", "short"], target);
      const result = geometry.resolve(capture);

      expect(geometry.offsetOf("short") - result.scrollTop).toBe(offset);
      expect(geometry.pinned).toBe("prompt");
      expect(geometry.reserve).toBe(VIEWPORT_H - 100 - offset);
      const settled = geometry.resolve(
        geometry.capture(viewport(result.scrollTop), "viewport"),
      );
      expect(settled.scrollTop).toBe(result.scrollTop);
      // Extra reading reserve drains after leaving it; the prompt pin stays.
      geometry.resolve(geometry.capture(viewport(0), "viewport"));
      expect(geometry.reserve).toBe(VIEWPORT_H - 244);
      expect(geometry.pinTop).toBe(956);
    },
  );

  it.each([0, 44, 144])(
    "should retain the top landing inset when replacing a descendant pin at reading offset %i",
    (offset) => {
      const geometry = new Geometry(100);
      seed(geometry, [...keysRange(0, 10), "old", "reply", "later", "long"]);
      geometry.measure("long", 2000);
      geometry.pin("later", 44);
      const target = { key: "new", offset };
      const capture = geometry.capture(
        viewport(geometry.offsetOf("old") - offset),
        "viewport",
        target,
      );

      geometry.setKeys([...keysRange(0, 10), "new", "short"], target);
      const result = geometry.resolve(capture);

      expect(geometry.offsetOf("new") - result.scrollTop).toBe(offset);
      expect(geometry.pinned).toBe("new");
      expect(geometry.pinTop).toBe(956);
      expect(geometry.maxScrollTop(VIEWPORT_H)).toBeGreaterThanOrEqual(956);
    },
  );

  it("should not reserve space for an absent explicit anchor", () => {
    const geometry = new Geometry(100);
    seed(geometry, ["only"]);
    const capture = geometry.capture(viewport(0), "viewport", {
      key: "missing",
      offset: -1000,
    });

    const result = geometry.resolve(capture);

    expect(result.scrollTop).toBe(0);
    expect(geometry.reserve).toBe(0);
  });

  it("puts the named key's top at the named offset; a missing key falls back to the captured anchor", () => {
    const geometry = new Geometry(100);
    seed(geometry, keysRange(0, 40));
    const xs = Array.from({ length: 40 }, (_, i) => `x${i}`);
    const vp = viewport(geometry.offsetOf("m10") + 40);
    const capture = geometry.capture(vp, "viewport", {
      key: "x3",
      offset: -25,
    });
    geometry.setKeys(xs);
    expect(geometry.resolve(capture).scrollTop).toBe(
      geometry.offsetOf("x3") + 25,
    );

    const missing = geometry.capture(
      viewport(geometry.offsetOf("x4") + 10),
      "viewport",
      { key: "gone", offset: 0 },
    );
    geometry.setKeys(["y0", ...xs]);
    expect(geometry.resolve(missing).scrollTop).toBe(
      geometry.offsetOf("x4") + 10,
    );
  });

  it("exposes indexed heightAt, offsetAt, and anchorIndexAt consistent with keyed accessors", () => {
    const geometry = new Geometry(100);
    expect(geometry.anchorIndexAt(viewport(0))).toBe(-1);
    expect(geometry.heightAt(0)).toBe(0);
    expect(geometry.offsetAt(-1)).toBe(-1);
    expect(geometry.offsetAt(0)).toBe(-1);

    seed(geometry, ["a", "b", "c"]);
    geometry.measure("b", 140);
    expect(geometry.heightAt(0)).toBe(geometry.heightOf("a"));
    expect(geometry.heightAt(1)).toBe(geometry.heightOf("b"));
    expect(geometry.heightAt(3)).toBe(0);
    expect(geometry.offsetAt(0)).toBe(geometry.offsetOf("a"));
    expect(geometry.offsetAt(2)).toBe(geometry.offsetOf("c"));
    expect(geometry.offsetAt(3)).toBe(-1);
    expect(geometry.anchorIndexAt(viewport(120))).toBe(1);
  });
});
