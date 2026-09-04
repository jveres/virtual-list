// An image loader for a scroller: a priority queue with a concurrency
// limit, the nearest-to-viewport image first, and cancellation for images
// that left the scroller before they arrived. The browser alone queues
// every image handed a source and never gives one up, so a fling through a
// gallery leaves hundreds of downloads competing with the ones on screen.

export interface LoaderMetrics {
  /** Waiting for a slot. */
  queued: number;
  /** Downloading now. */
  inFlight: number;
  /** The deepest the queue has been: a warm cache drains it before a frame can show it. */
  peakQueued: number;
  /** Arrived since the loader was created. */
  loaded: number;
  /** Errored or stalled. */
  failed: number;
  /** Abandoned in flight because the image left the scroller. */
  cancelled: number;
  /** Served from what the loader had already fetched (a second drawing, a remount). */
  reused: number;
  concurrency: number;
}

export interface ImageLoader {
  /** Queue an image for its source; one already fetched shows at once. */
  add(img: HTMLImageElement, src: string): void;
  /** The image left the scroller: drop it from the queue, or abandon its download. */
  remove(img: HTMLImageElement): void;
  /** The viewport moved: the queue's order follows it (one viewport read, one per queued image). */
  reprioritize(): void;
  setConcurrency(n: number): void;
  metrics(): Readonly<LoaderMetrics>;
}

interface Pending {
  img: HTMLImageElement;
  src: string;
  /** Distance from the viewport, in pixels; 0 inside it. */
  distance: number;
}

const STALL_MS = 15_000;

export function createImageLoader(options: {
  viewport: HTMLElement;
  concurrency: number;
  onMetrics?: (metrics: Readonly<LoaderMetrics>) => void;
}): ImageLoader {
  const { viewport } = options;
  const metrics: LoaderMetrics = {
    queued: 0,
    inFlight: 0,
    peakQueued: 0,
    loaded: 0,
    failed: 0,
    cancelled: 0,
    reused: 0,
    concurrency: options.concurrency,
  };
  const queue: Pending[] = [];
  const inFlight = new Map<
    HTMLImageElement,
    { src: string; done: () => void }
  >();
  /** Sources that have arrived: a later image of the same source shows at once. */
  const fetched = new Set<string>();
  /** Images waiting for a source that is in flight for another image. */
  const followers = new Map<string, Set<HTMLImageElement>>();
  let metricsFrame = 0;

  function publish(): void {
    if (metricsFrame || !options.onMetrics) return;
    metricsFrame = requestAnimationFrame(() => {
      metricsFrame = 0;
      options.onMetrics?.(current());
    });
  }

  function distanceOf(img: HTMLImageElement, r: DOMRect): number {
    const b = img.getBoundingClientRect();
    if (b.bottom < r.top) return r.top - b.bottom;
    if (b.top > r.bottom) return b.top - r.bottom;
    return 0;
  }

  /** Shows an image whose source the loader has fetched. */
  function show(img: HTMLImageElement, src: string): void {
    metrics.reused++;
    img.classList.add("loaded");
    img.src = src;
  }

  function inFlightFor(src: string): boolean {
    for (const flight of inFlight.values()) if (flight.src === src) return true;
    return false;
  }

  /** Queue an image behind a source in flight for another: it shows when that one arrives. */
  function follow(img: HTMLImageElement, src: string): void {
    const set = followers.get(src) ?? new Set<HTMLImageElement>();
    followers.set(src, set);
    set.add(img);
  }

  function enqueue(img: HTMLImageElement, src: string, r: DOMRect): void {
    queue.push({ img, src, distance: distanceOf(img, r) });
    metrics.peakQueued = Math.max(metrics.peakQueued, queue.length);
  }

  function add(img: HTMLImageElement, src: string): void {
    if (fetched.has(src)) {
      show(img, src);
      publish();
      return;
    }
    if (inFlightFor(src)) {
      follow(img, src);
      publish();
      return;
    }
    enqueue(img, src, viewport.getBoundingClientRect());
    pump();
  }

  function remove(img: HTMLImageElement): void {
    const queued = queue.findIndex((p) => p.img === img);
    if (queued >= 0) {
      queue.splice(queued, 1);
      publish();
      return;
    }
    for (const set of followers.values()) set.delete(img);
    const flight = inFlight.get(img);
    if (!flight) return;
    // Abandon the download: an image without a source aborts its fetch.
    inFlight.delete(img);
    flight.done();
    img.removeAttribute("src");
    metrics.cancelled++;
    // Its followers go back to the queue.
    const set = followers.get(flight.src);
    followers.delete(flight.src);
    const r = viewport.getBoundingClientRect();
    for (const follower of set ?? []) enqueue(follower, flight.src, r);
    pump();
  }

  function reprioritize(): void {
    const r = viewport.getBoundingClientRect();
    for (const pending of queue) pending.distance = distanceOf(pending.img, r);
    pump();
  }

  function pump(): void {
    if (queue.length > 0 && inFlight.size < metrics.concurrency) {
      queue.sort((a, b) => a.distance - b.distance);
    }
    while (queue.length > 0 && inFlight.size < metrics.concurrency) {
      start(queue.shift() as Pending);
    }
    publish();
  }

  function start({ img, src, distance }: Pending): void {
    // The source may have arrived, or set off, since the image was queued
    // (a card's second drawing): no second fetch.
    if (fetched.has(src)) {
      show(img, src);
      return;
    }
    if (inFlightFor(src)) {
      follow(img, src);
      return;
    }
    let settled = false;
    // A stalled download is abandoned like one that left the scroller: the
    // slot and the connection both go free.
    const stall = window.setTimeout(() => {
      img.removeAttribute("src");
      finish("failed");
    }, STALL_MS);
    const onLoad = () => finish("loaded");
    const onError = () => finish("failed");
    const done = () => {
      settled = true;
      window.clearTimeout(stall);
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
    };
    function finish(outcome: "loaded" | "failed"): void {
      if (settled) return;
      done();
      inFlight.delete(img);
      if (outcome === "loaded") {
        metrics.loaded++;
        fetched.add(src);
        img.classList.add("loaded");
      } else {
        metrics.failed++;
        img.classList.add("failed");
      }
      const set = followers.get(src);
      followers.delete(src);
      for (const follower of set ?? []) {
        if (outcome === "loaded") show(follower, src);
        else follower.classList.add("failed");
      }
      pump();
    }
    inFlight.set(img, { src, done });
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
    img.setAttribute("fetchpriority", distance === 0 ? "high" : "low");
    img.src = src;
    if (img.complete && img.naturalWidth > 0) finish("loaded");
  }

  return {
    add,
    remove,
    reprioritize,
    setConcurrency: (n) => {
      metrics.concurrency = Math.max(1, Math.floor(n));
      pump();
    },
    metrics: current,
  };

  function current(): Readonly<LoaderMetrics> {
    metrics.queued = queue.length;
    metrics.inFlight = inFlight.size;
    return metrics;
  }
}
