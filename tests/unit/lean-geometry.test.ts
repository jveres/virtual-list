import { describe, expect, it } from "vitest";
import { Geometry, type GeometryViewport } from "../../src/lean/geometry";

// The geometry kernel is judged by the lean-core invariants (docs/lean-core.md):
// I1 — the visible anchor's viewport coordinate never moves across
//      setKeys/measure once the returned scrollDelta is applied;
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

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
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

describe("offsets and totals", () => {
  it("matches the naive oracle through appends, prepends, and measures", () => {
    const geometry = new Geometry(100);
    const oracle = new Oracle(100);

    oracle.keys = keysRange(10, 20);
    geometry.setKeys(oracle.keys, viewport(0), "none");
    expectMatchesOracle(geometry, oracle);

    geometry.measure("m12", 240, viewport(0));
    oracle.heights.set("m12", 240);
    expectMatchesOracle(geometry, oracle);

    // Prepend history: learned heights survive by identity.
    oracle.keys = [...keysRange(0, 10), ...oracle.keys];
    geometry.setKeys(oracle.keys, viewport(0), "none");
    expectMatchesOracle(geometry, oracle);
    expect(geometry.heightOf("m12")).toBe(240);
    expect(geometry.isMeasured("m12")).toBe(true);
  });

  it("drops learned heights for removed keys", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(["a", "b"], viewport(0), "none");
    geometry.measure("b", 500, viewport(0));
    geometry.setKeys(["a"], viewport(0), "none");
    geometry.setKeys(["a", "b"], viewport(0), "none");
    expect(geometry.heightOf("b")).toBe(100);
    expect(geometry.isMeasured("b")).toBe(false);
  });
});

describe("I1 — anchor preservation", () => {
  it("keeps the anchor's viewport coordinate through a prepend", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(10, 30), viewport(0), "none");
    // Reading m15 with the viewport top 30px into it.
    const vp = viewport(geometry.offsetOf("m15") + 30);
    const before = geometry.offsetOf("m15") - vp.scrollTop;

    const commit = geometry.setKeys(
      [...keysRange(0, 10), ...keysRange(10, 30)],
      vp,
      "viewport",
    );
    const after =
      geometry.offsetOf("m15") - (vp.scrollTop + commit.scrollDelta);
    expect(after).toBeCloseTo(before, 6);
  });

  it("measure above the viewport shifts scroll; below does not", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    const vp = viewport(geometry.offsetOf("m10"));

    const above = geometry.measure("m2", 300, vp);
    expect(above.scrollDelta).toBe(200);

    const vp2 = viewport(vp.scrollTop + above.scrollDelta);
    const below = geometry.measure("m15", 400, vp2);
    expect(below.scrollDelta).toBe(0);
  });

  it("a shrink spanning the viewport top does not push the anchor up", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    geometry.measure("m5", 500, viewport(0));
    // Viewport top sits inside m5's grown extent.
    const vp = viewport(geometry.offsetOf("m5") + 350);
    const commit = geometry.measure("m5", 100, vp);
    // The shrink happens at/around the top; the correction may pull the
    // viewport back but never below the item's new extent.
    expect(vp.scrollTop + commit.scrollDelta).toBeGreaterThanOrEqual(
      geometry.offsetOf("m5"),
    );
  });

  it("falls back to the nearest surviving neighbor when the anchor is removed", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    const vp = viewport(geometry.offsetOf("m10") + 10);
    const nextKeys = keysRange(0, 20).filter((k) => k !== "m10");
    const commit = geometry.setKeys(nextKeys, vp, "viewport");
    // The neighbor (m9) ends up exactly at the viewport top.
    expect(geometry.offsetOf("m9")).toBeCloseTo(
      vp.scrollTop + commit.scrollDelta,
      6,
    );
  });
});

describe("anchor policies", () => {
  it("auto follows the end for appends while at the end", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    const vp = viewport(geometry.maxScrollTop(viewport(0)));

    const commit = geometry.setKeys(keysRange(0, 22), vp, "auto");
    expect(vp.scrollTop + commit.scrollDelta).toBeCloseTo(
      geometry.maxScrollTop(vp),
      6,
    );
  });

  it("auto preserves the viewport for appends while reading history", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    const vp = viewport(geometry.offsetOf("m4"));

    const commit = geometry.setKeys(keysRange(0, 25), vp, "auto");
    expect(commit.scrollDelta).toBe(0);
    expect(geometry.offsetOf("m4")).toBe(vp.scrollTop);
  });
});

describe("I5 — pin-to-top reserve", () => {
  it("reserves exactly the shortfall to top-align the pinned key", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    const pinnedTop = geometry.offsetOf("m18");

    geometry.pin("m18", viewport(0));
    expect(geometry.totalSize).toBeCloseTo(pinnedTop + VIEWPORT_H, 6);
    // The pinned key can now sit at the viewport top.
    const vp = viewport(geometry.maxScrollTop(viewport(0)));
    expect(vp.scrollTop).toBeCloseTo(pinnedTop, 6);
  });

  it("growth consumes the reserve without changing the total; shrink regrows it", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    geometry.pin("m18", viewport(0));
    const total = geometry.totalSize;
    const vp = viewport(geometry.maxScrollTop(viewport(0)));

    geometry.measure("m19", 300, vp);
    expect(geometry.totalSize).toBeCloseTo(total, 6);

    geometry.measure("m19", 100, vp);
    expect(geometry.totalSize).toBeCloseTo(total, 6);
  });

  it("keeps a viewport-covering reserve alive through transient growth (no yank)", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    geometry.pin("m18", viewport(0));
    const vp = viewport(geometry.maxScrollTop(viewport(0)));

    // Growth consumes the whole reserve...
    geometry.measure("m19", 100 + geometry.reserve + 400, vp);
    expect(geometry.reserve).toBe(0);
    // ...and the following shrink regrows it: the viewport never loses the
    // surface it is standing on.
    geometry.measure("m19", 100, vp);
    expect(geometry.totalSize).toBeGreaterThanOrEqual(
      vp.scrollTop + VIEWPORT_H - 1,
    );
  });

  it("drains a released reserve only when the viewport no longer needs it", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 20), viewport(0), "none");
    geometry.pin("m18", viewport(0));
    const atEnd = viewport(geometry.maxScrollTop(viewport(0)));

    // Unpin while standing inside the reserve: it must hold.
    geometry.pin(null, atEnd);
    expect(geometry.totalSize).toBeGreaterThanOrEqual(
      atEnd.scrollTop + VIEWPORT_H - 1,
    );

    // Away from it, the reserve drains.
    geometry.refresh(viewport(0));
    expect(geometry.reserve).toBe(0);
  });
});

describe("window planning", () => {
  it("covers the viewport plus overscan and stays in bounds", () => {
    const geometry = new Geometry(100);
    geometry.setKeys(keysRange(0, 50), viewport(0), "none");
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
  it("stays exact through random splices and measures", () => {
    const rng = mulberry32(0xc0ffee);
    const geometry = new Geometry(80);
    const oracle = new Oracle(80);
    let nextId = 0;

    for (let step = 0; step < 400; step++) {
      const roll = rng();
      if (roll < 0.35 || oracle.keys.length === 0) {
        // Splice: prepend, append, or remove a run.
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
        const vp = viewport(rng() * Math.max(0, oracle.contentSize()));
        geometry.setKeys(oracle.keys, vp, "viewport");
      } else {
        const key = oracle.keys[
          Math.floor(rng() * oracle.keys.length)
        ] as string;
        const height = 20 + Math.floor(rng() * 400);
        const vp = viewport(rng() * Math.max(0, oracle.contentSize()));
        const anchor = geometry.anchorAt(vp);
        const before =
          anchor === null ? null : geometry.offsetOf(anchor.key) - vp.scrollTop;
        const commit = geometry.measure(key, height, vp);
        oracle.heights.set(key, height);
        // I1 (measure form): anchors at or below the change stay put; the
        // returned delta absorbs changes above.
        if (anchor !== null && anchor.key !== key) {
          const after =
            geometry.offsetOf(anchor.key) - (vp.scrollTop + commit.scrollDelta);
          expect(after).toBeCloseTo(before as number, 6);
        }
      }
      expectMatchesOracle(geometry, oracle);
    }
  });
});
