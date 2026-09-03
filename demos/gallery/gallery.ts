import {
  type AnchorPolicy,
  createVirtualList,
  type VirtualList,
} from "../../src/virtual-list.js";
import { mustGet } from "../shared/utils.js";
import "./gallery.css";

// The gallery: justified rows on the v2 runtime, as little as possible.
//
// - A row is the virtualized item. Its height is a function of the photos'
//   aspect ratios and the row width, so a row's geometry is exact before an
//   image has loaded; the runtime still premeasures it (cheap: images carry
//   width/height attributes, so the row lays out without any pixel data).
// - The layout is a pure function (photos, width, target height) → rows.
//   A width change or a size choice recomputes it and hands the runtime a
//   new snapshot anchored on the viewport: the row under the viewport top
//   keeps its place. Rows are keyed by their first photo, so a relayout
//   that leaves a row's membership intact reuses its element.
// - Photos load lazily with the browser's own scheduler; a failed or stalled
//   provider leaves a flat tile in the photo's exact box, never a shift.
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
const STALL_MS = 8_000;
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
 * the width exactly. The last row keeps the target height ragged rather
 * than stretching a couple of photos across the width.
 */
function layout(
  photos: readonly Photo[],
  width: number,
  target: number,
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
  flush(target, false);
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

function renderRow(row: Row, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  el.className = "photo-row";
  el.style.height = `${row.height}px`;
  el.replaceChildren(
    ...row.photos.map((p) => {
      const img = document.createElement("img");
      img.className = "photo";
      img.width = p.width;
      img.height = row.height;
      img.alt = `Photo ${p.id}`;
      img.loading = "lazy";
      img.decoding = "async";
      img.src = `https://picsum.photos/seed/vl-${p.id}/${SOURCE_WIDTH}/${Math.round(SOURCE_WIDTH / p.aspect)}`;
      // A provider that errors or never answers leaves a flat tile in the
      // photo's exact box.
      const stall = window.setTimeout(() => fallback(img), STALL_MS);
      img.addEventListener("load", () => window.clearTimeout(stall), {
        once: true,
      });
      img.addEventListener(
        "error",
        () => {
          window.clearTimeout(stall);
          fallback(img);
        },
        { once: true },
      );
      return img;
    }),
  );
  return el;
}

function fallback(img: HTMLImageElement): void {
  img.removeAttribute("src");
  img.classList.add("photo-fallback");
}

function relayout(anchor: AnchorPolicy): void {
  const photos = Array.from({ length: loaded }, (_, i) => photo(i));
  rows = layout(photos, width, TARGET_ROW_HEIGHTS[size]);
  list?.setItems(rows, { anchor });
  syncStatus();
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
    // A page appends below: the viewport keeps its row.
    relayout("viewport");
  }, LOAD_DELAY_MS);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    loading = false;
  });
}

// --- Boot -------------------------------------------------------------------

width = viewport.clientWidth;
loaded = PAGE;
rows = layout(
  Array.from({ length: loaded }, (_, i) => photo(i)),
  width,
  TARGET_ROW_HEIGHTS[size],
);
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
  relayout("viewport");
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
    relayout("viewport");
  });
}
