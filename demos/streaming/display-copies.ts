// Safari drops the decoded bitmap of an unmounted row's image and decodes it
// again when the row remounts: seconds for a 12 MP HDR (gain-map) photo, on
// the scroll path. Large data-URL images show a display-sized standard-range
// copy made in a worker instead. The data URL stays the image's identity (see
// `displaySource`), so the viewer still opens the original.

/** Long edge of a display copy: a chat column at 2x, with headroom. */
const MAX_EDGE = 2048;
/** Long edge of a tree thumbnail: a 44x30 cover crop at 3x. */
const THUMBNAIL_EDGE = 160;

// Copies are shared by retained rows within one conversation.
const copies = new Map<string, Promise<string | null>>();
const ready = new Map<string, string>();
const thumbnails = new Map<string, Promise<string | null>>();
const thumbnailsReady = new Map<string, string>();
const pending = new Map<number, (blob: Blob | null) => void>();
const sources = new WeakMap<
  HTMLImageElement,
  { display: string; source: string }
>();
// A decoded copy held from the swap until the row's image has loaded it.
let probes = new WeakMap<HTMLImageElement, HTMLImageElement>();
const decoding = new Set<HTMLImageElement>();
let worker: Worker | null | undefined;
let nextId = 1;
let generation = 0;

function disableWorker(target: Worker): void {
  if (worker !== target) return;
  worker = null;
  target.onmessage = null;
  target.onerror = null;
  target.onmessageerror = null;
  target.terminate();
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

function copyWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (
    typeof Worker !== "function" ||
    typeof OffscreenCanvas !== "function" ||
    typeof createImageBitmap !== "function"
  ) {
    worker = null;
    return worker;
  }
  try {
    const target = new Worker(
      new URL("./display-copy-worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    worker = target;
    target.onerror = (event) => {
      event.preventDefault();
      disableWorker(target);
    };
    target.onmessageerror = () => disableWorker(target);
    target.onmessage = ({
      data,
    }: MessageEvent<{ id: number; blob: Blob | null }>) => {
      pending.get(data.id)?.(data.blob);
      pending.delete(data.id);
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** One worker copy of `url` whose long edge is at most `maxEdge`. */
function requestCopy(
  url: string,
  maxEdge: number,
  cache: Map<string, Promise<string | null>>,
  done: Map<string, string>,
): Promise<string | null> {
  let copy = cache.get(url);
  if (copy) return copy;
  const target = copyWorker();
  if (!target) return Promise.resolve(null);
  const id = nextId++;
  const started = generation;
  copy = new Promise<Blob | null>((resolve) => {
    pending.set(id, resolve);
    try {
      target.postMessage({ id, url, maxEdge });
    } catch {
      disableWorker(target);
    }
  }).then((blob) => {
    if (started !== generation) return null;
    if (blob) {
      try {
        const display = URL.createObjectURL(blob);
        done.set(url, display);
        return display;
      } catch {
        // A copy is optional; retain the original on allocation failure.
      }
    }
    cache.delete(url);
    return null;
  });
  cache.set(url, copy);
  return copy;
}

function displayCopy(url: string): Promise<string | null> {
  return requestCopy(url, MAX_EDGE, copies, ready);
}

/**
 * A small preview of an image for the conversation tree: the finished copy
 * when one exists, else a pending worker copy. Never the original, whose
 * full-size decode is what previews must avoid.
 */
export function thumbnailCopy(url: string): string | Promise<string | null> {
  // Vectors draw cheaply at thumbnail size, and a worker cannot decode them.
  if (url.startsWith("data:image/svg+xml")) return url;
  return (
    thumbnailsReady.get(url) ??
    requestCopy(url, THUMBNAIL_EDGE, thumbnails, thumbnailsReady)
  );
}

/** Release a replaced conversation after disposing its rows, never on paging. */
export function resetDisplayCopies(): void {
  generation++;
  if (worker) disableWorker(worker);
  worker = undefined;
  copies.clear();
  for (const display of ready.values()) URL.revokeObjectURL(display);
  ready.clear();
  thumbnails.clear();
  for (const thumbnail of thumbnailsReady.values())
    URL.revokeObjectURL(thumbnail);
  thumbnailsReady.clear();
  for (const probe of decoding) probe.removeAttribute("src");
  decoding.clear();
  probes = new WeakMap();
}

/** Swap a loaded, oversized data-URL image to its display copy once ready. */
export function useDisplayCopy(image: HTMLImageElement, url: string): void {
  if (
    // Firefox downsamples originals to their displayed size. Pre-decoding a
    // copy makes it retain an additional full-size surface for the same photo.
    !CSS.supports("-webkit-nbsp-mode", "space") ||
    sources.has(image) ||
    !url.startsWith("data:image/") ||
    Math.max(image.naturalWidth, image.naturalHeight) <= MAX_EDGE
  )
    return;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const started = generation;
  void displayCopy(url).then(async (display) => {
    // The renderer may have replaced the source meanwhile.
    if (
      started !== generation ||
      !display ||
      sources.has(image) ||
      image.currentSrc !== url
    )
      return;
    // The swap lands on a visible row. Chrome and WebKit decode a large
    // image asynchronously, so a swap to an undecoded copy can paint one
    // empty frame. Decode the copy first, and keep that decode alive until
    // the row's own image has loaded from the shared resource.
    const probe = new Image();
    probe.src = display;
    decoding.add(probe);
    try {
      await probe.decode();
    } catch {
      return;
    } finally {
      decoding.delete(probe);
    }
    if (
      started !== generation ||
      sources.has(image) ||
      image.currentSrc !== url
    )
      return;
    // The attributes keep the box at the original size and aspect ratio.
    if (!image.hasAttribute("width") || !image.hasAttribute("height")) {
      image.width = width;
      image.height = height;
    }
    sources.set(image, { display, source: url });
    probes.set(image, probe);
    image.addEventListener("load", () => probes.delete(image), {
      once: true,
    });
    image.src = display;
  });
}

/**
 * Point a freshly built row's images at their finished copies before the row
 * is inserted. A swap after insertion is too late: the image keeps painting
 * (and decoding) the original until the copy loads. Rows rebuilt after a
 * resize would otherwise decode every full-size photo again.
 */
export function adoptDisplayCopies<E extends ParentNode>(root: E): E {
  if (ready.size === 0) return root;
  for (const image of root.querySelectorAll("img")) {
    const url = image.getAttribute("src");
    const display = url ? ready.get(url) : undefined;
    if (!url || !display) continue;
    sources.set(image, { display, source: url });
    image.src = display;
  }
  return root;
}

/** The finished copy of a data URL, if any: already decoded where shown. */
export function readyDisplayCopy(url: string): string | undefined {
  return ready.get(url);
}

/** The data URL behind a displayed copy, or `displayed` itself. */
export function displaySource(
  image: HTMLImageElement,
  displayed: string,
): string {
  const source = sources.get(image);
  return source?.display === displayed ? source.source : displayed;
}
