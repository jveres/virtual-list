import { createPagedWindow } from "/src/paging.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise(requestAnimationFrame);
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
let imageLoads = 0;
let streamUpdates = 0;
let widthChanges = 0;
let frameGaps = [];
const calls = {
  key: 0,
  height: 0,
  position: 0,
  render: 0,
  destroy: 0,
  project: 0,
};
const rowHeight = (id) => 40 + (id % 8) * 0.25;
const imageHeight = (item) => 24 + ((item.id + item.edit) % 4) * 12;
function renderMeasured(item, existing) {
  const row = existing ?? document.createElement("div");
  row.className = "row measured";
  row.dataset.id = String(item.id);
  if (!existing) {
    row.append(document.createElement("p"), document.createElement("p"));
    const image = document.createElement("img");
    image.alt = "Synthetic inline image";
    image.addEventListener("load", () => imageLoads++);
    row.append(image);
  }
  row.children[0].textContent = `${item.id} / ${item.edit}: ${"Measured streaming text wraps as the source and viewport change. ".repeat(
    1 + (item.id % 3) + (item.edit % 6),
  )}`;
  row.children[1].textContent = item.payload.slice(0, 120);
  // No reserved height: decode changes the measured row after the live edit.
  row.lastElementChild.src = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="${imageHeight(item)}"><rect width="96" height="100%" fill="#abc"/></svg>`,
  )}`;
  return row;
}
async function settleMeasured() {
  const start = performance.now();
  let stable = 0;
  while (performance.now() - start < 10000) {
    await frame();
    stable = list.state.held ? 0 : stable + 1;
    if (stable >= 8 && performance.now() - start > 300) return;
  }
  throw new Error("Measured work did not settle");
}
async function verifyMeasured(item) {
  const element = list.elementOf(`k${item.id}`);
  require(element?.isConnected, "Measured target is not mounted");
  const image = element.lastElementChild;
  await image.decode();
  await frame();
  await frame();
  require(image.naturalHeight === imageHeight(item), "Image did not update");
  require(Math.abs(
    element.getBoundingClientRect().height -
      list.positionOf(`k${item.id}`).height,
  ) < 1.05, "Measured row height differs");
}
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
  require(["stacked", "positioned", "measured"].includes(
    nextMode,
  ), "Unknown paging mode");
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
  imageLoads = streamUpdates = widthChanges = 0;
  frameGaps = [];
  viewport.style.width = "1100px";
  for (const name of Object.keys(calls)) calls[name] = 0;
  const initial = pageFor(100);
  list = createVirtualList(viewport, {
    items: initial.items,
    key: keyOf,
    height:
      mode === "measured"
        ? undefined
        : (item) => {
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
      if (mode === "measured") return renderMeasured(item, existing);
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
  if (mode === "measured") await verifyMeasured(pager.items.at(-1));
}
async function cycle(totalCycles) {
  require(!busy && pager && list, "No idle paging workload");
  busy = true;
  let previousFrame = null;
  let frameHandle = 0;
  const sample = (now) => {
    if (previousFrame !== null) frameGaps.push(now - previousFrame);
    previousFrame = now;
    frameHandle = requestAnimationFrame(sample);
  };
  if (mode === "measured") frameHandle = requestAnimationFrame(sample);
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
    const updates = mode === "measured" ? 6 : 1;
    const edit = boundary.edit + updates;
    const editStart = performance.now();
    for (let update = 0; update < updates; update++) {
      require(await pager.updateItemLive(key, (item) => ({
        ...item,
        edit: item.edit + 1,
      })), "Live edit failed");
      if (mode === "measured") {
        streamUpdates++;
        await frame();
      }
    }
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
    let resizeMs = 0;
    if (mode === "measured") {
      if (cycles % 4 === 3) {
        const resizeStart = performance.now();
        viewport.style.width = widthChanges % 2 ? "1100px" : "650px";
        widthChanges++;
        await settleMeasured();
        resizeMs = performance.now() - resizeStart;
      }
      await verifyMeasured(pager.items[Math.floor(pager.items.length / 2)]);
    }
    timings.push({
      editMs,
      loadMs,
      trimMs,
      resizeMs,
      items: pager.items.length,
    });
    cycles++;
  } finally {
    cancelAnimationFrame(frameHandle);
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
    imageLoads,
    streamUpdates,
    widthChanges,
    frameGaps: (() => {
      const sorted = frameGaps.toSorted((a, b) => a - b);
      return {
        count: sorted.length,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
        max: sorted.at(-1) ?? null,
        over25: sorted.filter((x) => x > 25).length,
      };
    })(),
    errors: [...errors],
    activeItems: list?.state.count ?? 0,
    mountedRows: viewport.querySelectorAll(".row").length,
  }),
};
