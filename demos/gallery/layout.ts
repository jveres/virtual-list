// The gallery lab's layouts, as pure math: photos in, positioned items out.
// Nothing here touches the DOM, so it is unit-tested directly.

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
 * Justified rows: photos join a row at the target height until it would
 * overflow the width, then the row's height is set so its photos fill the
 * width exactly. Photos that do not yet fill a row are held back unless
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
  const rows: JustifiedRow[] = [];
  let current: Photo[] = [];
  let aspectSum = 0;
  const flush = (height: number, justified: boolean): void => {
    if (current.length === 0) return;
    const rounded = Math.round(height);
    // Widths from rounded cumulative positions: a justified row fills the
    // width exactly rather than drifting by a pixel per photo.
    let used = 0;
    let acc = 0;
    const placed = current.map((p, i) => {
      acc += p.aspect * rounded;
      const last = i === current.length - 1;
      const w =
        justified && last
          ? width - gap * (current.length - 1) - used
          : Math.round(acc) - used;
      used += w;
      return { ...p, width: w };
    });
    rows.push({
      kind: "row",
      key: `r${current[0]?.id}`,
      height: rounded,
      photos: placed,
    });
    current = [];
    aspectSum = 0;
  };
  for (const p of photos) {
    current.push(p);
    aspectSum += p.aspect;
    const gaps = gap * (current.length - 1);
    if (aspectSum * target >= width - gaps)
      flush((width - gaps) / aspectSum, true);
  }
  if (complete) flush(target, false);
  return rows;
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
  // Keep fractional geometry: distributing rounded pixels can make one
  // column grow as the viewport shrinks. Rounding each stacked height then
  // amplifies that one-pixel reversal into large jumps deep in the gallery.
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const bottoms = new Array<number>(columns).fill(0);
  const weights = new Array<number>(columns).fill(0);
  const cards: Card[] = [];
  for (const p of photos) {
    let c = 0;
    for (let i = 1; i < columns; i++) {
      if ((weights[i] as number) < (weights[c] as number)) c = i;
    }
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
    weights[c] = (weights[c] as number) + 1 / p.aspect;
  }
  const height = Math.max(0, Math.max(...bottoms, 0) - gap);
  return { cards, height };
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
