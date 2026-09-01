import { type Glide, glideDuration, startGlide } from "../../src/glide.js";
import {
  createScrollSettleController,
  detectScrollSettleStrategy,
  type ScrollSettleController,
  type VirtualListScrollSettleStrategy,
} from "../../src/scroll-settle.js";

// The scroll-settle lab: makes the settle controller testable in every real
// browser, with no virtualizer in the way. A plain (non-virtualized) DOM list
// scrolls natively while the panel shows the controller's classification
// live; scrollback chunks are fetched while scrolling but STRUCTURALLY
// COMMITTED only at the settle signal — prepend + one anchor-preserving
// scrollTop write in the same frame. This is the v2 core contract in
// miniature: if this page scrolls clean on an engine (no ghost end, no
// flash, no premature settle), the settle signal is trustworthy there.
//
// Verification per browser:
// - scroll up fast into the top: the pill shows loading/waiting, the chunk
//   appears only after the gesture truly ends, and the list neither jumps
//   nor bounces against a ghost end afterwards;
// - "post-settle motion" stays at 0: scroll events arriving after a settle
//   with no new input mean the strategy declared idle too early. ADVISORY
//   on desktop wheel engines — momentum wheel events are indistinguishable
//   from fresh input, so treat spikes as a prompt to read the trace, not
//   as proof. The lab's own commit write is excluded (expected targets);
// - "settle lag" shows how long after the last scroll event the strategy
//   takes to settle;
// - the strategy dropdown forces another engine's heuristics to compare.
// "copy trace" exports the full event/decision sequence for review.
//
// FIREFOX EDGE SEMANTICS (v2 deviation, see src/scroll-settle.ts): a
// pending edge release is CONTESTED when wheel input follows its
// scrollend (it was a pause, not the release). Uncontested releases
// settle after a short 450ms confirmation window (~0.3s after the
// scrollend; main took ~1.5s). Contested ones need the full 1600ms of
// wheel silence — active motion keeps pushing it, a decaying momentum
// tail at a pinned edge still recovers (no hang), and only ≥1.6s of
// TOTAL stillness (observably identical to a release) can commit under
// resting fingers. Lab focus for FF: (a) active hold or motion → never
// settles; (b) clean flick release → chunk lands quickly; (c) fast
// re-grab right after an edge commit → watch for a ghost-edge bounce
// (the 450ms race buffer must rise if seen).
// A settle during actual MOTION is always a real finding — copy the trace.

// Small enough that either edge is one or two flicks away — the lab is
// about edge behavior, not endurance scrolling.
const INITIAL_ROWS = 24;
const CHUNK_ROWS = 12;
const MAX_CHUNKS = 60;
const LOAD_LATENCY_MS = 180;
const REACH_EDGE_PX = 400;
const PREMATURE_WINDOW_MS = 400;
const LOG_RING_MAX = 4000;
const LOG_DOM_MAX = 350;

function mustGet<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

const viewport = mustGet("viewport");
const rows = mustGet("rows");
const pill = mustGet("pill");
const pillLabel = mustGet("pill-label");
const logElement = mustGet<HTMLPreElement>("log");
const strategySelect = mustGet<HTMLSelectElement>("strategy");

const stat = {
  strategy: mustGet("s-strategy"),
  activeDot: mustGet("s-active"),
  activeText: mustGet("s-active-t"),
  top: mustGet("s-top"),
  gestures: mustGet("s-gestures"),
  settles: mustGet("s-settles"),
  lag: mustGet("s-lag"),
  chunks: mustGet("s-chunks"),
  queuedDot: mustGet("s-queued"),
  queuedText: mustGet("s-queued-t"),
  premature: mustGet("s-premature"),
};

mustGet("ua").textContent = navigator.userAgent;

// --- Deterministic row content ----------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRow(index: number): HTMLElement {
  const random = mulberry32(index * 2654435761);
  const row = document.createElement("div");
  row.className = "row";
  const height = Math.round(48 + random() * 212);
  row.style.height = `${height}px`;
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = `#${index}`;
  row.appendChild(idx);
  // Fill the row with skeleton text lines so varied heights read as
  // varied content, not empty boxes.
  const lines = Math.max(1, Math.floor((height - 46) / 21));
  for (let line = 0; line < lines; line++) {
    const element = document.createElement("span");
    element.className = "line";
    const last = line === lines - 1;
    element.style.width = `${Math.round((last ? 25 : 68) + random() * 30)}%`;
    row.appendChild(element);
  }
  return row;
}

// --- Event/decision trace ---------------------------------------------------

const traceRing: string[] = [];
const startedAt = performance.now();

function log(message: string, cls?: "mark" | "good" | "warn"): void {
  const line = `+${(performance.now() - startedAt).toFixed(0)}ms ${message}`;
  traceRing.push(line);
  if (traceRing.length > LOG_RING_MAX) traceRing.shift();

  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = `${line}\n`;
  logElement.appendChild(span);
  while (logElement.childNodes.length > LOG_DOM_MAX) {
    logElement.firstChild?.remove();
  }
  logElement.scrollTop = logElement.scrollHeight;
}

// --- Demo state -------------------------------------------------------------

type Boundary = "top" | "bottom";

let controller: ScrollSettleController;
let firstIndex = 0;
let nextBottomIndex = INITIAL_ROWS;
const chunksRemaining: Record<Boundary, number> = {
  top: MAX_CHUNKS,
  bottom: MAX_CHUNKS,
};
let chunksApplied = 0;
let loading: Boundary | null = null;
let queuedChunk: {
  fragment: DocumentFragment;
  count: number;
  boundary: Boundary;
} | null = null;
// scrollTop targets the LAB itself is about to write (the commit's
// anchor-preserving write); their scroll events must not feed the
// premature-settle heuristic.
const labExpectedTops: number[] = [];
let gestures = 0;
let settles = 0;
let prematureCount = 0;
let lastScrollEventAt = 0;
let lastInputAt = 0;
let lastSettleAt = Number.NEGATIVE_INFINITY;
let prematureFlagged = false;
let statusFrame = 0;
let pillTimer = 0;
let pillSticky = false;
let glide: Glide | null = null;
let glideTargetFn: (() => number) | null = null;

function showPill(text: string, boundary: Boundary, sticky = false): void {
  window.clearTimeout(pillTimer);
  pillSticky = sticky;
  pill.classList.toggle("bottom", boundary === "bottom");
  pillLabel.textContent = text;
  pill.classList.add("visible");
  if (sticky) {
    pillTimer = window.setTimeout(() => {
      pillSticky = false;
      pill.classList.remove("visible");
    }, 1400);
  }
}

/** Hides the pill; a sticky pill ("at the top/bottom") survives unless forced. */
function hidePill(force = false): void {
  if (pillSticky && !force) return;
  window.clearTimeout(pillTimer);
  pillSticky = false;
  pill.classList.remove("visible");
}

function scheduleStatus(): void {
  if (statusFrame) return;
  statusFrame = requestAnimationFrame(() => {
    statusFrame = 0;
    const active = controller.isUserScrollActive();
    stat.activeDot.className = `dot${active ? " on" : ""}`;
    stat.activeText.textContent = active ? "active" : "idle";
    stat.top.textContent = `${Math.round(viewport.scrollTop)} / ${Math.max(
      0,
      viewport.scrollHeight - viewport.clientHeight,
    )}`;
    stat.gestures.textContent = String(gestures);
    stat.settles.textContent = String(settles);
    stat.chunks.textContent = `${chunksApplied} (T:${chunksRemaining.top} B:${chunksRemaining.bottom} left)`;
    stat.queuedDot.className = `dot${queuedChunk ? " pending" : ""}`;
    stat.queuedText.textContent = queuedChunk
      ? "waiting for settle"
      : loading !== null
        ? "loading"
        : "no";
    stat.premature.textContent = String(prematureCount);
  });
}

// --- The settle-time structural commit (the v2 contract in miniature) -------

function applyQueuedChunk(reason: string): void {
  const pending = queuedChunk;
  if (!pending) return;
  queuedChunk = null;
  const beforeTop = viewport.scrollTop;
  const beforeHeight = viewport.scrollHeight;
  if (pending.boundary === "top") {
    rows.insertBefore(pending.fragment, rows.firstChild);
    const delta = viewport.scrollHeight - beforeHeight;
    const target = beforeTop + delta;
    // One anchor-preserving write, pre-announced so neither the controller
    // nor the lab's own premature-settle heuristic mistakes it for a user
    // scroll.
    controller.recordProgrammaticScrollTop(target);
    labExpectedTops.push(target);
    if (labExpectedTops.length > 4) labExpectedTops.shift();
    viewport.scrollTop = target;
    log(
      `COMMIT top ${reason}: +${pending.count} rows +${delta}px, top ${Math.round(
        beforeTop,
      )} → ${Math.round(target)}`,
      "good",
    );
  } else {
    // Content below the anchor: the position is preserved with no write.
    rows.appendChild(pending.fragment);
    log(
      `COMMIT bottom ${reason}: +${pending.count} rows +${
        viewport.scrollHeight - beforeHeight
      }px, no write`,
      "good",
    );
  }
  chunksApplied += 1;
  if (chunksRemaining[pending.boundary] > 0) {
    hidePill(true);
  } else {
    showPill(
      pending.boundary === "top" ? "at the top" : "at the bottom",
      pending.boundary,
      true,
    );
  }
  scheduleStatus();
}

function buildChunk(boundary: Boundary): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (boundary === "top") {
    for (let offset = CHUNK_ROWS; offset >= 1; offset--) {
      const element = buildRow(firstIndex - offset);
      element.classList.add("fresh");
      fragment.appendChild(element);
    }
    firstIndex -= CHUNK_ROWS;
  } else {
    for (let offset = 0; offset < CHUNK_ROWS; offset++) {
      const element = buildRow(nextBottomIndex + offset);
      element.classList.add("fresh");
      fragment.appendChild(element);
    }
    nextBottomIndex += CHUNK_ROWS;
  }
  return fragment;
}

function startLoad(reason: string, boundary: Boundary): void {
  if (
    loading !== null ||
    queuedChunk !== null ||
    chunksRemaining[boundary] <= 0
  ) {
    return;
  }
  loading = boundary;
  showPill(boundary === "top" ? "loading older…" : "loading newer…", boundary);
  log(`load start (${reason}, ${boundary})`);
  window.setTimeout(() => {
    loading = null;
    chunksRemaining[boundary] -= 1;
    queuedChunk = {
      fragment: buildChunk(boundary),
      count: CHUNK_ROWS,
      boundary,
    };
    log(`load ready (${CHUNK_ROWS} rows, ${boundary})`);
    if (controller.isUserScrollActive()) {
      // The scroll surface is structurally immutable while the user
      // scrolls: hold the chunk for the settle signal.
      showPill("waiting for settle…", boundary);
      log("HELD: gesture active, committing at settle", "mark");
      scheduleStatus();
    } else {
      applyQueuedChunk("idle");
    }
  }, LOAD_LATENCY_MS);
}

// --- Controller wiring ------------------------------------------------------

function currentStrategy(): VirtualListScrollSettleStrategy {
  const chosen = strategySelect.value;
  return chosen === "auto"
    ? detectScrollSettleStrategy()
    : (chosen as VirtualListScrollSettleStrategy);
}

function buildController(): ScrollSettleController {
  const strategy = currentStrategy();
  stat.strategy.textContent = strategy;
  log(`controller: ${strategy}`, "mark");
  return createScrollSettleController({
    viewport,
    strategy,
    measureEpsilon: 0.5,
    isDisposed: () => false,
    // BOTH edges are loadable: the engine strategies arm their edge
    // protection (Firefox stability windows etc.) only for loadable
    // boundaries — an undeclared edge settles on the generic cooldown and
    // mid-hold structural commits become possible there (the "held works
    // on top but not bottom in FF" lab finding).
    canLoadAtBoundary: (boundary) =>
      chunksRemaining[boundary] > 0 ||
      loading === boundary ||
      queuedChunk?.boundary === boundary,
    // A genuine user scroll interrupts the button glide.
    cancelActiveSmoothScroll: () => glide?.cancel(),
    // Scrollends emitted mid-glide are not the user's release.
    smoothScrollReachedTarget: () => {
      if (glide === null || glideTargetFn === null) return true;
      return Math.abs(viewport.scrollTop - glideTargetFn()) <= 2;
    },
    onGestureActivity: () => {},
    onGestureStarted: () => {
      gestures += 1;
      prematureFlagged = false;
      labExpectedTops.length = 0;
      log("GESTURE START", "mark");
      scheduleStatus();
    },
    onGestureSettled: () => {
      settles += 1;
      lastSettleAt = performance.now();
      prematureFlagged = false;
      const lag = lastSettleAt - lastScrollEventAt;
      stat.lag.textContent = `${lag.toFixed(0)}ms`;
      log(`SETTLE (lag ${lag.toFixed(0)}ms after last scroll)`, "mark");
      applyQueuedChunk("settle");
      if (queuedChunk === null && loading === null) hidePill();
      scheduleStatus();
    },
    onGestureReset: () => scheduleStatus(),
    onScrollEventObserved: () => {
      const now = performance.now();
      lastScrollEventAt = now;
      const top = viewport.scrollTop;
      // The lab's own commit write produces a scroll event too — consume
      // its expected target instead of counting it as post-settle motion.
      const expectedIndex = labExpectedTops.findIndex(
        (target) => Math.abs(target - top) <= 1,
      );
      if (expectedIndex >= 0) {
        labExpectedTops.splice(0, expectedIndex + 1);
      } else if (
        // A scroll event after a settle with no fresh input in between
        // means the strategy declared idle while the engine was still
        // moving (advisory on wheel engines — see the header).
        now - lastSettleAt < PREMATURE_WINDOW_MS &&
        lastInputAt < lastSettleAt &&
        !prematureFlagged
      ) {
        prematureFlagged = true;
        prematureCount += 1;
        log("POST-SETTLE MOTION — premature settle?", "warn");
      }
      if (mustGet<HTMLInputElement>("auto-load").checked) {
        const maxTop = viewport.scrollHeight - viewport.clientHeight;
        if (viewport.scrollTop < REACH_EDGE_PX) {
          startLoad("reach-top", "top");
        } else if (maxTop - viewport.scrollTop < REACH_EDGE_PX) {
          startLoad("reach-bottom", "bottom");
        }
      }
      scheduleStatus();
    },
    onNativeScrollEndIdle: () => {},
  });
}

// --- Programmatic glides (the controller's programmatic-gesture path) -------

function glideTo(boundary: Boundary): void {
  glide?.cancel();
  const target = () =>
    boundary === "top"
      ? 0
      : Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  // A glide is a scroll phase too: reach-zone loads queue during it and
  // commit at the settle that follows its landing.
  controller.beginProgrammaticGesture();
  log(`glide ${boundary}`, "mark");
  glideTargetFn = target;
  glide = startGlide(
    {
      read: () => viewport.scrollTop,
      write: (top) => {
        controller.recordProgrammaticScrollTop(top);
        viewport.scrollTop = top;
      },
      target,
    },
    (distancePx) => glideDuration(distancePx, viewport.clientHeight),
    (completed) => {
      glide = null;
      glideTargetFn = null;
      log(
        `glide ${completed ? "landed" : "cancelled"}`,
        completed ? "good" : "warn",
      );
      // A landed glide settles through the controller's normal cooldown;
      // a cancelled one belongs to the user gesture that took over.
      if (completed) controller.markSettlePending();
      scheduleStatus();
    },
  );
}

// --- Raw event trace (what the engine actually emits) -----------------------

function traceEvents(): void {
  const input = (name: string) => () => {
    lastInputAt = performance.now();
    log(name);
  };
  viewport.addEventListener(
    "wheel",
    (event) => {
      lastInputAt = performance.now();
      log(`wheel dy=${Math.round(event.deltaY)}`);
    },
    { passive: true },
  );
  viewport.addEventListener("touchstart", input("touchstart"), {
    passive: true,
  });
  viewport.addEventListener("touchend", input("touchend"), { passive: true });
  viewport.addEventListener("pointerdown", input("pointerdown"), {
    passive: true,
  });
  window.addEventListener("pointerup", input("pointerup"), { passive: true });
  viewport.addEventListener(
    "scroll",
    () => log(`scroll top=${Math.round(viewport.scrollTop)}`),
    { passive: true },
  );
  viewport.addEventListener("scrollend", () => log("scrollend"), {
    passive: true,
  });
}

// --- Boot / controls --------------------------------------------------------

function rebuildList(): void {
  rows.replaceChildren();
  firstIndex = 0;
  nextBottomIndex = INITIAL_ROWS;
  chunksRemaining.top = MAX_CHUNKS;
  chunksRemaining.bottom = MAX_CHUNKS;
  chunksApplied = 0;
  loading = null;
  queuedChunk = null;
  labExpectedTops.length = 0;
  gestures = 0;
  settles = 0;
  prematureCount = 0;
  for (let index = 0; index < INITIAL_ROWS; index++) {
    rows.appendChild(buildRow(index));
  }
  // Start mid-list: both edge zones then require a deliberate scroll — a
  // boot at an edge would auto-load instantly with no user intent.
  const middle = Math.max(
    0,
    (viewport.scrollHeight - viewport.clientHeight) / 2,
  );
  controller?.recordProgrammaticScrollTop(middle);
  viewport.scrollTop = middle;
  hidePill(true);
  scheduleStatus();
}

for (const option of [
  "auto",
  "default",
  "chromium-wheel",
  "firefox-wheel",
  "safari-wheel",
]) {
  const element = document.createElement("option");
  element.value = option;
  element.textContent = option;
  strategySelect.appendChild(element);
}

strategySelect.addEventListener("change", () => {
  glide?.cancel();
  controller.dispose();
  controller = buildController();
});
mustGet("glide-top").addEventListener("click", () => glideTo("top"));
mustGet("glide-bottom").addEventListener("click", () => glideTo("bottom"));
mustGet("queue-now").addEventListener("click", () =>
  startLoad("manual", "top"),
);
mustGet("append-now").addEventListener("click", () =>
  startLoad("manual", "bottom"),
);
mustGet("reset").addEventListener("click", () => {
  glide?.cancel();
  rebuildList();
  log("reset", "mark");
});
mustGet("clear").addEventListener("click", () => {
  logElement.replaceChildren();
  traceRing.length = 0;
});
mustGet("copy").addEventListener("click", () => {
  const trace = `${navigator.userAgent}\nstrategy=${stat.strategy.textContent}\n${traceRing.join("\n")}`;
  void navigator.clipboard?.writeText(trace).then(
    () => log("trace copied", "good"),
    () => log("clipboard unavailable — select the log manually", "warn"),
  );
});

traceEvents();
rebuildList();
controller = buildController();
