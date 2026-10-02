import { initMarkdown, renderMarkdown } from "/demos/shared/markdown.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const frame = () => new Promise(requestAnimationFrame);
// Native-flow rows use the runtime's whole-CSS-pixel height quantization.
const pixelTolerance = () => 1.05;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const documentId = crypto.randomUUID();
let list = null;
let mode = null;
let variant = "plain";
let renders = 0;
let destroyed = 0;
let scrolls = 0;
let ends = 0;
let distance = 0;
let previousTop = 0;
let result = null;
let completed = false;
let large = null;
let source = "";
let blocks = [];
let beforeHeights = [];
let renderMs = 0;
let cacheMs = 0;
let initialMs = 0;
let selectedText = "";
let autoEvents = 0;
let skippedEvents = 0;

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
const mark = (name, edge) =>
  performance.mark(`structure:${mode}:${name}:${edge}`);
const line = (index) =>
  `const item${index} = rows.map((row) => ({ id: row.id, value: row.value + ${index} }));`;
function markdown(kind) {
  if (kind === "code")
    return `\`\`\`typescript\n${Array.from({ length: 3000 }, (_, i) => line(i)).join("\n")}\n\`\`\``;
  if (kind === "table") {
    const header =
      "| Key | First value | Second value | Details |\n| --- | --- | --- | --- |\n";
    return (
      header +
      Array.from(
        { length: 1200 },
        (_, i) =>
          `| ${i} | value-${i} | \`record[${i}]\` | ${"A wrapping table cell. ".repeat(5)} |`,
      ).join("\n")
    );
  }
  const count = kind === "ordinary" ? 12 : 120;
  return Array.from(
    { length: count },
    (_, i) =>
      `## Section ${i}\n\n${"A completed reply explains a deterministic data structure. ".repeat(5)}\n\n\`\`\`typescript\n${Array.from({ length: 25 }, (_, j) => line(i * 25 + j)).join("\n")}\n\`\`\``,
  ).join("\n\n");
}
function release() {
  list?.dispose();
  list = null;
  large = null;
  blocks = [];
  source = "";
  selectedText = "";
  beforeHeights = [];
  require(viewport.childElementCount === 0, "Canvas remains after disposal");
  require(renders === destroyed, "Unbalanced row lifecycle");
}
function disableSkipping() {
  for (const block of blocks) {
    block.style.contentVisibility = "visible";
    block.style.containIntrinsicBlockSize = "none";
  }
}
async function selectText() {
  const range = document.createRange();
  range.selectNodeContents(large);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  await frame();
  await frame();
  const text = selection.toString().replace(/\s+/g, "");
  selection.removeAllRanges();
  return text;
}
function rememberBlocks() {
  if (variant !== "skip") return;
  const start = performance.now();
  // One read pass, then one write pass. These costs belong to the candidate.
  const heights = blocks.map((block) => block.getBoundingClientRect().height);
  blocks.forEach((block, i) => {
    block.style.containIntrinsicBlockSize = `auto ${heights[i]}px`;
    block.style.contentVisibility = "auto";
  });
  cacheMs += performance.now() - start;
}
function renderLarge(item) {
  const row = document.createElement("article");
  row.dataset.key = item.id;
  if (item.id !== "large") {
    row.className = "compact";
    row.textContent = `Surrounding row ${item.id}`;
    return row;
  }
  const start = performance.now();
  row.className = "markdown-viewer";
  const content = document.createElement("div");
  content.className = "markdown";
  content.innerHTML = renderMarkdown(source);
  // Identical grouping in both variants keeps flow and margin behavior matched.
  const children = [...content.children];
  for (const child of children) {
    const block = document.createElement("div");
    block.className = "block";
    child.before(block);
    block.append(child);
    block.addEventListener("contentvisibilityautostatechange", (event) => {
      autoEvents++;
      if (event.skipped) skippedEvents++;
    });
    blocks.push(block);
  }
  row.append(content);
  large = row;
  renderMs += performance.now() - start;
  return row;
}
function renderResize(item) {
  const row = document.createElement("article");
  row.dataset.key = item.id;
  const index = Number(item.id);
  const paragraphs =
    mode === "uniform"
      ? 8
      : mode === "mixed"
        ? index % 16 === 0
          ? 300
          : 2
        : index === 160
          ? 2400
          : 2;
  for (let i = 0; i < paragraphs; i++) {
    const p = document.createElement("p");
    p.textContent = `${index}:${i} ${"A retained paragraph changes its line wrapping with the available width. ".repeat(5)}`;
    row.append(p);
  }
  return row;
}
async function settleWidth(timeout = 10000) {
  const start = performance.now();
  let sawHeld = false;
  let previous = await frame();
  const gaps = [];
  let stable = 0;
  while (performance.now() - start < timeout) {
    const now = await frame();
    gaps.push(now - previous);
    previous = now;
    sawHeld ||= list.state.held;
    stable = list.state.held ? 0 : stable + 1;
    if (stable >= 8 && (sawHeld || performance.now() - start > 300))
      return { ms: performance.now() - start, sawHeld, gaps };
  }
  throw new Error("Width work did not settle");
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    total: sorted.reduce((a, b) => a + b, 0),
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
    over25: sorted.filter((x) => x > 25).length,
  };
}
async function prepare(nextMode, nextVariant) {
  release();
  mode = nextMode;
  variant = nextVariant;
  require([
    "blocks",
    "code",
    "table",
    "ordinary",
    "uniform",
    "mixed",
    "spike",
  ].includes(mode), "Unknown rendering case");
  require(["plain", "skip"].includes(variant), "Unknown rendering variant");
  viewport.style.width = "1100px";
  renders = destroyed = scrolls = ends = distance = 0;
  renderMs = cacheMs = autoEvents = skippedEvents = 0;
  previousTop = 0;
  result = null;
  completed = false;
  const resize = ["uniform", "mixed", "spike"].includes(mode);
  if (!resize) source = markdown(mode);
  const items = resize
    ? Array.from({ length: 320 }, (_, i) => ({ id: String(i) }))
    : [
        ...Array.from({ length: 12 }, (_, i) => ({ id: `before-${i}` })),
        { id: "large" },
        ...Array.from({ length: 12 }, (_, i) => ({ id: `after-${i}` })),
      ];
  mark("prepare", "start");
  const start = performance.now();
  list = createVirtualList(viewport, {
    items,
    key: (item) => item.id,
    boot: "start",
    pinning: false,
    overscanPx: 400,
    render(item) {
      renders++;
      return resize ? renderResize(item) : renderLarge(item);
    },
    onDestroy() {
      destroyed++;
    },
  });
  initialMs = performance.now() - start;
  mark("prepare", "end");
  if (resize) {
    await list.scrollTo("120", { align: "start" });
    beforeHeights = items.map((item) => list.positionOf(item.id).height);
  } else {
    await list.scrollTo("large", { align: "start" });
    selectedText = await selectText();
    rememberBlocks();
  }
  await pause(150);
}
async function exercise(cycles = 4) {
  require(list, "No prepared list");
  const resize = ["uniform", "mixed", "spike"].includes(mode);
  const phases = [];
  if (resize) {
    for (let i = 0; i < cycles; i++) {
      const width = i % 2 ? 1100 : 650;
      mark(`resize-${i}`, "start");
      viewport.style.width = `${width}px`;
      const timing = await settleWidth();
      mark(`resize-${i}`, "end");
      let top = 0;
      for (let j = 0; j < beforeHeights.length; j++) {
        const position = list.positionOf(String(j));
        require(Math.abs(position.top - top) < 0.1, `Invalid prefix ${j}`);
        require(width === 1100
          ? Math.abs(position.height - beforeHeights[j]) < 0.1
          : position.height > beforeHeights[j], `Invalid resized height ${j}`);
        top += position.height;
      }
      require(Math.abs(list.state.totalSize - top) <
        0.1, "Wrong total after resize");
      const visible = viewport.querySelector("article");
      require(Math.abs(
        visible.getBoundingClientRect().height -
          list.positionOf(visible.dataset.key).height,
      ) < pixelTolerance(), "Mounted row geometry differs");
      phases.push({
        width,
        settledMs: timing.ms,
        gaps: distribution(timing.gaps),
      });
    }
  } else {
    const originalText = large.textContent;
    const initialHeight = list.positionOf("large").height;
    for (let round = 0; round < cycles; round++) {
      mark(`traverse-${round}`, "start");
      const base = list.positionOf("large").top;
      const extent = list.positionOf("large").height - viewport.clientHeight;
      let previous = await frame();
      const gaps = [];
      for (let i = 0; i <= 24; i++) {
        const fraction = round % 2 ? 1 - i / 24 : i / 24;
        viewport.scrollTop = base + extent * fraction;
        for (let tick = 0; tick < 2; tick++) {
          const now = await frame();
          gaps.push(now - previous);
          previous = now;
        }
      }
      mark(`traverse-${round}`, "end");
      require(Math.abs(list.positionOf("large").height - initialHeight) <
        pixelTolerance(), "Skipping changed the measured outer height");
      phases.push({ round, gaps: distribution(gaps) });
    }
    // Width invalidation includes the candidate's complete size-cache rebuild.
    mark("width", "start");
    disableSkipping();
    viewport.style.width = "650px";
    const timing = await settleWidth();
    rememberBlocks();
    mark("width", "end");
    phases.push({
      width: 650,
      settledMs: timing.ms,
      gaps: distribution(timing.gaps),
    });
    require(large.textContent ===
      originalText, "Content changed during traversal");
    const selectedAfter = await selectText();
    require(selectedAfter ===
      selectedText, `Full row selection lost content: ${JSON.stringify({ mode, variant, before: selectedText.length, after: selectedAfter.length })}`);
    disableSkipping();
    await pause(100);
    const revealedHeight = large.getBoundingClientRect().height;
    const reportedHeight = list.positionOf("large").height;
    require(Math.abs(revealedHeight - reportedHeight) <
      pixelTolerance(), `Revealed geometry differs: ${JSON.stringify({ mode, variant, revealedHeight, reportedHeight, connected: large.isConnected, top: viewport.scrollTop, held: list.state.held })}`);
  }
  await list.scrollTo("end");
  await pause(80);
  await list.scrollTo("start");
  await pause(80);
  require(distance > 10000 &&
    scrolls > 2 &&
    ends > 0, "Missing actual movement");
  result = {
    mode,
    variant,
    initialMs,
    renderMs,
    cacheMs,
    phases,
    autoEvents,
    skippedEvents,
    totalSize: list.state.totalSize,
    blocks: blocks.length,
    nodes: large?.querySelectorAll("*").length ?? 0,
  };
  completed = true;
  status.textContent = `${mode}: completed`;
}
await initMarkdown();
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
    activeItems: list?.state.count ?? 0,
  }),
};
