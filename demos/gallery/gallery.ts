import { createVirtualList, type VirtualList } from "../../src/virtual-list.js";
import { mustGet } from "../shared/utils.js";
import {
  type Band,
  type GalleryItem,
  type JustifiedRow,
  justify,
  masonry,
  originFor,
  type Photo,
  slice,
} from "./layout.js";

// The gallery: two layouts of the same photos on the v2 runtime.
//
// - Rows: a justified row is the item. Its height follows from its photos'
//   aspect ratios and the width, so its geometry is exact before an image
//   has loaded. Photos that do not yet fill a row are held back while pages
//   remain, so a row on screen never changes when the next page arrives.
// - Masonry: a true column grid, sliced into fixed-height bands; the band
//   is the item. A card crossing a band edge is drawn in both bands, offset
//   and clipped, so the seam is invisible. Appending goes to the shortest
//   columns and never moves an earlier card, so a page load changes nothing
//   on screen; bands are keyed by their start, which appends keep.
// - A re-flow (width, size, or layout change) is anchored through the
//   runtime: the point under the viewport top is a photo and a fraction of
//   it, the row or band that holds that point afterwards inherits the
//   anchor row's key (for masonry the band edges are placed so the point
//   keeps its offset within the band), and the runtime resolves the
//   snapshot as any anchored one. No scroll is written by the lab.
// - Rows and bands keep their object while unchanged, so the runtime
//   re-renders nothing for them; a re-render keeps the tiles its element
//   already holds. A photo that has loaded once shows at once from the
//   browser's cache in any new element, without the fade. Sources are set
//   when a photo nears the viewport (the observer while scrolling, a
//   commit for what it mounted); a failed provider leaves a flat tile.

type Layout = "rows" | "masonry";
type Size = "s" | "m" | "l";
const ROW_HEIGHTS: Record<Size, number> = { s: 150, m: 210, l: 290 };
const COLUMN_WIDTHS: Record<Size, number> = { s: 170, m: 240, l: 330 };
const GAP = 6;
const BAND_HEIGHT = 480;
const PAGE = 120;
const TOTAL = 3_000;
const LOAD_DELAY_MS = 500;
const LOADER_HEIGHT = 56;
const SOURCE_WIDTH = 640;
const STALL_MS = 15_000;
// Portraits, squares, and landscapes in the proportions a camera roll has.
const ASPECTS = [0.67, 0.75, 0.8, 1, 1.33, 1.5, 1.5, 1.78, 2.0];

function photo(id: number): Photo {
  // A cheap hash spreads aspects so neighbours differ.
  const hash = (id * 2654435761) >>> 0;
  return { id, aspect: ASPECTS[hash % ASPECTS.length] as number };
}

const viewport = mustGet("viewport");
const status = mustGet("status");
// TEMPORARY instrumentation (?debug-load): what happens around a load.
const debugLoad = new URLSearchParams(location.search).has("debug-load");
const t0 = performance.now();
function log(tag: string, detail: unknown): void {
  if (debugLoad)
    console.log(
      `[load] +${Math.round(performance.now() - t0)}ms ${tag}`,
      JSON.stringify(detail),
    );
}
const loaderSlot = { key: "more", height: LOADER_HEIGHT, render: renderLoader };

let layout: Layout = "rows";
let size: Size = "m";
let width = 0;
let loaded = 0;
let loading = false;
let bandOrigin = 0;
let list: VirtualList<GalleryItem> | undefined;
let items: GalleryItem[] = [];
/** Keys inherited across re-flows: by the row's first photo, or the band's start. */
const inheritedRowKeys = new Map<number, { key: string; photo: number }>();
const inheritedBandKeys = new Map<number, string>();

// --- Rendering ---------------------------------------------------------------

function renderLoader(): HTMLElement {
  const el = document.createElement("div");
  el.className = "loader";
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
  const before = existing ? existing.querySelectorAll(".tile").length : 0;
  const el =
    item.kind === "row"
      ? renderRow(item, existing)
      : renderBand(item, existing);
  if (debugLoad) {
    const ids = [...el.querySelectorAll<HTMLElement>(".tile")].map(
      (t) => t.dataset.tile,
    );
    log("render", {
      key: item.key,
      existing: !!existing,
      inDocument: existing?.isConnected ?? false,
      tilesBefore: before,
      tiles: ids.length,
      cachedNow: ids.filter((id) => loadedPhotos.has(Number(id?.split(":")[0])))
        .length,
      created: createdThisRender,
    });
    createdThisRender = 0;
  }
  return el;
}
let createdThisRender = 0;

/** The tiles an element already holds, by photo and part: a re-render keeps them. */
function existingTiles(el: HTMLElement): Map<string, HTMLElement> {
  const held = new Map<string, HTMLElement>();
  for (const tile of el.querySelectorAll<HTMLElement>(".tile")) {
    held.set(tile.dataset.tile as string, tile);
  }
  return held;
}

/**
 * A photo's tile at a size: the placeholder box, its image over it. Tiles
 * belong to their element — the runtime renders a held update fresh and
 * off-screen while the old element stays on screen, so nothing may be
 * taken from another element. A photo that has loaded once shows at once
 * from the browser's cache, without the fade.
 */
function tileAt(
  held: Map<string, HTMLElement>,
  p: Photo,
  width: number,
  height: number,
  part = 0,
): HTMLElement {
  const id = `${p.id}:${part}`;
  const kept = held.get(id);
  if (!kept) createdThisRender++;
  const tile = kept ?? tileElement(p, id);
  tile.style.width = `${width}px`;
  tile.style.height = `${height}px`;
  return tile;
}

function renderRow(row: JustifiedRow, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  const held = existingTiles(el);
  el.className = "photo-row";
  el.style.height = `${row.height + GAP}px`;
  el.replaceChildren(
    ...row.photos.map((p) => {
      const tile = tileAt(held, p, p.width, row.height);
      tile.style.left = "";
      tile.style.top = "";
      return tile;
    }),
  );
  return el;
}

function renderBand(band: Band, existing?: HTMLElement): HTMLElement {
  const el = existing ?? document.createElement("div");
  const held = existingTiles(el);
  el.className = "band";
  el.style.height = `${band.height}px`;
  el.replaceChildren(
    ...band.cards.map((card) => {
      const tile = tileAt(held, card, card.width, card.height, card.part);
      tile.style.left = `${card.left}px`;
      tile.style.top = `${card.top - band.start}px`;
      return tile;
    }),
  );
  return el;
}

function tileElement(p: Photo, id: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.tile = id;
  tile.dataset.id = String(p.id);
  tile.append(photoElement(p));
  freshTwins.set(id, tile);
  return tile;
}

/**
 * Tiles created for elements the runtime has prepared but not mounted,
 * by tile id. The runtime renders an update fresh, off-screen, while the
 * old element stays on screen, and destroys the old element just before
 * mounting the new one: at that moment the old tiles move into the new
 * element in place of their twins, so an image keeps loading or stays
 * decoded instead of starting over. A twin the runtime has mounted is no
 * longer fresh and leaves the registry at the next state publish.
 */
const freshTwins = new Map<string, HTMLElement>();

function forgetMountedTwins(): void {
  for (const [id, twin] of freshTwins) {
    if (twin.isConnected) freshTwins.delete(id);
  }
}

function transplantTiles(dead: HTMLElement): void {
  let moved = 0;
  for (const tile of dead.querySelectorAll<HTMLElement>(".tile")) {
    const id = tile.dataset.tile as string;
    const twin = freshTwins.get(id);
    if (!twin || twin === tile || twin.isConnected) continue;
    freshTwins.delete(id);
    tile.style.cssText = twin.style.cssText;
    const twinImg = twin.querySelector("img");
    if (twinImg) nearViewport.unobserve(twinImg);
    twin.replaceWith(tile);
    moved++;
  }
  log("transplant", { moved, of: dead.querySelectorAll(".tile").length });
}

/** Photos whose image has loaded once: the browser has them, a new element shows them at once. */
const loadedPhotos = new Set<number>();

function photoElement(p: Photo): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "photo";
  img.alt = `Photo ${p.id}`;
  img.dataset.id = String(p.id);
  const cached = loadedPhotos.has(p.id);
  // A cached photo decodes with the frame that first paints its element:
  // "async" lets the browser paint the frame without it, a gray blink on
  // every re-created tile (Safari does). A photo still to arrive decodes
  // off the main thread.
  img.decoding = cached ? "sync" : "async";
  img.addEventListener(
    "load",
    () => {
      log("img load", { id: p.id, wasCached: loadedPhotos.has(p.id) });
      loadedPhotos.add(p.id);
      // Every drawing of the photo (a card crossing a band edge is two)
      // shows together: one half ahead of the other reads as a cut.
      for (const part of drawingsOf(p.id)) part.classList.add("loaded");
    },
    { once: true },
  );
  img.addEventListener("error", () => img.classList.add("failed"), {
    once: true,
  });
  img.dataset.src = `https://picsum.photos/seed/vl-${p.id}/${SOURCE_WIDTH}/${Math.round(SOURCE_WIDTH / p.aspect)}`;
  if (cached) {
    // No fade: the image paints with the element.
    img.classList.add("loaded");
    reveal(img);
  } else {
    // The source waits until the photo nears the viewport: the runtime
    // premeasures fresh items in a hidden root that the browser's own lazy
    // loading counts as visible.
    nearViewport.observe(img);
  }
  return img;
}

/** The mounted drawings of a photo. */
function drawingsOf(id: number): NodeListOf<HTMLImageElement> {
  return viewport.querySelectorAll<HTMLImageElement>(
    `img.photo[data-id="${id}"]`,
  );
}

/** Gives an image its source, and its photo's other drawings theirs; once each. */
function reveal(img: HTMLImageElement): void {
  if (!img.dataset.src) return;
  const id = Number(img.dataset.id);
  const parts = img.isConnected ? [...drawingsOf(id)] : [img];
  if (!parts.includes(img)) parts.push(img);
  for (const part of parts) revealOne(part);
}

function revealOne(img: HTMLImageElement): void {
  const src = img.dataset.src;
  if (!src) return;
  log("reveal", {
    id: img.dataset.id,
    cached: loadedPhotos.has(Number(img.dataset.id)),
    connected: img.isConnected,
  });
  delete img.dataset.src;
  nearViewport.unobserve(img);
  img.src = src;
  // A provider that never answers leaves a flat tile in the photo's exact
  // box; a late answer still paints over it.
  const stall = window.setTimeout(() => img.classList.add("failed"), STALL_MS);
  img.addEventListener("load", () => window.clearTimeout(stall), {
    once: true,
  });
}

// Photos near the viewport get their source two ways. The observer covers
// scrolling. A commit covers what the runtime just mounted or swapped in:
// an element rendered fresh off-screen for a held update arrives with its
// tiles observed while detached, which Safari does not re-evaluate.
const nearViewport = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) reveal(entry.target as HTMLImageElement);
    }
  },
  { root: viewport, rootMargin: "50% 0px" },
);

function revealMountedNearViewport(): void {
  if (revealFrame) return;
  revealFrame = requestAnimationFrame(() => {
    revealFrame = 0;
    revealNearViewportNow();
  });
}
let revealFrame = 0;

function revealNearViewportNow(): void {
  const r = viewport.getBoundingClientRect();
  const margin = r.height / 2;
  for (const img of viewport.querySelectorAll<HTMLImageElement>(
    "img.photo[data-src]",
  )) {
    const b = img.getBoundingClientRect();
    if (b.bottom >= r.top - margin && b.top <= r.bottom + margin) reveal(img);
  }
}

// --- Layout ------------------------------------------------------------------

function columns(): number {
  return Math.max(2, Math.round(width / COLUMN_WIDTHS[size]));
}

function build(): GalleryItem[] {
  const photos = Array.from({ length: loaded }, (_, i) => photo(i));
  if (layout === "rows") {
    const rows = justify(
      photos,
      width,
      ROW_HEIGHTS[size],
      GAP,
      loaded >= TOTAL,
    );
    // An inherited key holds while its row still starts at the same photo
    // and still holds the photo it was carried for.
    const starts = new Map(rows.map((row) => [row.photos[0]?.id ?? -1, row]));
    for (const [start, carried] of inheritedRowKeys) {
      const row = starts.get(start);
      if (row?.photos.some((p) => p.id === carried.photo))
        row.key = carried.key;
      else inheritedRowKeys.delete(start);
    }
    return rows;
  }
  const { cards, height } = masonry(photos, width, columns(), GAP);
  const bands = slice(cards, height, BAND_HEIGHT, bandOrigin);
  for (const band of bands) {
    const key = inheritedBandKeys.get(band.start);
    if (key !== undefined) band.key = key;
  }
  return bands;
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
  list?.setItems(items, { anchor: "viewport" });
  syncStatus();
}

/**
 * A re-flow: the point under the viewport top — a photo and a fraction of
 * it — is found in the current items, the items are rebuilt, and the row
 * or band that now holds that point inherits the anchor item's key; the
 * runtime keeps that key's offset under the viewport top (I1). For
 * masonry the band edges are placed so the point sits at the same offset
 * within its band, which makes the landing exact.
 */
function reflow(): void {
  const anchor = itemUnderViewportTop();
  if (anchor) {
    const { item, offset } = anchor;
    let photoId: number | undefined;
    let fraction = 0;
    if (item.kind === "row") {
      photoId = item.photos[0]?.id;
      fraction = Math.min(1, offset / item.height);
    } else {
      const y = item.start + offset;
      const card =
        item.cards.find((c) => c.top <= y && y < c.top + c.height) ??
        item.cards[0];
      if (card) {
        photoId = card.id;
        fraction = Math.min(1, Math.max(0, (y - card.top) / card.height));
      }
    }
    if (photoId !== undefined) {
      if (layout === "rows") {
        inheritedBandKeys.clear();
        const target = build().find(
          (row): row is JustifiedRow =>
            row.kind === "row" && row.photos.some((p) => p.id === photoId),
        );
        if (target && target.key !== item.key) {
          inheritedRowKeys.set(target.photos[0]?.id ?? 0, {
            key: item.key,
            photo: photoId,
          });
        }
      } else {
        inheritedRowKeys.clear();
        inheritedBandKeys.clear();
        // Place a band edge `offset` above the point, so the point keeps
        // its offset within the band the anchor key lands on.
        const probe = masonry(
          Array.from({ length: loaded }, (_, i) => photo(i)),
          width,
          columns(),
          GAP,
        ).cards.find((c) => c.id === photoId);
        if (probe) {
          const y = probe.top + fraction * probe.height;
          const start = Math.max(0, Math.round(y - offset));
          bandOrigin = originFor(start, BAND_HEIGHT);
          inheritedBandKeys.set(start, item.key);
        }
      }
    }
  }
  items = reconcile(build(), items);
  list?.setItems(items, { anchor: "viewport" });
  syncStatus();
}

/** The item the viewport top falls in, and the offset into it (items start at 0; the only slot is at the end). */
function itemUnderViewportTop(): { item: GalleryItem; offset: number } | null {
  const scrollTop = viewport.scrollTop;
  let top = 0;
  for (const item of items) {
    const height = item.kind === "row" ? item.height + GAP : item.height;
    if (scrollTop < top + height) return { item, offset: scrollTop - top };
    top += height;
  }
  const last = items[items.length - 1];
  return last ? { item: last, offset: 0 } : null;
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
    if (loaded >= TOTAL) list?.setEdgeSlot("end", null);
    log("append", { loaded });
    appendPage();
  }, LOAD_DELAY_MS);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    loading = false;
  });
}

// --- Boot --------------------------------------------------------------------

width = viewport.clientWidth;
loaded = PAGE;
items = build();
list = createVirtualList<GalleryItem>(viewport, {
  items,
  key: (item) => item.key,
  render,
  overscanPx: 600,
  // A page that lands mid-gesture waits for the settle, whole: no photos
  // appear under a moving finger or an overscroll bounce, and no band is
  // swapped early for keeping its height. ("same-height" is for streaming
  // text; the chat's "live" for a reply that must keep rendering.)
  scrollingUpdates: "freeze",
  edgeSlots: { end: loaderSlot },
  onReachEnd: ({ signal }) => {
    log("reachEnd", {});
    loadMore(signal);
  },
  onState: (state) => {
    log("state", state);
    forgetMountedTwins();
    revealMountedNearViewport();
  },
  onDestroy: (element, item) => {
    log("destroy", {
      key: item.key,
      tiles: element.querySelectorAll(".tile").length,
    });
    transplantTiles(element);
  },
});
// A gallery starts at its first photo, not at the end.
void list.scrollTo("start");
syncStatus();

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
    const next = button.dataset.size as Size;
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
    reflow();
  });
}
