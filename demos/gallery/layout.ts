// The gallery lab's layouts, as pure math: photos in, positioned items out.
// Nothing here touches the DOM, so it is unit-tested directly.

import { assignColumn, type LayoutCheckpoint } from "./layout-history.js";
import { createLayoutManager, layoutDensity } from "./layout-manager.js";

export interface Photo {
  id: number;
  /** width / height */
  aspect: number;
}

/** A photo placed in a justified row. */
export interface Placed extends Photo {
  width: number;
}

/** A photo placed in the masonry grid, in layout coordinates. */
export interface Card extends Photo {
  kind: "card";
  key: string;
  lane: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface JustifiedRow {
  kind: "row";
  key: string;
  height: number;
  photos: Placed[];
}

export type GalleryItem = JustifiedRow | Card;

/** Compare render inputs directly, stopping at the first changed field. */
export function sameGalleryItem(a: GalleryItem, b: GalleryItem): boolean {
  if (a === b) return true;
  if (a.key !== b.key || a.height !== b.height) return false;
  if (a.kind === "row" && b.kind === "row") {
    return (
      a.photos.length === b.photos.length &&
      a.photos.every((p, i) => {
        const next = b.photos[i];
        return (
          next !== undefined &&
          p.id === next.id &&
          p.aspect === next.aspect &&
          p.width === next.width
        );
      })
    );
  }
  if (a.kind === "card" && b.kind === "card") {
    return (
      a.id === b.id &&
      a.aspect === b.aspect &&
      a.lane === b.lane &&
      a.left === b.left &&
      a.top === b.top &&
      a.width === b.width
    );
  }
  return false;
}

/**
 * Justified rows: aspect-ratio groups remain fixed within a responsive
 * density. Each row scales to fill the width. Incomplete groups wait unless
 * the collection is complete, so a row on screen never changes when the
 * next page arrives; a complete collection ends in a ragged row at the
 * target height.
 */
export function justify(
  photos: readonly Photo[],
  width: number,
  target: number,
  gap: number,
  complete: boolean,
): JustifiedRow[] {
  const density = layoutDensity(width, target);
  return placeRows(planRows(photos, density, complete), width, target, gap);
}

interface RowGroup {
  photos: readonly Photo[];
  aspectSum: number;
  ragged: boolean;
}

function planRows(
  photos: readonly Photo[],
  density: number,
  complete: boolean,
  aspectSum = 0,
): RowGroup[] {
  const groups: RowGroup[] = [];
  let current: Photo[] = [];
  let clipped = aspectSum > 0;
  for (const p of photos) {
    current.push(p);
    aspectSum += p.aspect;
    if (aspectSum >= density) {
      if (!clipped) groups.push({ photos: current, aspectSum, ragged: false });
      clipped = false;
      current = [];
      aspectSum = 0;
    }
  }
  if (complete && current.length && !clipped)
    groups.push({ photos: current, aspectSum, ragged: true });
  return groups;
}

function placeRows(
  groups: readonly RowGroup[],
  width: number,
  target: number,
  gap: number,
): JustifiedRow[] {
  return groups.map(({ photos, aspectSum, ragged }) => {
    const fitted = (width - gap * (photos.length - 1)) / aspectSum;
    const height = ragged ? Math.min(target, fitted) : fitted;
    return {
      kind: "row",
      key: `r${photos[0]?.id}`,
      height,
      photos: photos.map((p) => ({ ...p, width: p.aspect * height })),
    };
  });
}

/**
 * Masonry: balance columns by aspect-ratio height, independently of pixel
 * rounding and gaps. Resizing only changes placement, not column ownership,
 * until the column count changes. Appending never moves an earlier card.
 */
export function masonry(
  photos: readonly Photo[],
  width: number,
  columns: number,
  gap: number,
): { cards: Card[]; height: number } {
  const { cards, height } = placeColumns(
    planColumns(photos, columns),
    width,
    gap,
  );
  return { cards, height };
}

interface ColumnPlan {
  columns: number;
  photos: { photo: Photo; column: number }[];
  weights?: number[];
  counts?: number[];
}

function planColumns(
  photos: readonly Photo[],
  columns: number,
  checkpoint?: LayoutCheckpoint,
): ColumnPlan {
  const weights = checkpoint
    ? [...checkpoint.weights]
    : new Array<number>(columns).fill(0);
  const counts = checkpoint
    ? [...checkpoint.counts]
    : new Array<number>(columns).fill(0);
  const initialWeights = [...weights];
  const initialCounts = [...counts];
  return {
    columns,
    weights: initialWeights,
    counts: initialCounts,
    photos: photos.map((photo) => {
      return { photo, column: assignColumn(weights, counts, photo.aspect) };
    }),
  };
}

function placeColumns(
  plan: ColumnPlan,
  width: number,
  gap: number,
): { cards: Card[]; height: number } {
  const { columns } = plan;
  // Keep fractional geometry: distributing rounded pixels can make one
  // column grow as the viewport shrinks. Rounding each stacked height then
  // amplifies that one-pixel reversal into large jumps deep in the gallery.
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const bottoms = Array.from(
    { length: columns },
    (_, c) =>
      (plan.weights?.[c] ?? 0) * columnWidth + (plan.counts?.[c] ?? 0) * gap,
  );
  const cards: Card[] = [];
  for (const { photo: p, column: c } of plan.photos) {
    const h = Math.max(1, columnWidth / p.aspect);
    const top = bottoms[c] as number;
    cards.push({
      ...p,
      kind: "card",
      key: `p${p.id}`,
      lane: c,
      left: c * (columnWidth + gap),
      top,
      width: columnWidth,
      height: h,
    });
    bottoms[c] = top + h + gap;
  }
  const height = Math.max(0, Math.max(...bottoms, 0) - gap);
  return { cards, height };
}

/** Both gallery layouts use the same planning/placement lifecycle. */
export function createGalleryLayouts(
  checkpoint?: (photos: readonly Photo[], density: number) => LayoutCheckpoint,
) {
  return {
    rows: createLayoutManager({
      minimumDensity: 1,
      plan: (photos, density, complete) =>
        planRows(
          photos,
          density,
          complete,
          checkpoint?.(photos, density).rowAspect,
        ),
      place: placeRows,
    }),
    masonry: createLayoutManager({
      minimumDensity: 2,
      plan: (photos, density) =>
        planColumns(photos, density, checkpoint?.(photos, density)),
      place: (plan: ColumnPlan, width: number, _target: number, gap: number) =>
        placeColumns(plan, width, gap).cards,
    }),
  };
}
