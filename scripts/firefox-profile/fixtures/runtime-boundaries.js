import { createPagedWindow } from "/src/paging.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const frame = () => new Promise(requestAnimationFrame);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let completed = false;
let failure = null;
let running = null;
let list = null;
let pager = null;
const calls = { key: 0, height: 0, position: 0, pin: 0, render: 0 };
const clearCalls = () => {
  for (const key of Object.keys(calls)) calls[key] = 0;
};
const itemsFor = (count) =>
  Array.from({ length: count }, (_, i) => ({ id: String(i), version: 0 }));
function require(value, message) {
  if (!value) throw new Error(message);
}
function dispose() {
  pager?.dispose();
  pager = null;
  list?.dispose();
  list = null;
  require(viewport.childElementCount ===
    0, "Disposed canvas remains connected");
}
function render(item, existing) {
  calls.render++;
  const row = existing ?? document.createElement("div");
  row.className = "row";
  row.textContent = `Item ${item.id}: revision ${item.version}`;
  return row;
}
function begin(name) {
  status.textContent = name;
  performance.mark(`runtime-boundaries:${name}:start`);
}
function end(name) {
  performance.mark(`runtime-boundaries:${name}:end`);
  performance.measure(
    `runtime-boundaries:${name}`,
    `runtime-boundaries:${name}:start`,
    `runtime-boundaries:${name}:end`,
  );
}

async function editCase(mode, count) {
  dispose();
  viewport.style.width = "1100px";
  const items = itemsFor(count);
  list = createVirtualList(viewport, {
    items,
    key: (item) => {
      calls.key++;
      return item.id;
    },
    height: () => {
      calls.height++;
      return 80;
    },
    position:
      mode === "positioned"
        ? (item) => {
            calls.position++;
            return { top: Number(item.id) * 80, lane: 0 };
          }
        : undefined,
    pinning:
      mode === "pin-no-match"
        ? {
            match: () => {
              calls.pin++;
              return false;
            },
          }
        : false,
    boot: "start",
    overscanPx: 400,
    render,
  });
  if (mode === "pager") {
    pager = createPagedWindow({
      list,
      initial: {
        items,
        start: { available: false },
        end: { available: false },
      },
      key: (item) => item.id,
      maxItems: count,
      load: async () => {
        throw new Error("Unexpected paging request");
      },
      project: (rows) => rows,
      live: { project: (item) => item, key: (item) => item.id },
      keysOf: (item) => [item.id],
    });
  }
  const key = String(count / 2);
  await list.scrollTo(key, { align: "start" });
  await pause(100);
  const initialPosition = list.positionOf(key);
  const slotRender = () => {
    const element = document.createElement("div");
    element.style.height = "40px";
    element.textContent = "Boundary loader";
    return element;
  };
  const update = (version) => {
    if (mode === "edge-slot") {
      list.setEdgeSlot(
        "end",
        version % 2 ? { key: "loader", height: 40, render: slotRender } : null,
      );
    } else if (mode === "pager") {
      return pager.updateItemLive(key, (item) => ({ ...item, version }));
    } else {
      list.updateItem(key, { id: key, version }, { anchor: "none" });
    }
  };
  for (let i = 0; i < 10; i++) await update(i);
  await frame();
  clearCalls();
  const name = `${mode}-${count}`;
  begin(name);
  const durations = [];
  // One API operation per frame, with only operation-boundary timing reads.
  for (let i = 10; i < 70; i++) {
    await frame();
    const start = performance.now();
    await update(i);
    durations.push(performance.now() - start);
  }
  end(name);
  const counted = { ...calls };
  require(list.positionOf(key).top ===
    initialPosition.top, `${name}: position changed`);
  require(viewport.scrollTop ===
    initialPosition.top, `${name}: viewport moved`);
  if (mode !== "edge-slot") {
    require(list.elementOf(key)?.textContent ===
      `Item ${key}: revision 69`, `${name}: edit not committed`);
  }
  if (pager)
    require(pager.items[Number(key)].version === 69, "Pager source edit lost");
  const expectedTotal = count * 80 + (mode === "edge-slot" ? 40 : 0);
  require(list.state.totalSize === expectedTotal, `${name}: wrong total size`);
  const sorted = [...durations].sort((a, b) => a - b);
  results.push({
    name,
    count,
    operations: durations.length,
    totalMs: durations.reduce((a, b) => a + b, 0),
    p50Ms: sorted[30],
    p95Ms: sorted[57],
    maxMs: sorted.at(-1),
    calls: counted,
  });
}

async function resizeCase(count) {
  dispose();
  viewport.style.width = "1100px";
  const text =
    "A deterministic paragraph explains the retained row and its width-dependent layout. ".repeat(
      5,
    );
  list = createVirtualList(viewport, {
    items: itemsFor(count),
    key: (item) => item.id,
    boot: "start",
    pinning: false,
    overscanPx: 400,
    render() {
      const row = document.createElement("article");
      row.className = "measured";
      for (let p = 0; p < 8; p++) {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        row.append(paragraph);
      }
      return row;
    },
  });
  await list.scrollTo(String(count / 2), { align: "start" });
  await pause(200);
  const beforeHeight = list.positionOf("0").height;
  const name = `resize-${count}`;
  begin(name);
  let previous = await frame();
  const gaps = [];
  let heldSeen = false;
  let settledAfterMs = null;
  const start = performance.now();
  viewport.style.width = "650px";
  // The sampler reads cached state and frame timestamps, never DOM geometry.
  while (performance.now() - start < 1200) {
    const now = await frame();
    gaps.push(now - previous);
    previous = now;
    heldSeen ||= list.state.held;
    if (heldSeen && !list.state.held && settledAfterMs === null)
      settledAfterMs = performance.now() - start;
  }
  end(name);
  require(heldSeen && !list.state.held, `${name}: resize did not drain`);
  const height = list.positionOf("0").height;
  require(height > beforeHeight, `${name}: text did not reflow`);
  for (let i = 0; i < count; i++) {
    const position = list.positionOf(String(i));
    require(position.height === height &&
      Math.abs(position.top - i * height) <
        0.1, `${name}: stale geometry for ${i}`);
  }
  const mounted = viewport.querySelector(".measured");
  require(Math.abs(mounted.getBoundingClientRect().height - height) <
    0.1, `${name}: DOM and geometry differ`);
  require(list.state.totalSize === count * height, `${name}: incorrect total`);
  results.push({
    name,
    count,
    beforeHeight,
    height,
    heldSeen,
    settledAfterMs,
    maxFrameGapMs: Math.max(...gaps),
    gapsOver25Ms: gaps.filter((gap) => gap > 25),
    totalSize: list.state.totalSize,
  });
}

async function run() {
  try {
    for (const count of [1000, 10000]) {
      for (const mode of [
        "stacked",
        "positioned",
        "pin-no-match",
        "pager",
        "edge-slot",
      ]) {
        await editCase(mode, count);
      }
    }
    for (const count of [480, 1000]) await resizeCase(count);
    dispose();
    completed = true;
    status.textContent = "All runtime boundary checks passed";
  } catch (error) {
    failure = String(error?.stack ?? error);
    dispose();
    status.textContent = failure;
  }
}

globalThis.__runtimeBoundaries = {
  run() {
    running ??= run();
    return running;
  },
  snapshot: () => ({ completed, failure, results }),
};
globalThis.__runtimeAudit = {
  start() {
    void globalThis.__runtimeBoundaries.run();
  },
  stop() {
    require(completed && !failure, failure ?? "Incomplete boundary workload");
    return {
      fixtureSummary: { name: "runtime-boundaries-v1", completed, results },
    };
  },
};
