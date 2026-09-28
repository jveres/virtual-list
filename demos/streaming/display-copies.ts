// Safari drops the decoded bitmap of an unmounted row's image and decodes it
// again when the row remounts: seconds for a 12 MP HDR (gain-map) photo, on
// the scroll path. Large data-URL images show a display-sized standard-range
// copy made in a worker instead. The data URL stays the image's identity (see
// `displaySource`), so the viewer still opens the original.

/** Long edge of a display copy: a chat column at 2x, with headroom. */
const MAX_EDGE = 2048;

// Copies are small and live as long as the page; transcripts reuse them.
const copies = new Map<string, Promise<string | null>>();
const ready = new Map<string, string>();
const pending = new Map<number, (blob: Blob | null) => void>();
const sources = new WeakMap<
  HTMLImageElement,
  { display: string; source: string }
>();
// A decoded copy held from the swap until the row's image has loaded it.
const probes = new WeakMap<HTMLImageElement, HTMLImageElement>();
let worker: Worker | null | undefined;
let nextId = 1;

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
    worker = new Worker(new URL("./display-copy-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({
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

function displayCopy(url: string): Promise<string | null> {
  let copy = copies.get(url);
  if (copy) return copy;
  const target = copyWorker();
  if (!target) return Promise.resolve(null);
  const id = nextId++;
  copy = new Promise<Blob | null>((resolve) => {
    pending.set(id, resolve);
    target.postMessage({ id, url, maxEdge: MAX_EDGE });
  }).then((blob) => {
    if (!blob) return null;
    const display = URL.createObjectURL(blob);
    ready.set(url, display);
    return display;
  });
  copies.set(url, copy);
  return copy;
}

/** Swap a loaded, oversized data-URL image to its display copy once ready. */
export function useDisplayCopy(image: HTMLImageElement, url: string): void {
  if (
    sources.has(image) ||
    !url.startsWith("data:image/") ||
    Math.max(image.naturalWidth, image.naturalHeight) <= MAX_EDGE
  )
    return;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  void displayCopy(url).then(async (display) => {
    // The renderer may have replaced the source meanwhile.
    if (!display || sources.has(image) || image.currentSrc !== url) return;
    // The swap lands on a visible row. Chrome and WebKit decode a large
    // image asynchronously, so a swap to an undecoded copy can paint one
    // empty frame. Decode the copy first, and keep that decode alive until
    // the row's own image has loaded from the shared resource.
    const probe = new Image();
    probe.src = display;
    try {
      await probe.decode();
    } catch {
      return;
    }
    if (sources.has(image) || image.currentSrc !== url) return;
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
