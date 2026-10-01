import { createPagedWindow } from "/src/paging.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cohorts = [];
const retained = [];
const errors = [];
let generation = 0;
let list = null;
let pager = null;
let mode = null;
let cycles = 0;
let renders = 0;
let destroyed = 0;
let evicted = 0;
let scrolls = 0;
let ends = 0;
let distance = 0;
let previousTop = 0;
let busy = false;
const documentId = crypto.randomUUID();

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

function itemsFor(count) {
  const cohort = { generation: ++generation, items: [], nodes: [] };
  cohorts.push(cohort);
  return Array.from({ length: count }, (_, index) => {
    // Flat, distinct 32 KiB strings make stale source retention measurable.
    // The renderer consumes only short excerpts; no images or external input.
    let seed = generation * 1009 + index + 1;
    const bytes = new Uint8Array(32768);
    for (let i = 0; i < bytes.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      bytes[i] = 97 + ((seed >>> 16) % 26);
    }
    const item = {
      id: `${generation}:${index}`,
      generation,
      payload: String.fromCharCode(...bytes),
    };
    cohort.items.push(new WeakRef(item));
    return item;
  });
}

function render(item) {
  renders++;
  const row = document.createElement("article");
  row.dataset.key = item.id;
  for (let i = 0; i < 6; i++) {
    const paragraph = document.createElement("p");
    paragraph.textContent = `${item.id} / ${i}: ${item.payload.slice(i * 180, (i + 1) * 180)}`;
    row.append(paragraph);
  }
  row.addEventListener("click", () => {
    row.title = item.id;
  });
  cohorts
    .find((entry) => entry.generation === item.generation)
    .nodes.push(new WeakRef(row));
  return row;
}
function createList(items) {
  return createVirtualList(viewport, {
    items,
    key: (item) => item.id,
    render,
    onDestroy: () => {
      destroyed++;
    },
    boot: "start",
    pinning: false,
    overscanPx: 400,
  });
}
function pageFor(cursor) {
  return {
    items: itemsFor(32),
    start: { available: cursor > 0, cursor: cursor - 1 },
    end: { available: true, cursor: cursor + 1 },
  };
}
function createPager(initial) {
  return createPagedWindow({
    list,
    initial,
    maxItems: 96,
    key: (item) => item.id,
    keysOf: (item) => [item.id],
    project: (items) => items,
    load: async ({ cursor }) => pageFor(cursor),
    onEvict: (items) => {
      evicted += items.length;
    },
  });
}
function dispose(keep = false) {
  pager?.dispose();
  list?.dispose();
  if (keep) retained.push({ list, pager });
  pager = null;
  list = null;
  require(viewport.childElementCount === 0, "Disposed canvas remains mounted");
}
async function travel() {
  require(list?.state.count > 0, "No live items to traverse");
  await list.scrollTo("end");
  await pause(80);
  await list.scrollTo("start");
  await pause(80);
}

async function begin(nextMode) {
  require(!busy, "Operation already running");
  dispose();
  retained.length = 0;
  cohorts.length = 0;
  mode = nextMode;
  cycles = renders = destroyed = evicted = scrolls = ends = distance = 0;
  previousTop = viewport.scrollTop;
  require(["replace", "paging", "dispose-drop", "dispose-keep"].includes(
    mode,
  ), "Unknown mode");
  if (mode === "replace") list = createList(itemsFor(96));
  if (mode === "paging") {
    const initial = pageFor(0);
    list = createList(initial.items);
    pager = createPager(initial);
  }
  await pause(100);
  status.textContent = mode;
}
async function cycle() {
  require(!busy, "Operation already running");
  busy = true;
  try {
    if (mode === "replace") {
      list.setItems(itemsFor(96), { anchor: "none", interrupt: true });
      await travel();
      require(list.state.count === 96, "Replacement did not commit");
    } else if (mode === "paging") {
      await list.scrollTo("end");
      await pause(80);
      require(await pager.load("end"), "Page load failed");
      await list.scrollTo("end");
      await pause(80);
      await pager.reconcile();
      require(pager.items.length <= 96, "Page budget did not settle");
      require(list.state.count === pager.items.length, "Pager/runtime differ");
    } else {
      list = createList(itemsFor(96));
      await travel();
      dispose(mode === "dispose-keep");
      require(renders === destroyed, "Row lifecycle is unbalanced");
    }
    cycles++;
  } finally {
    busy = false;
  }
}

globalThis.__runtimeRetention = {
  begin,
  cycle,
  release() {
    dispose();
    retained.length = 0;
  },
  // Call only after a separate browser collection task. WeakRef reads keep
  // referents alive for the current JavaScript job, never across checkpoints.
  snapshot() {
    return {
      documentId,
      mode,
      cycles,
      renders,
      destroyed,
      evicted,
      scrolls,
      ends,
      distance,
      retainedHandles: retained.length,
      activeItems: list?.state.count ?? 0,
      mountedRows: viewport.querySelectorAll("article").length,
      canvasCount: viewport.childElementCount,
      errors: [...errors],
      cohorts: cohorts.map((entry) => ({
        generation: entry.generation,
        createdItems: entry.items.length,
        aliveItems: entry.items.filter((ref) => ref.deref() !== undefined)
          .length,
        createdNodes: entry.nodes.length,
        aliveNodes: entry.nodes.filter((ref) => ref.deref() !== undefined)
          .length,
      })),
    };
  },
};
