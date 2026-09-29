/** Layout reads belong at checkpoints, never in the scroll/frame recorder. */
export function memoryPageState() {
  const viewport = document.querySelector("#viewport");
  return {
    ...window.__memoryCycle,
    timeOrigin: performance.timeOrigin,
    documentId: window.__memoryDocumentId,
    errors: window.__memoryErrors,
    invalidations: window.__memoryInvalidations,
    visible: document.visibilityState === "visible" && document.hasFocus(),
    streaming: document
      .querySelector("#send-btn")
      .classList.contains("stop-btn"),
    geometry: {
      x: screenX,
      y: screenY,
      outerWidth,
      outerHeight,
      innerWidth,
      innerHeight,
      dpr: devicePixelRatio,
    },
    nodes: document.querySelectorAll("*").length,
    rows: viewport.querySelectorAll("article").length,
    images: viewport.querySelectorAll("img").length,
    top: viewport.scrollTop,
    height: viewport.scrollHeight,
    windowStatus: document.querySelector("#window-status")?.textContent,
    compositing: {
      messageHints: [
        ...new Set(
          [...viewport.querySelectorAll(".message")].map(
            (element) => getComputedStyle(element).willChange,
          ),
        ),
      ],
      canvasTransform: getComputedStyle(
        viewport.querySelector("[data-anchoring]"),
      ).transform,
      canvasTransformStyle: getComputedStyle(
        viewport.querySelector("[data-anchoring]"),
      ).transformStyle,
    },
  };
}

/** Fixed allocation stress, distinct from native gesture/presentation profiling. */
export function startMemoryCycle({
  steps = 80,
  step = 900,
  interval = 40,
  external = false,
  warmupSteps = 0,
} = {}) {
  if (window.__memoryCycle && !window.__memoryCycle.done)
    throw new Error("Previous memory cycle still running");
  const viewport = document.querySelector("#viewport");
  const result = {
    distance: 0,
    events: 0,
    ends: 0,
    done: false,
    min: Infinity,
    max: 0,
    keys: [],
    decodedImageKeys: [],
    wheels: 0,
    streamingObserved: false,
    trailObserved: false,
  };
  window.__memoryCycle = result;
  let last = viewport.scrollTop;
  const keys = new Set();
  const decoded = new Set();
  const recordContent = () => {
    if (document.querySelector("#send-btn").classList.contains("stop-btn"))
      result.streamingObserved = true;
    if (document.querySelector("[data-trail-group] > div"))
      result.trailObserved = true;
    for (const row of viewport.querySelectorAll("article[data-key]")) {
      keys.add(row.dataset.key);
      for (const image of row.querySelectorAll("img"))
        if (
          image.complete &&
          image.naturalWidth > 0 &&
          image.hasAttribute("src")
        )
          decoded.add(row.dataset.key);
    }
  };
  const read = () => {
    const top = viewport.scrollTop;
    result.distance += Math.abs(top - last);
    result.min = Math.min(result.min, top);
    result.max = Math.max(result.max, top);
    last = top;
    result.events++;
    recordContent();
  };
  const end = () => result.ends++;
  const wheel = () => result.wheels++;
  const finish = () => {
    viewport.removeEventListener("scroll", read);
    viewport.removeEventListener("scrollend", end);
    viewport.removeEventListener("wheel", wheel);
    result.keys = [...keys];
    result.decodedImageKeys = [...decoded];
    result.done = true;
    delete window.__finishMemoryCycle;
  };
  viewport.addEventListener("scroll", read);
  viewport.addEventListener("scrollend", end);
  viewport.addEventListener("wheel", wheel, { passive: true });
  if (external) {
    window.__finishMemoryCycle = finish;
    return true;
  }
  void (async () => {
    try {
      // Keep the newly streaming reply mounted long enough to exercise its
      // trail before the full history traversal can recycle that row.
      for (let i = 0; i < warmupSteps; i++) {
        viewport.scrollBy({
          top: i % 2 === 0 ? -120 : 120,
          behavior: "instant",
        });
        await new Promise((resolve) => setTimeout(resolve, interval));
        recordContent();
      }
      for (const direction of [-1, 1]) {
        for (let i = 0; i < steps; i++) {
          viewport.scrollBy({ top: direction * step, behavior: "instant" });
          await new Promise((resolve) => setTimeout(resolve, interval));
          recordContent();
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } catch (error) {
      result.error = String(error);
    } finally {
      finish();
    }
  })();
  return true;
}
