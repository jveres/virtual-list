import { createVirtualList, type VirtualList } from "../../src/virtual-list.js";
import { mustGet } from "../shared/utils.js";
import "./gallery.css";

// The gallery: justified rows on the v2 runtime, as little as possible.
//
// - A row is the virtualized item. Its height is a function of the photos'
//   aspect ratios and the row width, so a row's geometry is exact before an
//   image has loaded; the runtime still premeasures it (cheap: images carry
//   width/height attributes, so the row lays out without any pixel data).
// - The layout is a pure function (photos, width, target height) → rows.
//   A page append leaves every row above unchanged (the runtime keeps the
//   viewport); a width or size change re-flows every row, and the demo
//   carries the photo under the viewport top across it. Rows are keyed by
//   their first photo and keep their object while unchanged, so the runtime
//   re-renders nothing for them.
// - Photos load once they near the viewport; a failed or stalled provider
//   leaves a flat tile in the photo's exact box, never a shift.
// - Scrolling forward loads another page through the runtime's reach
//   signal, with a fixed-height loader slot at the end.

const TARGET_ROW_HEIGHTS = { s: 140, m: 190, l: 260 } as const;
type RowSize = keyof typeof TARGET_ROW_HEIGHTS;
const GAP = 4;
const PAGE = 120;
const TOTAL = 2_400;
const LOAD_DELAY_MS = 500;
const LOADER_HEIGHT = 56;
const SOURCE_WIDTH = 640;
const STALL_MS = 15_000;
// Portraits, squares, and landscapes in the proportions a camera roll has.
const ASPECTS = [0.67, 0.75, 0.8, 1, 1.33, 1.5, 1.5, 1.78, 2.0];

interface Photo {
  id: number;
  aspect: number;
}

interface Placed extends Photo {
  width: number;
}

interface Row {
  key: string;
  height: number;
  photos: Placed[];
}

function photo(id: number): Photo {
  // A cheap hash spreads aspects so neighbours differ.
  const hash = (id * 2654435761) >>> 0;
  return { id, aspect: ASPECTS[hash % ASPECTS.length] as number };
}

/**
 * Justified rows: photos join a row at the target height until the row
 * would overflow the width, then the row's height is set so its photos fill
 * the width exactly. The trailing photos that do not fill a row are held
 * back while more pages are to come, so a row on screen never changes when
 * the next page arrives; once the collection is complete they form a last
 * row at the target height, ragged rather than stretched across the width.
 */
function layout(
  photos: readonly Photo[],
  width: number,
  target: number,
  complete: boolean,
): Row[] {
  const rows: Row[] = [];
  let current: Photo[] = [];
  let aspectSum = 0;
  const flush = (height: number, justified: boolean): void => {
    if (current.length === 0) return;
    const rounded = Math.round(height);
    // Widths from rounded cumulative positions, so a justified row fills
    // the width exactly rather than drifting by a pixel per photo.
    let used = 0;
    let acc = 0;
    const placed = current.map((p, i) => {
      acc += p.aspect * rounded;
      const isLast = i === current.length - 1;
      const w =
        justified && isLast
          ? width - GAP * (current.length - 1) - used
          : Math.round(acc) - used;
      used += w;
      return { ...p, width: w };
    });
    rows.push({ key: `r${current[0]?.id}`, height: rounded, photos: placed });
    current = [];
    aspectSum = 0;
  };
  for (const p of photos) {
    current.push(p);
    aspectSum += p.aspect;
    const gaps = GAP * (current.length - 1);
    if (aspectSum * target >= width - gaps) {
      flush((width - gaps) / aspectSum, true);
    }
  }
  if (complete) flush(target, false);
  return rows;
}

const viewport = mustGet("viewport");
const status = mustGet("status");
const loaderSlot = { key: "more", height: LOADER_HEIGHT, render: renderLoader };

let size: RowSize = "m";
let width = 0;
let loaded = 0;
let loading = false;
let list: VirtualList<Row> | undefined;
let rows: Row[] = [];

function renderLoader(): HTMLElement {
  const el = document.createElement("div");
  el.className = "loader";
  el.textContent = "Loading more photos";
  return el;
}

/**
 * Renders a row. A re-render with the same photos only resizes the images
 * in place: a new <img> would restart its download, and a page load
 * re-flows every row, so recreating them showed empty tiles and reloads
 * on each scroll.
 */
function renderRow(row: Row, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  el.className = "photo-row";
  el.style.height = `${row.height}px`;
  const same =
    el.children.length === row.photos.length &&
    row.photos.every(
      (p, i) => (el.children[i] as HTMLElement).dataset.id === String(p.id),
    );
  if (same) {
    row.photos.forEach((p, i) => {
      const img = el.children[i] as HTMLImageElement;
      img.width = p.width;
      img.height = row.height;
    });
    return el;
  }
  el.replaceChildren(...row.photos.map((p) => photoElement(p, row.height)));
  return el;
}

function photoElement(p: Placed, height: number): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "photo";
  img.dataset.id = String(p.id);
  img.width = p.width;
  img.height = height;
  img.alt = `Photo ${p.id}`;
  img.decoding = "async";
  // A provider that errors, or never answers, leaves a flat tile in the
  // photo's exact box; a late answer still paints over it.
  img.addEventListener("load", () => img.classList.remove("photo-fallback"), {
    once: true,
  });
  img.addEventListener("error", () => img.classList.add("photo-fallback"), {
    once: true,
  });
  // The source is set only once the photo nears the viewport: the runtime
  // premeasures fresh rows in a hidden root that the browser's own lazy
  // loading counts as visible, so a src at render time downloaded every
  // photo of every re-flowed row.
  img.dataset.src = `https://picsum.photos/seed/vl-${p.id}/${SOURCE_WIDTH}/${Math.round(SOURCE_WIDTH / p.aspect)}`;
  nearViewport.observe(img);
  return img;
}

const nearViewport = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      nearViewport.unobserve(img);
      if (!img.dataset.src) continue;
      img.src = img.dataset.src;
      const stall = window.setTimeout(
        () => img.classList.add("photo-fallback"),
        STALL_MS,
      );
      img.addEventListener("load", () => window.clearTimeout(stall), {
        once: true,
      });
    }
  },
  { root: viewport, rootMargin: "600px 0px" },
);

/** Rows equal to their previous version keep their object: the runtime then re-renders nothing for them. */
function reconcile(next: Row[], previous: readonly Row[]): Row[] {
  const byKey = new Map(previous.map((row) => [row.key, row]));
  return next.map((row) => {
    const old = byKey.get(row.key);
    if (
      old &&
      old.height === row.height &&
      old.photos.length === row.photos.length &&
      old.photos.every(
        (p, i) =>
          p.id === row.photos[i]?.id && p.width === row.photos[i]?.width,
      )
    ) {
      return old;
    }
    return row;
  });
}

/** A page appended below: rows above are unchanged, the runtime keeps the viewport. */
function appendPage(): void {
  rows = reconcile(layoutLoaded(), rows);
  list?.setItems(rows, { anchor: "viewport" });
  syncStatus();
}

function layoutLoaded(): Row[] {
  const photos = Array.from({ length: loaded }, (_, i) => photo(i));
  const next = layout(photos, width, TARGET_ROW_HEIGHTS[size], loaded >= TOTAL);
  // An inherited key holds while its row still starts at the same photo and
  // still holds the photo it was carried for; the rest are forgotten.
  const starts = new Map(next.map((row) => [row.photos[0]?.id ?? -1, row]));
  for (const [start, carried] of inherited) {
    const row = starts.get(start);
    if (row?.photos.some((p) => p.id === carried.photo)) row.key = carried.key;
    else inherited.delete(start);
  }
  return next;
}

/**
 * A re-flow (a width or row-size change) changes which photo starts each
 * row, so the key of the row under the viewport top would not survive it
 * and the runtime's key anchor would have nothing to hold. The row that
 * now holds that row's first photo inherits its key instead: the runtime
 * then resolves the re-flow as any other anchored snapshot, keeping that
 * row's line under the viewport top, settle-gated and on the device grid.
 * The inheritance is remembered, so a later page append (which regenerates
 * keys from first photos) does not rename the row underneath the viewport.
 */
function reflow(): void {
  const anchor = rowUnderViewportTop();
  if (anchor) {
    const first = anchor.photos[0]?.id ?? 0;
    const next = layoutLoaded();
    const target = next.find((row) => row.photos.some((p) => p.id === first));
    if (target && target.key !== anchor.key) {
      inherited.set(target.photos[0]?.id ?? 0, {
        key: anchor.key,
        photo: first,
      });
    }
  }
  rows = reconcile(layoutLoaded(), rows);
  list?.setItems(rows, { anchor: "viewport" });
  syncStatus();
}

/** Inherited row keys, by the row's first photo: the key and the photo it was carried for. */
const inherited = new Map<number, { key: string; photo: number }>();

/** The row the viewport top falls in, from the committed geometry the demo mirrors (rows start at 0; the only slot is at the end). */
function rowUnderViewportTop(): Row | undefined {
  const scrollTop = viewport.scrollTop;
  let top = 0;
  for (const row of rows) {
    top += row.height;
    if (scrollTop < top) return row;
  }
  return rows[rows.length - 1];
}

function syncStatus(): void {
  status.textContent = `${loaded.toLocaleString()} of ${TOTAL.toLocaleString()} photos · ${rows.length.toLocaleString()} rows · ${TARGET_ROW_HEIGHTS[size]}px rows`;
}

function loadMore(signal: AbortSignal): void {
  if (loading || loaded >= TOTAL) return;
  loading = true;
  const timer = window.setTimeout(() => {
    loading = false;
    loaded = Math.min(TOTAL, loaded + PAGE);
    if (loaded >= TOTAL) list?.setEdgeSlot("end", null);
    appendPage();
  }, LOAD_DELAY_MS);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    loading = false;
  });
}

// --- Boot -------------------------------------------------------------------

width = viewport.clientWidth;
loaded = PAGE;
rows = layoutLoaded();
list = createVirtualList<Row>(viewport, {
  items: rows,
  key: (row) => row.key,
  render: renderRow,
  overscanPx: 600,
  scrollingUpdates: "live",
  edgeSlots: { end: loaderSlot },
  onReachEnd: ({ signal }) => loadMore(signal),
});
// A gallery starts at its first photo, not at the end.
void list.scrollTo("start");
syncStatus();

// A width change re-flows every row; the row under the viewport top stays.
new ResizeObserver(() => {
  const next = viewport.clientWidth;
  if (next === width || next === 0) return;
  width = next;
  reflow();
}).observe(viewport);

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-size]",
)) {
  button.addEventListener("click", () => {
    const next = button.dataset.size as RowSize;
    if (next === size) return;
    size = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      "[data-size]",
    )) {
      b.classList.toggle("active", b === button);
    }
    reflow();
  });
}
