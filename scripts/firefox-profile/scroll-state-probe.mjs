import assert from "node:assert/strict";

/** Diagnostic server overlay; never shipped in the application. */
export function instrumentScrollState(source, id) {
  let replacements;
  if (id.endsWith("/src/virtual-list.ts")) {
    replacements = [
      [
        "  return {\n    setItems,",
        `  globalThis.__scrollStateRead ??= {};
  globalThis.__scrollStateRead.list = () => ({
    state: lastState, idle: idle(), jobs: windowJobs.size,
    glide: glide !== null, pending: pending !== null,
    dirty: dirtyRows.size, stale: staleRows.size,
    rows: rows.size, mounted: mountedRows.size,
  });
  return {\n    setItems,`,
      ],
      [
        "inputEpoch += 1;",
        'globalThis.__scrollStateProbe?.record("input-cancel");\n        inputEpoch += 1;',
      ],
      [
        "  function writeScrollTop(top: number): void {",
        '  function writeScrollTop(top: number): void {\n    globalThis.__scrollStateProbe?.record("scroll-write", top);',
      ],
      [
        "    // A newer command supersedes the last; then it takes the viewport over,",
        `    globalThis.__scrollStateProbe?.record("command", target === "start" || target === "end" ? target : "item");
    // A newer command supersedes the last; then it takes the viewport over,`,
      ],
      [
        "    const complete = (completed: boolean): void =>\n      pass(() => {",
        `    const complete = (completed: boolean): void =>
      pass(() => {
        globalThis.__scrollStateProbe?.record("command-result", completed);`,
      ],
    ];
  } else if (id.endsWith("/src/scroll-settle.ts")) {
    replacements = [
      [
        "  function handleWheel(event: WheelEvent): void {",
        `  function handleWheel(event: WheelEvent): void {
    globalThis.__scrollStateProbe?.record("wheel-input", { delta: event.deltaY, horizontal: event.deltaX, mode: event.deltaMode });`,
      ],
      [
        "  return {\n    isScrollPhaseActive:",
        `  globalThis.__scrollStateRead ??= {};
  globalThis.__scrollStateRead.settle = () => ({
    active: scrollPhaseActive, moved: scrollPhaseMoved,
    pendingEnd: nativeScrollEndPending, wheel: wheelInputActive,
    edge: firefox?.protectedEdge ?? null,
    release: firefox?.hasRelease ?? false,
    initial: awaitingInitialInput, pointers: activePointers.size,
    touch: touchInputActive,
  });
  return {\n    isScrollPhaseActive:`,
      ],
      [
        "function clearPendingNativeScrollEnd(): void {",
        'function clearPendingNativeScrollEnd(): void {\n    globalThis.__scrollStateProbe?.record("release-cleared");',
      ],
      [
        "function finishScrollPhase(): void {",
        'function finishScrollPhase(): void {\n    globalThis.__scrollStateProbe?.record("settled");',
      ],
    ];
  } else if (id.endsWith("/src/native-glide.ts")) {
    replacements = [
      [
        '    viewport.scrollTo({ top: destination, behavior: "smooth" });',
        `    globalThis.__scrollStateProbe?.record("native-request", destination);
    viewport.scrollTo({ top: destination, behavior: "smooth" });`,
      ],
      [
        "    finished = true;",
        '    globalThis.__scrollStateProbe?.record("native-result", { completed, requested });\n    finished = true;',
      ],
    ];
  } else return source;
  assert.ok(!source.includes("__scrollState"), "Already instrumented");
  for (const [needle, replacement] of replacements) {
    assert.equal(
      source.split(needle).length,
      2,
      `State hook changed: ${needle}`,
    );
    source = source.replace(needle, replacement);
  }
  return source;
}

/** Serialized in an isolated page. No RAF sampler or row-layout reads. */
export function installScrollStateProbe() {
  if (globalThis.__scrollStateProbe) throw new Error("Probe already installed");
  const viewport = document.getElementById("viewport");
  const status = document.getElementById("window-status");
  if (!viewport || !status) throw new Error("Streaming demo unavailable");
  const records = [];
  const counts = {};
  const errors = [];
  const invalidations = [];
  const removals = [];
  const started = performance.now();
  // Read button geometry once, before recording. A failed native hit can then
  // be compared with input coordinates without layout reads at the click.
  const buttons = ["scroll-top-btn", "scroll-bottom-btn"].map((id) => {
    const button = document.getElementById(id);
    const bounds = button?.getBoundingClientRect();
    return {
      id,
      hidden: button?.hidden,
      x: bounds?.x,
      y: bounds?.y,
      width: bounds?.width,
      height: bounds?.height,
    };
  });
  let dropped = 0;
  let disposed = false;
  const state = () => ({
    list: globalThis.__scrollStateRead?.list?.() ?? null,
    settle: globalThis.__scrollStateRead?.settle?.() ?? null,
  });
  const record = (type, detail = null) => {
    if (disposed) return;
    counts[type] = (counts[type] ?? 0) + 1;
    if (records.length >= 20000) {
      dropped++;
      return;
    }
    records.push({
      time: performance.now() - started,
      type,
      detail,
      top: viewport.scrollTop,
      ...state(),
    });
  };
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler, { passive: true });
    removals.push(() => target.removeEventListener(type, handler));
  };
  for (const type of ["scroll", "scrollend"])
    listen(viewport, type, () => record(type));
  listen(viewport, "wheel", (event) =>
    record("wheel", { delta: event.deltaY, mode: event.deltaMode }),
  );
  for (const type of [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "touchstart",
    "touchend",
    "click",
  ])
    listen(document, type, (event) =>
      record(type, {
        button: event.target.closest?.(".scroll-jump")?.id ?? null,
        viewport: viewport.contains(event.target),
        x: event.clientX ?? null,
        y: event.clientY ?? null,
      }),
    );
  listen(window, "error", (event) => {
    if (errors.length < 16) errors.push(event.message);
  });
  listen(window, "unhandledrejection", (event) => {
    if (errors.length < 16) errors.push(String(event.reason));
  });
  const invalidate = (reason) => {
    if (invalidations.length < 16) invalidations.push(reason);
  };
  listen(window, "blur", () => invalidate("window lost focus"));
  listen(window, "resize", () => invalidate("window resized"));
  listen(document, "visibilitychange", () => {
    if (document.hidden) invalidate("document hidden");
  });
  listen(document, "keydown", (event) => {
    if (event.code === "KeyM" && event.ctrlKey && event.altKey) record("mark");
  });
  const observer = new MutationObserver(() =>
    record("paging", status.textContent),
  );
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  const snapshot = (includeRecords = false) => ({
    duration: performance.now() - started,
    counts: { ...counts },
    errors: [...errors],
    invalidations: [...invalidations],
    dropped,
    buttons,
    status: status.textContent,
    current: {
      top: viewport.scrollTop,
      max: viewport.scrollHeight - viewport.clientHeight,
      ...state(),
    },
    ...(includeRecords ? { records: [...records] } : {}),
  });
  const probe = {
    record,
    snapshot,
    stop() {
      disposed = true;
      observer.disconnect();
      for (const remove of removals) remove();
      if (globalThis.__scrollStateProbe === probe)
        delete globalThis.__scrollStateProbe;
      return snapshot(true);
    },
  };
  globalThis.__scrollStateProbe = probe;
  record("paging", status.textContent);
  return true;
}

/** Preserve transitions and a short causal tail, not a raw event capture. */
export function summarizeScrollState(capture) {
  const { records, ...summary } = capture;
  const transitions = records.filter(
    (record) =>
      (record.type === "wheel-input" && record.list?.glide) ||
      [
        "paging",
        "pointerdown",
        "pointerup",
        "pointercancel",
        "click",
        "command",
        "command-result",
        "native-request",
        "native-result",
        "scroll-write",
        "mark",
        "settled",
      ].includes(record.type),
  );
  let previous;
  const changes = [];
  for (const record of records) {
    const signature = JSON.stringify([
      record.list?.jobs,
      record.list?.glide,
      record.settle,
    ]);
    if (signature === previous) continue;
    previous = signature;
    changes.push(record);
  }
  return {
    ...summary,
    transitions: transitions.slice(-100),
    omittedTransitions: Math.max(0, transitions.length - 100),
    stateChanges: changes.slice(-60),
    omittedStateChanges: Math.max(0, changes.length - 60),
  };
}
