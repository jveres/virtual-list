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
  laneNumber: number;
  indices: Int32Array;
  /**
   * Non-null only when intervals within this lane have non-monotone bottoms
   * (nested/overlapping cards); null when `this.bottoms[indices[i]]` is
   * already non-decreasing.
   */
  bottoms: Float64Array | null;
  /** Flat max-bottom segment tree for non-monotone lanes (`bottoms !== null`). */
  segTree: Float64Array | null;
  segSize: number;
  start: number;
  end: number;
}

const SEG_STACK = new Int32Array(192);

function buildSegTree(
  indices: Int32Array,
  allBottoms: Float64Array,
): { segTree: Float64Array; segSize: number } {
  const len = indices.length;
  let size = 1;
  while (size < len) size <<= 1;
  const seg = new Float64Array(size << 1);
  seg.fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < len; i++) {
    seg[size + i] = allBottoms[indices[i] as number] as number;
  }
  for (let k = size - 1; k >= 1; k--) {
    const left = seg[k << 1] as number;
    const right = seg[(k << 1) | 1] as number;
    seg[k] = left >= right ? left : right;
  }
  return { segTree: seg, segSize: size };
}

function scanSegTreeAbove(
  lane: Lane,
  start: number,
  end: number,
  top: number,
  out: number[] | null,
  containing: number,
  excluded?: (index: number) => boolean,
): number {
  const seg = lane.segTree;
  if (seg === null || start >= end) return containing;
  const laneIndices = lane.indices;
  const size = lane.segSize;
  const len = laneIndices.length;
  let sp = 0;
  SEG_STACK[sp++] = 1;
  SEG_STACK[sp++] = 0;
  SEG_STACK[sp++] = size;
  while (sp > 0) {
    const nodeR = SEG_STACK[--sp] as number;
    const nodeL = SEG_STACK[--sp] as number;
    const node = SEG_STACK[--sp] as number;
    if (nodeR <= start || nodeL >= end || !((seg[node] as number) > top))
      continue;
    if (node >= size) {
      const pos = node - size;
      if (pos < len) {
        const index = laneIndices[pos] as number;
        if (out !== null) out.push(index);
        else if (
          (containing < 0 || index < containing) &&
          !(excluded as (i: number) => boolean)(index)
        ) {
          if (index === 0) return 0;
          containing = index;
        }
      }
      continue;
    }
    const mid = (nodeL + nodeR) >>> 1;
    if (end > mid && (seg[(node << 1) | 1] as number) > top) {
      SEG_STACK[sp++] = (node << 1) | 1;
      SEG_STACK[sp++] = mid;
      SEG_STACK[sp++] = nodeR;
    }
    if (start < mid && (seg[node << 1] as number) > top) {
      SEG_STACK[sp++] = node << 1;
      SEG_STACK[sp++] = nodeL;
      SEG_STACK[sp++] = mid;
    }
  }
  return containing;
}

/** Positioned layout snapshot with cached windowing and in-place monotone item updates. */
export class PositionedGeometry {
  private readonly tops: Float64Array;
  private readonly bottoms: Float64Array;
  private readonly lanes: Lane[];
  private currentTotalSize: number;
  private cached: GeometryWindow | null = null;
  private cachedTop = Number.NaN;
  private cachedBottom = Number.NaN;
  private orderedBottoms = true;

  get totalSize(): number {
    return this.currentTotalSize;
  }

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
    this.currentTotalSize = built.totalSize;
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
    const denseIds = new Int32Array(64);
    denseIds.fill(-1);
    let sparseIds: Map<number, number> | null = null;
    const laneNums: number[] = [];
    const counts: number[] = [];
    let total = 0;
    const length = tops.length;

    // Pass 1: validate, convert heights -> bottoms, and count per-lane sizes.
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
      ) {
        throw new RangeError(
          "positioned items need finite non-negative tops, positive heights and non-negative integer lanes",
        );
      }
      let id: number;
      if (lane < 64) {
        id = denseIds[lane] as number;
        if (id < 0) {
          id = counts.length;
          denseIds[lane] = id;
          laneNums.push(lane);
          counts.push(0);
        }
      } else {
        sparseIds ??= new Map<number, number>();
        const found = sparseIds.get(lane);
        if (found === undefined) {
          id = counts.length;
          sparseIds.set(lane, id);
          laneNums.push(lane);
          counts.push(0);
        } else {
          id = found;
        }
      }
      counts[id] = (counts[id] as number) + 1;
      if (itemBottom > total) total = itemBottom;
      heightsOrBottoms[index] = itemBottom;
    }

    // Pass 2: pack indices into exact-sized Int32Arrays per lane.
    const groupCount = counts.length;
    const groups = new Array<Int32Array>(groupCount);
    const cursors = new Int32Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
      groups[g] = new Int32Array(counts[g] as number);
    }
    for (let index = 0; index < length; index++) {
      const lane = laneNumbers[index] as number;
      const id =
        lane < 64
          ? (denseIds[lane] as number)
          : (sparseIds!.get(lane) as number);
      const pos = cursors[id] as number;
      (groups[id] as Int32Array)[pos] = index;
      cursors[id] = pos + 1;
    }

    const lanes: Lane[] = new Array<Lane>(groupCount);
    let orderedBottoms = true;
    for (let g = 0; g < groupCount; g++) {
      const indices = groups[g] as Int32Array;
      const len = indices.length;
      let sorted = true;
      for (let i = 1; i < len; i++) {
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
      let laneMonotone = true;
      let prevBottom = 0;
      for (let i = 0; i < len; i++) {
        const b = heightsOrBottoms[indices[i] as number] as number;
        if (b < prevBottom) {
          laneMonotone = false;
          break;
        }
        prevBottom = b;
      }
      let laneBottoms: Float64Array | null = null;
      let segTree: Float64Array | null = null;
      let segSize = 0;
      if (!laneMonotone) {
        orderedBottoms = false;
        laneBottoms = new Float64Array(len);
        let maxB = 0;
        for (let i = 0; i < len; i++) {
          const b = heightsOrBottoms[indices[i] as number] as number;
          if (b > maxB) maxB = b;
          laneBottoms[i] = maxB;
        }
        const builtSeg = buildSegTree(indices, heightsOrBottoms);
        segTree = builtSeg.segTree;
        segSize = builtSeg.segSize;
      }
      lanes[g] = {
        laneNumber: laneNums[g] as number,
        indices,
        bottoms: laneBottoms,
        segTree,
        segSize,
        start: 0,
        end: 0,
      };
    }
    return { lanes, totalSize: total, orderedBottoms };
  }

  top(index: number): number {
    return this.tops[index] ?? -1;
  }

  private bottom(index: number): number {
    return this.bottoms[index] ?? -1;
  }

  private findLanePosition(lane: Lane, index: number): number {
    const indices = lane.indices;
    const tops = this.tops;
    const targetTop = tops[index] as number;
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const midIndex = indices[mid] as number;
      const midTop = tops[midIndex] as number;
      if (midTop < targetTop || (midTop === targetTop && midIndex < index)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low < indices.length && indices[low] === index ? low : -1;
  }

  /**
   * Whether `index` can be updated in place without changing its lane, lane
   * sort order, or monotone-bottom invariant.
   */
  canUpdateInPlace(
    index: number,
    nextTop: number,
    nextHeight: number,
    laneNumber: number,
  ): boolean {
    if (
      !this.orderedBottoms ||
      index < 0 ||
      index >= this.tops.length ||
      !Number.isFinite(nextTop) ||
      nextTop < 0 ||
      !Number.isFinite(nextHeight) ||
      nextHeight <= 0
    ) {
      return false;
    }
    const nextBottom = nextTop + nextHeight;
    if (!Number.isFinite(nextBottom)) return false;
    let lane: Lane | undefined;
    for (let g = 0; g < this.lanes.length; g++) {
      const candidate = this.lanes[g] as Lane;
      if (candidate.laneNumber === laneNumber) {
        lane = candidate;
        break;
      }
    }
    if (!lane || lane.bottoms !== null) return false;
    const pos = this.findLanePosition(lane, index);
    if (pos < 0) return false;
    const indices = lane.indices;
    if (pos > 0) {
      const prevIdx = indices[pos - 1] as number;
      const prevTop = this.tops[prevIdx] as number;
      if (nextTop < prevTop || (nextTop === prevTop && prevIdx > index)) {
        return false;
      }
      if (nextBottom < (this.bottoms[prevIdx] as number)) return false;
    }
    if (pos + 1 < indices.length) {
      const nextIdx = indices[pos + 1] as number;
      const afterTop = this.tops[nextIdx] as number;
      if (nextTop > afterTop || (nextTop === afterTop && index > nextIdx)) {
        return false;
      }
      if (nextBottom > (this.bottoms[nextIdx] as number)) return false;
    }
    return true;
  }

  /** Whether every item except `modifiedAt` keeps its committed lane and shifted top. */
  matchesExcept(
    modifiedAt: number,
    rawTops: Float64Array,
    shift: number,
    laneNums: Float64Array,
  ): boolean {
    const tops = this.tops;
    for (let g = 0; g < this.lanes.length; g++) {
      const lane = this.lanes[g] as Lane;
      const expectedLane = lane.laneNumber;
      const indices = lane.indices;
      for (let k = 0; k < indices.length; k++) {
        const idx = indices[k] as number;
        if (idx === modifiedAt) continue;
        if (
          laneNums[idx] !== expectedLane ||
          (rawTops[idx] as number) + shift !== tops[idx]
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /** Apply a pre-validated single-item update in O(lanes) time and 0 allocations. */
  applyUpdateInPlace(index: number, nextTop: number, nextHeight: number): void {
    const oldTop = this.tops[index] as number;
    const oldBottom = this.bottoms[index] as number;
    const nextBottom = nextTop + nextHeight;
    if (oldTop === nextTop && oldBottom === nextBottom) return;
    this.tops[index] = nextTop;
    this.bottoms[index] = nextBottom;
    let total = 0;
    for (let g = 0; g < this.lanes.length; g++) {
      const indices = (this.lanes[g] as Lane).indices;
      if (indices.length > 0) {
        const b = this.bottoms[indices[indices.length - 1] as number] as number;
        if (b > total) total = b;
      }
    }
    this.currentTotalSize = total;
    this.cached = null;
    this.cachedTop = Number.NaN;
    this.cachedBottom = Number.NaN;
  }

  private firstAfter(lane: Lane, top: number): number {
    const indices = lane.indices;
    const laneBottoms = lane.bottoms;
    const allBottoms = this.bottoms;
    let low = 0;
    let high = indices.length;
    if (laneBottoms !== null) {
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((laneBottoms[mid] as number) <= top) low = mid + 1;
        else high = mid;
      }
    } else {
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((allBottoms[indices[mid] as number] as number) <= top)
          low = mid + 1;
        else high = mid;
      }
    }
    return low;
  }

  private firstTopAtOrAfter(lane: Lane, limit: number): number {
    const indices = lane.indices;
    const tops = this.tops;
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((tops[indices[mid] as number] as number) < limit) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private firstTopAfter(lane: Lane, limit: number): number {
    const indices = lane.indices;
    const tops = this.tops;
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((tops[indices[mid] as number] as number) <= limit) low = mid + 1;
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
    for (let g = 0; g < this.lanes.length; g++) {
      const lane = this.lanes[g] as Lane;
      const laneIndices = lane.indices;
      const start = this.firstAfter(lane, top);
      lane.start = start;
      if (
        lane.segTree !== null &&
        Number.isFinite(top) &&
        Number.isFinite(bottom)
      ) {
        const end = this.firstTopAtOrAfter(lane, bottom);
        lane.end = Math.max(start, end);
        scanSegTreeAbove(lane, start, end, top, indices, -1);
      } else {
        let i = start;
        for (; i < laneIndices.length; i++) {
          const index = laneIndices[i] as number;
          if ((this.tops[index] as number) >= bottom) break;
          if ((this.bottoms[index] as number) > top) indices.push(index);
        }
        lane.end = i;
      }
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
      end: indices.length
        ? (indices[indices.length - 1] as number) + 1
        : this.tops.length,
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
    const tops = this.tops;
    const allBottoms = this.bottoms;
    for (let g = 0; g < this.lanes.length; g++) {
      const lane = this.lanes[g] as Lane;
      const laneIndices = lane.indices;
      const len = laneIndices.length;
      const oldStart = lane.start;
      const oldEnd = lane.end;
      let start = oldStart;
      let end = oldEnd;
      while (
        start > 0 &&
        (allBottoms[laneIndices[start - 1] as number] as number) > top
      )
        start--;
      while (
        start < len &&
        (allBottoms[laneIndices[start] as number] as number) <= top
      )
        start++;
      while (
        end > 0 &&
        (tops[laneIndices[end - 1] as number] as number) >= bottom
      )
        end--;
      while (end < len && (tops[laneIndices[end] as number] as number) < bottom)
        end++;
      // Empty windows in gaps have coincident cursors.
      end = Math.max(start, end);
      for (let i = oldStart; i < Math.min(start, oldEnd); i++)
        leaving.push(laneIndices[i] as number);
      for (let i = Math.max(end, oldStart); i < oldEnd; i++)
        leaving.push(laneIndices[i] as number);
      for (let i = start; i < Math.min(oldStart, end); i++)
        entering.push(laneIndices[i] as number);
      for (let i = Math.max(oldEnd, start); i < end; i++)
        entering.push(laneIndices[i] as number);
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
    for (let k = 0; k < from.length; k++) {
      const index = from[k] as number;
      while (added < entering.length && (entering[added] as number) < index)
        indices.push(entering[added++] as number);
      if (leaving[removed] === index) removed++;
      else indices.push(index);
    }
    while (added < entering.length) indices.push(entering[added++] as number);
    this.cached = {
      start: indices[0] ?? this.tops.length,
      end: indices.length
        ? (indices[indices.length - 1] as number) + 1
        : this.tops.length,
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
    // Prefix maxima and segment trees skip intervals that end above the reading
    // point, even when later intervals nest inside an earlier one. Preserve
    // source-order ties while using each lane's vertical order to stop in gaps.
    if (isPure && Number.isFinite(top)) {
      let containing = -1;
      let following = -1;
      for (let g = 0; g < this.lanes.length; g++) {
        const lane = this.lanes[g] as Lane;
        const laneIndices = lane.indices;
        const start = this.firstAfter(lane, top);
        let i: number;
        if (lane.segTree !== null) {
          const end = this.firstTopAfter(lane, top);
          i = end;
          containing = scanSegTreeAbove(
            lane,
            start,
            end,
            top,
            null,
            containing,
            excluded,
          );
          if (containing === 0) return 0;
        } else {
          i = start;
          for (; i < laneIndices.length; i++) {
            const index = laneIndices[i] as number;
            if ((this.tops[index] as number) > top) break;
            if (
              (this.bottoms[index] as number) > top &&
              (containing < 0 || index < containing) &&
              !excluded(index)
            ) {
              if (index === 0) return index;
              containing = index;
            }
          }
        }
        if (containing >= 0) continue;
        for (; i < laneIndices.length; i++) {
          const index = laneIndices[i] as number;
          if (excluded(index)) continue;
          const itemTop = this.tops[index] as number;
          if (
            following < 0 ||
            itemTop < (this.tops[following] as number) ||
            (itemTop === (this.tops[following] as number) && index < following)
          )
            following = index;
          break;
        }
      }
      if (containing >= 0) return containing;
      if (following >= 0) return following;

      let previous = -1;
      for (let g = 0; g < this.lanes.length; g++) {
        const lane = this.lanes[g] as Lane;
        const laneIndices = lane.indices;
        const laneBottoms = lane.bottoms;
        for (let i = this.firstTopAfter(lane, top) - 1; i >= 0; i--) {
          const maxB =
            laneBottoms !== null
              ? (laneBottoms[i] as number)
              : (this.bottoms[laneIndices[i] as number] as number);
          if (previous >= 0 && maxB < (this.bottoms[previous] as number)) break;
          const index = laneIndices[i] as number;
          const itemBottom = this.bottoms[index] as number;
          if (
            (previous < 0 ||
              itemBottom > (this.bottoms[previous] as number) ||
              (itemBottom === (this.bottoms[previous] as number) &&
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
