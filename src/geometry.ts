import { FenwickTree } from "./fenwick";
import type { GeometryWindow, PositionedGeometry } from "./positioned-geometry";

// The keyed geometry kernel: items, measured or declared heights, offsets,
// anchoring, and the pin-to-top reserve — as pure math. No DOM, no
// scheduling, no side effects; the runtime feeds it heights
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
// Invariants owned here (see docs/core-contract.md):
//   I1  the resolved scroll target keeps the visible anchor's viewport
//       coordinate stationary;
//   I5  a pinned key can always be scrolled to the viewport top: the
//       reserve makes up the shortfall, is consumed by growth and regrown
//       by shrinkage, and never collapses out from under the viewport.

export type AnchorPolicy = "auto" | "viewport" | "end" | "none";
/**
 * A host-named anchor: after the commit, `key`'s top sits `offset` pixels
 * below the viewport top (negative: above it). A host that re-flows its
 * items — new keys for the same content — names where the old point went.
 * A key absent from the new items falls back to the captured anchor.
 */
export interface ExplicitAnchor {
  key: string;
  offset: number;
}
/**
 * The runtime's own resolution intents on top of the host policies: "pin"
 * puts the pinned key back at the viewport top (a viewport size change
 * under a pin the viewport stands on or glides onto, and the rows grown
 * under that pinned landing).
 */
export type CapturePolicy = AnchorPolicy | "pin";

export interface GeometryViewport {
  scrollTop: number;
  height: number;
}

export interface Commit {
  /** Absolute scroll target — the runtime performs exactly one write. */
  scrollTop: number;
  /** Content size plus reserve — the scroll surface height. */
  totalSize: number;
  /** Resolution intent, exposed so the DOM runtime can animate end-follow only. */
  mode: "end" | "anchor" | "none";
}

/** Opaque transaction token from `capture`; spend it once in `resolve`. */
interface Capture {
  readonly viewport: GeometryViewport;
  readonly policy: CapturePolicy;
  readonly target: ExplicitAnchor | null;
  readonly atEnd: boolean;
  readonly oldKeys: readonly string[];
  readonly anchor: {
    key: string;
    offset: number;
    oldIndex: number;
    /** The anchor's height at capture, for a shrink under the offset. */
    height: number;
  } | null;
}

const EPSILON = 0.5;
/** "At the end" tolerance; matches the runtime's AT_EDGE_EPSILON_PX. */
const AT_END_EPSILON = 1;

export class Geometry {
  private keys: readonly string[] = [];
  private indexByKey = new Map<string, number>();
  private tree = new FenwickTree(new Float64Array(0));
  private positioned: PositionedGeometry | null = null;
  /** Learned (measured) heights by identity; estimates fill the rest. */
  private readonly heightByKey = new Map<string, number>();
  private readonly estimateForKey: (key: string) => number;
  private pinnedKey: string | null = null;
  /** Space reserved above the pinned key for host chrome. */
  private pinnedInsetPx = 0;
  private reservePx = 0;
  /** Keys that never anchor (edge slots): the anchor falls to a neighbor. */
  private neverAnchor: (key: string) => boolean = () => false;
  private anchorExclusionIsPure = true;

  constructor(estimate: number | ((key: string) => number)) {
    this.estimateForKey =
      typeof estimate === "number" ? () => estimate : estimate;
  }

  get count(): number {
    return this.keys.length;
  }

  /**
   * Rows that must never be the anchor — a loader slot at an edge. When the
   * viewport top sits in one, the anchor is its content neighbor (the
   * successor for a leading slot, the predecessor for a trailing one) with
   * the offset that keeps the exact coordinate, so the slot's replacement by
   * content leaves the content the user was reading where it was.
   * Pure predicates allow positioned lookup to skip or reorder their calls.
   */
  setAnchorExclusion(
    predicate: (key: string) => boolean,
    isPure = false,
  ): void {
    this.neverAnchor = predicate;
    this.anchorExclusionIsPure = isPure;
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
    return this.heightByKey.has(key);
  }

  /** Content-space top of the item; `indexOf(key) === -1` yields -1. */
  offsetOf(key: string): number {
    const index = this.indexByKey.get(key);
    return index === undefined
      ? -1
      : (this.positioned?.top(index) ?? this.tree.prefix(index));
  }

  get contentSize(): number {
    return this.positioned?.totalSize ?? this.tree.total();
  }

  /** Swap a prevalidated positioned snapshot inside the normal geometry commit. */
  setPositioned(layout: PositionedGeometry | null): void {
    this.positioned = layout;
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

  /** The scroll position that puts the pinned key at the viewport top (below its inset); null when unpinned. */
  get pinTop(): number | null {
    if (this.pinnedKey === null) return null;
    return Math.max(0, this.offsetOf(this.pinnedKey) - this.pinnedInsetPx);
  }

  maxScrollTop(viewportHeight: number): number {
    return Math.max(0, this.totalSize - viewportHeight);
  }

  /** The item owning the viewport top, and how far into it the top sits. */
  anchorAt(viewport: GeometryViewport): { key: string; offset: number } | null {
    if (this.keys.length === 0) return null;
    const top = Math.max(0, Math.min(viewport.scrollTop, this.contentSize));
    if (this.positioned) {
      const index = this.positioned.anchorAt(
        top,
        (i) => this.neverAnchor(this.keys[i] as string),
        this.anchorExclusionIsPure,
      );
      const key = this.keys[index];
      return key === undefined
        ? null
        : { key, offset: top - this.positioned.top(index) };
    }
    let index = this.tree.indexAt(top); // Clamped to the last index.
    // A row with less than EPSILON left below the viewport top is not what
    // the user sees as the top row: anchoring it would let its own growth
    // push the visually top-aligned successor down by the full delta.
    // Anchor the successor instead, with a (slightly negative) offset that
    // keeps the exact coordinate.
    const remaining = this.tree.prefix(index + 1) - top;
    if (remaining <= EPSILON && index + 1 < this.keys.length) index += 1;
    if (this.neverAnchor(this.keys[index] as string)) {
      let next = index + 1;
      while (
        next < this.keys.length &&
        this.neverAnchor(this.keys[next] as string)
      ) {
        next += 1;
      }
      if (next < this.keys.length) {
        index = next;
      } else {
        let previous = index - 1;
        while (
          previous >= 0 &&
          this.neverAnchor(this.keys[previous] as string)
        ) {
          previous -= 1;
        }
        if (previous < 0) return null;
        index = previous;
      }
    }
    const key = this.keys[index] as string;
    return { key, offset: top - this.tree.prefix(index) };
  }

  /** Mounted index range covering the viewport plus overscan. */
  window(viewport: GeometryViewport, overscanPx: number): GeometryWindow {
    if (this.keys.length === 0) return { start: 0, end: 0 };
    const top = Math.max(0, viewport.scrollTop - overscanPx);
    const bottom = Math.min(
      this.contentSize,
      viewport.scrollTop + viewport.height + overscanPx,
    );
    if (this.positioned) {
      // Reuse an overscanned set across small scrolls. Whole cards still mount
      // once each; only the query bounds advance in batches, avoiding DOM
      // churn every time one of many staggered column edges crosses a pixel.
      const step = overscanPx;
      return this.positioned.window(
        step > 0 ? Math.floor(top / step) * step : top,
        step > 0 ? Math.ceil(bottom / step) * step : bottom,
      );
    }
    const start = this.tree.indexAt(top); // Clamped to the last index.
    const end = this.tree.lowerBound(bottom);
    return { start, end };
  }

  /** Open a transaction: resolve anchor intent on the current geometry. */
  capture(
    viewport: GeometryViewport,
    policy: CapturePolicy = "auto",
    target: ExplicitAnchor | null = null,
  ): Capture {
    // Elastic overscroll is browser presentation, not a reading position.
    // Capture the old legal range before measurements change it; otherwise
    // streaming growth can retain spare reserve under a bottom bounce and
    // permanently move the end farther down after each gesture.
    viewport = {
      ...viewport,
      scrollTop: Math.max(
        0,
        Math.min(viewport.scrollTop, this.maxScrollTop(viewport.height)),
      ),
    };
    const anchor = this.anchorAt(viewport);
    return {
      viewport: { ...viewport },
      policy,
      target,
      atEnd:
        this.maxScrollTop(viewport.height) - viewport.scrollTop <=
        AT_END_EPSILON,
      oldKeys: this.keys,
      anchor:
        anchor === null
          ? null
          : {
              ...anchor,
              oldIndex: this.indexByKey.get(anchor.key) as number,
              height: this.heightOf(anchor.key),
            },
    };
  }

  /**
   * Replace the item order. Keys are identity: duplicates are rejected.
   * Learned heights survive by key; heights of removed keys are dropped; a
   * removed pin transfers to a known replacement, otherwise it is cleared.
   */
  setKeys(
    nextKeys: readonly string[],
    replacementAnchor: ExplicitAnchor | null = null,
  ): void {
    // Build and validate the entire candidate state first — a throwing
    // estimator or a duplicate key must leave the previous geometry fully
    // intact, never a half-updated one.
    const keys = [...nextKeys];
    const indexByKey = new Map<string, number>();
    for (let index = 0; index < keys.length; index++) {
      indexByKey.set(keys[index] as string, index);
    }
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
    // A pinned row replaced in place (a version switch, an edit) passes
    // its pin to the row that took its place — a new key at its index,
    // everything before it unchanged — so the reserve keeps that position
    // at the top (I5). A removal (a surviving row shifted up into the
    // index) drops the pin.
    let pinned = this.pinnedKey;
    const pinnedInset = this.pinnedInsetPx;
    if (pinned !== null && !indexByKey.has(pinned)) {
      const index = this.indexByKey.get(pinned) ?? -1;
      const replacement = index >= 0 ? keys[index] : undefined;
      const inPlace =
        replacement !== undefined &&
        !this.indexByKey.has(replacement) &&
        this.keys.slice(0, index).every((key, i) => keys[i] === key);
      pinned = inPlace ? (replacement as string) : null;
      // A host-named replacement is authoritative even when separators or
      // other prefix rows changed. Preserve the pin, not just this commit's
      // scroll offset, so later shorter versions can regrow trailing space.
      if (replacementAnchor && indexByKey.has(replacementAnchor.key)) {
        // The reading offset can be lower than the pin's landing inset.
        // Preserve the latter so the replacement can still scroll to the
        // top even when the user switched it halfway down the viewport.
        pinned = replacementAnchor.key;
      }
    }

    this.keys = keys;
    this.indexByKey = indexByKey;
    this.tree = tree;
    for (const key of this.heightByKey.keys()) {
      if (!indexByKey.has(key)) this.heightByKey.delete(key);
    }
    this.pin(pinned, pinnedInset);
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
    if (delta !== 0) this.tree.add(index, delta);
  }

  /**
   * Pin a key: reserve enough trailing space that its top can sit at the
   * viewport top (the chat send flow). `null` releases the pin; remaining
   * reserve then drains only once the viewport no longer stands on it (I5).
   */
  pin(key: string | null, inset = 0): void {
    this.pinnedKey = key !== null && this.indexByKey.has(key) ? key : null;
    this.pinnedInsetPx =
      this.pinnedKey !== null && Number.isFinite(inset) ? inset : 0;
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
   * - pin: the pinned key's top (the captured scrollTop when unpinned); the
   *   reserve then equals the pin's shortfall exactly.
   */
  resolve(capture: Capture): Commit {
    const { viewport } = capture;
    const mode = this.resolveMode(capture);

    if (mode === "end") {
      this.recomputeReserve(viewport.height, viewport.scrollTop);
      return {
        scrollTop: this.maxScrollTop(viewport.height),
        totalSize: this.totalSize,
        mode,
      };
    }

    let target = viewport.scrollTop;
    if (mode === "anchor") {
      target = this.anchorTarget(capture) ?? viewport.scrollTop;
    } else if (capture.policy === "pin") {
      target = this.pinTop ?? viewport.scrollTop;
    }
    this.recomputeReserve(viewport.height, target);
    // An explicit replacement is a host-named reading position. A shorter
    // tail may need more reserve than the existing pin supplies (for example
    // an assistant at the top while its prompt remains pinned above it).
    // Keep the pin independent; this extra reserve drains once out of view.
    if (
      mode === "anchor" &&
      capture.target !== null &&
      this.indexByKey.has(capture.target.key)
    ) {
      this.reservePx = Math.max(
        this.reservePx,
        Math.max(0, target) + viewport.height - this.contentSize,
      );
    }
    return {
      scrollTop: Math.max(
        0,
        Math.min(target, this.maxScrollTop(viewport.height)),
      ),
      totalSize: this.totalSize,
      mode,
    };
  }

  private resolveMode(capture: Capture): "end" | "anchor" | "none" {
    if (capture.policy === "end") return "end";
    if (capture.policy === "none" || capture.policy === "pin") return "none";
    if (capture.policy === "viewport") return "anchor";
    // auto: follow the end only for end-compatible updates — the old keys
    // are an unchanged prefix of the new (pure appends, or the identical
    // list carrying streaming measurements). Prepends, reorders, and
    // replacements preserve the viewport even at the end.
    if (!capture.atEnd) return "anchor";
    const oldKeys = capture.oldKeys;
    if (oldKeys === this.keys) return "end";
    const endCompatible =
      this.keys.length >= oldKeys.length &&
      oldKeys.every((key, index) => this.keys[index] === key);
    return endCompatible ? "end" : "anchor";
  }

  private anchorTarget(capture: Capture): number | null {
    // A host-named anchor, when its key exists.
    const target = capture.target;
    if (target !== null && this.indexByKey.has(target.key)) {
      return this.offsetOf(target.key) - target.offset;
    }
    const anchor = capture.anchor;
    if (anchor === null) return null;

    if (this.indexByKey.has(anchor.key)) {
      // The in-row offset is kept while the row still reaches it. A row
      // that shrank under the viewport's offset into it keeps the slice the
      // user saw — its bottom — at the same distance from the viewport top,
      // so the rows below hold their place (the row's own top moves, as it
      // must: the content that was above the viewport is gone).
      const height = this.heightOf(anchor.key);
      const offset =
        anchor.offset <= height
          ? anchor.offset
          : Math.max(0, height - (anchor.height - anchor.offset));
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
      const targetTop = Math.max(0, pinnedTop - this.pinnedInsetPx);
      // Reaching the start needs no new reserve, but doesn't release the
      // pin: later prepends or height changes can move the same key again.
      if (targetTop > EPSILON) {
        target = Math.max(0, targetTop + viewportHeight - content);
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
