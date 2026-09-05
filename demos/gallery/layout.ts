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
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A card as one band holds it: `part` counts the bands it crosses, from the one holding its top. */
export interface BandCard extends Card {
  part: number;
}

export interface JustifiedRow {
  kind: "row";
  key: string;
  height: number;
  photos: Placed[];
}

/** A horizontal slice of the masonry grid: the cards it intersects, positioned relative to its top. */
export interface Band {
  kind: "band";
  key: string;
  /** Layout y of the slice's top. */
  start: number;
  height: number;
  cards: BandCard[];
}

export type GalleryItem = JustifiedRow | Band;

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
  if (a.kind === "band" && b.kind === "band") {
    return (
      a.start === b.start &&
      a.cards.length === b.cards.length &&
      a.cards.every((p, i) => {
        const next = b.cards[i];
        return (
          next !== undefined &&
          p.id === next.id &&
          p.aspect === next.aspect &&
          p.left === next.left &&
          p.top === next.top &&
          p.width === next.width &&
          p.height === next.height &&
          p.part === next.part
        );
      })
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
  bandHeight: number,
  checkpoint?: (photos: readonly Photo[], density: number) => LayoutCheckpoint,
  pixelRatio: () => number = () => 1,
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
      place: (
        plan: ColumnPlan,
        width: number,
        _target: number,
        gap: number,
      ) => {
        const { cards, height } = placeColumns(plan, width, gap);
        // Keep every retained card's top. Only the first band is shortened;
        // all later bands keep their absolute identity and boundaries.
        return slice(
          cards,
          height,
          bandHeight,
          cards.length ? Math.min(...cards.map((card) => card.top)) : 0,
          pixelRatio(),
        );
      },
    }),
  };
}

/**
 * Slices the masonry grid into bands of `bandHeight`, the last one ending
 * at the grid's height. A card crossing an edge belongs to every band it
 * intersects (drawn in each, offset and clipped), so the seam is invisible.
 * Bands are keyed by their start, which appends never change.
 */
export function slice(
  cards: readonly Card[],
  height: number,
  bandHeight: number,
  from = 0,
  pixelRatio = 1,
): Band[] {
  // Runtime slots round heights up to device pixels. Align slicing to the
  // same grid so a fractional leading band cannot leave a white seam.
  bandHeight = Math.ceil(bandHeight * pixelRatio - 1e-6) / pixelRatio;
  from = Math.floor(from * pixelRatio + 1e-6) / pixelRatio;
  const bands: Band[] = [];
  const firstBand = Math.floor(from / bandHeight);
  for (let index = firstBand; index * bandHeight < height; index++) {
    const start = Math.max(from, index * bandHeight);
    bands.push({
      kind: "band",
      key: `b${index * bandHeight}`,
      start,
      height: Math.min((index + 1) * bandHeight, height) - start,
      cards: [],
    });
  }
  // Assign each card directly to its intersecting bands, preserving top
  // order without rescanning all earlier cards for every band.
  for (const card of [...cards].sort((a, b) => a.top - b.top)) {
    const origin = Math.floor(card.top / bandHeight);
    const first = Math.max(0, origin - firstBand);
    const last = Math.min(
      bands.length - 1,
      Math.ceil((card.top + card.height) / bandHeight) - firstBand - 1,
    );
    for (let i = first; i <= last; i++) {
      const band = bands[i] as Band;
      band.cards.push({ ...card, part: i + firstBand - origin });
    }
  }
  return bands;
}
