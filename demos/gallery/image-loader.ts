// An image loader for a scroller: a priority queue with a concurrency
// limit, the nearest-to-viewport image first, and cancellation for images
// that left the scroller before they arrived. The browser alone queues
// every image handed a source and never gives one up, so a fling through a
// gallery leaves hundreds of downloads competing with the ones on screen.

export interface LoaderMetrics {
  /** Unique sources waiting for a slot. */
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
  /** Apply subscription changes together, then measure priorities and start downloads once. */
  update(changes: {
    add?: readonly { img: HTMLImageElement; src: string }[];
    remove?: readonly HTMLImageElement[];
  }): void;
  /** Unsubscribe an image; abandon its request only when no images still need it. */
  remove(img: HTMLImageElement): void;
  /** The viewport moved: the queue's order follows it (one viewport read, one per queued image). */
  reprioritize(): void;
  setConcurrency(n: number): void;
  metrics(): Readonly<LoaderMetrics>;
  /** Release fetched-source hints when the owning data page is evicted. */
  forget(sources: Iterable<string>): void;
}

interface ImageRequest {
  src: string;
  images: Set<HTMLImageElement>;
  /** Distance of the nearest subscriber to the viewport, in pixels. */
  distance: number;
}

const STALL_MS = 15_000;

export function createImageLoader(options: {
  viewport: HTMLElement;
  concurrency: number;
  onMetrics?: (metrics: Readonly<LoaderMetrics>) => void;
  /** Optional geometry-based distance; bypasses all DOM bounds reads. */
  distance?: (img: HTMLImageElement) => number;
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
  const queue: ImageRequest[] = [];
  const requests = new Map<string, ImageRequest>();
  const subscriptions = new WeakMap<HTMLImageElement, ImageRequest>();
  const inFlight = new Map<string, () => void>();
  /** Sources that have arrived: a later image of the same source shows at once. */
  const fetched = new Set<string>();
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
  function show(img: HTMLImageElement, src: string, reused = true): void {
    if (reused) metrics.reused++;
    img.classList.add("loaded");
    img.src = src;
  }

  function updateDistance(request: ImageRequest, r: DOMRect | null): void {
    request.distance = Infinity;
    for (const img of request.images) {
      const distance = options.distance
        ? options.distance(img)
        : r
          ? distanceOf(img, r)
          : Infinity;
      request.distance = Math.min(request.distance, distance);
    }
  }

  function subscribe(img: HTMLImageElement, src: string): void {
    const previous = subscriptions.get(img);
    if (previous?.src === src) return;
    if (previous) unsubscribe(img);
    img.classList.remove("loaded", "failed", "cached");
    if (fetched.has(src)) {
      // Reflow creates new drawings of photos already seen. Do not replay
      // their entrance transition as they move between rows or bands.
      img.classList.add("cached");
      show(img, src);
      publish();
      return;
    }
    img.removeAttribute("src");
    let request = requests.get(src);
    if (!request) {
      request = { src, images: new Set(), distance: Infinity };
      requests.set(src, request);
      queue.push(request);
      metrics.peakQueued = Math.max(metrics.peakQueued, queue.length);
    }
    request.images.add(img);
    subscriptions.set(img, request);
  }

  function update({
    add = [],
    remove = [],
  }: {
    add?: readonly { img: HTMLImageElement; src: string }[];
    remove?: readonly HTMLImageElement[];
  }): void {
    // Subscribe replacements first: moving the last drawing of a source
    // must not cancel and restart its transport between DOM owners.
    for (const { img, src } of add) subscribe(img, src);
    for (const img of remove) unsubscribe(img);
    reprioritize();
  }

  function unsubscribe(img: HTMLImageElement): void {
    const request = subscriptions.get(img);
    if (!request) return;
    subscriptions.delete(img);
    request.images.delete(img);
    if (request.images.size === 0) {
      requests.delete(request.src);
      const cancel = inFlight.get(request.src);
      if (cancel) {
        inFlight.delete(request.src);
        cancel();
        metrics.cancelled++;
      } else {
        const index = queue.indexOf(request);
        if (index >= 0) queue.splice(index, 1);
      }
    }
  }

  function reprioritize(): void {
    if (queue.length) {
      const r = options.distance ? null : viewport.getBoundingClientRect();
      for (const request of queue) updateDistance(request, r);
    }
    pump();
  }

  function pump(): void {
    if (queue.length > 0 && inFlight.size < metrics.concurrency) {
      queue.sort((a, b) => a.distance - b.distance);
    }
    while (queue.length > 0 && inFlight.size < metrics.concurrency) {
      start(queue.shift() as ImageRequest);
    }
    publish();
  }

  function start({ src, images, distance }: ImageRequest): void {
    // The transport belongs to the source, not a tile that can unmount
    // or be reused for another source while this request is in flight.
    const img = new Image();
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
      inFlight.delete(src);
      requests.delete(src);
      if (outcome === "loaded") {
        metrics.loaded++;
        fetched.add(src);
      } else {
        metrics.failed++;
      }
      let reused = false;
      for (const subscriber of images) {
        subscriptions.delete(subscriber);
        if (outcome === "loaded") show(subscriber, src, reused);
        else subscriber.classList.add("failed");
        reused = true;
      }
      images.clear();
      pump();
    }
    inFlight.set(src, () => {
      done();
      img.removeAttribute("src");
    });
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
    img.setAttribute("fetchpriority", distance === 0 ? "high" : "low");
    img.src = src;
    if (img.complete && img.naturalWidth > 0) finish("loaded");
  }

  return {
    add: (img, src) => update({ add: [{ img, src }] }),
    update,
    remove: (img) => update({ remove: [img] }),
    reprioritize,
    setConcurrency: (n) => {
      metrics.concurrency = Math.max(1, Math.floor(n));
      pump();
    },
    metrics: current,
    forget: (sources) => {
      for (const src of sources) fetched.delete(src);
    },
  };

  function current(): Readonly<LoaderMetrics> {
    metrics.queued = queue.length;
    metrics.inFlight = inFlight.size;
    return metrics;
  }
}
