/**
 * Pure layout math for the virtualizer — no DOM, no state, no side effects.
 * Everything here maps geometry inputs (counts, heights, scroll position,
 * viewport size) to layout decisions (render ranges, pixel windows, slot
 * visibility), so it is directly unit- and property-testable.
 */

import type { FenwickTree } from "./fenwick";

export interface VirtualListPixelWindowPlan {
  start: number;
  end: number;
  count: number;
  height: number;
}

export interface VirtualListPixelWindowConfig {
  count: number;
  minimumPx: number;
  getItemHeight: (index: number) => number;
  minItems?: number;
  maxItems?: number;
}

export interface VirtualListPixelWindowFromStartConfig
  extends VirtualListPixelWindowConfig {
  start?: number;
}

export interface VirtualListPixelWindowFromEndConfig
  extends VirtualListPixelWindowConfig {
  end?: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function positiveSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function nonNegativeSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizedWindowItemLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function shouldCollectPixelWindowItem(
  itemCount: number,
  height: number,
  minimumPx: number,
  minItems: number,
  maxItems: number,
): boolean {
  if (itemCount >= maxItems) return false;
  return itemCount < minItems || height < minimumPx;
}

export function planVirtualListPixelWindowFromEnd(
  config: VirtualListPixelWindowFromEndConfig,
): VirtualListPixelWindowPlan {
  const count = nonNegativeInteger(config.count);
  const end = clamp(normalizedWindowItemLimit(config.end, count), 0, count);
  const minimumPx = nonNegativeSize(config.minimumPx);
  const minItems = normalizedWindowItemLimit(
    config.minItems,
    count > 0 ? 1 : 0,
  );
  const maxItems = Math.max(
    minItems,
    normalizedWindowItemLimit(config.maxItems, count),
  );
  let start = end;
  let height = 0;

  while (
    start > 0 &&
    shouldCollectPixelWindowItem(
      end - start,
      height,
      minimumPx,
      minItems,
      maxItems,
    )
  ) {
    start--;
    height += positiveSize(config.getItemHeight(start));
  }

  return { start, end, count: end - start, height };
}

export function planVirtualListPixelWindowFromStart(
  config: VirtualListPixelWindowFromStartConfig,
): VirtualListPixelWindowPlan {
  const count = nonNegativeInteger(config.count);
  const start = clamp(normalizedWindowItemLimit(config.start, 0), 0, count);
  const minimumPx = nonNegativeSize(config.minimumPx);
  const minItems = normalizedWindowItemLimit(
    config.minItems,
    count > 0 ? 1 : 0,
  );
  const maxItems = Math.max(
    minItems,
    normalizedWindowItemLimit(config.maxItems, count),
  );
  let end = start;
  let height = 0;

  while (
    end < count &&
    shouldCollectPixelWindowItem(
      end - start,
      height,
      minimumPx,
      minItems,
      maxItems,
    )
  ) {
    height += positiveSize(config.getItemHeight(end));
    end++;
  }

  return { start, end, count: end - start, height };
}

export interface RenderRange {
  start: number;
  end: number;
}

/**
 * The mounted item range for a frame: the rows intersecting the viewport plus
 * `overscanPx` above and below, widened by one buffer row at the top and two
 * at the bottom (the exclusive end). Writes into `target` so the per-frame
 * path allocates nothing. `itemScrollTop` is the scroll position in item
 * space (logical scrollTop minus the top slot height); `itemTotal` is the
 * summed item height (the tree total, passed in where the caller caches it).
 */
export function planRenderRange(
  target: RenderRange,
  tree: FenwickTree,
  count: number,
  fullRender: boolean,
  itemScrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  itemTotal: number,
): void {
  if (count === 0) {
    target.start = 0;
    target.end = 0;
    return;
  }
  if (fullRender) {
    target.start = 0;
    target.end = count;
    return;
  }

  const startTarget = Math.max(0, itemScrollTop - overscanPx);
  const endTarget = Math.min(
    itemTotal,
    itemScrollTop + viewportHeight + overscanPx,
  );
  target.start = Math.max(0, tree.indexAt(startTarget) - 1);
  target.end = Math.min(count, tree.indexAt(endTarget) + 2);
}

/**
 * Whether at least `threshold` of a slot's height overlaps the viewport —
 * the visibility signal an IntersectionObserver at the same threshold would
 * report, computed from content-space geometry.
 */
export function slotCoverageVisible(
  slotTop: number,
  slotHeight: number,
  scrollTop: number,
  viewportHeight: number,
  threshold: number,
): boolean {
  const visibleHeight =
    Math.min(slotTop + slotHeight, scrollTop + viewportHeight) -
    Math.max(slotTop, scrollTop);
  if (visibleHeight <= 0) return false;
  return visibleHeight / Math.max(1, slotHeight) >= threshold;
}
