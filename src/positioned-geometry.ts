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
  bottoms: Float64Array;
  start: number;
  end: number;
}

/** Immutable positioned snapshot. Only the last visibility result is cached. */
export class PositionedGeometry {
  private readonly tops: Float64Array;
  private readonly bottoms: Float64Array;
  private readonly lanes: Lane[];
  readonly totalSize: number;
  private cached: GeometryWindow | null = null;
  private cachedTop = Number.NaN;
  private cachedBottom = Number.NaN;
  private orderedBottoms = true;

  constructor(items: readonly PositionedItem[]);
  constructor(items: {
    tops: Float64Array;
    heights: Float64Array;
    lanes: Float64Array;
  });
  constructor(
    items:
      | readonly PositionedItem[]
      | { tops: Float64Array; heights: Float64Array; lanes: Float64Array },
  ) {
    let tops: Float64Array;
    let heights: Float64Array;
    let lanes: Float64Array;
    if ("tops" in items) {
      ({ tops, heights, lanes } = items);
    } else {
      const length = items.length;
      tops = new Float64Array(length);
      heights = new Float64Array(length);
      lanes = new Float64Array(length);
      for (let index = 0; index < length; index++) {
        const item = items[index] as PositionedItem;
        tops[index] = typeof item.top === "number" ? item.top : Number.NaN;
        heights[index] =
          typeof item.height === "number" ? item.height : Number.NaN;
        lanes[index] = typeof item.lane === "number" ? item.lane : Number.NaN;
      }
    }
    const built = PositionedGeometry.build(tops, heights, lanes);
    this.tops = tops;
    this.bottoms = heights;
    this.lanes = built.lanes;
    this.totalSize = built.totalSize;
    this.orderedBottoms = built.orderedBottoms;
  }

  /** Build directly from owned columnar buffers (`heights` is overwritten with bottoms). */
  static fromColumns(
    tops: Float64Array,
    heights: Float64Array,
    lanes: Float64Array,
  ): PositionedGeometry {
    return new PositionedGeometry({ tops, heights, lanes });
  }

  private static build(
    tops: Float64Array,
    heightsOrBottoms: Float64Array,
    laneNumbers: Float64Array,
  ): { lanes: Lane[]; totalSize: number; orderedBottoms: boolean } {
    const dense: (number[] | undefined)[] = [];
    let sparse: Map<number, number[]> | null = null;
    const groups: number[][] = [];
    let total = 0;
    const length = tops.length;
    for (let index = 0; index < length; index++) {
      const top = tops[index] as number;
      const height = heightsOrBottoms[index] as number;
      const lane = laneNumbers[index] as number;
      const itemBottom = top + height;
      if (
        !Number.isFinite(top) ||
        top < 0 ||
        !Number.isFinite(height) ||
        height <= 0 ||
        !Number.isFinite(itemBottom) ||
        !Number.isSafeInteger(lane) ||
        lane < 0
      )
        throw new RangeError(
          "positioned items need finite non-negative tops, positive heights and non-negative integer lanes",
        );
      let indices: number[] | undefined;
      if (lane < 64) {
        indices = dense[lane];
        if (indices === undefined) {
          indices = [];
          dense[lane] = indices;
          groups.push(indices);
        }
      } else {
        sparse ??= new Map<number, number[]>();
        indices = sparse.get(lane);
        if (indices === undefined) {
          indices = [];
          sparse.set(lane, indices);
          groups.push(indices);
        }
      }
      indices.push(index);
      if (itemBottom > total) total = itemBottom;
      heightsOrBottoms[index] = itemBottom;
    }
    const lanes: Lane[] = [];
    let orderedBottoms = true;
    for (let g = 0; g < groups.length; g++) {
      const indices = groups[g] as number[];
      let sorted = true;
      for (let i = 1; i < indices.length; i++) {
        if (
          (tops[indices[i] as number] as number) <
          (tops[indices[i - 1] as number] as number)
        ) {
          sorted = false;
          break;
        }
      }
      if (!sorted) {
        indices.sort(
          (a, b) => (tops[a] as number) - (tops[b] as number) || a - b,
        );
      }
      const laneBottoms = new Float64Array(indices.length);
      let bottom = 0;
      for (let i = 0; i < indices.length; i++) {
        const b = heightsOrBottoms[indices[i] as number] as number;
        if (b < bottom) orderedBottoms = false;
        if (b > bottom) bottom = b;
        laneBottoms[i] = bottom;
      }
      lanes.push({
        indices,
        start: 0,
        end: 0,
        bottoms: laneBottoms,
      });
    }
    return { lanes, totalSize: total, orderedBottoms };
  }

  top(index: number): number {
    return this.tops[index] ?? -1;
  }

  private bottom(index: number): number {
    return this.bottoms[index] ?? -1;
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
    const prevIndices = this.cached?.indices;
    if (prevIndices && prevIndices.length === indices.length) {
      let same = true;
      for (let i = 0; i < indices.length; i++) {
        if (prevIndices[i] !== indices[i]) {
          same = false;
          break;
        }
      }
      if (same && this.cached) return this.cached;
    }
    this.cached = {
      start: indices[0] ?? this.tops.length,
      end: indices.length ? (indices.at(-1) as number) + 1 : this.tops.length,
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
      start: indices[0] ?? this.tops.length,
      end: indices.length ? (indices.at(-1) as number) + 1 : this.tops.length,
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
    // Prefix maxima skip intervals that end above the reading point, even
    // when later intervals nest inside an earlier one. Preserve source-order
    // ties while using each lane's vertical order to stop searching in gaps.
    if (isPure && Number.isFinite(top)) {
      let containing = -1;
      let following = -1;
      for (const lane of this.lanes) {
        let i = this.firstAfter(lane, top);
        for (; i < lane.indices.length; i++) {
          const index = lane.indices[i] as number;
          if (this.top(index) > top) break;
          if (
            this.bottom(index) > top &&
            (containing < 0 || index < containing) &&
            !excluded(index)
          ) {
            if (index === 0) return index;
            containing = index;
          }
        }
        if (containing >= 0) continue;
        for (; i < lane.indices.length; i++) {
          const index = lane.indices[i] as number;
          if (excluded(index)) continue;
          if (
            following < 0 ||
            this.top(index) < this.top(following) ||
            (this.top(index) === this.top(following) && index < following)
          )
            following = index;
          break;
        }
      }
      if (containing >= 0) return containing;
      if (following >= 0) return following;

      let previous = -1;
      for (const lane of this.lanes) {
        for (let i = lane.indices.length - 1; i >= 0; i--) {
          if (
            previous >= 0 &&
            (lane.bottoms[i] as number) < this.bottom(previous)
          )
            break;
          const index = lane.indices[i] as number;
          if (
            this.top(index) <= top &&
            (previous < 0 ||
              this.bottom(index) > this.bottom(previous) ||
              (this.bottom(index) === this.bottom(previous) &&
                index < previous)) &&
            !excluded(index)
          )
            previous = index;
        }
      }
      return previous;
    }

    // Arbitrary predicates keep their observable source-order effects.
    // Nonfinite coordinates retain the original comparison semantics.
    let containing = -1;
    let following = -1;
    let previous = -1;
    for (let index = 0; index < this.tops.length; index++) {
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
