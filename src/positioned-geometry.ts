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
}

interface Lane {
  indices: number[];
  /** Prefix maxima also cover overlapping intervals within a lane. */
  bottoms: number[];
}

/** Immutable positioned snapshot. Only the last visibility result is cached. */
export class PositionedGeometry {
  private readonly items: readonly PositionedItem[];
  private readonly lanes: Lane[];
  readonly totalSize: number;
  private cached: GeometryWindow | null = null;
  private cachedTop = Number.NaN;
  private cachedBottom = Number.NaN;

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
        bottoms: indices.map((index) => {
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
    this.cachedTop = top;
    this.cachedBottom = bottom;
    const indices: number[] = [];
    for (const lane of this.lanes) {
      for (let i = this.firstAfter(lane, top); i < lane.indices.length; i++) {
        const index = lane.indices[i] as number;
        if (this.top(index) >= bottom) break;
        if (this.bottom(index) > top) indices.push(index);
      }
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

  /** Prefer a containing item in source order, then the nearest following item. */
  anchorAt(top: number, excluded: (index: number) => boolean): number {
    let containing = -1;
    let following = -1;
    let previous = -1;
    // Anchor capture is a transaction operation, not the scrolling hot path.
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
