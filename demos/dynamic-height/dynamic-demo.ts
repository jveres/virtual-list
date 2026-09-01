import { detectScrollSettleStrategy } from "../../src/scroll-settle.js";
import {
  createVirtualList,
  type ReachContext,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list.js";

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
// Two mutation channels: direct DOM mutation (the ResizeObserver path) and
// setItems with changed items (in-place re-render, or a replacing re-render
// with the "replace" box).
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
//   L  an idle content change took more frames to commit than the budget;
//   T  a slot height was committed again with no content or width change
//      in between (heights must commit once, latest);
//   D  an element destroyed twice, never rendered by the lab, still in the
//      DOM after destruction, or leaked at dispose.
// A violation counter above 0 is a defect: copy the trace.

const INITIAL_ROWS = 40;
const CHUNK_ROWS = 12;
const MAX_CHUNKS = 40;
const LOAD_LATENCY_MS = 250;
const STREAM_CONCURRENCY = 5;
const TOGGLE_INTERVAL_MS = 900;
const WIDTH_JITTER_MS = 2500;
const INPUT_WINDOW_MS = 120;
const EXPECTED_WRITE_TTL_MS = 400;
const QUIET_FRAMES = 3;
const IDLE_COMMIT_FRAME_BUDGET = 3;
const PX_EPSILON = 1;
const LOG_RING_MAX = 4000;
const LOG_DOM_MAX = 350;

const WORDS =
  "the quick brown fox jumps over a lazy dog while streaming tokens arrive one after another and the row grows taller than its committed slot until the settle signal lets geometry move again so nothing under a live gesture ever shifts".split(
    " ",
  );

function mustGet<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stage = mustGet("stage");
const viewport = mustGet("viewport");
const logElement = mustGet<HTMLPreElement>("log");
const checkbox = (id: string) => mustGet<HTMLInputElement>(id);
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
  latency: mustGet("s-latency"),
  streams: mustGet("s-streams"),
  images: mustGet("s-images"),
  loads: mustGet("s-loads"),
};
mustGet("ua").textContent = navigator.userAgent;
stat.strategy.textContent = detectScrollSettleStrategy();

// --- Trace ------------------------------------------------------------------

const traceRing: string[] = [];
const startedAt = performance.now();

function log(message: string, cls?: "mark" | "good" | "warn" | "bad"): void {
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

function verbose(): boolean {
  return checkbox("verbose").checked;
}

let violations = 0;

function violation(code: string, message: string): void {
  violations += 1;
  log(`VIOLATION ${code}: ${message}`, "bad");
  scheduleStatus();
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
  for (const item of chunk) itemById.set(item.id, item);
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

function scheduleImage(row: HTMLElement, img: HTMLImageElement, item: Item) {
  if (!checkbox("images").checked) {
    img.src = imageSource(item);
    return;
  }
  imagesPending += 1;
  let settled = false;
  const timer = window.setTimeout(() => {
    settled = true;
    imagesPending -= 1;
    img.src = imageSource(item);
  }, item.imageDelayMs);
  img.addEventListener("load", () => {
    imagesLoaded += 1;
    // A resource change: the row is taller now, mounted or not.
    recordContentChange(item.id, `image #${item.id} loaded`);
  });
  cleanupByElement.set(row, () => {
    window.clearTimeout(timer);
    if (!settled) imagesPending -= 1;
  });
}

function build(item: Item): HTMLElement {
  const row = element("div", `row ${item.kind}`);
  row.dataset.id = String(item.id);
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
  row.dataset.version = String(item.version);
}

function render(item: Item, existing?: HTMLElement): HTMLElement {
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
let activitySerial = 0;
let frameHadNativeScroll = false;
const expectedWrites: { top: number; at: number }[] = [];
const runtimeWriteTimes: number[] = [];
let commandIssuing = false;
let smoothPending = 0;

function noteActivity(): void {
  activitySerial += 1;
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
      expectedWrites.push({ top: actual, at: now });
      runtimeWriteTimes.push(now);
      if (runtimeWriteTimes.length > 4) runtimeWriteTimes.shift();
      if (verbose()) log(`write scrollTop=${Math.round(actual)}`);
      // Glide frames race a user grab by at most one frame before the
      // controller cancels the glide; those writes are not a violation.
      if (!commandIssuing && smoothPending === 0 && nativeActive(now)) {
        violation(
          "W",
          `scrollTop written (${Math.round(actual)}) during native scroll`,
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
      noteActivity();
      if (verbose()) log(`wheel dy=${Math.round(event.deltaY)}`);
    },
    { passive: true },
  );
  viewport.addEventListener(
    "touchstart",
    () => {
      touchDown = true;
      noteActivity();
      if (verbose()) log("touchstart");
    },
    { passive: true },
  );
  const touchUp = (name: string) => () => {
    touchDown = false;
    noteActivity();
    if (verbose()) log(name);
  };
  window.addEventListener("touchend", touchUp("touchend"), { passive: true });
  window.addEventListener("touchcancel", touchUp("touchcancel"), {
    passive: true,
  });
  window.addEventListener(
    "keydown",
    (event) => {
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
        noteActivity();
      }
    },
    { passive: true },
  );
  viewport.addEventListener(
    "scroll",
    () => {
      const now = performance.now();
      const top = viewport.scrollTop;
      while (
        expectedWrites.length > 0 &&
        now - (expectedWrites[0]?.at ?? now) > EXPECTED_WRITE_TTL_MS
      ) {
        expectedWrites.shift();
      }
      const index = expectedWrites.findIndex(
        (write) => Math.abs(write.top - top) <= PX_EPSILON,
      );
      if (index >= 0) {
        expectedWrites.splice(0, index + 1);
        if (verbose()) log(`scroll top=${Math.round(top)} (runtime write)`);
        return;
      }
      lastNativeScrollAt = now;
      frameHadNativeScroll = true;
      noteActivity();
      if (verbose()) log(`scroll top=${Math.round(top)}`);
    },
    { passive: true },
  );
  viewport.addEventListener(
    "scrollend",
    () => {
      if (verbose()) log("scrollend");
    },
    { passive: true },
  );
}

// --- Content-change bookkeeping (what the lab itself changed, and when) ----

let contentSerial = 0;
let globalChangeSerial = 0;
const contentSerialByKey = new Map<string, number>();
let lastContentChangeFrame = Number.NEGATIVE_INFINITY;
let frame = 0;
let stateHeld = false;
const latencyProbes = new Map<
  string,
  { frame: number; activity: number; serial: number }
>();
let lastLatencyFrames: number | null = null;
let maxLatencyFrames = 0;

function effectiveSerial(key: string): number {
  return Math.max(contentSerialByKey.get(key) ?? 0, globalChangeSerial);
}

function recordContentChange(id: number, what: string): void {
  contentSerial += 1;
  const key = String(id);
  contentSerialByKey.set(key, contentSerial);
  lastContentChangeFrame = frame;
  if (verbose()) log(what);
  // An idle change to a MOUNTED row must commit within the frame budget.
  if (!nativeActive() && !stateHeld && smoothPending === 0 && slotOf(key)) {
    latencyProbes.set(key, {
      frame,
      activity: activitySerial,
      serial: contentSerial,
    });
  }
}

function recordWidthChange(): void {
  contentSerial += 1;
  globalChangeSerial = contentSerial;
  lastContentChangeFrame = frame;
  latencyProbes.clear();
}

// --- The runtime ------------------------------------------------------------

let list: VirtualList<Item>;
let canvas: HTMLElement | null = null;
let booted = false;
let commits = 0;
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

function startLoad(edge: "start" | "end", context: ReachContext): void {
  if (!booted || !checkbox("auto-load").checked) return;
  if (loading[edge] || chunksLeft[edge] <= 0) return;
  loading[edge] = true;
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
    list.setItems(items, { anchor: "viewport" });
    scheduleStatus();
  }, LOAD_LATENCY_MS);
  // What a real host does with fetch(url, { signal }).
  context.signal.addEventListener("abort", () => {
    if (!loading[edge]) return;
    window.clearTimeout(timer);
    loading[edge] = false;
    loadsAborted += 1;
    log(`ABORT load ${edge} (signal)`, "warn");
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
  } else if (verbose() && previous.count !== state.count) {
    log(`state count=${state.count} total=${Math.round(state.totalSize)}`);
  }
  scheduleStatus();
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
  });
  canvas = viewport.firstElementChild as HTMLElement | null;
  if (!canvas) throw new Error("runtime canvas not found");
  observeCanvas(canvas);
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
let anchorRecord: { key: string; top: number; atEnd: boolean } | null = null;

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
  const added = new Set<Element>();
  let removed = 0;
  const firstOldStyle = new Map<Element, string | null>();
  for (const record of records) {
    if (record.type === "childList") {
      if (record.target !== canvas) continue;
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          added.add(node);
          knownSlots.add(node);
        }
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
    if (heightFrom !== null && heightTo !== null && heightFrom !== heightTo) {
      heightChanges.push({ key, from: heightFrom, to: heightTo });
    }
    if (parseOffset(oldStyle) !== parseOffset(style)) offsetChanges += 1;
  }

  const geometryChanged =
    canvasChange !== null || heightChanges.length > 0 || offsetChanges > 0;
  if (!geometryChanged) {
    if (verbose() && (added.size > 0 || removed > 0)) {
      log(`window +${added.size}/−${removed}`);
    }
    return;
  }

  commits += 1;
  // Idle streaming commits every few frames; log only settle commits (the
  // ones that cleared a held phase) unless verbose.
  if (verbose() || heldCleared) {
    heldCleared = false;
    log(
      `COMMIT canvas ${canvasChange ? `${Math.round(canvasChange.from ?? 0)}→${Math.round(canvasChange.to ?? 0)}` : "same"} · ${heightChanges.length} heights · ${offsetChanges} offsets · slots +${added.size}/−${removed}`,
      "good",
    );
  }

  // G: geometry is immutable under a live scroll phase.
  if (!commandIssuing) {
    if (nativeActive(now)) {
      violation(
        "G",
        `geometry changed during native scroll (${heightChanges.length} heights, ${offsetChanges} offsets, canvas ${canvasChange ? "changed" : "same"})`,
      );
    } else if (glideMoving(now)) {
      violation("G", "geometry changed while a glide was still moving");
    }
  }

  // T: a height commits once per change, the latest.
  for (const change of heightChanges) {
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
  if (!commandIssuing && !nativeActive(now) && !glideMoving(now)) {
    checkAnchor(canvasChange, heightChanges);
  }
  expectAnchoredCommit = false;
  checkOverlap();
  scheduleStatus();
}

function checkSlotClips(slot: Element): void {
  const overflow = getComputedStyle(slot).overflowY;
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

function captureAnchor(): { key: string; top: number; atEnd: boolean } | null {
  const viewportTop = viewport.getBoundingClientRect().top;
  let best: { key: string; top: number } | null = null;
  for (const { slot, key } of mountedSlots()) {
    const rect = slot.getBoundingClientRect();
    if (rect.bottom <= viewportTop + 0.5) continue;
    const top = rect.top - viewportTop;
    if (best === null || top < best.top) best = { key, top };
  }
  return best === null ? null : { ...best, atEnd: atEndNow() };
}

function checkAnchor(
  canvasChange: { from: number | null; to: number | null } | null,
  heightChanges: readonly { key: string; from: number; to: number }[],
): void {
  const record = anchorRecord;
  if (!record) return;
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
    if (verbose()) log(`anchor #${record.key} unmounted/removed across commit`);
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
  if (Math.abs(top - record.top) > PX_EPSILON) {
    violation(
      "A",
      `anchor #${record.key} moved ${record.top.toFixed(1)}→${top.toFixed(1)}px across a commit`,
    );
  }
}

// --- Per-frame telemetry: quiet-state consistency ---------------------------

const staleFrames = new Map<string, number>();
const staleReported = new Set<string>();
let clippedNow = 0;
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

  if (quietFrame && !commandIssuing) anchorRecord = captureAnchor();

  const quiet =
    !nativeActive(now) &&
    !stateHeld &&
    smoothPending === 0 &&
    frame - lastContentChangeFrame > QUIET_FRAMES;

  let clipped = 0;
  for (const { slot, key, h } of mountedSlots()) {
    const row = slot.firstElementChild as HTMLElement | null;
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    const mismatch = Math.abs(rect.height - h) > PX_EPSILON;
    if (mismatch) clipped += 1;

    const probe = latencyProbes.get(key);
    if (probe) {
      if (probe.activity !== activitySerial || stateHeld) {
        latencyProbes.delete(key);
      } else if (!mismatch) {
        const frames = frame - probe.frame;
        lastLatencyFrames = frames;
        maxLatencyFrames = Math.max(maxLatencyFrames, frames);
        latencyProbes.delete(key);
        if (frames > IDLE_COMMIT_FRAME_BUDGET) {
          violation(
            "L",
            `idle change to #${key} committed after ${frames} frames`,
          );
        }
      }
    }

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
  clippedNow = clipped;

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
    stat.commits.textContent = String(commits);
    stat.violations.textContent = String(violations);
    stat.violations.className = `val${violations > 0 ? " bad" : ""}`;
    stat.nodes.textContent = `${created}/${destroyed}/${created - destroyed}`;
    stat.clipped.textContent = String(clippedNow);
    stat.latency.textContent =
      lastLatencyFrames === null
        ? "–"
        : `${lastLatencyFrames}f / max ${maxLatencyFrames}f`;
    stat.streams.textContent = `${streams.size} active`;
    stat.images.textContent = `${imagesPending}/${imagesLoaded}`;
    stat.loads.textContent = `T:${chunksLeft.start} B:${chunksLeft.end} left · ${loadsAborted} aborted`;
  });
}

// --- Content generators (the adversary) -----------------------------------

const random = mulberry32(0x9e3779b9);
const streams = new Map<number, number>();

function changeContent(item: Item, what: string): void {
  if (checkbox("channel").value === "items") {
    const updated = { ...item, version: item.version + 1 };
    replaceItem(updated);
    list.setItems(items);
  } else {
    item.version += 1;
    const row = elementById.get(item.id);
    if (row) update(item, row);
  }
  recordContentChange(item.id, what);
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

function startStream(id: number): void {
  log(`stream #${id} start`);
  const tick = () => {
    const item = itemById.get(id);
    if (!item || !checkbox("streaming").checked || !items.includes(item)) {
      streams.delete(id);
      return;
    }
    const burst = 1 + Math.floor(random() * 3);
    for (let count = 0; count < burst; count++)
      item.words.push(pick(WORDS, random));
    changeContent(item, `stream #${id} +${burst} words`);
    if (item.words.length >= item.streamTarget) {
      streams.delete(id);
      log(`stream #${id} done`);
      maintainStreams();
      scheduleStatus();
      return;
    }
    streams.set(id, window.setTimeout(tick, 60 + random() * 160));
  };
  streams.set(id, window.setTimeout(tick, 100));
  scheduleStatus();
}

function stopStreams(): void {
  for (const timer of streams.values()) window.clearTimeout(timer);
  streams.clear();
}

function flipToggle(id: number, why: string): void {
  const item = itemById.get(id);
  if (!item) return;
  item.open = !item.open;
  changeContent(
    item,
    `toggle #${id} ${item.open ? "open" : "closed"} (${why})`,
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
  list.setItems(items);
}

function burst(): void {
  log("burst: 5 superseding setItems", "mark");
  for (let count = 0; count < 5; count++) {
    const item = pick(items, random);
    item.words.push(pick(WORDS, random));
    const updated = { ...item, version: item.version + 1 };
    replaceItem(updated);
    list.setItems(items);
    recordContentChange(item.id, `burst #${item.id}`);
  }
}

// --- Commands ---------------------------------------------------------------

function issue<T>(work: () => T): T {
  commandIssuing = true;
  try {
    return work();
  } finally {
    commandIssuing = false;
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
  committedSerial.clear();
  staleFrames.clear();
  staleReported.clear();
  latencyProbes.clear();
  createList();
  // Start mid-list so both edge zones need a deliberate scroll.
  const middle = items[Math.floor(items.length / 2)];
  if (middle) void issue(() => list.scrollTo(String(middle.id)));
  booted = true;
  maintainStreams();
  log("booted mid-list", "mark");
  scheduleStatus();
}

function reset(): void {
  stopStreams();
  const before = { created, destroyed };
  list.dispose();
  canvasObserver?.disconnect();
  canvas = null;
  const live = created - destroyed;
  if (live !== 0) {
    violation(
      "D",
      `${live} element(s) leaked at dispose (created ${before.created}, destroyed ${destroyed})`,
    );
  } else {
    log(`dispose: every element destroyed exactly once (${destroyed})`, "good");
  }
  elementById.clear();
  boot();
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
mustGet("clear").addEventListener("click", () => {
  logElement.replaceChildren();
  traceRing.length = 0;
});
mustGet("copy").addEventListener("click", () => {
  const trace = `${navigator.userAgent}\nstrategy=${stat.strategy.textContent}\nviolations=${violations}\n${traceRing.join("\n")}`;
  void navigator.clipboard?.writeText(trace).then(
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
