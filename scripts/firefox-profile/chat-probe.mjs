// Serialized into a dedicated diagnostic origin before the real demo starts.
// The rAF sampler reads cached numbers only. Detail mode adds measurable cost.
export function installChatProbe(config) {
  localStorage.setItem(
    "virtual-list:ai-settings",
    JSON.stringify({
      provider: "openai",
      apiKey: "local-profile-only",
      model: "profile-model",
      contextTurns: 8,
    }),
  );
  // Each reload on the diagnostic origin restores exactly the same history.
  // The demo awaits this promise before reading its IndexedDB store.
  const seedHistory =
    typeof indexedDB === "undefined"
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const request = indexedDB.open("virtual-list-demo", 1);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains("openai-history"))
              request.result.createObjectStore("openai-history");
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction("openai-history", "readwrite");
            transaction
              .objectStore("openai-history")
              .put(config.turns, "history");
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            transaction.onabort = () => {
              db.close();
              reject(transaction.error);
            };
            transaction.onerror = () => {
              db.close();
              reject(transaction.error);
            };
          };
        });
  localStorage.setItem(
    "virtual-list:openai-history",
    JSON.stringify(config.turns),
  );
  localStorage.setItem(
    "virtual-list:chat-options",
    JSON.stringify({
      sticky: true,
      landing: "end",
      follow: "end",
      trail: config.trail,
    }),
  );
  let active = false;
  let started = false;
  let frame = 0;
  let frameIndex = 0;
  let startTime = 0;
  let top = 0;
  let phase = "idle";
  let viewport;
  let currentState = null;
  let initial;
  let final;
  let lastInput = null;
  let streamDone = false;
  let characters = 0;
  let chunks = 0;
  let events = 0;
  let scrolls = 0;
  let ends = 0;
  let wheels = 0;
  const mutations = {
    callbacks: 0,
    added: 0,
    removed: 0,
    attributes: 0,
    text: 0,
  };
  const frames = [];
  const inputs = [];
  const states = [];
  const deliveries = [];
  const spans = [];
  const phases = [];
  const entries = [];
  const errors = [];
  const invalidations = [];
  const observers = [];
  const restore = [];
  const capabilities = {};
  const dropped = {};
  const operations = new Map();
  const access = new Map();
  const stack = [];
  const lastText = new WeakMap();
  const identities = new WeakMap();
  let identity = 0;
  const append = (kind, array, value) => {
    if (array.length < config.limit) array.push(value);
    else dropped[kind] = (dropped[kind] ?? 0) + 1;
  };
  const now = () => performance.now() - startTime;
  const entityId = (entity) => {
    if (!entity || typeof entity !== "object") return null;
    if (!identities.has(entity)) identities.set(entity, ++identity);
    return identities.get(entity);
  };
  const boundary = () => ({
    top: viewport.scrollTop,
    height: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    nodes: viewport.querySelectorAll("*").length,
    images: [...viewport.querySelectorAll("img")].map((img) => ({
      complete: img.complete,
      width: img.naturalWidth,
      height: img.naturalHeight,
    })),
    heapBytes: performance.memory?.usedJSHeapSize ?? null,
    window: {
      x: screenX,
      y: screenY,
      outerWidth,
      outerHeight,
      innerWidth,
      innerHeight,
      dpr: devicePixelRatio,
    },
    status: document.querySelector("#window-status")?.textContent ?? null,
  });
  const countAccess = (name) => {
    if (!active) return;
    const owner = stack.at(-1)?.name ?? "unattributed";
    const key = `${owner}|${name}`;
    access.set(key, (access.get(key) ?? 0) + 1);
  };
  function instrumentDOM() {
    for (const [prototype, names] of [
      [
        Element.prototype,
        [
          "scrollTop",
          "scrollHeight",
          "scrollWidth",
          "clientHeight",
          "clientWidth",
        ],
      ],
      [HTMLElement.prototype, ["offsetHeight", "offsetWidth", "offsetTop"]],
    ])
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor?.get || !descriptor.configurable) continue;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          get() {
            countAccess(`read:${name}`);
            return descriptor.get.call(this);
          },
          ...(descriptor.set
            ? {
                set(value) {
                  countAccess(`write:${name}`);
                  descriptor.set.call(this, value);
                },
              }
            : {}),
        });
        restore.push(() => Object.defineProperty(prototype, name, descriptor));
      }
    for (const [prototype, name] of [
      [Element.prototype, "getBoundingClientRect"],
      [Range.prototype, "getBoundingClientRect"],
      [Range.prototype, "getClientRects"],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value !== "function" || !descriptor.configurable)
        continue;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value(...args) {
          countAccess(`call:${name}`);
          return descriptor.value.apply(this, args);
        },
      });
      restore.push(() => Object.defineProperty(prototype, name, descriptor));
    }
  }
  function recordEntries(records) {
    for (const entry of records) {
      if (entry.startTime < startTime || !active) continue;
      const data = {
        type: entry.entryType,
        time: entry.startTime - startTime,
        duration: entry.duration,
      };
      if (entry.entryType === "event")
        Object.assign(data, {
          name: entry.name,
          processingStart: entry.processingStart - startTime,
          processingEnd: entry.processingEnd - startTime,
          interactionId: entry.interactionId,
        });
      if (entry.entryType === "layout-shift")
        Object.assign(data, {
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
        });
      if (entry.entryType === "resource")
        Object.assign(data, {
          path: new URL(entry.name, location.href).pathname,
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        });
      if (entry.entryType === "long-animation-frame")
        Object.assign(data, {
          blockingDuration: entry.blockingDuration,
          renderStart: entry.renderStart ? entry.renderStart - startTime : null,
          styleAndLayoutStart: entry.styleAndLayoutStart
            ? entry.styleAndLayoutStart - startTime
            : null,
          scripts: [...entry.scripts].map((script) => ({
            duration: script.duration,
            invoker: script.invoker,
            sourceURL: script.sourceURL,
            sourceFunctionName: script.sourceFunctionName,
            sourceCharPosition: script.sourceCharPosition,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
          })),
        });
      append("entries", entries, data);
    }
  }
  function observePerformance() {
    for (const type of [
      "longtask",
      "long-animation-frame",
      "event",
      "layout-shift",
      "resource",
    ]) {
      capabilities[type] = {
        supported: PerformanceObserver.supportedEntryTypes.includes(type),
      };
      if (!capabilities[type].supported) continue;
      try {
        const observer = new PerformanceObserver((list) =>
          recordEntries(list.getEntries()),
        );
        observer.observe({
          type,
          ...(type === "event" ? { durationThreshold: 16 } : {}),
        });
        observers.push(observer);
      } catch (error) {
        capabilities[type] = { supported: false, error: String(error) };
      }
    }
  }
  const mutation = new MutationObserver((records) => {
    if (!active) return;
    mutations.callbacks++;
    for (const record of records) {
      mutations.added += record.addedNodes.length;
      mutations.removed += record.removedNodes.length;
      if (record.type === "attributes") mutations.attributes++;
      if (record.type === "characterData") mutations.text++;
    }
  });
  // Bypass our optional access counters for the probe's own scroll sample.
  const scrollGetter = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  ).get;
  const onScroll = (event) => {
    if (!active || event.target !== viewport) return;
    top = scrollGetter.call(viewport);
    scrolls++;
  };
  const onEnd = (event) => {
    if (active && event.target === viewport) ends++;
  };
  const onWheel = (event) => {
    if (!active || !viewport.contains(event.target)) return;
    wheels++;
    lastInput ??= now();
    append("inputs", inputs, [
      now(),
      event.timeStamp - startTime,
      event.deltaY,
      event.deltaMode,
      event.isTrusted,
    ]);
  };
  const invalidate = (event) => {
    if (active)
      append("invalidations", invalidations, { time: now(), type: event.type });
  };
  const onError = (event) =>
    append("errors", errors, {
      time: started ? now() : null,
      message: String(event.message ?? event.reason),
    });
  const sample = (time) => {
    if (!active) return;
    frameIndex++;
    append("frames", frames, [
      time - startTime,
      top,
      phase,
      characters,
      scrolls,
      currentState?.following ?? false,
      currentState?.count ?? null,
      currentState?.totalSize ?? null,
      currentState?.held ?? false,
      // rAF's supplied timestamp can precede event delivery in this frame.
      // Use callback-entry time for input delay, not the animation timeline.
      lastInput === null ? null : now() - lastInput,
      !streamDone,
    ]);
    lastInput = null;
    frame = requestAnimationFrame(sample);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  const api = {
    seedHistory,
    enter(name, entity, text) {
      if (!active || !config.diagnostic) return null;
      const duplicate =
        typeof text === "string" && entity && lastText.get(entity) === text;
      if (typeof text === "string" && entity) lastText.set(entity, text);
      const span = {
        name,
        start: performance.now(),
        children: 0,
        frame: frameIndex,
        phase,
        entity: entityId(entity),
        unchangedText: !!duplicate,
      };
      stack.push(span);
      return span;
    },
    leave(span) {
      if (!span) return;
      const duration = performance.now() - span.start;
      if (stack.pop() !== span) throw new Error("Unbalanced profiling spans");
      if (stack.length) stack.at(-1).children += duration;
      const self = Math.max(0, duration - span.children);
      const key = `${span.phase}|${span.name}`;
      const aggregate = operations.get(key) ?? {
        name: span.name,
        phase: span.phase,
        count: 0,
        inclusiveMs: 0,
        selfMs: 0,
        maxMs: 0,
        unchangedText: 0,
      };
      aggregate.count++;
      aggregate.inclusiveMs += duration;
      aggregate.selfMs += self;
      aggregate.maxMs = Math.max(aggregate.maxMs, duration);
      aggregate.unchangedText += Number(span.unchangedText);
      operations.set(key, aggregate);
      append("spans", spans, [
        span.start - startTime,
        duration,
        self,
        span.name,
        span.frame,
        span.phase,
        span.entity,
        span.unchangedText,
      ]);
    },
    state(state) {
      currentState = {
        count: state.count,
        start: state.start,
        end: state.end,
        following: state.following,
        held: state.held,
        totalSize: state.totalSize,
      };
      if (active) append("states", states, [now(), currentState]);
    },
    delivery(type, length) {
      if (!active) return;
      events++;
      if (type === "response.output_text.delta") {
        chunks++;
        characters += length;
      }
      if (type === "response.completed") streamDone = true;
      append("deliveries", deliveries, [now(), type, length]);
    },
    phase(next) {
      if (!/^[a-z0-9-]{1,40}$/.test(next))
        throw new Error("Invalid profiling phase");
      phase = next;
      if (active) append("phases", phases, { time: now(), name: next });
      performance.mark(`chat-profile:${next}`);
    },
    ready() {
      return (
        !!document.querySelector("#send-btn") &&
        performance.getEntriesByName("chat:visible").length > 0
      );
    },
    start() {
      if (started || !api.ready())
        throw new Error("Chat profiling is not ready or already started");
      started = true;
      viewport = document.querySelector("#viewport");
      initial = boundary();
      top = initial.top;
      startTime = performance.now();
      phase = config.scenario;
      window.addEventListener("scroll", onScroll, {
        capture: true,
        passive: true,
      });
      window.addEventListener("scrollend", onEnd, true);
      window.addEventListener("wheel", onWheel, {
        capture: true,
        passive: true,
      });
      for (const event of ["blur", "resize"])
        window.addEventListener(event, invalidate);
      document.addEventListener("visibilitychange", invalidate);
      observePerformance();
      if (config.diagnostic) {
        instrumentDOM();
        mutation.observe(viewport, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      }
      active = true;
      performance.mark("chat-profile-start");
      frame = requestAnimationFrame(sample);
      const prompt = document.querySelector("#prompt");
      prompt.value = "Produce the deterministic complex profiling reply.";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#send-btn").click();
      return { timeOrigin: performance.timeOrigin, startTime };
    },
    stop() {
      if (!active) throw new Error("Chat profiling is not active");
      for (const observer of observers) {
        recordEntries(observer.takeRecords());
        observer.disconnect();
      }
      const durationMs = now();
      active = false;
      cancelAnimationFrame(frame);
      mutation.disconnect();
      for (const cleanup of restore.reverse()) cleanup();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("scrollend", onEnd, true);
      window.removeEventListener("wheel", onWheel, true);
      for (const event of ["blur", "resize"])
        window.removeEventListener(event, invalidate);
      document.removeEventListener("visibilitychange", invalidate);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
      performance.mark("chat-profile-end");
      final = boundary();
      const result = {
        schema: 1,
        timeOrigin: performance.timeOrigin,
        startTime,
        durationMs,
        mode: config.diagnostic ? "diagnostic" : "timing",
        scenario: config.scenario,
        workload: config.workload,
        userAgent: navigator.userAgent,
        initial,
        final,
        frames,
        inputs,
        states,
        deliveries,
        spans,
        phases,
        entries,
        operations: [...operations.values()],
        access: [...access].map(([key, count]) => ({ key, count })),
        capabilities,
        dropped,
        errors,
        invalidations,
        mutations: config.diagnostic ? mutations : null,
        stream: { done: streamDone, characters, chunks, events },
        scroll: { scrolls, ends, wheels },
        instrumentation: {
          maxRecordsPerKind: config.limit,
          domReadsInFrameSampler: false,
          detailed: config.diagnostic,
        },
      };
      // Stop an unfinished local response only after recording its incomplete state.
      if (document.querySelector("#send-btn")?.classList.contains("stop-btn"))
        document.querySelector("#send-btn").click();
      return result;
    },
  };
  globalThis.__chatProfile = api;
  // Existing native Firefox lifecycle starts/stops this at its trace markers.
  globalThis.__runtimeAudit = {
    start: () => api.start(),
    stop: () => api.stop(),
  };
  // Manual Safari/other-browser captures can keep Inspector closed while
  // recording. Reload between trials; the recorder owns one bounded session.
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey) return;
    if (event.code === "KeyP" && !started && api.ready()) {
      event.preventDefault();
      api.start();
    } else if (event.code === "KeyS" && active) {
      event.preventDefault();
      const recording = api.stop();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(recording)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `chat-profile-${recording.mode}-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
}
