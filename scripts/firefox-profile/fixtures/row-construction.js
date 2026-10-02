import { initMarkdown, renderMarkdown } from "/demos/shared/markdown.ts";
import { stageMessageLayout } from "/demos/streaming/staged-message.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const frame = () => new Promise(requestAnimationFrame);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const documentId = crypto.randomUUID();
let list = null;
let row = null;
let mode = null;
let variant = null;
let renders = 0;
let destroyed = 0;
let scrolls = 0;
let ends = 0;
let distance = 0;
let previousTop = 0;
let completed = false;
let result = null;
let originalHtml = "";
let originalNodes = [];
let selectedText = "";
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
const line = (i) =>
  `const item${i} = rows.map((row) => ({ id: row.id, value: row.value + ${i} }));`;
function markdown() {
  if (mode === "construct-code")
    return `\`\`\`typescript\n${Array.from({ length: 3000 }, (_, i) => line(i)).join("\n")}\n\`\`\``;
  if (mode === "construct-table")
    return (
      "| Key | First value | Second value | Details |\n| --- | --- | --- | --- |\n" +
      Array.from(
        { length: 1200 },
        (_, i) =>
          `| ${i} | value-${i} | \`record[${i}]\` | ${"A wrapping table cell. ".repeat(5)} |`,
      ).join("\n")
    );
  return Array.from(
    { length: 120 },
    (_, i) =>
      `## Section ${i}\n\n${"A completed reply explains a deterministic data structure. ".repeat(5)}\n\n\`\`\`typescript\n${Array.from({ length: 25 }, (_, j) => line(i * 25 + j)).join("\n")}\n\`\`\``,
  ).join("\n\n");
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    max: sorted.at(-1),
    over25: sorted.filter((v) => v > 25).length,
  };
}
function nestedStage(element) {
  const code = element.querySelector("pre > code");
  const body = element.querySelector("tbody");
  const target =
    code?.childNodes.length >= 2000
      ? code
      : body?.rows.length >= 600
        ? body
        : null;
  if (!target) return stageMessageLayout(element);
  const limit = target === code ? 1000 : 100;
  const remaining = document.createDocumentFragment();
  while (target.firstChild) remaining.append(target.firstChild);
  result.nestedTarget = target.tagName;
  return {
    next() {
      const batch = document.createDocumentFragment();
      let units = 0;
      while (remaining.firstChild && units < limit) {
        const node = remaining.firstChild;
        if (target === code || node.nodeType === Node.ELEMENT_NODE) units++;
        batch.append(node);
      }
      target.append(batch);
      return { done: !remaining.firstChild, value: undefined };
    },
    return() {
      target.append(remaining);
      return { done: true, value: undefined };
    },
  };
}
function selectText() {
  const range = document.createRange();
  range.selectNodeContents(row);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString().replace(/\s+/g, "");
  selection.removeAllRanges();
  return text;
}
function validate() {
  require(row.isConnected, "Large row is detached");
  require(row.innerHTML ===
    originalHtml, "Staging changed the completed markup");
  const nodes = [...row.querySelectorAll("*")];
  require(nodes.length === originalNodes.length &&
    nodes.every(
      (node, i) => node === originalNodes[i],
    ), "Staging changed element identity or order");
  require(Math.abs(
    list.positionOf("large").height - row.getBoundingClientRect().height,
  ) < 1.05, "Staged row geometry differs");
}
function release() {
  list?.dispose();
  list = row = null;
  originalNodes = [];
  originalHtml = selectedText = "";
  require(viewport.childElementCount === 0, "Canvas remains after disposal");
  require(renders === destroyed, "Unbalanced staged row lifecycle");
}
async function prepare(nextMode, nextVariant) {
  release();
  mode = nextMode;
  variant = nextVariant;
  require(["construct-blocks", "construct-code", "construct-table"].includes(
    mode,
  ), "Unknown construction case");
  require(["plain", "nested"].includes(
    variant,
  ), "Unknown construction variant");
  viewport.style.width = "1100px";
  renders = destroyed = scrolls = ends = distance = previousTop = 0;
  completed = false;
  result = { mode, variant, stages: 0, maxStageMs: 0, phases: [] };
  const source = markdown();
  const items = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `before-${i}` })),
    { id: "large" },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `after-${i}` })),
  ];
  list = createVirtualList(viewport, {
    items: [],
    key: (item) => item.id,
    boot: "start",
    pinning: false,
    overscanPx: 400,
    render(item) {
      renders++;
      const element = document.createElement("article");
      if (item.id !== "large") {
        element.className = "compact";
        element.textContent = `Surrounding row ${item.id}`;
        return element;
      }
      row = element;
      mark("markup", "start");
      const start = performance.now();
      const html = renderMarkdown(source);
      result.markdownMs = performance.now() - start;
      mark("markup", "end");
      mark("dom", "start");
      const domStart = performance.now();
      element.innerHTML = `<div class="message-content"><div class="markdown-viewer"><div class="markdown">${html}</div></div></div>`;
      result.domMs = performance.now() - domStart;
      mark("dom", "end");
      originalHtml = element.innerHTML;
      originalNodes = [...element.querySelectorAll("*")];
      return element;
    },
    stage(item, element) {
      if (item.id !== "large") return;
      const iterator =
        variant === "nested"
          ? nestedStage(element)
          : stageMessageLayout(element);
      if (!iterator) return;
      return {
        next() {
          const start = performance.now();
          const next = iterator.next();
          result.stages++;
          result.maxStageMs = Math.max(
            result.maxStageMs,
            performance.now() - start,
          );
          return next;
        },
        return() {
          return iterator.return();
        },
      };
    },
    onDestroy() {
      destroyed++;
    },
  });
  const gaps = [];
  let previous = await frame();
  let sampling = true;
  const sample = async () => {
    while (sampling) {
      const now = await frame();
      gaps.push(now - previous);
      previous = now;
    }
  };
  const sampler = sample();
  mark("prepare", "start");
  const start = performance.now();
  try {
    require(await list.updateWindow(() => ({
      items,
      anchor: "none",
    })), "Construction was canceled");
    result.readyMs = performance.now() - start;
    await frame();
    await frame();
  } finally {
    mark("prepare", "end");
    sampling = false;
    await sampler;
  }
  result.preparationGaps = distribution(gaps);
  if (variant === "nested" && mode !== "construct-blocks")
    require(result.nestedTarget &&
      result.stages > 1, "Nested staging was not exercised");
  await list.scrollTo("large", { align: "start" });
  await pause(150);
  validate();
  selectedText = selectText();
  result.selectedCharacters = selectedText.length;
  result.nodes = originalNodes.length;
}
async function exercise(cycles = 4) {
  for (let round = 0; round < cycles; round++) {
    const base = list.positionOf("large").top;
    const extent = list.positionOf("large").height - viewport.clientHeight;
    mark(`traverse-${round}`, "start");
    for (let i = 0; i <= 24; i++) {
      viewport.scrollTop = base + extent * (round % 2 ? 1 - i / 24 : i / 24);
      await frame();
      await frame();
    }
    mark(`traverse-${round}`, "end");
  }
  viewport.style.width = "650px";
  await pause(700);
  validate();
  require(selectText() === selectedText, "Selection changed after resize");
  await list.scrollTo("end");
  await pause(80);
  await list.scrollTo("start");
  await pause(80);
  require(distance > 10000 &&
    scrolls > 2 &&
    ends > 0, "Missing construction traversal");
  completed = true;
  status.textContent = `${mode}/${variant}: completed`;
}
await initMarkdown();
globalThis.__renderingWorkload = {
  prepare,
  exercise,
  release,
  checkCancellation(steps) {
    const copy = row.cloneNode(true);
    const before = copy.innerHTML;
    const nodes = [...copy.querySelectorAll("*")];
    const iterator = nestedStage(copy);
    require(iterator, "Missing cancellation iterator");
    for (let i = 0; i < steps; i++) iterator.next();
    iterator.return();
    require(iterator.next().done, "Canceled stage has more work");
    require(copy.innerHTML === before, "Cancellation lost withheld content");
    const restored = [...copy.querySelectorAll("*")];
    require(restored.length === nodes.length &&
      restored.every(
        (node, i) => node === nodes[i],
      ), "Cancellation changed element identity or order");
  },
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
