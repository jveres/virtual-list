import {
  createPagedWindow,
  type Page,
  type PagedWindow,
} from "../../src/paging.js";
import {
  createVirtualList,
  type Edge,
  type ReachContext,
  type VirtualList,
} from "../../src/virtual-list.js";
import {
  createPhotoPreview,
  type PhotoPreviewItem,
} from "../shared/photo-preview.js";
import { mustGet } from "../shared/utils.js";
import { createImageLoader, type LoaderMetrics } from "./image-loader.js";
import {
  type Card,
  createGalleryLayouts,
  type GalleryItem,
  type JustifiedRow,
  type Photo,
  sameGalleryItem,
} from "./layout.js";
import { createLayoutHistory } from "./layout-history.js";
import { layoutDensity } from "./layout-manager.js";

// The gallery: two layouts of the same photos on the v2 runtime.
//
// - Rows: a justified row is the item. Photos that do not yet fill a row
//   are held back while pages remain, so a row on screen never changes
//   when the next page arrives.
// - Masonry: each photo is one positioned item. Aspect ratios balance
//   columns independently of width; appending never moves an earlier card.
//   The runtime queries visible cards by lane and mounts each photo once.
// - Every item declares its height (`height`), so the runtime never
//   measures: a row's height follows from its photos' aspect ratios, a
//   card's from its column width. Geometry and content changes during a
//   gesture commit together at the settle.
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
/** The layouts are centred at this width; the scroller spans the page. */
const CONTENT_WIDTH = 1080;
const PAGE = 120;
const RETAIN = PAGE * 4;
const TOTAL = 3_000;
// Keep compact checkpoints for every responsive density, not discarded photos.
const layouts = createGalleryLayouts(
  createLayoutHistory(
    photo,
    layoutDensity(
      CONTENT_WIDTH,
      Math.min(...Object.values(ROW_HEIGHTS), ...Object.values(COLUMN_WIDTHS)),
      2,
    ),
    PAGE,
  ),
);
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
const photoPreview = createPhotoPreview<PhotoPreviewItem>({
  viewport,
  getAdjacentPhoto: (current, direction) => {
    const id = current.id + direction;
    if (id < 0 || id >= TOTAL) return null;
    const { aspect } = photo(id);
    return {
      id,
      aspectRatio: 1 / aspect,
      width: SOURCE_WIDTH,
      height: Math.round(SOURCE_WIDTH / aspect),
    };
  },
  thumbnailUrl: (p) =>
    `https://picsum.photos/seed/vl-${p.id}/${SOURCE_WIDTH}/${Math.round(SOURCE_WIDTH * p.aspectRatio)}`,
  previewUrl: (p, width) =>
    `https://picsum.photos/seed/vl-${p.id}/${width}/${Math.round(width * p.aspectRatio)}`,
});
window.addEventListener("pagehide", () => photoPreview.dispose());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
viewport.scrollTop = 0;
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
let paging: PagedWindow<Photo, number> | null = null;
let items: GalleryItem[] = [];
let photos: readonly Photo[] = [];
let resizeAnchor: { point: Point; scrollTop: number } | null = null;

// --- Images ------------------------------------------------------------------

const imagePlacements = new WeakMap<
  HTMLImageElement,
  { key: string; top: number; bottom: number }
>();
const imageRowTops = new Map<string, number>();
let imagePositionOf: VirtualList<GalleryItem>["positionOf"] | null = null;
let imageViewport: Readonly<{ scrollTop: number; height: number }> = {
  scrollTop: 0,
  height: 0,
};
let lastMetricsText = "";

function imageDistance(img: HTMLImageElement): number {
  const placement = imagePlacements.get(img);
  if (!placement || !imagePositionOf) return Infinity;
  let rowTop = imageRowTops.get(placement.key);
  if (rowTop === undefined) {
    const position = imagePositionOf(placement.key);
    if (!position) return Infinity;
    rowTop = position.top;
    imageRowTops.set(placement.key, rowTop);
  }
  return Math.max(
    0,
    imageViewport.scrollTop - (rowTop + placement.bottom),
    rowTop + placement.top - (imageViewport.scrollTop + imageViewport.height),
  );
}

function placeImage(
  tile: HTMLElement,
  key: string,
  top: number,
  bottom: number,
): HTMLElement {
  imagePlacements.set(tile.firstElementChild as HTMLImageElement, {
    key,
    top,
    bottom,
  });
  return tile;
}

const images = createImageLoader({
  viewport,
  concurrency,
  onMetrics: showMetrics,
  distance: imageDistance,
});
const pendingImages = new Set<HTMLImageElement>();
const retiredImages = new Set<HTMLImageElement>();
let imageFlushQueued = false;

function scheduleImageFlush(): void {
  if (imageFlushQueued) return;
  imageFlushQueued = true;
  queueMicrotask(() => {
    imageFlushQueued = false;
    // Normal commits flush in onState; disposal/failed renders may not publish.
    if (pendingImages.size || retiredImages.size) flushImages();
  });
}

function showMetrics(m: Readonly<LoaderMetrics>): void {
  const text = `queue ${m.queued} (peak ${m.peakQueued}) · loading ${m.inFlight}/${m.concurrency} · loaded ${m.loaded} · reused ${m.reused} · cancelled ${m.cancelled} · failed ${m.failed}`;
  if (text === lastMetricsText) return;
  lastMetricsText = text;
  loaderMetrics.textContent = text;
}

function sourceOf(p: Photo): string {
  return `https://picsum.photos/seed/vl-${p.id}/${SOURCE_WIDTH}/${Math.round(SOURCE_WIDTH / p.aspect)}`;
}

function queueImages(element: HTMLElement): void {
  for (const img of element.querySelectorAll<HTMLImageElement>("img.photo")) {
    pendingImages.add(img);
    retiredImages.delete(img);
  }
  scheduleImageFlush();
}

function dropImages(element: HTMLElement): void {
  for (const img of element.querySelectorAll<HTMLImageElement>("img.photo")) {
    pendingImages.delete(img);
    retiredImages.add(img);
  }
  scheduleImageFlush();
}

function flushImages(): void {
  // Boot publishes before createVirtualList returns its position lookup.
  if (!imagePositionOf) return;
  imageRowTops.clear();
  if (pendingImages.size === 0 && retiredImages.size === 0) {
    images.reprioritize();
    return;
  }
  // onState supplies the viewport already read by the runtime. Priorities
  // use committed positions, never a layout read after DOM mutations.
  const batch = Array.from(pendingImages)
    .filter((img) => img.isConnected)
    .map((img) => ({ img, src: img.dataset.src as string }));
  pendingImages.clear();
  const removed = Array.from(retiredImages);
  retiredImages.clear();
  if (batch.length || removed.length)
    images.update({ add: batch, remove: removed });
  else images.reprioritize();
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
    : renderCard(item, existing);
}

/** The height every item declares: the runtime never measures. */
function heightOf(item: GalleryItem): number {
  return item.kind === "row" ? item.height + GAP : item.height;
}

/** The tiles a row already holds: a re-render keeps them. */
function existingTiles(el: HTMLElement): Map<string, HTMLElement> {
  const held = new Map<string, HTMLElement>();
  for (const tile of el.querySelectorAll<HTMLElement>(".tile")) {
    held.set(tile.dataset.tile as string, tile);
  }
  return held;
}

/** Reuse and size a tile; syncTiles owns DOM changes and image registration. */
function tileAt(
  held: Map<string, HTMLElement>,
  p: Photo,
  width: number,
  height: number,
): HTMLElement {
  const id = String(p.id);
  let tile = held.get(id);
  if (tile) {
    held.delete(id);
  } else {
    tile = tileElement(p, id);
  }
  tile.style.width = `${width}px`;
  tile.style.height = `${height}px`;
  return tile;
}

function syncTiles(
  el: HTMLElement,
  next: readonly HTMLElement[],
  unused: Map<string, HTMLElement>,
): void {
  let cursor = el.firstElementChild;
  for (const tile of next) {
    const added = tile.parentElement !== el;
    if (tile === cursor) cursor = cursor.nextElementSibling;
    else el.insertBefore(tile, cursor);
    if (added && el.isConnected) queueImages(tile);
  }
  for (const tile of unused.values()) {
    photoPreview.unbind(tile);
    if (el.isConnected) dropImages(tile);
    tile.remove();
  }
}

function renderRow(row: JustifiedRow, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  const held = existingTiles(el);
  el.className = "photo-row";
  el.style.height = `${row.height + GAP}px`;
  syncTiles(
    el,
    row.photos.map((p) =>
      placeImage(tileAt(held, p, p.width, row.height), row.key, 0, row.height),
    ),
    held,
  );
  return el;
}

function renderCard(card: Card, existing?: HTMLElement): HTMLElement {
  const tile = existing ?? tileElement(card, String(card.id));
  tile.classList.add("masonry-card");
  tile.style.width = `${card.width}px`;
  tile.style.height = `${card.height}px`;
  tile.style.left = `${card.left}px`;
  return placeImage(tile, card.key, 0, card.height);
}

function tileElement(p: Photo, id: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.tile = id;
  tile.dataset.id = String(p.id);
  const img = document.createElement("img");
  img.className = "photo photo-preview-image";
  img.draggable = false;
  img.alt = `Photo ${p.id}`;
  img.decoding = "async";
  img.dataset.src = sourceOf(p);
  tile.append(img);
  photoPreview.bind(tile, {
    id: p.id,
    aspectRatio: 1 / p.aspect,
    width: SOURCE_WIDTH,
    height: Math.round(SOURCE_WIDTH / p.aspect),
  });
  return tile;
}

// --- Layout ------------------------------------------------------------------

function columns(): number {
  return layoutDensity(width, COLUMN_WIDTHS[size], 2);
}

function build(retained = photos): GalleryItem[] {
  return layouts[layout](
    retained,
    width,
    layout === "rows" ? ROW_HEIGHTS[size] : COLUMN_WIDTHS[size],
    GAP,
    retained.at(-1)?.id === TOTAL - 1,
  );
}

/** Items equal to their previous version keep their object: the runtime re-renders nothing for them. */
function reconcile(
  next: GalleryItem[],
  previous: readonly GalleryItem[],
): GalleryItem[] {
  const byKey = new Map(previous.map((item) => [item.key, item]));
  return next.map((item) => {
    const old = byKey.get(item.key);
    return old && sameGalleryItem(old, item) ? old : item;
  });
}

/**
 * A re-flow: the point under the viewport top — a photo and a fraction of
 * it — is found in the current items; the items are rebuilt; the item that
 * now holds that point is named as the anchor, with the offset that keeps
 * the point where it was. The runtime resolves the rest.
 */
function reflow(interrupt = false): void {
  if (interrupt) {
    // Interruption may first commit a fetched page. Build from the newly
    // committed source and reading point, not a pre-interruption snapshot.
    void list
      .updateWindow(
        () => {
          const point = pointUnderViewportTop();
          const next = reconcile(build(), items);
          return {
            items: next,
            anchor: point ? anchorFor(point, next) : "viewport",
            onCommit: () => {
              items = next;
              resizeAnchor = point
                ? { point, scrollTop: viewport.scrollTop }
                : null;
              syncStatus();
            },
          };
        },
        undefined,
        { interrupt: true },
      )
      .catch(reportLoadError);
    return;
  }
  // Re-grouping rows or columns can put a different photo first at the
  // viewport top. Keep the original point across resizes, including pauses.
  // A changed scroll position or an explicit control action starts afresh.
  const point =
    resizeAnchor?.scrollTop === viewport.scrollTop
      ? resizeAnchor.point
      : pointUnderViewportTop();
  items = reconcile(build(), items);
  list.setItems(items, {
    anchor: point ? anchorFor(point) : "viewport",
  });
  resizeAnchor = point ? { point, scrollTop: viewport.scrollTop } : null;
  syncStatus();
}

interface Point {
  photo: number;
  /** The fraction of the photo's height above the viewport top. */
  fraction: number;
  /** Reading point's screen offset when the viewport top is in a loader/gap. */
  viewportOffset: number;
}

/**
 * The photo under the viewport top and how far into it the top falls. The
 * item under the top comes from the runtime's committed geometry (on the
 * device grid; a sum of declared heights would drift on a fractional
 * ratio); the gallery adds only the photo and the fraction.
 */
function pointUnderViewportTop(): Point | null {
  const scrollTop = viewport.scrollTop;
  if (items[0]?.kind === "card") {
    // Captured on paging/reflow, not on scroll frames. Source order is
    // stable even where different columns overlap vertically.
    let nearest: { card: Card; top: number; distance: number } | null = null;
    for (const item of items) {
      if (item.kind !== "card") continue;
      const position = list.positionOf(item.key);
      if (!position) continue;
      const distance = Math.max(
        position.top - scrollTop,
        scrollTop - position.top - item.height,
        0,
      );
      if (!nearest || distance < nearest.distance)
        nearest = { card: item, top: position.top, distance };
      if (distance === 0) break;
    }
    if (!nearest) return null;
    const { card, top } = nearest;
    const inside = Math.max(0, Math.min(card.height, scrollTop - top));
    return {
      photo: card.id,
      fraction: inside / card.height,
      viewportOffset: top + inside - scrollTop,
    };
  }
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
    if (!position) high = mid - 1;
    else if (scrollTop < position.top) {
      found = { item, offset: scrollTop - position.top };
      high = mid - 1;
    } else if (scrollTop >= position.top + position.height) low = mid + 1;
    else {
      found = { item, offset: scrollTop - position.top };
      break;
    }
  }
  if (!found) return null;
  const { item, offset } = found;
  if (item.kind === "row") {
    const first = item.photos[0];
    const photoOffset = Math.max(0, Math.min(item.height, offset));
    return first
      ? {
          photo: first.id,
          fraction: photoOffset / item.height,
          // Keep the signed distance outside the photo, including the gap
          // below it. Clamping that gap to zero moves every row at append.
          viewportOffset: photoOffset - offset,
        }
      : null;
  }
  return null;
}

/** The new item holding the point, and the offset of its top from the viewport top that keeps the point there. */
function anchorFor(
  point: Point,
  nextItems: readonly GalleryItem[] = items,
): { key: string; offset: number } | "viewport" {
  for (const item of nextItems) {
    if (item.kind === "row") {
      if (item.photos.some((p) => p.id === point.photo)) {
        return {
          key: item.key,
          offset: point.viewportOffset - point.fraction * item.height,
        };
      }
    } else if (item.id === point.photo) {
      return {
        key: item.key,
        offset: point.viewportOffset - point.fraction * item.height,
      };
    }
  }
  return "viewport";
}

function syncStatus(): void {
  const unit = layout === "rows" ? "rows" : `cards · ${columns()} columns`;
  status.textContent = `${loaded.toLocaleString()} of ${TOTAL.toLocaleString()} photos · ${photos.length} retained · ${items.length.toLocaleString()} ${unit}`;
}

function photoPage(start: number): Page<Photo, number> {
  const end = Math.min(TOTAL, start + PAGE);
  return {
    items: Array.from({ length: end - start }, (_, i) => photo(start + i)),
    start:
      start > 0
        ? { available: true, cursor: Math.max(0, start - PAGE) }
        : { available: false },
    end: end < TOTAL ? { available: true, cursor: end } : { available: false },
  };
}

function reportLoadError(error: unknown): void {
  console.error(error);
  status.textContent = "Photo loading failed — scroll away and back to retry.";
}

function loadMore(edge: Edge, context: ReachContext): void {
  // Boot can reach an edge before the paging companion has been constructed.
  queueMicrotask(() => {
    if (!paging) {
      context.complete();
      return;
    }
    void paging
      .load(edge, context)
      .then(() => paging?.reconcile())
      .catch(reportLoadError);
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
const initial = photoPage(0);
photos = initial.items;
items = build();
const list: VirtualList<GalleryItem> = createVirtualList<GalleryItem>(
  viewport,
  {
    items,
    key: (item) => item.key,
    render,
    height: heightOf,
    position: (item) =>
      item.kind === "card" ? { top: item.top, lane: item.lane } : null,
    // A gallery starts at its first photo, not at the end.
    boot: "start",
    overscanPx: 600,
    // A page that lands mid-gesture waits for the settle, whole: no photos
    // appear under a moving finger or an overscroll bounce.
    scrollingUpdates: "freeze",
    edgeSlots: { end: loaderSlot },
    onReachStart: (context) => loadMore("start", context),
    onReachEnd: (context) => loadMore("end", context),
    onMount: queueImages,
    onUnmount: dropImages,
    onDestroy: (element) => {
      if (element.classList.contains("tile")) photoPreview.unbind(element);
      for (const tile of element.querySelectorAll<HTMLElement>(".tile"))
        photoPreview.unbind(tile);
    },
    onState: (_state, viewport) => {
      imageViewport = viewport;
      flushImages();
      void paging?.reconcile()?.catch(reportLoadError);
    },
  },
);
imagePositionOf = list.positionOf;
flushImages();
paging = createPagedWindow({
  list,
  initial,
  maxItems: RETAIN,
  key: (p) => String(p.id),
  load: ({ cursor, signal }) =>
    new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        const page = photoPage(cursor);
        loaded = Math.max(loaded, cursor + page.items.length);
        syncStatus();
        resolve(page);
      }, LOAD_DELAY_MS);
      function cancel(): void {
        window.clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener("abort", cancel, { once: true });
    }),
  project: (next) => reconcile(build(next), items),
  anchor: (rows) => {
    const point = pointUnderViewportTop();
    return point ? anchorFor(point, rows) : "viewport";
  },
  keysOf: (item) => {
    const content = item.kind === "row" ? item.photos : [item];
    // Keep a guard page available before the reading window during reflow.
    return content.flatMap((p) => [
      String(p.id),
      String(Math.max(0, p.id - PAGE)),
    ]);
  },
  edgeSlots: ({ start, end }) => ({
    start: start.available ? loaderSlot : null,
    end: end.available ? loaderSlot : null,
  }),
  onChange: (next, rows) => {
    photos = next;
    items = [...rows];
    resizeAnchor = null;
    syncStatus();
  },
  onEvict: (evicted) => images.forget(evicted.map(sourceOf)),
});
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
    reflow(true);
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
    reflow(true);
  });
}
