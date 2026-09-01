import { FenwickTree } from "./fenwick";

// The lean core's geometry kernel: keyed items, learned heights, offsets,
// anchoring, and the pin-to-top reserve — as pure math. No DOM, no
// scheduling, no side effects; the runtime (step 2) feeds it measurements
// and applies the single scroll target it resolves. Identity is the key;
// indexes are derived positions and never survive an update.
//
// One logical update is one transaction (I4):
//
//   const capture = geometry.capture(viewport, policy);
//   geometry.setKeys(nextKeys);      // any number of mutations
//   geometry.measure(key, height);
//   const commit = geometry.resolve(capture);  // one absolute scroll target
//
// Anchor intent is captured on the old geometry; the commit is resolved
// against the final geometry, so measurements landing inside the
// transaction are fully reflected (end-follow reaches the *measured* end,
// never an estimated one — I2).
//
// Invariants owned here (see docs/lean-core.md):
//   I1  the resolved scroll target keeps the visible anchor's viewport
//       coordinate stationary;
//   I5  a pinned key can always be scrolled to the viewport top: the
//       reserve makes up the shortfall, is consumed by growth and regrown
//       by shrinkage, and never collapses out from under the viewport.

export type AnchorPolicy = "auto" | "viewport" | "end" | "none";

export interface GeometryViewport {
  scrollTop: number;
  height: number;
}

export interface Commit {
  /** Absolute scroll target — the arbiter performs exactly one write. */
  scrollTop: number;
  /** Content size plus reserve — the scroll surface height. */
  totalSize: number;
}

/** Opaque transaction token from `capture`; spend it once in `resolve`. */
export interface Capture {
  readonly viewport: GeometryViewport;
  readonly policy: AnchorPolicy;
  readonly atEnd: boolean;
  readonly oldKeys: readonly string[];
  readonly anchor: { key: string; offset: number; oldIndex: number } | null;
}

const EPSILON = 0.5;

export class Geometry {
  private keys: readonly string[] = [];
  private indexByKey = new Map<string, number>();
  private tree = new FenwickTree(new Float64Array(0));
  /** Learned (measured) heights by identity; estimates fill the rest. */
  private readonly heightByKey = new Map<string, number>();
  private readonly measuredKeys = new Set<string>();
  private readonly estimateForKey: (key: string) => number;
  private pinnedKey: string | null = null;
  private reservePx = 0;

  constructor(estimate: number | ((key: string) => number)) {
    this.estimateForKey =
      typeof estimate === "number" ? () => estimate : estimate;
  }

  get count(): number {
    return this.keys.length;
  }

  keyAt(index: number): string | undefined {
    return this.keys[index];
  }

  indexOf(key: string): number {
    return this.indexByKey.get(key) ?? -1;
  }

  /** Learned height, or the (validated) estimate for unseen keys. */
  heightOf(key: string): number {
    const learned = this.heightByKey.get(key);
    if (learned !== undefined) return learned;
    const estimate = this.estimateForKey(key);
    if (!Number.isFinite(estimate) || estimate <= 0) {
      throw new Error(
        `estimate for "${key}" must be finite and > 0, got ${estimate}`,
      );
    }
    return estimate;
  }

  isMeasured(key: string): boolean {
    return this.measuredKeys.has(key);
  }

  /** Content-space top of the item; `indexOf(key) === -1` yields -1. */
  offsetOf(key: string): number {
    const index = this.indexByKey.get(key);
    return index === undefined ? -1 : this.tree.prefix(index);
  }

  get contentSize(): number {
    return this.tree.total();
  }

  get reserve(): number {
    return this.reservePx;
  }

  get totalSize(): number {
    return this.contentSize + this.reservePx;
  }

  get pinned(): string | null {
    return this.pinnedKey;
  }

  maxScrollTop(viewportHeight: number): number {
    return Math.max(0, this.totalSize - viewportHeight);
  }

  /** The item owning the viewport top, and how far into it the top sits. */
  anchorAt(viewport: GeometryViewport): { key: string; offset: number } | null {
    if (this.keys.length === 0) return null;
    const top = Math.max(0, Math.min(viewport.scrollTop, this.contentSize));
    let index = Math.min(this.tree.indexAt(top), this.keys.length - 1);
    // A row with less than EPSILON left below the viewport top is not what
    // the user sees as the top row: anchoring it would let its own growth
    // push the visually top-aligned successor down by the full delta.
    // Anchor the successor instead, with a (slightly negative) offset that
    // keeps the exact coordinate.
    const remaining = this.tree.prefix(index + 1) - top;
    if (remaining <= EPSILON && index + 1 < this.keys.length) index += 1;
    const key = this.keys[index];
    if (key === undefined) return null;
    return { key, offset: top - this.tree.prefix(index) };
  }

  /** Mounted index range covering the viewport plus overscan. */
  window(
    viewport: GeometryViewport,
    overscanPx: number,
  ): { start: number; end: number } {
    if (this.keys.length === 0) return { start: 0, end: 0 };
    const top = Math.max(0, viewport.scrollTop - overscanPx);
    const bottom = Math.min(
      this.contentSize,
      viewport.scrollTop + viewport.height + overscanPx,
    );
    const start = Math.min(this.tree.indexAt(top), this.keys.length - 1);
    let end = start;
    while (end < this.keys.length && this.tree.prefix(end) < bottom) end++;
    return { start, end };
  }

  /** Open a transaction: resolve anchor intent on the current geometry. */
  capture(viewport: GeometryViewport, policy: AnchorPolicy = "auto"): Capture {
    const anchor = this.anchorAt(viewport);
    return {
      viewport: { ...viewport },
      policy,
      atEnd:
        this.maxScrollTop(viewport.height) - viewport.scrollTop <= 2 * EPSILON,
      oldKeys: this.keys,
      anchor:
        anchor === null
          ? null
          : { ...anchor, oldIndex: this.indexByKey.get(anchor.key) as number },
    };
  }

  /**
   * Replace the item order. Keys are identity: duplicates are rejected.
   * Learned heights survive by key; heights of removed keys are dropped; a
   * removed pin is cleared.
   */
  setKeys(nextKeys: readonly string[]): void {
    // Build and validate the entire candidate state first — a throwing
    // estimator or a duplicate key must leave the previous geometry fully
    // intact, never a half-updated one.
    const keys = [...nextKeys];
    const indexByKey = new Map(keys.map((key, index) => [key, index]));
    if (indexByKey.size !== keys.length) {
      const seen = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) throw new Error(`duplicate key: "${key}"`);
        seen.add(key);
      }
    }
    const sizes = new Float64Array(keys.length);
    for (let index = 0; index < keys.length; index++) {
      sizes[index] = this.heightOf(keys[index] as string);
    }
    const tree = new FenwickTree(sizes);

    this.keys = keys;
    this.indexByKey = indexByKey;
    this.tree = tree;
    for (const key of this.measuredKeys) {
      if (!indexByKey.has(key)) {
        this.measuredKeys.delete(key);
        this.heightByKey.delete(key);
      }
    }
    if (this.pinnedKey !== null && !indexByKey.has(this.pinnedKey)) {
      this.pinnedKey = null;
    }
  }

  /**
   * Commit a learned height, exactly. Unknown keys and invalid heights are
   * no-ops. A measured key never consults the estimator again: `isMeasured`
   * implies `heightOf` returns the stored value. Noise suppression (skipping
   * sub-pixel deltas) is the DOM runtime's concern, not the kernel's.
   */
  measure(key: string, height: number): void {
    const index = this.indexByKey.get(key);
    if (index === undefined || !Number.isFinite(height) || height <= 0) return;
    const delta = height - this.heightOf(key);
    this.heightByKey.set(key, height);
    this.measuredKeys.add(key);
    if (delta !== 0) this.tree.add(index, delta);
  }

  /**
   * Pin a key: reserve enough trailing space that its top can sit at the
   * viewport top (the chat send flow). `null` releases the pin; remaining
   * reserve then drains only once the viewport no longer stands on it (I5).
   */
  pin(key: string | null): void {
    this.pinnedKey = key !== null && this.indexByKey.has(key) ? key : null;
  }

  /**
   * Close the transaction: one absolute scroll target against the final
   * geometry.
   * - end mode (explicit, or auto while at the end when the old keys are an
   *   unchanged prefix of the new — appends and same-key streaming updates):
   *   the measured end, including the recomputed reserve.
   * - anchor mode: the captured anchor's viewport coordinate is preserved.
   *   A removed anchor falls to its first surviving successor (inheriting
   *   the in-row offset — the content was replaced, the reading position
   *   was not), else to the predecessor end-aligned.
   * - none: the captured scrollTop, clamped.
   */
  resolve(capture: Capture): Commit {
    const { viewport } = capture;
    const mode = this.resolveMode(capture);

    if (mode === "end") {
      this.recomputeReserve(viewport.height, viewport.scrollTop);
      return {
        scrollTop: this.maxScrollTop(viewport.height),
        totalSize: this.totalSize,
      };
    }

    let target = viewport.scrollTop;
    if (mode === "anchor" && capture.anchor !== null) {
      target = this.anchorTarget(capture) ?? viewport.scrollTop;
    }
    this.recomputeReserve(viewport.height, target);
    return {
      scrollTop: Math.max(
        0,
        Math.min(target, this.maxScrollTop(viewport.height)),
      ),
      totalSize: this.totalSize,
    };
  }

  private resolveMode(capture: Capture): "end" | "anchor" | "none" {
    if (capture.policy === "end") return "end";
    if (capture.policy === "none") return "none";
    if (capture.policy === "viewport") return "anchor";
    // auto: follow the end only for end-compatible updates — the old keys
    // are an unchanged prefix of the new (pure appends, or the identical
    // list carrying streaming measurements). Prepends, reorders, and
    // replacements preserve the viewport even at the end.
    if (!capture.atEnd) return "anchor";
    const oldKeys = capture.oldKeys;
    const endCompatible =
      this.keys.length >= oldKeys.length &&
      oldKeys.every((key, index) => this.keys[index] === key);
    return endCompatible ? "end" : "anchor";
  }

  private anchorTarget(capture: Capture): number | null {
    const anchor = capture.anchor;
    if (anchor === null) return null;

    if (this.indexByKey.has(anchor.key)) {
      // Clamp the in-row offset to the (possibly shrunken) current extent: a
      // shrink cannot push the viewport above the item's own bounds.
      const offset = Math.min(anchor.offset, this.heightOf(anchor.key));
      return this.offsetOf(anchor.key) + offset;
    }
    // First surviving successor, inheriting the removed anchor's in-row
    // offset: the content under the viewport was replaced; the position
    // should feel like replacement, not backwards navigation.
    for (let i = anchor.oldIndex + 1; i < capture.oldKeys.length; i++) {
      const key = capture.oldKeys[i];
      if (key !== undefined && this.indexByKey.has(key)) {
        const offset = Math.min(anchor.offset, this.heightOf(key));
        return this.offsetOf(key) + offset;
      }
    }
    // No successor: predecessor, end-aligned (its bottom at the viewport
    // top would show removed space; align the viewport top to its bottom).
    for (let i = anchor.oldIndex - 1; i >= 0; i--) {
      const key = capture.oldKeys[i];
      if (key !== undefined && this.indexByKey.has(key)) {
        return this.offsetOf(key) + this.heightOf(key);
      }
    }
    return null;
  }

  // The reserve rules, distilled from the tail-gap lessons:
  // - target: the pinned key's shortfall (0 when unpinned);
  // - floor: never let the total collapse out from under the viewport in
  //   one commit — existing reserve covering the viewport is kept until it
  //   is out of view, so transient growth cannot destroy it and shrinkage
  //   regrows it.
  private recomputeReserve(viewportHeight: number, scrollTop: number): void {
    const content = this.contentSize;
    let target = 0;
    if (this.pinnedKey !== null) {
      const pinnedTop = this.offsetOf(this.pinnedKey);
      if (pinnedTop <= EPSILON) {
        // Anchoring the very start needs no reserve; drop the stale pin.
        this.pinnedKey = null;
      } else {
        target = Math.max(0, pinnedTop + viewportHeight - content);
      }
    }
    const viewportNeeds = Math.max(
      0,
      Math.max(0, scrollTop) + viewportHeight - content,
    );
    const floor = Math.min(this.reservePx, viewportNeeds);
    this.reservePx = Math.max(target, floor);
  }
}
