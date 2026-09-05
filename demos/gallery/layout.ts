// The gallery lab's layouts, as pure math: photos in, positioned items out.
// Nothing here touches the DOM, so it is unit-tested directly.
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
): RowGroup[] {
  const groups: RowGroup[] = [];
  let current: Photo[] = [];
  let aspectSum = 0;
  for (const p of photos) {
    current.push(p);
    aspectSum += p.aspect;
    if (aspectSum >= density) {
      groups.push({ photos: current, aspectSum, ragged: false });
      current = [];
      aspectSum = 0;
    }
  }
  if (complete && current.length)
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
  return placeColumns(planColumns(photos, columns), width, gap);
}

interface ColumnPlan {
  columns: number;
  photos: { photo: Photo; column: number }[];
}

function planColumns(photos: readonly Photo[], columns: number): ColumnPlan {
  const weights = new Array<number>(columns).fill(0);
  return {
    columns,
    photos: photos.map((photo) => {
      let column = 0;
      for (let i = 1; i < columns; i++) {
        if ((weights[i] as number) < (weights[column] as number)) column = i;
      }
      weights[column] = (weights[column] as number) + 1 / photo.aspect;
      return { photo, column };
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
  const bottoms = new Array<number>(columns).fill(0);
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
export function createGalleryLayouts(bandHeight: number) {
  return {
    rows: createLayoutManager({
      minimumDensity: 1,
      plan: planRows,
      place: placeRows,
    }),
    masonry: createLayoutManager({
      minimumDensity: 2,
      plan: planColumns,
      place: (
        plan: ColumnPlan,
        width: number,
        _target: number,
        gap: number,
      ) => {
        const { cards, height } = placeColumns(plan, width, gap);
        return slice(cards, height, bandHeight);
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
): Band[] {
  const bands: Band[] = [];
  for (let start = 0; start < height; start += bandHeight) {
    bands.push({
      kind: "band",
      key: `b${start}`,
      start,
      height: Math.min(bandHeight, height - start),
      cards: [],
    });
  }
  // Assign each card directly to its intersecting bands, preserving top
  // order without rescanning all earlier cards for every band.
  for (const card of [...cards].sort((a, b) => a.top - b.top)) {
    const first = Math.max(0, Math.floor(card.top / bandHeight));
    const last = Math.min(
      bands.length - 1,
      Math.ceil((card.top + card.height) / bandHeight) - 1,
    );
    for (let i = first; i <= last; i++) {
      const band = bands[i] as Band;
      band.cards.push({ ...card, part: i - first });
    }
  }
  return bands;
}
