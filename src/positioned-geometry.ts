/** Declared vertical placement in a shared coordinate system. */
export interface ItemPosition {
  top: number;
  /** A column of vertically ordered items; different columns may overlap. */
  lane: number;
}

export interface PositionedItem extends ItemPosition {
  height: number;
}

export interface GeometryWindow {
  start: number;
  end: number;
  /** Positioned layouts can contain holes inside the index bounds. */
  indices?: readonly number[];
  /** Valid only when the consumer's last complete indices are exactly `from`. */
  delta?: {
    from: readonly number[];
    entering: readonly number[];
    leaving: readonly number[];
  };
}

interface Lane {
  indices: number[];
  /** Prefix maxima also cover overlapping intervals within a lane. */
  bottoms: number[];
  start: number;
  end: number;
}

/** Immutable positioned snapshot. Only the last visibility result is cached. */
export class PositionedGeometry {
  private readonly items: readonly PositionedItem[];
  private readonly lanes: Lane[];
  readonly totalSize: number;
  private cached: GeometryWindow | null = null;
  private cachedTop = Number.NaN;
  private cachedBottom = Number.NaN;
  private orderedBottoms = true;

  constructor(items: readonly PositionedItem[]) {
    const lanes = new Map<number, number[]>();
    let total = 0;
    this.items = items.map(({ top, height, lane }, index) => {
      if (
        !Number.isFinite(top) ||
        top < 0 ||
        !Number.isFinite(height) ||
        height <= 0 ||
        !Number.isFinite(top + height) ||
        !Number.isSafeInteger(lane) ||
        lane < 0
      )
        throw new RangeError(
          "positioned items need finite non-negative tops, positive heights and non-negative integer lanes",
        );
      const indices = lanes.get(lane) ?? [];
      if (!lanes.has(lane)) lanes.set(lane, indices);
      indices.push(index);
      total = Math.max(total, top + height);
      return { top, height, lane };
    });
    this.totalSize = total;
    this.lanes = [...lanes.values()].map((indices) => {
      indices.sort((a, b) => this.top(a) - this.top(b) || a - b);
      let bottom = 0;
      return {
        indices,
        start: 0,
        end: 0,
        bottoms: indices.map((index) => {
          if (this.bottom(index) < bottom) this.orderedBottoms = false;
          bottom = Math.max(bottom, this.bottom(index));
          return bottom;
        }),
      };
    });
  }

  top(index: number): number {
    return this.items[index]?.top ?? -1;
  }

  private bottom(index: number): number {
    const item = this.items[index];
    return item ? item.top + item.height : -1;
  }

  private firstAfter(lane: Lane, top: number): number {
    let low = 0;
    let high = lane.indices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((lane.bottoms[mid] as number) <= top) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  window(top: number, bottom: number): GeometryWindow {
    if (this.cached && top === this.cachedTop && bottom === this.cachedBottom)
      return this.cached;
    const incremental =
      this.cached?.indices &&
      this.orderedBottoms &&
      top <= bottom &&
      this.cachedTop <= this.cachedBottom &&
      top < this.cachedBottom &&
      bottom > this.cachedTop;
    this.cachedTop = top;
    this.cachedBottom = bottom;
    if (incremental && this.cached?.indices)
      return this.advanceWindow(top, bottom, this.cached.indices);
    const indices: number[] = [];
    for (const lane of this.lanes) {
      lane.start = this.firstAfter(lane, top);
      let i = lane.start;
      for (; i < lane.indices.length; i++) {
        const index = lane.indices[i] as number;
        if (this.top(index) >= bottom) break;
        if (this.bottom(index) > top) indices.push(index);
      }
      lane.end = i;
    }
    indices.sort((a, b) => a - b);
    if (
      this.cached?.indices?.length === indices.length &&
      indices.every((index, i) => this.cached?.indices?.[i] === index)
    )
      return this.cached;
    this.cached = {
      start: indices[0] ?? this.items.length,
      end: indices.length ? (indices.at(-1) as number) + 1 : this.items.length,
      indices,
    };
    return this.cached;
  }

  private advanceWindow(
    top: number,
    bottom: number,
    from: readonly number[],
  ): GeometryWindow {
    const entering: number[] = [];
    const leaving: number[] = [];
    for (const lane of this.lanes) {
      const oldStart = lane.start;
      const oldEnd = lane.end;
      let start = oldStart;
      let end = oldEnd;
      while (start > 0 && (lane.bottoms[start - 1] as number) > top) start--;
      while (
        start < lane.indices.length &&
        (lane.bottoms[start] as number) <= top
      )
        start++;
      while (end > 0 && this.top(lane.indices[end - 1] as number) >= bottom)
        end--;
      while (
        end < lane.indices.length &&
        this.top(lane.indices[end] as number) < bottom
      )
        end++;
      // Empty windows in gaps have coincident cursors.
      end = Math.max(start, end);
      for (let i = oldStart; i < Math.min(start, oldEnd); i++)
        leaving.push(lane.indices[i] as number);
      for (let i = Math.max(end, oldStart); i < oldEnd; i++)
        leaving.push(lane.indices[i] as number);
      for (let i = start; i < Math.min(oldStart, end); i++)
        entering.push(lane.indices[i] as number);
      for (let i = Math.max(oldEnd, start); i < end; i++)
        entering.push(lane.indices[i] as number);
      lane.start = start;
      lane.end = end;
    }
    if (entering.length === 0 && leaving.length === 0 && this.cached)
      return this.cached;
    entering.sort((a, b) => a - b);
    leaving.sort((a, b) => a - b);
    // Merge only the boundary changes into the source-ordered snapshot. Retain
    // one prior array, not a chain of previous GeometryWindow objects.
    const indices: number[] = [];
    let added = 0;
    let removed = 0;
    for (const index of from) {
      while (added < entering.length && (entering[added] as number) < index)
        indices.push(entering[added++] as number);
      if (leaving[removed] === index) removed++;
      else indices.push(index);
    }
    while (added < entering.length) indices.push(entering[added++] as number);
    this.cached = {
      start: indices[0] ?? this.items.length,
      end: indices.length ? (indices.at(-1) as number) + 1 : this.items.length,
      indices,
      delta: { from, entering, leaving },
    };
    return this.cached;
  }

  /**
   * Prefer a containing item in source order, then the nearest following item.
   * Pure exclusion predicates allow indexed lookup to skip or reorder calls.
   */
  anchorAt(
    top: number,
    excluded: (index: number) => boolean,
    isPure = false,
  ): number {
    // Ordered lane bottoms let us skip everything above the reading point.
    // Source order can differ from both lane order and vertical order, so
    // compare every containing candidate before choosing the anchor.
    if (isPure && this.orderedBottoms && Number.isFinite(top)) {
      let containing = -1;
      for (const lane of this.lanes) {
        for (let i = this.firstAfter(lane, top); i < lane.indices.length; i++) {
          const index = lane.indices[i] as number;
          if (this.top(index) > top) break;
          if ((containing < 0 || index < containing) && !excluded(index)) {
            if (index === 0) return index;
            containing = index;
          }
        }
      }
      if (containing >= 0) return containing;
    }

    // Keep the source-order fallback for gaps, excluded content, and nested
    // intervals whose bottoms are unordered. It also preserves boundary ties.
    let containing = -1;
    let following = -1;
    let previous = -1;
    for (let index = 0; index < this.items.length; index++) {
      if (excluded(index)) continue;
      if (this.top(index) <= top && this.bottom(index) > top) {
        containing = index;
        break;
      }
      if (this.top(index) > top) {
        if (following < 0 || this.top(index) < this.top(following))
          following = index;
      } else if (previous < 0 || this.bottom(index) > this.bottom(previous))
        previous = index;
    }
    return containing >= 0 ? containing : following >= 0 ? following : previous;
  }
}
