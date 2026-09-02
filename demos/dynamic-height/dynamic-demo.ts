import { detectScrollSettleStrategy } from "../../src/scroll-settle.js";
import {
  createVirtualList,
  type ReachContext,
  type ScrollingUpdates,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { createEdgePill, createTraceLog, mulberry32 } from "../shared/lab.js";
import { mustGet } from "../shared/utils.js";

// The dynamic-height lab: adversarial, size-changing content on the v2
// runtime, with telemetry that observes the runtime STRICTLY FROM OUTSIDE.
// The lab generates content and reports violations; every dynamic-height
// behavior — holding, clipping, premeasuring, committing at settle — lives
// in the runtime (docs/lean-core.md, execution order step 4).
//
// Content (all generated here, all volatile):
// - streaming rows grow word by word (several at once, near and far from
//   the viewport, so some grow while unmounted or held);
// - toggle rows expand/collapse on a timer and on click;
// - image rows carry a real <img> whose src arrives LATE — zero height at
//   premeasure, taller once decoded, mounted or not;
// - code rows wrap differently at every width ("narrow/wide", width jitter);
// - reach-driven chunk loads at both edges (aborted through the reach
//   signal), superseding setItems bursts, deletion of random rows and of the
//   very row under the viewport top.
// Every change reaches the runtime through setItems (a new item object for
// the key): rendered in place while idle or under "live", rendered fresh
// off-scroller during a scroll phase under "same-height"/"freeze", or a
// replacing re-render with the "replace" box. Late images learn their size at load and re-enter
// through setItems the same way — the lab never mutates a mounted row's
// size directly.
//
// Telemetry, purely observational:
// - an instance-level scrollTop accessor on the viewport records every
//   runtime write; the scroll event it produces is attributed to it;
// - a MutationObserver on the canvas classifies every batch: canvas height,
//   slot heights, slot offsets (geometry — a commit) versus slot mount and
//   unmount (window reconciliation — allowed anytime);
// - the lab's OWN evidence of native scrolling: touch down, wheel/key input
//   or unattributed scroll events within the last 120ms.
// Violations reported:
//   G  geometry (slot height/offset, canvas height) changed while native
//      scrolling — or while a glide was still moving;
//   W  scrollTop written by the runtime while native scrolling;
//   O  mounted slots overlap, or a slot does not clip;
//   A  the row under the viewport top moved across a commit (unless the
//      commit legitimately kept the viewport pinned to the end);
//   S  a mounted slot's committed height differs from its content while
//      everything is quiet (stale height: held work never committed, or a
//      width/resource change was not honored);
//   L  a mounted row's content disagreed with its slot at the post-runtime
//      ResizeObserver delivery — a frame that paints clipped or gapped
//      (held or not: frozen elements never change under a live phase);
//   T  a slot height was committed again with no content or width change
//      in between (heights must commit once, latest);
//   D  an element destroyed twice, never rendered by the lab, still in the
//      DOM after destruction, or leaked at dispose;
//   X  the runtime threw where it must not (an uncaught exception, or a
//      setItems/command failure not caused by the lab's own chaos throw).
// A violation counter above 0 is a defect: copy the trace.

const INITIAL_ROWS = 40;
const CHUNK_ROWS = 12;
const MAX_CHUNKS = 40;
const LOAD_LATENCY_MS = 250;
const STREAM_CONCURRENCY = 5;
const TOGGLE_INTERVAL_MS = 900;
const WIDTH_JITTER_MS = 2500;
const INPUT_WINDOW_MS = 120;
/** Mirrors the controller: a bounded set of expected targets, no expiry. */
const EXPECTED_WRITE_MAX = 8;
const QUIET_FRAMES = 3;
const PX_EPSILON = 1;
/**
 * Anchor drift: rectangles keep subpixel precision while Chromium rounds
 * scrollTop to whole pixels, so a correct commit can read up to ~0.5px of
 * movement (0.52px observed); a 1px step is visible and still caught.
 */
const ANCHOR_EPSILON = 0.55;

const WORDS =
  "the quick brown fox jumps over a lazy dog while streaming tokens arrive one after another and the row grows taller than its committed slot until the settle signal lets geometry move again so nothing under a live gesture ever shifts".split(
    " ",
  );

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

const stage = mustGet("stage");
const viewport = mustGet("viewport");
const trace = createTraceLog(mustGet("log", HTMLPreElement));
const log = trace.log;
/** The input ring's clock (the trace log keeps its own, same origin). */
const startedAt = performance.now();
// Tooling hook: automated runs read the full ring, not the trimmed DOM log.
(window as unknown as { labTrace: string[] }).labTrace = trace.ring;
const checkbox = (id: string) => mustGet(id, HTMLInputElement);
const stat = {
  strategy: mustGet("s-strategy"),
  activeDot: mustGet("s-active"),
  activeText: mustGet("s-active-t"),
  heldDot: mustGet("s-held"),
  heldText: mustGet("s-held-t"),
  rows: mustGet("s-rows"),
  commits: mustGet("s-commits"),
  violations: mustGet("s-violations"),
  nodes: mustGet("s-nodes"),
  clipped: mustGet("s-clipped"),
  paints: mustGet("s-paints"),
  streams: mustGet("s-streams"),
  images: mustGet("s-images"),
  loads: mustGet("s-loads"),
};
mustGet("ua").textContent = navigator.userAgent;
stat.strategy.textContent = detectScrollSettleStrategy();

// --- Trace ------------------------------------------------------------------

function verbose(): boolean {
  return checkbox("verbose").checked;
}

let violations = 0;

function violation(code: string, message: string): void {
  violations += 1;
  log(`VIOLATION ${code}: ${message}`, "bad");
  scheduleStatus();
  scheduleReport("violation");
}

// --- Device report channel ------------------------------------------------
// A phone or tablet cannot hand its trace over easily: the lab POSTs the
// tail of its ring to the dev server (a vite middleware appends it under
// browser-artifacts/). Debounced; a violation triggers it, so does the
// "upload trace" button. Silently a no-op without the dev server.

let reportTimer = 0;

function scheduleReport(why: string): void {
  if (reportTimer !== 0) return;
  reportTimer = window.setTimeout(() => {
    reportTimer = 0;
    void sendReport(why);
  }, 1200);
}

async function sendReport(why: string): Promise<void> {
  const body = JSON.stringify({
    why,
    userAgent: navigator.userAgent,
    strategy: stat.strategy.textContent,
    mode: scrollingMode(),
    violations,
    viewport: { width: innerWidth, height: innerHeight },
    trace: trace.ring.slice(-700),
  });
  try {
    const response = await fetch("/__lab/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
    if (!response.ok) throw new Error(String(response.status));
    if (why === "manual") log("trace uploaded", "good");
  } catch {
    if (why === "manual")
      log("upload failed — is the dev server running?", "warn");
  }
}

// --- Content model ----------------------------------------------------------

type Kind = "text" | "stream" | "toggle" | "image" | "code";

interface Item {
  id: number;
  kind: Kind;
  version: number;
  words: string[];
  open: boolean;
  streamTarget: number;
  imageDelayMs: number;
  imageAspect: number;
  imageLoaded: boolean;
  /** Actively receiving tokens (carried by the item so a render shows it). */
  streaming: boolean;
  hue: number;
}

function makeItem(id: number): Item {
  const random = mulberry32(id * 2654435761 + 7);
  const roll = random();
  const kind: Kind =
    roll < 0.3
      ? "text"
      : roll < 0.55
        ? "stream"
        : roll < 0.7
          ? "toggle"
          : roll < 0.85
            ? "image"
            : "code";
  const count =
    kind === "stream"
      ? 3 + Math.floor(random() * 6)
      : 8 + Math.floor(random() * 56);
  const words: string[] = [];
  for (let index = 0; index < count; index++) words.push(pick(WORDS, random));
  return {
    id,
    kind,
    version: 0,
    words,
    open: random() < 0.5,
    streamTarget: kind === "stream" ? 50 + Math.floor(random() * 110) : 0,
    imageDelayMs: kind === "image" ? 400 + Math.floor(random() * 3600) : 0,
    imageAspect: 0.3 + random() * 0.5,
    imageLoaded: false,
    streaming: false,
    hue: Math.floor(random() * 360),
  };
}

function imageSource(item: Item): string {
  const height = Math.round(800 * item.imageAspect);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}"><rect width="800" height="${height}" fill="hsl(${item.hue} 55% 55%)"/><text x="24" y="48" font-family="sans-serif" font-size="30" fill="white">#${item.id} late image · 800×${height}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function codeText(item: Item): string {
  const random = mulberry32(item.id * 97 + 3);
  const lines: string[] = [];
  const count = 3 + Math.floor(random() * 5);
  for (let line = 0; line < count; line++) {
    const width = 40 + Math.floor(random() * 90);
    let text = `${line}: `;
    while (text.length < width) text += `${pick(WORDS, random)}_`;
    lines.push(text);
  }
  return lines.join("\n");
}

function extraText(item: Item): string {
  const random = mulberry32(item.id * 31 + 11);
  const count = 20 + Math.floor(random() * 50);
  const words: string[] = [];
  for (let index = 0; index < count; index++) words.push(pick(WORDS, random));
  return `expanded: ${words.join(" ")}`;
}

// --- Data ---------------------------------------------------------------------

let items: Item[] = [];
const itemById = new Map<number, Item>();
let nextId = 0;
let firstId = 0;

function replaceItem(updated: Item): void {
  itemById.set(updated.id, updated);
  items = items.map((item) => (item.id === updated.id ? updated : item));
}

/** Ids of chunk rows not yet built: their first render gets the highlight. */
const freshIds = new Set<number>();

function makeChunk(edge: "start" | "end"): Item[] {
  const chunk: Item[] = [];
  if (edge === "start") {
    for (let offset = CHUNK_ROWS; offset >= 1; offset--) {
      chunk.push(makeItem(firstId - offset));
    }
    firstId -= CHUNK_ROWS;
  } else {
    for (let offset = 0; offset < CHUNK_ROWS; offset++) {
      chunk.push(makeItem(nextId + offset));
    }
    nextId += CHUNK_ROWS;
  }
  for (const item of chunk) {
    itemById.set(item.id, item);
    freshIds.add(item.id);
  }
  return chunk;
}

// --- Rendering (the host's render callback and its per-element resources) ---

const elementById = new Map<number, HTMLElement>();
/** Elements this lab rendered → how many times the runtime destroyed them. */
const destroyCount = new WeakMap<HTMLElement, number>();
const cleanupByElement = new WeakMap<HTMLElement, () => void>();
let created = 0;
let destroyed = 0;
let imagesPending = 0;
let imagesLoaded = 0;
const detachChecks: HTMLElement[] = [];

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A late image is a resource whose size is unknown until it loads. The host
// never lets the browser grow a mounted row on its own: the <img> box is
// reserved at zero height until the item says "loaded", and the load event
// re-enters through setItems like any other content change (in place when
// idle, a fresh off-scroller render during a phase).
function scheduleImage(row: HTMLElement, img: HTMLImageElement, item: Item) {
  if (item.imageLoaded) {
    img.src = imageSource(item); // Re-render of a loaded item.
    return;
  }
  img.addEventListener("load", () => {
    const current = itemById.get(item.id);
    if (!current || current.imageLoaded) return;
    imagesLoaded += 1;
    changeContent(current, `image #${item.id} loaded`, (updated) => {
      updated.imageLoaded = true;
    });
  });
  const delay = checkbox("images").checked ? item.imageDelayMs : 0;
  imagesPending += 1;
  let settled = false;
  const timer = window.setTimeout(() => {
    settled = true;
    imagesPending -= 1;
    img.src = imageSource(item);
  }, delay);
  cleanupByElement.set(row, () => {
    window.clearTimeout(timer);
    if (!settled) imagesPending -= 1;
  });
}

function build(item: Item): HTMLElement {
  const row = element("div", `row ${item.kind}`);
  row.dataset.id = String(item.id);
  if (freshIds.delete(item.id)) row.classList.add("fresh");
  row.append(element("span", "idx", `#${item.id} · ${item.kind}`));
  row.append(element("p", "body"));
  if (item.kind === "toggle") {
    const button = element("button", "tg", "toggle") as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => flipToggle(item.id, "click"));
    row.append(button, element("div", "extra", extraText(item)));
  }
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.className = "pic";
    img.alt = "";
    scheduleImage(row, img, item);
    row.append(img);
  }
  if (item.kind === "code") row.append(element("pre", "code", codeText(item)));
  update(item, row);
  destroyCount.set(row, 0);
  created += 1;
  return row;
}

function update(item: Item, row: HTMLElement): void {
  const body = row.querySelector(".body");
  if (body) body.textContent = item.words.join(" ");
  const extra = row.querySelector<HTMLElement>(".extra");
  if (extra) extra.hidden = !item.open;
  row.classList.toggle(
    "done",
    item.kind === "stream" && item.words.length >= item.streamTarget,
  );
  row.classList.toggle("live", item.streaming);
  const pic = row.querySelector<HTMLImageElement>(".pic");
  if (pic) {
    // Known size once loaded: the box is CSS-sized, independent of decode.
    row.classList.toggle("loaded", item.imageLoaded);
    pic.style.aspectRatio = `800 / ${Math.round(800 * item.imageAspect)}`;
  }
  row.dataset.version = String(item.version);
}

function render(item: Item, existing?: HTMLElement): HTMLElement {
  if (throwNextRender) {
    // Chaos: the host's render fails once. The runtime must roll back
    // atomically; the lab's later checks confirm nothing was left behind.
    throwNextRender = false;
    throw new Error(CHAOS_RENDER_ERROR);
  }
  if (existing && !checkbox("replace").checked) {
    update(item, existing);
    return existing;
  }
  const row = build(item);
  elementById.set(item.id, row);
  return row;
}

function onDestroy(row: HTMLElement, item: Item): void {
  const count = destroyCount.get(row);
  if (count === undefined) {
    violation("D", `destroyed an element the lab never rendered (#${item.id})`);
  } else if (count >= 1) {
    violation("D", `element #${item.id} destroyed ${count + 1} times`);
  }
  destroyCount.set(row, (count ?? 0) + 1);
  destroyed += 1;
  cleanupByElement.get(row)?.();
  cleanupByElement.delete(row);
  if (elementById.get(item.id) === row) elementById.delete(item.id);
  detachChecks.push(row);
}

// --- Native-scroll evidence and runtime write attribution ------------------

let touchDown = false;
let lastWheelAt = Number.NEGATIVE_INFINITY;
let lastKeyAt = Number.NEGATIVE_INFINITY;
let lastNativeScrollAt = Number.NEGATIVE_INFINITY;
let frameHadNativeScroll = false;
const expectedWrites: number[] = [];
let lastScrollEventTop = Number.NaN;
/** Advances on every runtime scrollTop write. */
let writeSerial = 0;
const runtimeWriteTimes: number[] = [];
let commandIssuing = false;
let smoothPending = 0;
/** A command was just issued; its takeover commit may follow in this task. */
let takeoverPending = false;
/** The last few raw input/scroll events — dumped with every G/W violation. */
const recentInput: string[] = [];

function noteInput(text: string): void {
  recentInput.push(`+${(performance.now() - startedAt).toFixed(0)}ms ${text}`);
  if (recentInput.length > 16) recentInput.shift();
  if (verbose()) log(text);
}

function evidence(now: number): string {
  const age = (at: number) =>
    Number.isFinite(at) ? `${(now - at).toFixed(0)}ms ago` : "never";
  return `touchDown=${touchDown} wheel ${age(lastWheelAt)} key ${age(lastKeyAt)} native scroll ${age(lastNativeScrollAt)} held=${stateHeld}; recent: ${recentInput.join(" | ")}`;
}

function nativeActive(now = performance.now()): boolean {
  return (
    touchDown ||
    now - lastWheelAt < INPUT_WINDOW_MS ||
    now - lastKeyAt < INPUT_WINDOW_MS ||
    now - lastNativeScrollAt < INPUT_WINDOW_MS
  );
}

/** A glide still moving: the write before the most recent one was fresh. */
function glideMoving(now = performance.now()): boolean {
  if (smoothPending === 0) return false;
  const previous = runtimeWriteTimes[runtimeWriteTimes.length - 2];
  return previous !== undefined && now - previous < INPUT_WINDOW_MS;
}

function installWriteHook(): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  if (!descriptor?.get || !descriptor.set) {
    log("scrollTop accessor not found — write telemetry disabled", "warn");
    return;
  }
  const { get, set } = descriptor;
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get() {
      return get.call(this) as number;
    },
    set(value: number) {
      const now = performance.now();
      set.call(this, value);
      const actual = get.call(this) as number;
      expectedWrites.push(actual);
      if (expectedWrites.length > EXPECTED_WRITE_MAX) expectedWrites.shift();
      writeSerial += 1;
      // A command moved the viewport: the anchor baseline is stale until
      // re-captured. A commit's own write is followed by its geometry batch
      // in the same microtask checkpoint (queued earlier), which consumes
      // the pre-commit baseline first and then refreshes it.
      anchorRefreshPending = true;
      queueMicrotask(() => {
        if (!anchorRefreshPending) return;
        anchorRefreshPending = false;
        anchorRecord = captureAnchor();
      });
      runtimeWriteTimes.push(now);
      if (runtimeWriteTimes.length > 4) runtimeWriteTimes.shift();
      if (verbose()) log(`write scrollTop=${Math.round(actual)}`);
      // Glide frames race a user grab by at most one frame before the
      // controller cancels the glide; those writes are not a violation.
      if (!commandIssuing && smoothPending === 0 && nativeActive(now)) {
        const stack = (new Error().stack ?? "")
          .split("\n")
          .slice(1, 6)
          .map((line) => line.trim())
          .join(" < ");
        violation(
          "W",
          `scrollTop written (${Math.round(actual)}) during native scroll — ${evidence(now)} — from ${stack}`,
        );
      }
    },
  });
}

function traceInput(): void {
  viewport.addEventListener(
    "wheel",
    (event) => {
      lastWheelAt = performance.now();
      noteInput(`wheel dy=${Math.round(event.deltaY)}`);
    },
    { passive: true },
  );
  viewport.addEventListener(
    "touchstart",
    () => {
      touchDown = true;
      noteInput("touchstart");
    },
    { passive: true },
  );
  const touchUp = (name: string) => () => {
    touchDown = false;
    noteInput(name);
  };
  window.addEventListener("touchend", touchUp("touchend"), { passive: true });
  window.addEventListener("touchcancel", touchUp("touchcancel"), {
    passive: true,
  });
  window.addEventListener(
    "keydown",
    (event) => {
      // Keys that activate a control (Space/Enter on a button, typing in
      // a field) are not scroll intent.
      const target = event.target as Element | null;
      if (
        target?.closest(
          "button, input, select, textarea, a, summary, [contenteditable]",
        )
      ) {
        return;
      }
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      ) {
        lastKeyAt = performance.now();
        noteInput(`key ${event.key}`);
      }
    },
    { passive: true },
  );
  viewport.addEventListener(
    "scroll",
    () => {
      const now = performance.now();
      const top = viewport.scrollTop;
      // Safari (iPadOS) emits a second scroll event at the SAME position
      // after a programmatic write. No movement is no input — and it must
      // not clear the expected-write queue, or the runtime's next write
      // goes unattributed too.
      if (Math.abs(top - lastScrollEventTop) <= PX_EPSILON) {
        noteInput(`scroll top=${Math.round(top)} (no movement)`);
        return;
      }
      lastScrollEventTop = top;
      const index = expectedWrites.findIndex(
        (target) => Math.abs(target - top) <= PX_EPSILON,
      );
      if (index >= 0) {
        expectedWrites.splice(0, index + 1);
        noteInput(`scroll top=${Math.round(top)} (runtime write)`);
        return;
      }
      // Unmatched: the user moved the viewport; every expected target is
      // stale now (the controller clears its targets the same way).
      expectedWrites.length = 0;
      lastNativeScrollAt = now;
      frameHadNativeScroll = true;
      noteInput(`scroll top=${Math.round(top)}`);
    },
    { passive: true },
  );
  viewport.addEventListener("scrollend", () => noteInput("scrollend"), {
    passive: true,
  });
}

// --- Content-change bookkeeping (what the lab itself changed, and when) ----

let contentSerial = 0;
let globalChangeSerial = 0;
const contentSerialByKey = new Map<string, number>();
let lastContentChangeFrame = Number.NEGATIVE_INFINITY;
let frame = 0;
let stateHeld = false;

function effectiveSerial(key: string): number {
  return Math.max(contentSerialByKey.get(key) ?? 0, globalChangeSerial);
}

function recordContentChange(id: number, what: string): void {
  contentSerial += 1;
  const key = String(id);
  contentSerialByKey.set(key, contentSerial);
  lastContentChangeFrame = frame;
  if (verbose()) log(what);
}

/** A width change that lands mid-phase reflows mounted rows live. */
let widthChangedInPhase = false;

function recordWidthChange(): void {
  contentSerial += 1;
  globalChangeSerial = contentSerial;
  lastContentChangeFrame = frame;
  if (stateHeld || nativeActive() || smoothPending > 0) {
    widthChangedInPhase = true;
  }
}

// --- The runtime ------------------------------------------------------------

let list: VirtualList<Item>;
let canvas: HTMLElement | null = null;
let booted = false;
let commits = 0;
let liveCommits = 0;
/** writeSerial when the previous geometry batch was classified. */
let writeSerialAtLastBatch = 0;
let lastState: VirtualListState | null = null;
const chunksLeft: Record<"start" | "end", number> = {
  start: MAX_CHUNKS,
  end: MAX_CHUNKS,
};
const loading: Record<"start" | "end", boolean> = { start: false, end: false };
let loadsAborted = 0;
/** The next geometry commit is a page load: the end-pin exception is off. */
let expectAnchoredCommit = false;
/** A held phase just committed: the next geometry batch is worth logging. */
let heldCleared = false;

// --- The edge pill (same presentation as the settle lab) --------------------

const edgePill = createEdgePill(mustGet("pill"), mustGet("pill-label"));
/** A chunk handed to the runtime while scrolling, committing at settle. */
const waitingChunk: Record<"start" | "end", boolean> = {
  start: false,
  end: false,
};

function showPill(text: string, edge: "start" | "end", sticky = false): void {
  edgePill.show(text, edge === "end", sticky);
}

function hidePill(force = false): void {
  edgePill.hide(force);
}

function chunkCommitted(edge: "start" | "end"): void {
  waitingChunk[edge] = false;
  if (chunksLeft[edge] > 0) {
    hidePill(true);
  } else {
    showPill(edge === "start" ? "at the top" : "at the bottom", edge, true);
  }
}

function startLoad(edge: "start" | "end", context: ReachContext): void {
  if (!booted || !checkbox("auto-load").checked) return;
  if (loading[edge] || waitingChunk[edge] || chunksLeft[edge] <= 0) return;
  loading[edge] = true;
  showPill(edge === "start" ? "loading older…" : "loading newer…", edge);
  log(`load ${edge} start`);
  const timer = window.setTimeout(() => {
    loading[edge] = false;
    chunksLeft[edge] -= 1;
    const chunk = makeChunk(edge);
    items = edge === "start" ? [...chunk, ...items] : [...items, ...chunk];
    log(`load ${edge} ready: setItems(+${chunk.length}, viewport)`, "mark");
    // A page load at either edge preserves the viewport — a viewport that
    // happens to sit exactly at the end must NOT follow the appended chunk
    // (that end-follow is `auto`'s convention for live messages, not pages).
    expectAnchoredCommit = true;
    waitingChunk[edge] = true;
    guardedCall(`setItems (load ${edge})`, () =>
      list.setItems(items, { anchor: "viewport" }),
    );
    if (stateHeld) {
      // The scroll surface is immutable while the user scrolls: the
      // runtime holds the prepared chunk for the settle signal.
      showPill("waiting for settle…", edge);
      log("HELD: gesture active, committing at settle", "mark");
    } else {
      chunkCommitted(edge);
    }
    scheduleStatus();
  }, LOAD_LATENCY_MS);
  // What a real host does with fetch(url, { signal }).
  context.signal.addEventListener("abort", () => {
    if (!loading[edge]) return;
    window.clearTimeout(timer);
    loading[edge] = false;
    loadsAborted += 1;
    log(`ABORT load ${edge} (signal)`, "warn");
    hidePill();
    scheduleStatus();
  });
}

function onState(state: VirtualListState): void {
  const previous = lastState;
  lastState = state;
  stateHeld = state.held;
  if (previous === null || previous.held !== state.held) {
    if (!state.held) heldCleared = true;
    log(
      state.held ? "HELD" : "committed (held cleared)",
      state.held ? "warn" : "good",
    );
    if (!state.held) {
      widthChangedInPhase = false;
      // ONE settle commits everything held, both edges.
      if (waitingChunk.start) chunkCommitted("start");
      if (waitingChunk.end) chunkCommitted("end");
    }
  } else if (verbose() && previous.count !== state.count) {
    log(`state count=${state.count} total=${Math.round(state.totalSize)}`);
  }
  scheduleStatus();
}

function scrollingMode(): ScrollingUpdates {
  return mustGet("scrolling-updates", HTMLSelectElement)
    .value as ScrollingUpdates;
}

function createList(): void {
  list = createVirtualList<Item>(viewport, {
    items,
    key: (item) => String(item.id),
    render,
    onState,
    onReachStart: (context) => startLoad("start", context),
    onReachEnd: (context) => startLoad("end", context),
    onDestroy,
    scrollingUpdates: scrollingMode(),
  });
  canvas = viewport.firstElementChild as HTMLElement | null;
  if (!canvas) throw new Error("runtime canvas not found");
  observeCanvas(canvas);
  createPaintObserver();
}

// --- Paint-time clipping: a lab-owned ResizeObserver ------------------------
// ResizeObservers deliver after layout and before paint, in creation order.
// This one is created AFTER the runtime's, so it runs after the runtime's
// same-delivery idle commit: a row still taller than its slot HERE is a
// frame that paints clipped. (A rAF-time comparison would run before the
// delivery and report transient, never-painted mismatches.)

let paintObserver: ResizeObserver | null = null;
const clippedKeys = new Set<string>();
let clippedPaints = 0;

function createPaintObserver(): void {
  paintObserver?.disconnect();
  paintObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const row = entry.target as HTMLElement;
      const slot = row.parentElement;
      if (!slot || slot.parentElement !== canvas) continue;
      const key = row.dataset.id ?? "?";
      const contentHeight = row.getBoundingClientRect().height;
      const slotHeight = parseHeight(slot.getAttribute("style"));
      const mismatch =
        slotHeight !== null &&
        Math.abs(contentHeight - slotHeight) > PX_EPSILON;
      if (!mismatch) {
        clippedKeys.delete(key);
        continue;
      }
      clippedKeys.add(key);
      // Frozen elements never change under a live phase, so this holds
      // held or not. The one thing the runtime cannot freeze is a width
      // change landing mid-phase (the browser reflows mounted rows live).
      if (widthChangedInPhase) continue;
      // "live": a dirty row strictly above the anchor waits off-screen —
      // its bottom is above the viewport top, so nothing of it paints.
      // Any row with pixels on screen must agree with its slot, held or
      // not: this is the browser-facing regression for a wrapped line
      // being visible before settlement.
      if (
        scrollingMode() === "live" &&
        slot.getBoundingClientRect().bottom <=
          viewport.getBoundingClientRect().top + 0.5
      ) {
        continue;
      }
      clippedPaints += 1;
      violation(
        "L",
        `#${key} paints ${contentHeight > slotHeight ? "clipped" : "gapped"} (slot ${slotHeight.toFixed(1)}px, content ${contentHeight.toFixed(1)}px, held=${stateHeld})`,
      );
    }
    scheduleStatus();
  });
  if (canvas) {
    for (const slot of canvas.children) watchRow(slot);
  }
}

// Registrations happen from the MutationObserver, i.e. inside the frame's
// observer delivery: observing there schedules a same-depth observation the
// loop cannot deliver ("loop completed with undelivered notifications").
// Registrations wait a frame instead — the runtime does the same.
const pendingWatches: Element[] = [];
let watchFrame = 0;

function watchRow(slot: Element): void {
  const row = slot.firstElementChild;
  if (row) watchElement(row);
}

function watchElement(row: Element): void {
  pendingWatches.push(row);
  if (watchFrame !== 0) return;
  watchFrame = requestAnimationFrame(() => {
    watchFrame = 0;
    for (const element of pendingWatches.splice(0)) {
      if (element.parentElement?.parentElement === canvas) {
        paintObserver?.observe(element);
      }
    }
  });
}

function unwatchRow(slot: Element): void {
  const row = slot.firstElementChild as HTMLElement | null;
  if (!row) return;
  paintObserver?.unobserve(row);
  clippedKeys.delete(row.dataset.id ?? "?");
}

function slotOf(key: string): HTMLElement | null {
  const row = elementById.get(Number(key));
  const slot = row?.parentElement;
  return slot && slot.parentElement === canvas ? slot : null;
}

function keyOfSlot(slot: Element): string {
  const row = slot.firstElementChild as HTMLElement | null;
  return row?.dataset.id ?? "?";
}

// --- Geometry telemetry: the MutationObserver on the canvas ----------------

const knownSlots = new WeakSet<Element>();
let canvasObserver: MutationObserver | null = null;
/** Content serial each slot's last committed height was observed at. */
const committedSerial = new Map<string, number>();
interface AnchorRecord {
  key: string;
  top: number;
  atEnd: boolean;
  /** Viewport position and write serial at capture: a different scrollTop
   * with the same serial means the viewport moved natively since. */
  scrollTop: number;
  writeSerial: number;
}
let anchorRecord: AnchorRecord | null = null;
/** A runtime write happened and no batch has re-captured the anchor yet. */
let anchorRefreshPending = false;
let lastSeenWidth = viewport.clientWidth;

function parseHeight(style: string | null): number | null {
  const match =
    style === null ? null : /(?:^|;)\s*height:\s*([\d.]+)px/.exec(style);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function parseOffset(style: string | null): number | null {
  const match =
    style === null ? null : /translateY\((-?[\d.]+)px\)/.exec(style);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function observeCanvas(target: HTMLElement): void {
  canvasObserver?.disconnect();
  for (const child of target.children) knownSlots.add(child);
  canvasObserver = new MutationObserver(classifyBatch);
  canvasObserver.observe(target, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["style"],
    childList: true,
    subtree: true,
  });
}

function classifyBatch(records: MutationRecord[]): void {
  if (!canvas) return;
  const now = performance.now();
  // Synced on EVERY batch (window batches arrive on every scroll event),
  // so a geometry batch knows whether a runtime write happened since.
  const wroteScrollTop = writeSerial !== writeSerialAtLastBatch;
  writeSerialAtLastBatch = writeSerial;
  // The scroll position the commit ran at: its writes (a glide frame)
  // precede its mutations in the same task, and nothing moves it before
  // this microtask.
  const scrollTopNow = viewport.scrollTop;
  // A width change the lab did not make (device rotation, browser chrome):
  // every row may legitimately re-commit.
  if (Math.abs(viewport.clientWidth - lastSeenWidth) > 0.5) {
    lastSeenWidth = viewport.clientWidth;
    recordWidthChange();
    log(`environment width → ${lastSeenWidth}px`, "mark");
  }
  const added = new Set<Element>();
  let removed = 0;
  const firstOldStyle = new Map<Element, string | null>();
  for (const record of records) {
    if (record.type === "childList") {
      if (record.target !== canvas) {
        // An element swapped inside a slot — a promoted equal-height
        // update, or a detached remeasure moving it out and back: the
        // paint observer follows the element now in the slot.
        if ((record.target as Element).parentElement === canvas) {
          for (const node of record.removedNodes) {
            if (node instanceof Element) paintObserver?.unobserve(node);
          }
          for (const node of record.addedNodes) {
            if (node instanceof Element) watchElement(node);
          }
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          added.add(node);
          knownSlots.add(node);
          watchRow(node);
        }
      }
      for (const node of record.removedNodes) {
        if (node instanceof Element) unwatchRow(node);
      }
      removed += record.removedNodes.length;
      continue;
    }
    const target = record.target as Element;
    if (target !== canvas && target.parentElement !== canvas) continue;
    if (!firstOldStyle.has(target)) firstOldStyle.set(target, record.oldValue);
  }
  for (const slot of added) checkSlotClips(slot);

  let canvasChange: { from: number | null; to: number | null } | null = null;
  const heightChanges: { key: string; from: number; to: number }[] = [];
  let offsetChanges = 0;
  // Pre-commit placement of every slot that changed, straight from the
  // mutation records — the ground truth for the "live" rule below.
  const changedSlots: {
    key: string;
    offsetFrom: number | null;
    heightFrom: number | null;
    movedOffset: boolean;
    resized: boolean;
  }[] = [];
  for (const [target, oldStyle] of firstOldStyle) {
    const style = target.getAttribute("style");
    if (target === canvas) {
      const from = parseHeight(oldStyle);
      const to = parseHeight(style);
      if (from !== to) canvasChange = { from, to };
      continue;
    }
    if (added.has(target) || !target.isConnected) continue;
    const key = keyOfSlot(target);
    const heightFrom = parseHeight(oldStyle);
    const heightTo = parseHeight(style);
    const resized =
      heightFrom !== null && heightTo !== null && heightFrom !== heightTo;
    if (resized) heightChanges.push({ key, from: heightFrom, to: heightTo });
    const offsetFrom = parseOffset(oldStyle);
    const offsetTo = parseOffset(style);
    const movedOffset = offsetFrom !== offsetTo;
    if (movedOffset) offsetChanges += 1;
    if (resized || movedOffset) {
      changedSlots.push({ key, offsetFrom, heightFrom, movedOffset, resized });
    }
  }

  const geometryChanged =
    canvasChange !== null || heightChanges.length > 0 || offsetChanges > 0;
  if (!geometryChanged) {
    if (verbose() && (added.size > 0 || removed > 0)) {
      log(`window +${added.size}/−${removed}`);
    }
    // The window moved (a command, a glide frame): new baseline.
    anchorRefreshPending = false;
    anchorRecord = captureAnchor();
    return;
  }

  commits += 1;
  // The commit that cleared a held phase is the settle commit: the one
  // permitted commit at the end of a programmatic phase (a landed glide's
  // promise resolves only after it, so smoothPending is still up).
  const settleCommit = heldCleared;
  heldCleared = false;
  // A command's takeover commit: the runtime stopped the native scroll and
  // committed held work by contract (explicit command > gesture).
  const takeover = takeoverPending && settleCommit;
  takeoverPending = false;
  // Idle streaming commits every few frames; log only settle commits
  // unless verbose.
  if (verbose() || settleCommit) {
    log(
      `COMMIT canvas ${canvasChange ? `${Math.round(canvasChange.from ?? 0)}→${Math.round(canvasChange.to ?? 0)}` : "same"} · ${heightChanges.length} heights · ${offsetChanges} offsets · slots +${added.size}/−${removed}${takeover ? " · takeover" : ""}${settleCommit ? " · settle" : ""} · mode=${scrollingMode()} smooth=${smoothPending} write=${wroteScrollTop}`,
      "good",
    );
  }

  // "live" commits only rows at or below the anchor row (the row under the
  // viewport top): a MOVED row must have started at or below the viewport
  // top (only rows after the anchor shift; the anchor keeps its offset), and
  // a RESIZED row must not have been entirely above it (the anchor row may
  // resize; rows above it would need an anchor write). Judged on the
  // pre-commit placement from the records and the commit's scroll position.
  /** Null when the batch is a legitimate live commit; else why not. */
  const liveCommitRejection = (): string | null => {
    if (scrollingMode() !== "live") return `mode=${scrollingMode()}`;
    // A glide writes every frame by design; under native input any write
    // disqualifies the commit.
    if (wroteScrollTop && smoothPending === 0) return "wrote scrollTop";
    for (const slot of changedSlots) {
      if (slot.offsetFrom === null) continue; // Freshly placed: not a move.
      if (slot.movedOffset && slot.offsetFrom < scrollTopNow - PX_EPSILON) {
        return `#${slot.key} moved from ${slot.offsetFrom} above scrollTop ${Math.round(scrollTopNow)}`;
      }
      if (
        slot.resized &&
        slot.heightFrom !== null &&
        slot.offsetFrom + slot.heightFrom <= scrollTopNow + PX_EPSILON
      ) {
        return `#${slot.key} resized entirely above scrollTop ${Math.round(scrollTopNow)} (${slot.offsetFrom}+${slot.heightFrom})`;
      }
    }
    return null;
  };
  const liveRejection = liveCommitRejection();

  // G: geometry is immutable under a live scroll phase.
  if (takeover) {
    if (verbose()) log("takeover commit (command ended the phase)");
  } else if (
    (nativeActive(now) || glideMoving(now)) &&
    liveRejection === null
  ) {
    liveCommits += 1;
  } else {
    if (nativeActive(now)) {
      violation(
        "G",
        `geometry changed during native scroll (${heightChanges.length} heights, ${offsetChanges} offsets, canvas ${canvasChange ? "changed" : "same"}; not a live commit: ${liveRejection ?? "?"}; smooth=${smoothPending} write=${wroteScrollTop}) — ${evidence(now)}`,
      );
    } else if (!settleCommit && glideMoving(now)) {
      violation(
        "G",
        `geometry changed while a glide was still moving — ${evidence(now)}`,
      );
    }
  }

  // T: a height commits once per change, the latest.
  for (const change of heightChanges) {
    // A committed height that matches the content un-clips the row.
    const slot = slotOf(change.key);
    const row = slot?.firstElementChild as HTMLElement | null;
    if (
      row &&
      Math.abs(row.getBoundingClientRect().height - change.to) <= PX_EPSILON
    ) {
      clippedKeys.delete(change.key);
    }
    const serial = effectiveSerial(change.key);
    if (committedSerial.get(change.key) === serial) {
      violation(
        "T",
        `#${change.key} height re-committed without a content change (${change.from.toFixed(1)}→${change.to.toFixed(1)}px)`,
      );
    }
    committedSerial.set(change.key, serial);
  }

  // A: the row under the viewport top stays where it was — unless this
  // commit legitimately kept an end-pinned viewport at the end.
  if (!takeover && !nativeActive(now) && !glideMoving(now)) {
    checkAnchor(canvasChange, heightChanges, wroteScrollTop);
  }
  expectAnchoredCommit = false;
  checkOverlap();
  // Consecutive commits before the next frame (an exempt anchor shrink,
  // then another commit 7ms later) must each be judged against the
  // geometry they started from.
  anchorRefreshPending = false;
  anchorRecord = captureAnchor();
  scheduleStatus();
}

function checkSlotClips(slot: Element): void {
  // A slot mounted and unmounted within one task has no computed style to
  // read (Firefox reports "" for a disconnected element).
  if (!slot.isConnected) return;
  const overflow = getComputedStyle(slot).overflowY;
  if (overflow === "") return;
  if (overflow !== "clip" && overflow !== "hidden") {
    violation(
      "O",
      `slot #${keyOfSlot(slot)} does not clip (overflow: ${overflow})`,
    );
  }
}

function mountedSlots(): {
  slot: HTMLElement;
  key: string;
  y: number;
  h: number;
}[] {
  if (!canvas) return [];
  const result: { slot: HTMLElement; key: string; y: number; h: number }[] = [];
  for (const child of canvas.children) {
    const slot = child as HTMLElement;
    const y = parseOffset(slot.getAttribute("style"));
    const h = parseHeight(slot.getAttribute("style"));
    if (y === null || h === null) continue;
    result.push({ slot, key: keyOfSlot(slot), y, h });
  }
  result.sort((a, b) => a.y - b.y);
  return result;
}

function checkOverlap(): void {
  const slots = mountedSlots();
  for (let index = 1; index < slots.length; index++) {
    const above = slots[index - 1];
    const below = slots[index];
    if (!above || !below) continue;
    if (above.y + above.h > below.y + PX_EPSILON) {
      violation(
        "O",
        `slots overlap: #${above.key} [${above.y.toFixed(1)}+${above.h.toFixed(1)}] over #${below.key} [${below.y.toFixed(1)}]`,
      );
      return;
    }
  }
}

function atEndNow(): boolean {
  return (
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <=
    PX_EPSILON
  );
}

function captureAnchor(): AnchorRecord | null {
  const viewportTop = viewport.getBoundingClientRect().top;
  let best: { key: string; top: number } | null = null;
  for (const { slot, key } of mountedSlots()) {
    const rect = slot.getBoundingClientRect();
    if (rect.bottom <= viewportTop + 0.5) continue;
    const top = rect.top - viewportTop;
    if (best === null || top < best.top) best = { key, top };
  }
  return best === null
    ? null
    : {
        ...best,
        atEnd: atEndNow(),
        scrollTop: viewport.scrollTop,
        writeSerial,
      };
}

function checkAnchor(
  canvasChange: { from: number | null; to: number | null } | null,
  heightChanges: readonly { key: string; from: number; to: number }[],
  wroteScrollTop: boolean,
): void {
  const record = anchorRecord;
  if (!record) return;
  const context = () =>
    `mode=${scrollingMode()} held=${stateHeld} write=${wroteScrollTop} scrollTop ${Math.round(record.scrollTop)}→${Math.round(viewport.scrollTop)} canvas ${canvasChange ? `${Math.round(canvasChange.from ?? 0)}→${Math.round(canvasChange.to ?? 0)}` : "same"} heights [${heightChanges.map((c) => `#${c.key} ${c.from}→${c.to}`).join(", ")}]`;
  // The viewport moved with no runtime write since the record — a native
  // scroll whose event has not fired yet: the baseline is stale, and the
  // batch is judged by G, not A.
  if (
    record.writeSerial === writeSerial &&
    Math.abs(viewport.scrollTop - record.scrollTop) > ANCHOR_EPSILON
  ) {
    if (verbose()) log(`anchor baseline stale (native motion) — skipped`);
    return;
  }
  if (atEndNow()) {
    // End-pinned: legitimate for live growth/appends at the end — never
    // for a page load, which asked for the viewport anchor.
    if (record.atEnd && !expectAnchoredCommit) return;
    // Content below shrank: the viewport was clamped to the new maximum.
    const shrank =
      canvasChange !== null &&
      canvasChange.from !== null &&
      canvasChange.to !== null &&
      canvasChange.to < canvasChange.from;
    if (!record.atEnd && shrank) return;
  }
  const slot = slotOf(record.key);
  if (!slot) {
    // The row under the viewport top survived the commit but is no longer
    // mounted: the viewport jumped far enough to leave the window.
    if (itemById.has(Number(record.key))) {
      violation(
        "A",
        `anchor #${record.key} survived the commit but left the window — ${context()}`,
      );
    } else if (verbose()) {
      log(`anchor #${record.key} removed across commit`);
    }
    return;
  }
  // The anchor row itself shrank above the viewport's offset into it: the
  // kernel clamps to the row's own bounds (I1), so its top legitimately
  // moves down.
  const own = heightChanges.find((change) => change.key === record.key);
  if (own && own.to < -record.top - PX_EPSILON) {
    if (verbose()) log(`anchor #${record.key} shrank under the viewport top`);
    return;
  }
  const top =
    slot.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  if (Math.abs(top - record.top) > ANCHOR_EPSILON) {
    violation(
      "A",
      `anchor #${record.key} moved ${record.top.toFixed(2)}→${top.toFixed(2)}px across a commit — ${context()}`,
    );
  }
}

// --- Per-frame telemetry: quiet-state consistency ---------------------------

const staleFrames = new Map<string, number>();
const staleReported = new Set<string>();
let statusFrame = 0;

function frameLoop(): void {
  frame += 1;
  const now = performance.now();
  const quietFrame = !frameHadNativeScroll;
  frameHadNativeScroll = false;

  // Destroyed elements must be out of the DOM by the next frame.
  for (const row of detachChecks.splice(0)) {
    if (row.isConnected) {
      violation(
        "D",
        `destroyed element #${row.dataset.id ?? "?"} is still in the DOM`,
      );
    }
  }

  if (quietFrame) anchorRecord = captureAnchor();

  const quiet =
    !nativeActive(now) &&
    !stateHeld &&
    smoothPending === 0 &&
    frame - lastContentChangeFrame > QUIET_FRAMES;

  // S: persistent stale heights while quiet. (This rAF-time read runs
  // BEFORE the frame's ResizeObserver delivery, so a single-frame mismatch
  // here is transient and never painted; only persistence counts.)
  for (const { slot, key, h } of mountedSlots()) {
    const row = slot.firstElementChild as HTMLElement | null;
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    const mismatch = Math.abs(rect.height - h) > PX_EPSILON;

    if (quiet && mismatch) {
      const count = (staleFrames.get(key) ?? 0) + 1;
      staleFrames.set(key, count);
      if (count >= QUIET_FRAMES && !staleReported.has(key)) {
        staleReported.add(key);
        violation(
          "S",
          `#${key} slot ${h.toFixed(1)}px but content ${rect.height.toFixed(1)}px while quiet`,
        );
      }
    } else if (!mismatch) {
      staleFrames.delete(key);
      staleReported.delete(key);
    }
  }
  if (frame % 6 === 0) scheduleStatus();
  requestAnimationFrame(frameLoop);
}

function scheduleStatus(): void {
  if (statusFrame) return;
  statusFrame = requestAnimationFrame(() => {
    statusFrame = 0;
    const active = nativeActive();
    stat.activeDot.className = `dot${active ? " on" : ""}`;
    stat.activeText.textContent = active ? "active" : "idle";
    stat.heldDot.className = `dot${stateHeld ? " pending" : ""}`;
    stat.heldText.textContent = stateHeld ? "yes" : "no";
    stat.rows.textContent = `${lastState?.count ?? 0} / ${canvas?.children.length ?? 0}`;
    stat.commits.textContent =
      liveCommits > 0 ? `${commits} (${liveCommits} live)` : String(commits);
    stat.violations.textContent = String(violations);
    stat.violations.className = `val${violations > 0 ? " bad" : ""}`;
    stat.nodes.textContent = `${created}/${destroyed}/${created - destroyed}`;
    stat.clipped.textContent = String(clippedKeys.size);
    stat.paints.textContent = String(clippedPaints);
    stat.paints.className = `val${clippedPaints > 0 ? " bad" : ""}`;
    stat.streams.textContent =
      chaosOps > 0
        ? `${streams.size} active · chaos ${chaosOps}`
        : `${streams.size} active`;
    stat.images.textContent = `${imagesPending}/${imagesLoaded}`;
    stat.loads.textContent = `T:${chunksLeft.start} B:${chunksLeft.end} left · ${loadsAborted} aborted`;
  });
}

// --- Content generators (the adversary) -----------------------------------

const random = mulberry32(0x9e3779b9);
const streams = new Map<number, number>();

/** Every content change, including nested words, is an immutable snapshot. */
function changeContent(
  item: Item,
  what: string,
  mutate: (updated: Item) => void,
): Item {
  const updated = {
    ...item,
    words: [...item.words],
    version: item.version + 1,
  };
  mutate(updated);
  replaceItem(updated);
  guardedCall(`setItems (${what})`, () => list.setItems(items));
  recordContentChange(item.id, what);
  return updated;
}

function maintainStreams(): void {
  if (!checkbox("streaming").checked) return;
  const candidates = items.filter(
    (item) =>
      item.kind === "stream" &&
      item.words.length < item.streamTarget &&
      !streams.has(item.id),
  );
  while (streams.size < STREAM_CONCURRENCY && candidates.length > 0) {
    const index = Math.floor(random() * candidates.length);
    const [chosen] = candidates.splice(index, 1);
    if (chosen) startStream(chosen.id);
  }
}

/** The "streaming" label belongs only to rows actively receiving tokens —
 * and reaches the DOM through setItems like every other change. */
function syncLive(id: number): void {
  const item = itemById.get(id);
  const streaming = streams.has(id);
  if (item && item.streaming !== streaming && items.includes(item)) {
    changeContent(
      item,
      `stream #${id} ${streaming ? "live" : "idle"}`,
      (updated) => {
        updated.streaming = streaming;
      },
    );
  }
}

function endStream(id: number): void {
  const timer = streams.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  streams.delete(id);
  syncLive(id);
}

function startStream(id: number): void {
  log(`stream #${id} start`);
  const tick = () => {
    const item = itemById.get(id);
    if (!item || !checkbox("streaming").checked || !items.includes(item)) {
      endStream(id);
      return;
    }
    const burst = 1 + Math.floor(random() * 3);
    const updated = changeContent(
      item,
      `stream #${id} +${burst} words`,
      (next) => {
        for (let count = 0; count < burst; count++)
          next.words.push(pick(WORDS, random));
      },
    );
    if (updated.words.length >= updated.streamTarget) {
      endStream(id);
      log(`stream #${id} done`);
      maintainStreams();
      scheduleStatus();
      return;
    }
    streams.set(id, window.setTimeout(tick, 60 + random() * 160));
  };
  streams.set(id, window.setTimeout(tick, 100));
  syncLive(id);
  scheduleStatus();
}

function stopStreams(): void {
  for (const id of [...streams.keys()]) endStream(id);
}

function flipToggle(id: number, why: string): void {
  const item = itemById.get(id);
  if (!item) return;
  const open = !item.open;
  changeContent(
    item,
    `toggle #${id} ${open ? "open" : "closed"} (${why})`,
    (updated) => {
      updated.open = open;
    },
  );
}

function toggleTick(): void {
  if (checkbox("toggles").checked) {
    const candidates = items.filter((item) => item.kind === "toggle");
    if (candidates.length > 0) flipToggle(pick(candidates, random).id, "timer");
  }
  window.setTimeout(toggleTick, TOGGLE_INTERVAL_MS);
}

function toggleWidth(why: string): void {
  stage.classList.toggle("narrow");
  recordWidthChange();
  log(
    `width → ${stage.classList.contains("narrow") ? "narrow" : "wide"} (${why})`,
    "mark",
  );
}

function widthTick(): void {
  if (checkbox("width-jitter").checked) toggleWidth("jitter");
  window.setTimeout(widthTick, WIDTH_JITTER_MS);
}

function deleteItem(item: Item, why: string): void {
  items = items.filter((candidate) => candidate !== item);
  itemById.delete(item.id);
  log(`delete #${item.id} (${why}): setItems`, "mark");
  guardedCall(`setItems (delete #${item.id})`, () => list.setItems(items));
}

function burst(): void {
  log("burst: 5 superseding setItems", "mark");
  for (let count = 0; count < 5; count++) {
    const item = pick(items, random);
    changeContent(item, `burst #${item.id}`, (updated) => {
      updated.words.push(pick(WORDS, random));
    });
  }
}

// --- Chaos ------------------------------------------------------------------
// A randomized adversary: every operation the lab exposes, at random, at a
// random cadence, on top of streaming/toggles/images — including a render
// that throws (the runtime must roll back atomically), mid-list inserts and
// reorders, commands, width flips, and scrollingUpdates switches (the list
// is recreated, counters carry on). The driver adds random wheel input.

const CHAOS_RENDER_ERROR = "chaos: render failure";
let throwNextRender = false;
let chaosTimer = 0;
let chaosOps = 0;
let insertedId = 1_000_000;

function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `AggregateError[${error.errors.map(describeError).join("; ")}]`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Only the lab's own chaos throw (possibly aggregated) is an expected failure. */
function isChaosFailure(error: unknown): boolean {
  const all = error instanceof AggregateError ? error.errors : [error];
  return (
    all.length > 0 &&
    all.every(
      (entry) => entry instanceof Error && entry.message === CHAOS_RENDER_ERROR,
    )
  );
}

function guardedCall(what: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    if (isChaosFailure(error)) {
      log(`expected: ${what} threw (${describeError(error)})`, "warn");
      return;
    }
    violation("X", `${what} threw: ${describeError(error)}`);
  }
}

const CHAOS_OPS: { weight: number; name: string; run: () => void }[] = [
  { weight: 3, name: "burst", run: burst },
  {
    weight: 2,
    name: "delete random",
    run: () => {
      if (items.length > 5) deleteItem(pick(items, random), "chaos");
    },
  },
  {
    weight: 1,
    name: "delete anchor",
    run: () => {
      const key = anchorRecord?.key;
      const item = key === undefined ? undefined : itemById.get(Number(key));
      if (item && items.length > 5) deleteItem(item, "chaos anchor");
    },
  },
  {
    weight: 2,
    name: "insert mid-list",
    run: () => {
      const item = makeItem(insertedId);
      insertedId += 1;
      itemById.set(item.id, item);
      const at = Math.floor(random() * (items.length + 1));
      items = [...items.slice(0, at), item, ...items.slice(at)];
      freshIds.add(item.id);
      log(`chaos: insert #${item.id} at ${at}`, "mark");
      guardedCall("setItems (insert)", () => list.setItems(items));
    },
  },
  {
    weight: 2,
    name: "swap adjacent",
    run: () => {
      if (items.length < 2) return;
      const at = Math.floor(random() * (items.length - 1));
      const next = [...items];
      const a = next[at];
      const b = next[at + 1];
      if (!a || !b) return;
      next[at] = b;
      next[at + 1] = a;
      items = next;
      log(`chaos: swap #${a.id} ↔ #${b.id}`, "mark");
      guardedCall("setItems (swap)", () => list.setItems(items));
    },
  },
  {
    weight: 2,
    name: "throwing render",
    run: () => {
      throwNextRender = true;
      const item = pick(items, random);
      changeContent(item, `chaos throw on #${item.id}`, (updated) => {
        updated.words.push(pick(WORDS, random));
      });
      throwNextRender = false; // If nothing rendered, do not ambush a later call.
    },
  },
  { weight: 1, name: "width", run: () => toggleWidth("chaos") },
  { weight: 1, name: "glide top", run: () => glideTo("start") },
  { weight: 1, name: "glide bottom", run: () => glideTo("end") },
  {
    weight: 1,
    name: "scrollTo random key",
    run: () => {
      const item = pick(items, random);
      log(`chaos: scrollTo #${item.id}`, "mark");
      const promise = issue(() => list.scrollTo(String(item.id)));
      void promise.then((landed) => {
        if (verbose()) log(`scrollTo #${item.id} → ${landed}`);
      });
    },
  },
  {
    weight: 1,
    name: "flip replace",
    run: () => {
      checkbox("replace").checked = !checkbox("replace").checked;
      log(`chaos: replace ${checkbox("replace").checked ? "on" : "off"}`);
    },
  },
  {
    weight: 0.3,
    name: "switch scrollingUpdates",
    run: () => {
      const modes: ScrollingUpdates[] = ["same-height", "freeze", "live"];
      const next = pick(
        modes.filter((mode) => mode !== scrollingMode()),
        random,
      );
      mustGet("scrolling-updates", HTMLSelectElement).value = next;
      log(`chaos: scrollingUpdates → ${next} (recreate)`, "mark");
      recreate();
    },
  },
];

function chaosTick(): void {
  chaosTimer = 0;
  if (!checkbox("chaos").checked) return;
  const total = CHAOS_OPS.reduce((sum, op) => sum + op.weight, 0);
  let roll = random() * total;
  let op = CHAOS_OPS[0];
  for (const candidate of CHAOS_OPS) {
    roll -= candidate.weight;
    if (roll < 0) {
      op = candidate;
      break;
    }
  }
  if (op) {
    chaosOps += 1;
    if (verbose()) log(`chaos op: ${op.name}`);
    guardedCall(`chaos ${op.name}`, op.run);
  }
  chaosTimer = window.setTimeout(chaosTick, 100 + random() * 500);
}

function startChaos(): void {
  if (chaosTimer !== 0) return;
  log("CHAOS on", "mark");
  chaosTimer = window.setTimeout(chaosTick, 200);
}

function stopChaos(): void {
  if (chaosTimer !== 0) window.clearTimeout(chaosTimer);
  chaosTimer = 0;
  throwNextRender = false;
  log("CHAOS off", "mark");
}

// --- Commands ---------------------------------------------------------------

function issue<T>(work: () => T): T {
  commandIssuing = true;
  // An explicit command takes the viewport over: it ends the active phase
  // and commits held work. That commit's mutation batch is delivered after
  // this call returns — still under fresh input evidence — and must not
  // read as a mid-scroll commit. The flag is cleared by the batch, or by
  // this microtask (queued after the batch's) when there was none.
  takeoverPending = true;
  try {
    return work();
  } finally {
    commandIssuing = false;
    // The command ended the gesture (the runtime stops the native scroll
    // and settles): input evidence from BEFORE it no longer means an active
    // scroll. Wheel or scroll events that arrive after it count again. A
    // finger still down does (the runtime cannot stop a touch).
    lastWheelAt = Number.NEGATIVE_INFINITY;
    lastKeyAt = Number.NEGATIVE_INFINITY;
    lastNativeScrollAt = Number.NEGATIVE_INFINITY;
    // Queued AFTER the command's mutations, so the observer's own microtask
    // (queued at the first mutation) runs first and sees the flag.
    queueMicrotask(() => {
      takeoverPending = false;
    });
  }
}

function glideTo(target: "start" | "end"): void {
  log(`glide ${target}`, "mark");
  smoothPending += 1;
  const promise = issue(() => list.scrollTo(target, { behavior: "smooth" }));
  void promise.then((landed) => {
    smoothPending -= 1;
    log(
      `glide ${target} ${landed ? "landed" : "interrupted"}`,
      landed ? "good" : "warn",
    );
  });
}

// --- Boot / reset -----------------------------------------------------------

function buildInitialItems(): void {
  items = [];
  itemById.clear();
  firstId = 0;
  nextId = 0;
  for (let index = 0; index < INITIAL_ROWS; index++) {
    const item = makeItem(nextId + index);
    items.push(item);
    itemById.set(item.id, item);
  }
  nextId += INITIAL_ROWS;
}

function boot(): void {
  booted = false;
  buildInitialItems();
  chunksLeft.start = MAX_CHUNKS;
  chunksLeft.end = MAX_CHUNKS;
  loading.start = false;
  loading.end = false;
  waitingChunk.start = false;
  waitingChunk.end = false;
  freshIds.clear();
  hidePill(true);
  committedSerial.clear();
  staleFrames.clear();
  staleReported.clear();
  clippedKeys.clear();
  // The boot commit and the mid-list positioning are the lab's own commands.
  issue(() => {
    createList();
    // Start mid-list so both edge zones need a deliberate scroll.
    const middle = items[Math.floor(items.length / 2)];
    if (middle) void list.scrollTo(String(middle.id));
  });
  booted = true;
  maintainStreams();
  log("booted mid-list", "mark");
  scheduleStatus();
}

/** Dispose (the leak check) and boot a new list; counters carry on. */
function recreate(): void {
  disposeCurrent();
  boot();
}

function disposeCurrent(): void {
  stopStreams();

  guardedCall("dispose", () => list.dispose());
  canvasObserver?.disconnect();
  canvas = null;
  const live = created - destroyed;
  if (live !== 0) {
    violation(
      "D",
      `${live} element(s) leaked at dispose (created ${created}, destroyed ${destroyed})`,
    );
  } else {
    log(`dispose: every element destroyed exactly once (${destroyed})`, "good");
  }
  elementById.clear();
  paintObserver?.disconnect();
}

function reset(): void {
  // A fresh run. Violation counters start over BEFORE the dispose, so a
  // leak found by it lands in the new run's count; the node counters start
  // over AFTER it and before the boot (zeroing after the boot left its rows
  // uncounted and every later dispose "over-destroyed" by that many).
  violations = 0;
  clippedPaints = 0;
  disposeCurrent();
  commits = 0;
  liveCommits = 0;
  created = 0;
  destroyed = 0;
  imagesLoaded = 0;
  loadsAborted = 0;
  chaosOps = 0;
  boot();
  scheduleStatus();
}

checkbox("streaming").addEventListener("change", () => {
  if (checkbox("streaming").checked) maintainStreams();
  else stopStreams();
  scheduleStatus();
});
mustGet("glide-top").addEventListener("click", () => glideTo("start"));
mustGet("glide-bottom").addEventListener("click", () => glideTo("end"));
mustGet("width").addEventListener("click", () => toggleWidth("button"));
mustGet("delete-anchor").addEventListener("click", () => {
  const key = anchorRecord?.key;
  const item = key === undefined ? undefined : itemById.get(Number(key));
  if (item) deleteItem(item, "anchor");
});
mustGet("delete-random").addEventListener("click", () => {
  if (items.length > 1) deleteItem(pick(items, random), "random");
});
mustGet("burst").addEventListener("click", burst);
mustGet("reset").addEventListener("click", () => {
  log("reset", "mark");
  reset();
});
mustGet("scrolling-updates").addEventListener("change", () => {
  log(`scrollingUpdates → ${scrollingMode()} (recreate)`, "mark");
  recreate();
});
checkbox("chaos").addEventListener("change", () => {
  if (checkbox("chaos").checked) startChaos();
  else stopChaos();
});
// Anything the runtime lets escape is a defect in its own right.
window.addEventListener("error", (event) => {
  violation("X", `uncaught: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  violation("X", `unhandled rejection: ${describeError(event.reason)}`);
});
mustGet("clear").addEventListener("click", () => {
  trace.clear();
  // Violations without their traces are meaningless: the count restarts.
  violations = 0;
  clippedPaints = 0;
  scheduleStatus();
});
mustGet("upload").addEventListener("click", () => {
  void sendReport("manual");
});
mustGet("copy").addEventListener("click", () => {
  const text = `${navigator.userAgent}\nstrategy=${stat.strategy.textContent}\nviolations=${violations}\n${trace.ring.join("\n")}`;
  void navigator.clipboard?.writeText(text).then(
    () => log("trace copied", "good"),
    () => log("clipboard unavailable — select the log manually", "warn"),
  );
});

installWriteHook();
traceInput();
boot();
toggleTick();
widthTick();
requestAnimationFrame(frameLoop);
