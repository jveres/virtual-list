// Single choke point for the demos' stock-photo provider. Lorem Picsum has a
// history of hanging outages — requests connect but the origin never responds,
// so no error event ever fires — which used to blank the gallery/newspaper
// demos entirely. Every image therefore gets a local fallback: the flat
// themed .stock-photo-fallback fill (see shared/styles.css), applied when the
// provider errors or stalls. Changing provider is a one-line edit here.

const PROVIDER_STALL_TIMEOUT_MS = 8000;

// One shared, cacheable pixel so a fallback img paints its CSS gradient
// instead of a broken-image glyph; the element's width/height attributes
// keep its box identical to the photo it stands in for.
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function stockPhotoUrl(
  seed: string,
  width: number,
  height: number,
): string {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

function applyFallback(img: HTMLImageElement): void {
  img.src = TRANSPARENT_PIXEL;
  img.classList.add("stock-photo-fallback");
}

/**
 * Point `img` at the stock photo for `seed` (dimensions come from the width/
 * height attributes the caller already set), swapping in the local fallback
 * if the provider errors — or stalls, picsum's signature failure mode, which
 * never fires an error event at all. The stall timer is armed a microtask
 * later: measurement clones are built and discarded within one task and must
 * not leave timers behind, and a timer that does arm holds its (possibly
 * discarded) element for at most the timeout.
 */
export function loadStockPhoto(img: HTMLImageElement, seed: string): void {
  img.src = stockPhotoUrl(seed, img.width, img.height);
  img.addEventListener("error", () => applyFallback(img), { once: true });
  queueMicrotask(() => {
    if (!img.isConnected) return;
    const timer = window.setTimeout(() => {
      if (img.isConnected && !img.complete) applyFallback(img);
    }, PROVIDER_STALL_TIMEOUT_MS);
    const release = () => window.clearTimeout(timer);
    img.addEventListener("load", release, { once: true });
    img.addEventListener("error", release, { once: true });
  });
}
