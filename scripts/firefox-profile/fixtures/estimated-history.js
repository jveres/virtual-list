import {
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from "@tanstack/virtual-core";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const frame = () => new Promise(requestAnimationFrame);
const documentId = crypto.randomUUID();
const errors = [];
let adapter = null;
let items = [];
let mode = null;
let variant = null;
let result = null;
let renders = 0;
let destroyed = 0;
let scrolls = 0;
let ends = 0;
let distance = 0;
let previousTop = 0;
let activity = 0;
let completed = false;
const rows = new Map();
function require(value, message) {
  if (!value) throw new Error(message);
}
addEventListener("error", (event) => errors.push(event.message));
addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason)),
);
viewport.addEventListener("scroll", () => {
  scrolls++;
  distance += Math.abs(viewport.scrollTop - previousTop);
  previousTop = viewport.scrollTop;
});
viewport.addEventListener("scrollend", () => ends++);
function makeRow(item) {
  const row = document.createElement("article");
  row.dataset.index = String(item.id);
  for (let i = 0; i < item.paragraphs; i++) {
    const p = document.createElement("p");
    p.textContent = `${item.id}:${i} ${item.text}`;
    row.append(p);
  }
  const pre = document.createElement("pre");
  pre.textContent = item.code;
  row.append(pre);
  return row;
}
function render(item) {
  const existing = rows.get(item.id);
  if (existing) return existing;
  const row = makeRow(item);
  rows.set(item.id, row);
  renders++;
  activity++;
  return row;
}
function estimatedSize(index) {
  const item = items[index];
  // A metadata-only line-wrap approximation, not measured or declared height.
  // Use the same formula for every width; no oracle result feeds this control.
  const charsPerLine = (Number.parseFloat(viewport.style.width) - 24) / 7;
  return (
    25 +
    item.paragraphs *
      (12 + 20 * Math.ceil((item.text.length + 10) / charsPerLine)) +
    18 * 4
  );
}
function estimatedAdapter() {
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  const block = document.createElement("div");
  block.style.cssText = "position:absolute;top:0;left:0;width:100%";
  canvas.append(block);
  viewport.append(canvas);
  // This control owns scroll corrections; do not combine them with UA anchoring.
  viewport.style.overflowAnchor = "none";
  let pending = false;
  let active = true;
  let instance;
  const measured = new Set();
  function schedule() {
    activity++;
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (active) draw();
    });
  }
  function draw() {
    const visible = instance.getVirtualItems();
    const keep = new Set(visible.map((item) => item.index));
    for (const node of [...block.children])
      if (!keep.has(Number(node.dataset.index))) node.remove();
    let cursor = block.firstChild;
    for (const item of visible) {
      const node = render(items[item.index]);
      if (node !== cursor) block.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    canvas.style.height = `${instance.getTotalSize()}px`;
    block.style.transform = `translateY(${visible[0]?.start ?? 0}px)`;
    instance.measureElement(null);
    for (const node of block.children) instance.measureElement(node);
  }
  instance = new Virtualizer({
    count: items.length,
    getScrollElement: () => viewport,
    getItemKey: (index) => items[index].id,
    estimateSize: estimatedSize,
    overscan: 0,
    observeElementRect,
    observeElementOffset,
    useScrollendEvent: true,
    measureElement(node, entry, owner) {
      result.measurements++;
      measured.add(Number(node.dataset.index));
      return measureElement(node, entry, owner);
    },
    scrollToFn(offset, options, owner) {
      result.scrollWrites++;
      if (options.adjustments) result.correctionWrites++;
      elementScroll(offset, options, owner);
    },
    onChange: schedule,
  });
  const cleanup = instance._didMount();
  instance._willUpdate();
  draw();
  return {
    total: () => instance.getTotalSize(),
    busy: () => pending,
    jump: (index, align) =>
      instance.scrollToIndex(index, { align, behavior: "auto" }),
    position: (index) =>
      instance.getVirtualItems().find((item) => item.index === index)?.start,
    measured: () => measured.size,
    invalidateWidth() {
      const offset = instance.scrollOffset ?? 0;
      const anchor = instance
        .getVirtualItems()
        .find((item) => item.end > offset);
      const inset = anchor ? offset - anchor.start : 0;
      measured.clear();
      instance.measure();
      if (anchor) {
        instance.scrollToIndex(anchor.index, {
          align: "start",
          behavior: "auto",
        });
        if (inset) instance.scrollBy(inset, { behavior: "auto" });
      }
      draw();
    },
    dispose() {
      active = false;
      cleanup();
      destroyed += rows.size;
      canvas.remove();
    },
  };
}
async function exactAdapter() {
  const list = createVirtualList(viewport, {
    items: [],
    key: (item) => String(item.id),
    render,
    onDestroy() {
      destroyed++;
    },
    boot: "start",
    overscanPx: 0,
    pinning: false,
  });
  try {
    require(await list.updateWindow(() => ({
      items,
      anchor: "none",
    })), "Exact preparation canceled");
  } catch (error) {
    // prepare() cannot own this adapter until its asynchronous work succeeds.
    list.dispose();
    throw error;
  }
  return {
    total: () => list.state.totalSize,
    busy: () => list.state.held,
    jump: (index, align) =>
      align === "end" && index === items.length - 1
        ? list.scrollTo("end")
        : list.scrollTo(String(index), { align: "start" }),
    position: (index) => list.positionOf(String(index)).top,
    measured: () => items.length,
    invalidateWidth() {},
    dispose: () => list.dispose(),
  };
}
async function settle() {
  const start = performance.now();
  let last = activity;
  let stable = 0;
  while (performance.now() - start < 15000) {
    await frame();
    stable = !adapter?.busy() && activity === last ? stable + 1 : 0;
    last = activity;
    if (stable >= 8) return;
  }
  throw new Error("History did not settle");
}
async function phase(label, operation) {
  let previous = await frame();
  const gaps = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const now = await frame();
      gaps.push(now - previous);
      previous = now;
    }
  })();
  performance.mark(`structure:${mode}:${label}:start`);
  const start = performance.now();
  let workMs;
  let settledMs;
  try {
    await operation();
    workMs = performance.now() - start;
    await settle();
    settledMs = performance.now() - start;
  } finally {
    performance.mark(`structure:${mode}:${label}:end`);
    sampling = false;
    await sampler;
  }
  result.phases.push({
    label,
    workMs,
    settledMs,
    gaps: {
      count: gaps.length,
      max: Math.max(...gaps),
      over25: gaps.filter((v) => v > 25).length,
    },
  });
}
function checkpoint(label, target) {
  const box = viewport.getBoundingClientRect();
  const mounted = [...viewport.querySelectorAll("article")];
  const visible = mounted.filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > box.top + 1 && rect.top < box.bottom - 1;
  });
  require(visible.length > 0, "No readable rows");
  const first = visible[0];
  const last = visible.at(-1);
  for (let i = 1; i < visible.length; i++) {
    require(Number(visible[i].dataset.index) ===
      Number(visible[i - 1].dataset.index) +
        1, "Visible history order differs");
    require(Math.abs(
      visible[i].getBoundingClientRect().top -
        visible[i - 1].getBoundingClientRect().bottom,
    ) < 1.05, "Visible rows have a gap or overlap");
  }
  require(first.getBoundingClientRect().top <= box.top + 1.05 &&
    last.getBoundingClientRect().bottom >=
      box.bottom - 1.05, "Viewport is not covered");
  const targetRow = target === undefined ? null : rows.get(target);
  result.checkpoints.push({
    label,
    width: Number.parseFloat(viewport.style.width),
    total: adapter.total(),
    rendered: renders,
    measured: adapter.measured(),
    first: Number(first.dataset.index),
    firstOffset: first.getBoundingClientRect().top - box.top,
    firstPosition: adapter.position(Number(first.dataset.index)),
    endDistance:
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    target,
    targetOffset: targetRow?.isConnected
      ? targetRow.getBoundingClientRect().top - box.top
      : null,
    targetText: targetRow?.isConnected ? targetRow.textContent : null,
  });
}
function release() {
  adapter?.dispose();
  adapter = null;
  rows.clear();
  items = [];
  require(renders === destroyed, "Unbalanced history lifecycle");
  require(viewport.childElementCount === 0, "History canvas survived disposal");
  viewport.style.overflowAnchor = "";
}
async function prepare(nextMode, nextVariant) {
  release();
  mode = nextMode;
  variant = nextVariant;
  require(["history-1000", "history-5000"].includes(
    mode,
  ), "Unknown history case");
  require(["plain", "estimated"].includes(variant), "Unknown history variant");
  viewport.style.width = "1100px";
  renders = destroyed = scrolls = ends = distance = previousTop = activity = 0;
  completed = false;
  result = {
    mode,
    variant,
    phases: [],
    checkpoints: [],
    measurements: 0,
    scrollWrites: 0,
    correctionWrites: 0,
  };
  items = Array.from({ length: Number(mode.split("-")[1]) }, (_, id) => ({
    id,
    paragraphs: 2 + (id % 7),
    text: "A deterministic rich history row wraps its readable content at the available width. ".repeat(
      2 + (id % 5),
    ),
    code: Array.from(
      { length: 4 },
      (_, line) => `const value${line} = records[${id}].value + ${line};`,
    ).join("\n"),
  }));
  await phase("prepare", async () => {
    adapter =
      variant === "estimated" ? estimatedAdapter() : await exactAdapter();
  });
  checkpoint("initial");
}
async function oracle() {
  // Validation runs after all timed work, so it cannot prime either variant.
  const root = document.createElement("div");
  root.style.cssText =
    "position:absolute;top:0;left:-20000px;visibility:hidden;pointer-events:none";
  const copies = items.map(makeRow);
  root.append(...copies);
  document.body.append(root);
  try {
    for (const width of [1100, 650]) {
      root.style.width = `${width}px`;
      let total = 0;
      const tops = copies.map((row) => {
        const top = total;
        total += Math.round(row.getBoundingClientRect().height);
        return top;
      });
      for (const point of result.checkpoints.filter(
        (point) => point.width === width,
      )) {
        point.exactTotal = total;
        point.totalError = point.total - total;
        point.firstPositionError = point.firstPosition - tops[point.first];
        if (variant === "plain")
          require(Math.abs(point.totalError) < 1.05 &&
            Math.abs(point.firstPositionError) <
              1.05, "Exact geometry differs from oracle");
      }
    }
  } finally {
    root.remove();
  }
}
async function exercise(cycles = 4) {
  for (let round = 0; round < cycles; round++) {
    const target = Math.floor(
      (items.length - 1) * [0.75, 0.25, 0.9, 0.5][round % 4],
    );
    await phase(`jump-${round}`, async () => {
      await adapter.jump(target, "start");
    });
    checkpoint(`jump-${round}`, target);
    require(result.checkpoints.at(-1).targetOffset !== null &&
      Math.abs(result.checkpoints.at(-1).targetOffset) <
        1.05, "Jump target did not align");
  }
  const anchor = result.checkpoints.at(-1).first;
  await phase("resize", async () => {
    viewport.style.width = "650px";
    adapter.invalidateWidth();
  });
  checkpoint("resized", anchor);
  require(result.checkpoints.at(-1).targetOffset !== null &&
    Math.abs(result.checkpoints.at(-1).targetOffset) <
      1.05, "Resize lost the reading anchor");
  await phase("end", async () => {
    await adapter.jump(items.length - 1, "end");
  });
  checkpoint("end", items.length - 1);
  require(result.checkpoints.at(-1).endDistance <=
    1.05, "Jump to end is inaccurate");
  await phase("start", async () => {
    await adapter.jump(0, "start");
  });
  checkpoint("start", 0);
  require(distance > 10000 &&
    scrolls > 2 &&
    ends > 0, "Missing history movement");
  await oracle();
  completed = true;
  status.textContent = `${mode}/${variant}: completed`;
}
globalThis.__renderingWorkload = {
  prepare,
  exercise,
  release,
  snapshot: () => ({
    documentId,
    mode,
    variant,
    completed,
    result,
    errors,
    renders,
    destroyed,
    scrolls,
    ends,
    distance,
    activeItems: items.length,
  }),
};
