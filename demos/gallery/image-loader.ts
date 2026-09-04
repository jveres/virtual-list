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
  /** The viewport moved: the queue's order follows it (cheap; call per commit). */
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

  function distanceOf(img: HTMLImageElement): number {
    const r = viewport.getBoundingClientRect();
    const b = img.getBoundingClientRect();
    if (b.bottom < r.top) return r.top - b.bottom;
    if (b.top > r.bottom) return b.top - r.bottom;
    return 0;
  }

  /** Shows an image whose source the loader has, or that another fetch will deliver. */
  function show(img: HTMLImageElement, src: string): void {
    img.src = src;
    if (img.complete && img.naturalWidth > 0) img.classList.add("loaded");
  }

  function add(img: HTMLImageElement, src: string): void {
    if (fetched.has(src)) {
      metrics.reused++;
      img.classList.add("loaded");
      show(img, src);
      publish();
      return;
    }
    const flying = [...inFlight.values()].some((f) => f.src === src);
    if (flying) {
      // The same source is on its way for another image: follow it.
      const set = followers.get(src) ?? new Set<HTMLImageElement>();
      followers.set(src, set);
      set.add(img);
      publish();
      return;
    }
    queue.push({ img, src, distance: distanceOf(img) });
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
    for (const follower of set ?? []) {
      queue.push({
        img: follower,
        src: flight.src,
        distance: distanceOf(follower),
      });
    }
    pump();
  }

  function reprioritize(): void {
    for (const pending of queue) pending.distance = distanceOf(pending.img);
    pump();
  }

  function pump(): void {
    if (queue.length > 0 && inFlight.size < metrics.concurrency) {
      queue.sort((a, b) => a.distance - b.distance);
    }
    while (queue.length > 0 && inFlight.size < metrics.concurrency) {
      const next = queue.shift() as Pending;
      start(next);
    }
    publish();
  }

  function start({ img, src, distance }: Pending): void {
    let settled = false;
    const stall = window.setTimeout(() => finish("failed"), STALL_MS);
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
        if (outcome === "loaded") {
          metrics.reused++;
          follower.classList.add("loaded");
          show(follower, src);
        } else {
          follower.classList.add("failed");
        }
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
