import { FenwickTree } from "../fenwick";

// The lean core's geometry kernel: keyed items, learned heights, offsets,
// anchoring, and the pin-to-top reserve — as pure math. No DOM, no
// scheduling, no side effects; the runtime (step 2) feeds it measurements
// and applies the scroll deltas it returns. Identity is the key; indexes are
// derived positions and never survive an update.
//
// Invariants owned here (see docs/lean-core.md):
//   I1  the visible anchor's viewport coordinate is preserved across
//       setKeys/measure (the returned scrollDelta makes it so);
//   I5  a pinned key can always be scrolled to the viewport top: the
//       reserve makes up the shortfall, is consumed by growth and regrown
//       by shrinkage, and never collapses out from under the viewport.

export type AnchorPolicy = "auto" | "viewport" | "end" | "none";

export interface GeometryViewport {
  scrollTop: number;
  height: number;
}

export interface Commit {
  /** Add to scrollTop so the resolved anchor stays stationary. */
  scrollDelta: number;
  /** Content size plus reserve — the scroll surface height. */
  totalSize: number;
}

const EPSILON = 0.5;

export class Geometry {
  private keys: string[] = [];
  private indexByKey = new Map<string, number>();
  private tree = new FenwickTree(new Float64Array(0));
  /** Learned (measured) heights by identity; estimates fill the rest. */
  private readonly heightByKey = new Map<string, number>();
  private readonly measuredKeys = new Set<string>();
  private readonly estimate: (key: string) => number;
  private pinnedKey: string | null = null;
  private reservePx = 0;

  constructor(estimate: number | ((key: string) => number)) {
    this.estimate = typeof estimate === "number" ? () => estimate : estimate;
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

  heightOf(key: string): number {
    return this.heightByKey.get(key) ?? this.estimate(key);
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

  maxScrollTop(viewport: GeometryViewport): number {
    return Math.max(0, this.totalSize - viewport.height);
  }

  /** The item owning the viewport top, and how far into it the top sits. */
  anchorAt(viewport: GeometryViewport): { key: string; offset: number } | null {
    if (this.keys.length === 0) return null;
    const top = Math.max(0, Math.min(viewport.scrollTop, this.contentSize));
    const index = Math.min(this.tree.indexAt(top), this.keys.length - 1);
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

  /**
   * Replace the item order. The anchor is resolved on the OLD geometry per
   * `policy`, the tree is rebuilt from learned heights (estimates for unseen
   * keys), and the returned delta repositions the viewport so that anchor is
   * stationary — or at the end, for the end policy. A removed anchor falls
   * back to its nearest surviving neighbor in the old order.
   */
  setKeys(
    nextKeys: readonly string[],
    viewport: GeometryViewport,
    policy: AnchorPolicy = "auto",
  ): Commit {
    const resolved = this.resolvePolicy(nextKeys, viewport, policy);
    const anchor =
      resolved === "viewport" ? this.survivingAnchor(nextKeys, viewport) : null;

    this.keys = [...nextKeys];
    this.indexByKey = new Map(this.keys.map((key, index) => [key, index]));
    const sizes = new Float64Array(this.keys.length);
    for (let index = 0; index < this.keys.length; index++) {
      sizes[index] = this.heightOf(this.keys[index] as string);
    }
    this.tree = new FenwickTree(sizes);
    for (const key of this.measuredKeys) {
      if (!this.indexByKey.has(key)) {
        this.measuredKeys.delete(key);
        this.heightByKey.delete(key);
      }
    }
    if (this.pinnedKey !== null && !this.indexByKey.has(this.pinnedKey)) {
      this.pinnedKey = null;
    }

    let scrollDelta = 0;
    if (resolved === "end") {
      this.recomputeReserve(viewport, viewport.scrollTop);
      scrollDelta = this.maxScrollTop(viewport) - viewport.scrollTop;
    } else if (anchor !== null) {
      // The anchor's viewport coordinate is preserved by definition:
      // scrollTop' = anchorTop' + offset (for a fallback neighbor, offset 0
      // places it exactly at the viewport top).
      const nextScrollTop = this.offsetOf(anchor.key) + anchor.offset;
      scrollDelta = nextScrollTop - viewport.scrollTop;
      this.recomputeReserve(viewport, viewport.scrollTop + scrollDelta);
    } else {
      this.recomputeReserve(viewport, viewport.scrollTop);
    }
    return { scrollDelta, totalSize: this.totalSize };
  }

  /**
   * Commit a learned height. The delta keeps the current anchor stationary:
   * changes above the viewport top shift the content the viewport rides on;
   * changes at or below it do not move the anchor.
   */
  measure(key: string, height: number, viewport: GeometryViewport): Commit {
    const index = this.indexByKey.get(key);
    if (
      index === undefined ||
      !Number.isFinite(height) ||
      height <= 0 ||
      Math.abs(height - this.heightOf(key)) <= EPSILON
    ) {
      return { scrollDelta: 0, totalSize: this.totalSize };
    }
    const oldHeight = this.heightOf(key);
    const delta = height - oldHeight;
    this.heightByKey.set(key, height);
    this.measuredKeys.add(key);
    this.tree.add(index, delta);

    // prefix(index) excludes the item's own height, so the top is stable.
    const itemTop = this.tree.prefix(index);
    const offsetIntoItem = viewport.scrollTop - itemTop;
    let scrollDelta = 0;
    if (offsetIntoItem >= oldHeight) {
      // Fully above the viewport top: the whole change shifts the anchor.
      scrollDelta = delta;
    } else if (offsetIntoItem > 0) {
      // The viewport top sits inside the item: it stays at the same offset
      // into it, clamped to the new extent (a shrink cannot push the
      // viewport above the item's own bounds).
      scrollDelta = Math.min(0, height - offsetIntoItem);
    }
    this.recomputeReserve(viewport, viewport.scrollTop + scrollDelta);
    return { scrollDelta, totalSize: this.totalSize };
  }

  /**
   * Pin a key: reserve enough trailing space that the key's top can sit at
   * the viewport top (the chat send flow). `null` releases the pin; the
   * remaining reserve then drains only when it is out of view (I5).
   */
  pin(key: string | null, viewport: GeometryViewport): Commit {
    this.pinnedKey = key !== null && this.indexByKey.has(key) ? key : null;
    this.recomputeReserve(viewport, viewport.scrollTop);
    return { scrollDelta: 0, totalSize: this.totalSize };
  }

  get pinned(): string | null {
    return this.pinnedKey;
  }

  /** Re-evaluate the reserve after a viewport resize. */
  refresh(viewport: GeometryViewport): Commit {
    this.recomputeReserve(viewport, viewport.scrollTop);
    return { scrollDelta: 0, totalSize: this.totalSize };
  }

  // The reserve rules, distilled from the tail-gap lessons:
  // - target: the pinned key's shortfall (0 when unpinned);
  // - floor: never let the total collapse out from under the viewport in
  //   one commit — existing reserve covering the viewport is kept until it
  //   is out of view (drains via target once the viewport no longer needs
  //   it), so transient growth cannot destroy it and shrinkage regrows it.
  private recomputeReserve(
    viewport: GeometryViewport,
    nextScrollTop: number,
  ): void {
    const content = this.contentSize;
    let target = 0;
    if (this.pinnedKey !== null) {
      const pinnedTop = this.offsetOf(this.pinnedKey);
      if (pinnedTop <= EPSILON) {
        // Anchoring the very start needs no reserve; drop the stale pin.
        this.pinnedKey = null;
      } else {
        target = Math.max(0, pinnedTop + viewport.height - content);
      }
    }
    const viewportNeeds = Math.max(
      0,
      Math.max(0, nextScrollTop) + viewport.height - content,
    );
    const floor = Math.min(this.reservePx, viewportNeeds);
    this.reservePx = Math.max(target, floor);
  }

  private resolvePolicy(
    nextKeys: readonly string[],
    viewport: GeometryViewport,
    policy: AnchorPolicy,
  ): "viewport" | "end" | "none" {
    if (policy !== "auto") return policy;
    if (this.keys.length === 0) return "end";
    const atEnd =
      this.maxScrollTop(viewport) - viewport.scrollTop <= 2 * EPSILON;
    if (!atEnd) return "viewport";
    // At the end, appends follow; anything else preserves the viewport.
    const lastKey = this.keys[this.keys.length - 1] as string;
    const lastNext = nextKeys.length === 0 ? undefined : nextKeys[0];
    const appended =
      nextKeys.length >= this.keys.length &&
      nextKeys.length > 0 &&
      lastNext !== undefined &&
      nextKeys.includes(lastKey);
    return appended ? "end" : "viewport";
  }

  private survivingAnchor(
    nextKeys: readonly string[],
    viewport: GeometryViewport,
  ): { key: string; offset: number } | null {
    const anchor = this.anchorAt(viewport);
    if (anchor === null) return null;
    const next = new Set(nextKeys);
    if (next.has(anchor.key)) return anchor;
    // Nearest surviving neighbor in the old order, preferring earlier items
    // (they keep the reading position above the removal).
    const from = this.indexByKey.get(anchor.key) ?? 0;
    for (let distance = 1; distance < this.keys.length; distance++) {
      const before = this.keys[from - distance];
      if (before !== undefined && next.has(before)) {
        return { key: before, offset: 0 };
      }
      const after = this.keys[from + distance];
      if (after !== undefined && next.has(after)) {
        return { key: after, offset: 0 };
      }
    }
    return null;
  }
}
