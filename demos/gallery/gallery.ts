import { createVirtualList, type VirtualList } from "../../src/virtual-list.js";
import { mustGet } from "../shared/utils.js";
import { createImageLoader, type LoaderMetrics } from "./image-loader.js";
import {
  type Band,
  type GalleryItem,
  type JustifiedRow,
  justify,
  masonry,
  type Photo,
  slice,
} from "./layout.js";

// The gallery: two layouts of the same photos on the v2 runtime.
//
// - Rows: a justified row is the item. Photos that do not yet fill a row
//   are held back while pages remain, so a row on screen never changes
//   when the next page arrives.
// - Masonry: a column grid sliced into fixed-height bands; the band is the
//   item. A card crossing a band edge is drawn in both bands, offset and
//   clipped, so the seam is invisible. Appending goes to the shortest
//   columns and never moves an earlier card; the bands it reaches change
//   in place. Bands are keyed by their start, which never changes.
// - Every item declares its height (`height`), so the runtime never
//   measures: a row's height follows from its photos' aspect ratios, a
//   band's from the slicing. A band that changes during a gesture is
//   rendered in place at the settle, inside the commit.
// - A re-flow (width, size, or layout) names its anchor: the photo under
//   the viewport top and a fraction of it are found in the current items,
//   and the new item holding that point is named with the offset that
//   keeps the point where it was (`anchor: { key, offset }`).
// - Images load through a loader fed by the mount hooks: an element joins
//   the scroller, its images queue nearest-first under a concurrency
//   limit; it leaves, its downloads are abandoned. The header shows the
//   loader's metrics.

type Layout = "rows" | "masonry";
type Size = "s" | "m" | "l";
const ROW_HEIGHTS: Record<Size, number> = { s: 150, m: 210, l: 290 };
const COLUMN_WIDTHS: Record<Size, number> = { s: 170, m: 240, l: 330 };
const GAP = 6;
/** The rows and bands are centred at this width; the scroller spans the page. */
const CONTENT_WIDTH = 1080;
const BAND_HEIGHT = 480;
const PAGE = 120;
const TOTAL = 3_000;
const LOAD_DELAY_MS = 500;
const LOADER_HEIGHT = 56;
const SOURCE_WIDTH = 640;
const CONCURRENCIES = [2, 4, 6, 8, 16];
// Portraits, squares, and landscapes in the proportions a camera roll has.
const ASPECTS = [0.67, 0.75, 0.8, 1, 1.33, 1.5, 1.5, 1.78, 2.0];

function photo(id: number): Photo {
  // A cheap hash spreads aspects so neighbours differ.
  const hash = (id * 2654435761) >>> 0;
  return { id, aspect: ASPECTS[hash % ASPECTS.length] as number };
}

const viewport = mustGet("viewport");
const status = mustGet("status");
const loaderMetrics = mustGet("loader-metrics");
const concurrencySelect = mustGet("concurrency", HTMLSelectElement);

// Layout, size, and concurrency persist in this browser.
const OPTIONS_KEY = "virtual-list:gallery-options";
const stored = ((): {
  layout?: unknown;
  size?: unknown;
  concurrency?: unknown;
} => {
  try {
    return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}");
  } catch {
    return {};
  }
})();
let layout: Layout = stored.layout === "masonry" ? "masonry" : "rows";
let size: Size = stored.size === "s" || stored.size === "l" ? stored.size : "m";
let concurrency = CONCURRENCIES.includes(Number(stored.concurrency))
  ? Number(stored.concurrency)
  : 6;
function saveOptions(): void {
  try {
    localStorage.setItem(
      OPTIONS_KEY,
      JSON.stringify({ layout, size, concurrency }),
    );
  } catch {
    // Storage may be unavailable; the session keeps its choices.
  }
}

let width = 0;
let loaded = 0;
let loading = false;
let items: GalleryItem[] = [];

// --- Images ------------------------------------------------------------------

const images = createImageLoader({
  viewport,
  concurrency,
  onMetrics: showMetrics,
});

function showMetrics(m: Readonly<LoaderMetrics>): void {
  loaderMetrics.textContent = `queue ${m.queued} (peak ${m.peakQueued}) · loading ${m.inFlight}/${m.concurrency} · loaded ${m.loaded} · reused ${m.reused} · cancelled ${m.cancelled} · failed ${m.failed}`;
}

function sourceOf(p: Photo): string {
  return `https://picsum.photos/seed/vl-${p.id}/${SOURCE_WIDTH}/${Math.round(SOURCE_WIDTH / p.aspect)}`;
}

function queueImages(element: HTMLElement): void {
  for (const img of element.querySelectorAll<HTMLImageElement>("img.photo")) {
    images.add(img, img.dataset.src as string);
  }
}

function dropImages(element: HTMLElement): void {
  for (const img of element.querySelectorAll<HTMLImageElement>("img.photo")) {
    images.remove(img);
  }
}

// --- Rendering ---------------------------------------------------------------

const loaderSlot = { key: "more", height: LOADER_HEIGHT, render: renderLoader };

function renderLoader(): HTMLElement {
  const el = document.createElement("div");
  el.className = "loader";
  el.style.height = `${LOADER_HEIGHT}px`;
  el.setAttribute("role", "status");
  const spinner = document.createElement("span");
  spinner.className = "boundary-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "Loading more photos";
  el.append(spinner, label);
  return el;
}

function render(item: GalleryItem, existing?: HTMLElement): HTMLElement {
  return item.kind === "row"
    ? renderRow(item, existing)
    : renderBand(item, existing);
}

/** The height every item declares: the runtime never measures. */
function heightOf(item: GalleryItem): number {
  return item.kind === "row" ? item.height + GAP : item.height;
}

/** The tiles an element already holds, by photo and drawing: a re-render keeps them. */
function existingTiles(el: HTMLElement): Map<string, HTMLElement> {
  const held = new Map<string, HTMLElement>();
  for (const tile of el.querySelectorAll<HTMLElement>(".tile")) {
    held.set(tile.dataset.tile as string, tile);
  }
  return held;
}

/**
 * A photo's tile at a size: the placeholder box, its image over it. A tile
 * new to a mounted element joins the loader here (the mount hook covered
 * the element's tiles when the element mounted); one that leaves a mounted
 * element on re-render is dropped from it.
 */
function tileAt(
  el: HTMLElement,
  held: Map<string, HTMLElement>,
  p: Photo,
  width: number,
  height: number,
  part = 0,
): HTMLElement {
  const id = `${p.id}:${part}`;
  let tile = held.get(id);
  if (tile) {
    held.delete(id);
  } else {
    tile = tileElement(p, id);
    if (el.isConnected) queueImages(tile);
  }
  tile.style.width = `${width}px`;
  tile.style.height = `${height}px`;
  return tile;
}

function dropUnused(el: HTMLElement, held: Map<string, HTMLElement>): void {
  if (!el.isConnected) return;
  for (const tile of held.values()) dropImages(tile);
}

function renderRow(row: JustifiedRow, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  const held = existingTiles(el);
  el.className = "photo-row";
  el.style.height = `${row.height + GAP}px`;
  el.replaceChildren(
    ...row.photos.map((p) => {
      return tileAt(el, held, p, p.width, row.height);
    }),
  );
  dropUnused(el, held);
  return el;
}

function renderBand(band: Band, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  const held = existingTiles(el);
  el.className = "band";
  el.style.height = `${band.height}px`;
  el.replaceChildren(
    ...band.cards.map((card) => {
      const tile = tileAt(el, held, card, card.width, card.height, card.part);
      tile.style.left = `${card.left}px`;
      tile.style.top = `${card.top - band.start}px`;
      return tile;
    }),
  );
  dropUnused(el, held);
  return el;
}

function tileElement(p: Photo, id: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.tile = id;
  tile.dataset.id = String(p.id);
  const img = document.createElement("img");
  img.className = "photo";
  img.alt = `Photo ${p.id}`;
  img.decoding = "async";
  img.dataset.src = sourceOf(p);
  tile.append(img);
  return tile;
}

// --- Layout ------------------------------------------------------------------

function columns(): number {
  return Math.max(2, Math.round(width / COLUMN_WIDTHS[size]));
}

function build(): GalleryItem[] {
  const photos = Array.from({ length: loaded }, (_, i) => photo(i));
  if (layout === "rows") {
    return justify(photos, width, ROW_HEIGHTS[size], GAP, loaded >= TOTAL);
  }
  const { cards, height } = masonry(photos, width, columns(), GAP);
  return slice(cards, height, BAND_HEIGHT);
}

/** Items equal to their previous version keep their object: the runtime re-renders nothing for them. */
function reconcile(
  next: GalleryItem[],
  previous: readonly GalleryItem[],
): GalleryItem[] {
  const byKey = new Map(previous.map((item) => [item.key, item]));
  return next.map((item) => {
    const old = byKey.get(item.key);
    return old && signature(old) === signature(item) ? old : item;
  });
}

function signature(item: GalleryItem): string {
  return item.kind === "row"
    ? `r${item.height}:${item.photos.map((p) => `${p.id}/${p.width}`).join(",")}`
    : `b${item.start}/${item.height}:${item.cards.map((c) => `${c.id}@${c.left},${c.top},${c.width}`).join(",")}`;
}

/** A page appended below: everything above is unchanged, the runtime keeps the viewport. */
function appendPage(): void {
  items = reconcile(build(), items);
  list.setItems(items, { anchor: "viewport" });
  syncStatus();
}

/**
 * A re-flow: the point under the viewport top — a photo and a fraction of
 * it — is found in the current items; the items are rebuilt; the item that
 * now holds that point is named as the anchor, with the offset that keeps
 * the point where it was. The runtime resolves the rest.
 */
function reflow(): void {
  const point = pointUnderViewportTop();
  items = reconcile(build(), items);
  list.setItems(items, { anchor: point ? anchorFor(point) : "viewport" });
  syncStatus();
}

interface Point {
  photo: number;
  /** The fraction of the photo's height above the viewport top. */
  fraction: number;
}

/**
 * The photo under the viewport top and how far into it the top falls. The
 * item under the top comes from the runtime's committed geometry (on the
 * device grid; a sum of declared heights would drift on a fractional
 * ratio); the gallery adds only the photo and the fraction.
 */
function pointUnderViewportTop(): Point | null {
  const scrollTop = viewport.scrollTop;
  // Items are ordered: binary-search the committed positions.
  let low = 0;
  let high = items.length - 1;
  let found: { item: GalleryItem; offset: number } | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const item = items[mid] as GalleryItem;
    const position = list.positionOf(item.key);
    // Not committed yet: a page appended while a gesture holds it. Appended
    // keys are at the end, so the point is above.
    if (!position || scrollTop < position.top) high = mid - 1;
    else if (scrollTop >= position.top + position.height) low = mid + 1;
    else {
      found = { item, offset: scrollTop - position.top };
      break;
    }
  }
  if (!found) return null;
  const { item, offset } = found;
  if (item.kind === "row") {
    const first = item.photos[0];
    return first
      ? { photo: first.id, fraction: Math.min(1, offset / item.height) }
      : null;
  }
  const y = item.start + offset;
  const card =
    item.cards.find((c) => c.top <= y && y < c.top + c.height) ?? item.cards[0];
  return card
    ? {
        photo: card.id,
        fraction: Math.min(1, Math.max(0, (y - card.top) / card.height)),
      }
    : null;
}

/** The new item holding the point, and the offset of its top from the viewport top that keeps the point there. */
function anchorFor(point: Point): { key: string; offset: number } | "viewport" {
  for (const item of items) {
    if (item.kind === "row") {
      if (item.photos.some((p) => p.id === point.photo)) {
        return { key: item.key, offset: -point.fraction * item.height };
      }
    } else {
      const card = item.cards.find((c) => c.id === point.photo);
      if (card) {
        const y = card.top + point.fraction * card.height;
        if (y >= item.start && y < item.start + item.height) {
          return { key: item.key, offset: -(y - item.start) };
        }
      }
    }
  }
  return "viewport";
}

function syncStatus(): void {
  const unit = layout === "rows" ? "rows" : `bands · ${columns()} columns`;
  status.textContent = `${loaded.toLocaleString()} of ${TOTAL.toLocaleString()} photos · ${items.length.toLocaleString()} ${unit}`;
}

function loadMore(signal: AbortSignal): void {
  if (loading || loaded >= TOTAL) return;
  loading = true;
  const timer = window.setTimeout(() => {
    loading = false;
    loaded = Math.min(TOTAL, loaded + PAGE);
    if (loaded >= TOTAL) list.setEdgeSlot("end", null);
    appendPage();
  }, LOAD_DELAY_MS);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    loading = false;
  });
}

// --- Boot --------------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-size], [data-layout]",
)) {
  button.classList.toggle(
    "active",
    button.dataset.size === size || button.dataset.layout === layout,
  );
}
concurrencySelect.replaceChildren(
  ...CONCURRENCIES.map((n) => {
    const option = document.createElement("option");
    option.value = String(n);
    option.textContent = String(n);
    return option;
  }),
);
concurrencySelect.value = String(concurrency);
concurrencySelect.addEventListener("change", () => {
  concurrency = Number(concurrencySelect.value);
  images.setConcurrency(concurrency);
  saveOptions();
});
showMetrics(images.metrics());

function contentWidth(): number {
  return Math.min(viewport.clientWidth, CONTENT_WIDTH);
}

// The stylesheet's sizes come from these constants.
const stage = viewport.parentElement as HTMLElement;
stage.style.setProperty("--content-width", `${CONTENT_WIDTH}px`);
stage.style.setProperty("--gap", `${GAP}px`);
width = contentWidth();
loaded = PAGE;
items = build();
const list: VirtualList<GalleryItem> = createVirtualList<GalleryItem>(
  viewport,
  {
    items,
    key: (item) => item.key,
    render,
    height: heightOf,
    // A gallery starts at its first photo, not at the end.
    boot: "start",
    overscanPx: 600,
    // A page that lands mid-gesture waits for the settle, whole: no photos
    // appear under a moving finger or an overscroll bounce.
    scrollingUpdates: "freeze",
    edgeSlots: { end: loaderSlot },
    onReachEnd: ({ signal }) => loadMore(signal),
    onMount: queueImages,
    onUnmount: dropImages,
    onState: () => images.reprioritize(),
  },
);
syncStatus();

new ResizeObserver(() => {
  const next = contentWidth();
  if (next === width || next === 0) return;
  width = next;
  reflow();
}).observe(viewport);

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-size]",
)) {
  button.addEventListener("click", () => {
    const next = button.dataset.size as Size;
    if (next === size) return;
    size = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      "[data-size]",
    )) {
      b.classList.toggle("active", b === button);
    }
    saveOptions();
    reflow();
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-layout]",
)) {
  button.addEventListener("click", () => {
    const next = button.dataset.layout as Layout;
    if (next === layout) return;
    layout = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      "[data-layout]",
    )) {
      b.classList.toggle("active", b === button);
    }
    saveOptions();
    reflow();
  });
}
