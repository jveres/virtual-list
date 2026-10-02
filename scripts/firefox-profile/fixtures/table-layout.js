import { initMarkdown, renderMarkdown } from "/demos/shared/markdown.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const frame = () => new Promise(requestAnimationFrame);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
const documentId = crypto.randomUUID();
let list = null;
let row = null;
let table = null;
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

function markdown() {
  const rows = Array.from(
    { length: 1200 },
    (_, i) =>
      `| ${i} | value-${i} | \`record[${i}]\` | ${mode === "table-long" && i % 12 === 0 ? "unbroken_".repeat(32) : "A wrapping table cell. ".repeat(5)} |`,
  );
  return (
    "| Key | First value | Second value | Details |\n| --- | --- | --- | --- |\n" +
    rows.join("\n")
  );
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
    over25: sorted.filter((value) => value > 25).length,
  };
}
async function settle(previous) {
  const start = performance.now();
  let stable = 0;
  const gaps = [];
  while (performance.now() - start < 10000) {
    const now = await frame();
    gaps.push(now - previous);
    previous = now;
    stable = list.state.held ? 0 : stable + 1;
    if (stable >= 8 && performance.now() - start > 300)
      return { ms: performance.now() - start, gaps: distribution(gaps) };
  }
  throw new Error("Table geometry did not settle");
}
async function contentHash() {
  const bytes = new TextEncoder().encode(table.textContent);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function validate() {
  require(row.isConnected, "Table row is detached during validation");
  require(table.rows.length === 1201, "Table rows were lost");
  require(table.querySelectorAll("td").length ===
    4800, "Table cells were lost");
  require(getComputedStyle(table).tableLayout ===
    (variant === "fixed" ? "fixed" : "auto"), "Wrong table algorithm");
  require(Math.abs(
    list.positionOf("table").height - row.getBoundingClientRect().height,
  ) < 1.05, "Cached table height differs");
  require(table.getBoundingClientRect().width <=
    row.clientWidth - 23, "Table exceeds its host width");
  for (const cell of table.querySelectorAll("th,td"))
    require(cell.scrollWidth <=
      cell.clientWidth + 1, "A constrained cell clips content");
  const range = document.createRange();
  range.selectNodeContents(table);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const selected = selection.toString().replace(/\s+/g, "");
  selection.removeAllRanges();
  require(selected ===
    table.textContent.replace(/\s+/g, ""), "Table selection lost text");
  return {
    height: list.positionOf("table").height,
    columns: [...table.rows[0].cells].map(
      (cell) => cell.getBoundingClientRect().width,
    ),
    textHash: await contentHash(),
    images: table.querySelectorAll("img").length,
  };
}
function release() {
  list?.dispose();
  list = row = table = null;
  require(viewport.childElementCount === 0, "Canvas remains after disposal");
  require(renders === destroyed, "Unbalanced table row lifecycle");
}
async function prepare(nextMode, nextVariant) {
  release();
  mode = nextMode;
  variant = nextVariant;
  require(["table-ordinary", "table-long", "table-images"].includes(
    mode,
  ), "Unknown constrained table case");
  require(["plain", "fixed"].includes(
    variant,
  ), "Unknown constrained table variant");
  viewport.style.width = "1100px";
  renders = destroyed = scrolls = ends = distance = previousTop = 0;
  completed = false;
  result = { mode, variant, phases: [] };
  const source = markdown();
  const items = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `before-${i}` })),
    { id: "table" },
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
      const element = document.createElement("article");
      element.dataset.key = item.id;
      if (item.id !== "table") {
        element.className = "compact";
        element.textContent = `Surrounding row ${item.id}`;
        return element;
      }
      row = element;
      element.className = `markdown-viewer constrained ${variant}`;
      const content = document.createElement("div");
      content.className = "markdown";
      const renderStart = performance.now();
      const html = renderMarkdown(source);
      result.markdownMs = performance.now() - renderStart;
      const domStart = performance.now();
      content.innerHTML = html;
      element.append(content);
      table = element.querySelector("table");
      const columns = document.createElement("colgroup");
      for (const width of [12, 20, 23, 45]) {
        const column = document.createElement("col");
        column.style.width = `${width}%`;
        columns.append(column);
      }
      table.prepend(columns);
      if (mode === "table-images") {
        for (let i = 1; i < table.rows.length; i += 12) {
          const image = document.createElement("img");
          // These rectangles exercise intrinsic image layout and are decorative.
          image.alt = "";
          image.width = 80;
          image.height = 32;
          image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="32"><rect width="80" height="32" fill="#426ca5"/></svg>')}`;
          table.rows[i].cells[1].append(image);
        }
      }
      result.domMs = performance.now() - domStart;
      return element;
    },
    onDestroy() {
      destroyed++;
    },
  });
  result.initialMs = performance.now() - start;
  mark("prepare", "end");
  await Promise.all(
    [...table.querySelectorAll("img")].map((image) => image.decode()),
  );
  await list.scrollTo("table", { align: "start" });
  await pause(150);
  result.initialGeometry = await validate();
}
async function exercise(cycles = 4) {
  for (let round = 0; round < cycles; round++) {
    const base = list.positionOf("table").top;
    const extent = list.positionOf("table").height - viewport.clientHeight;
    mark(`traverse-${round}`, "start");
    let previous = await frame();
    const gaps = [];
    for (let i = 0; i <= 24; i++) {
      viewport.scrollTop = base + extent * (round % 2 ? 1 - i / 24 : i / 24);
      for (let tick = 0; tick < 2; tick++) {
        const now = await frame();
        gaps.push(now - previous);
        previous = now;
      }
    }
    mark(`traverse-${round}`, "end");
    result.phases.push({ name: "traverse", round, gaps: distribution(gaps) });
    const beforeResize = await frame();
    mark(`resize-${round}`, "start");
    const width = round % 2 ? 1100 : 650;
    viewport.style.width = `${width}px`;
    const timing = await settle(beforeResize);
    mark(`resize-${round}`, "end");
    result.phases.push({
      name: "resize",
      width,
      ...timing,
      geometry: await validate(),
    });
    const beforeEdit = await frame();
    mark(`edit-${round}`, "start");
    for (let i = 1; i <= 25; i++)
      table.rows[i].cells[3].textContent += ` Live addition ${round}:${i}.`;
    list.remeasure("table");
    const edit = await settle(beforeEdit);
    mark(`edit-${round}`, "end");
    result.phases.push({
      name: "edit",
      round,
      ...edit,
      geometry: await validate(),
    });
  }
  await list.scrollTo("end");
  await pause(80);
  await list.scrollTo("start");
  await pause(80);
  require(distance > 10000 &&
    scrolls > 2 &&
    ends > 0, "Missing table traversal");
  result.totalSize = list.state.totalSize;
  completed = true;
  status.textContent = `${mode}/${variant}: completed`;
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
