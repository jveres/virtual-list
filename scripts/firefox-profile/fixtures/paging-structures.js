import { createPagedWindow } from "/src/paging.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const documentId = crypto.randomUUID();
const errors = [];
let list = null;
let pager = null;
let mode = null;
let budget = 0;
let pageSize = 0;
let overlap = 0;
let cycles = 0;
let cancelled = 0;
let completedReaches = 0;
let evicted = 0;
let peakItems = 0;
let scrolls = 0;
let ends = 0;
let distance = 0;
let previousTop = 0;
let sourceGate = null;
let busy = false;
let timings = [];
const calls = {
  key: 0,
  height: 0,
  position: 0,
  render: 0,
  destroy: 0,
  project: 0,
};
const rowHeight = (id) => 40 + (id % 8) * 0.25;
const keyOf = (item) => {
  calls.key++;
  return `k${item.id}`;
};
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

function pageFor(cursor) {
  const first = cursor * (pageSize - overlap);
  return {
    items: Array.from({ length: pageSize }, (_, index) => {
      const id = first + index;
      // Unique synthetic payloads exercise source retention without a renderer
      // dependency. No cache keeps evicted source objects alive.
      const payload = `${id}:`.padEnd(
        2048,
        String.fromCharCode(97 + (id % 26)),
      );
      return { id, edit: 0, payload };
    }),
    start: { available: cursor > 0, cursor: cursor - 1 },
    end: { available: true, cursor: cursor + 1 },
  };
}
function release() {
  pager?.dispose();
  list?.dispose();
  pager = list = null;
  sourceGate = null;
  require(viewport.childElementCount === 0, "Canvas survived disposal");
  require(calls.render === calls.destroy, "Row lifecycle is unbalanced");
}
async function prepare(nextMode, maxItems) {
  require(!busy, "Operation already running");
  release();
  require(["stacked", "positioned"].includes(nextMode), "Unknown paging mode");
  require(Number.isInteger(maxItems) &&
    maxItems >= 480 &&
    maxItems <= 10000, "Invalid item budget");
  mode = nextMode;
  budget = maxItems;
  pageSize = Math.floor(budget / 4);
  overlap = Math.floor(pageSize / 5);
  cycles = cancelled = completedReaches = evicted = peakItems = 0;
  scrolls = ends = distance = 0;
  previousTop = viewport.scrollTop;
  timings = [];
  for (const name of Object.keys(calls)) calls[name] = 0;
  const initial = pageFor(100);
  list = createVirtualList(viewport, {
    items: initial.items,
    key: keyOf,
    height: (item) => {
      calls.height++;
      return rowHeight(item.id);
    },
    position:
      mode === "positioned"
        ? (item) => {
            calls.position++;
            return { top: Math.floor(item.id / 4) * 64, lane: item.id % 4 };
          }
        : undefined,
    render: (item, existing) => {
      if (!existing) calls.render++;
      const row = existing ?? document.createElement("div");
      row.className = "row";
      row.style.height = `${rowHeight(item.id)}px`;
      row.textContent = `${item.id} / ${item.edit}: ${item.payload.slice(0, 40)}`;
      return row;
    },
    onDestroy: () => {
      calls.destroy++;
    },
    boot: "start",
    pinning: false,
    overscanPx: 400,
  });
  pager = createPagedWindow({
    list,
    initial,
    maxItems: budget,
    key: keyOf,
    keysOf: (item) => [keyOf(item)],
    project: (items) => {
      calls.project++;
      return items;
    },
    live: { project: (item) => item, key: keyOf },
    load: async ({ cursor }) => {
      if (sourceGate) await sourceGate;
      return pageFor(cursor);
    },
    onChange: (items) => {
      peakItems = Math.max(peakItems, items.length);
    },
    onEvict: (items) => {
      const kept = new Set(pager.items.map((item) => item.id));
      require(items.every(
        (item) => !kept.has(item.id),
      ), "Evicted a shared owner");
      evicted += items.length;
    },
  });
  status.textContent = `${mode}: ${budget} retained items`;
  await list.scrollTo("end");
  await pause(80);
}
async function cycle(totalCycles) {
  require(!busy && pager && list, "No idle paging workload");
  busy = true;
  const label = `structure:paging-${mode}:${budget}:cycle-${cycles}`;
  performance.mark(`${label}:start`);
  try {
    const edge = cycles < Math.floor(totalCycles * 0.75) ? "end" : "start";
    await list.scrollTo(edge);
    await pause(40);
    if (cycles % 4 === 0) {
      const before = pager.items;
      const controller = new AbortController();
      let resume;
      sourceGate = new Promise((resolve) => {
        resume = resolve;
      });
      const pending = pager.load(edge, {
        signal: controller.signal,
        complete: () => {
          completedReaches++;
        },
      });
      await Promise.resolve();
      controller.abort();
      require((await pending) === false, "Cancelled load committed");
      sourceGate = null;
      resume();
      await Promise.resolve();
      require(pager.items === before, "Cancelled source changed ownership");
      cancelled++;
    }
    const boundary = edge === "end" ? pager.items.at(-1) : pager.items[0];
    const key = `k${boundary.id}`;
    const edit = boundary.edit + 1;
    const editStart = performance.now();
    require(await pager.updateItemLive(key, (item) => ({
      ...item,
      edit,
    })), "Live edit failed");
    const editMs = performance.now() - editStart;
    const loadStart = performance.now();
    require(await pager.load(edge), "Page load failed");
    const loadMs = performance.now() - loadStart;
    require(pager.items.find((item) => item.id === boundary.id)?.edit ===
      edit, "An overlapping page lost a live edit");
    await list.scrollTo(edge);
    await pause(40);
    const trimStart = performance.now();
    await pager.reconcile();
    const trimMs = performance.now() - trimStart;
    require(pager.items.length <= budget, "Item budget did not settle");
    require(new Set(pager.items.map((item) => item.id)).size ===
      pager.items.length, "Overlapping pages exposed duplicate keys");
    require(list.state.count ===
      pager.items.length, "Pager and runtime differ");
    await list.scrollTo(
      `k${pager.items[Math.floor(pager.items.length / 2)].id}`,
    );
    await pause(40);
    timings.push({ editMs, loadMs, trimMs, items: pager.items.length });
    cycles++;
  } finally {
    performance.mark(`${label}:end`);
    busy = false;
  }
}
globalThis.__pagingStructures = {
  prepare,
  cycle,
  release,
  snapshot: () => ({
    documentId,
    mode,
    budget,
    pageSize,
    overlap,
    cycles,
    cancelled,
    completedReaches,
    evicted,
    peakItems,
    scrolls,
    ends,
    distance,
    calls: { ...calls },
    timings: [...timings],
    errors: [...errors],
    activeItems: list?.state.count ?? 0,
    mountedRows: viewport.querySelectorAll(".row").length,
  }),
};
