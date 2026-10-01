import { FenwickTree } from "/src/fenwick.ts";
import { Geometry } from "/src/geometry.ts";
import { PositionedGeometry } from "/src/positioned-geometry.ts";
import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const frame = () => new Promise(requestAnimationFrame);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const documentId = crypto.randomUUID();
const errors = [];
let mode = null;
let count = 0;
let keys = [];
let source = [];
let geometry = null;
let positioned = null;
let list = null;
let results = [];
let checksum = 0;
let scrolls = 0;
let ends = 0;
let distance = 0;
let previousTop = 0;
let busy = false;
let diagnostic = false;
const rowHeight = (index) => 40 + (index % 8) * 0.25;
const rowTop = (index) => Math.floor(index / 4) * 64 + (index % 4) * 0.25;
const listHeight = (index) => 40 + (index % 8);
const listTop = (index) => Math.floor(index / 4) * 64;
const positions = () =>
  Array.from({ length: count }, (_, index) => ({
    top: rowTop(index),
    height:
      mode === "positioned-overlap" && index === 0
        ? count * 64
        : rowHeight(index),
    lane: index % 4,
  }));
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

function release() {
  list?.dispose();
  list = null;
  geometry = null;
  positioned = null;
  keys = [];
  source = [];
  require(viewport.childElementCount === 0, "Canvas survived disposal");
}
function render(item, existing) {
  const row = existing ?? document.createElement("div");
  row.className = "row";
  row.style.height = `${listHeight(item.id)}px`;
  row.textContent = `Row ${item.id}, edit ${item.edit}`;
  return row;
}
async function prepare(nextMode, nextCount, profile = false) {
  require(!busy, "Operation already running");
  release();
  mode = nextMode;
  count = nextCount;
  diagnostic = profile;
  results = [];
  checksum = 0;
  require([
    "geometry",
    "geometry-sparse",
    "positioned",
    "list",
    "positioned-list",
    "positioned-overlap",
  ].includes(mode), "Unknown case");
  require(Number.isInteger(count) &&
    count >= 1000 &&
    count <= 100000, "Invalid size");
  scrolls = ends = distance = 0;
  previousTop = viewport.scrollTop;
  if (mode.startsWith("geometry")) {
    keys = Array.from({ length: count }, (_, i) => `k${i}`);
    geometry = new Geometry(40);
    geometry.setKeys(keys);
    keys.slice(0, mode === "geometry-sparse" ? 64 : count).forEach((key, i) => {
      geometry.measure(key, rowHeight(i));
    });
  } else if (mode === "positioned" || mode === "positioned-overlap") {
    positioned = new PositionedGeometry(positions());
  } else {
    source = Array.from({ length: count }, (_, id) => ({ id, edit: 0 }));
    list = createVirtualList(viewport, {
      items: source,
      key: (item) => `k${item.id}`,
      render,
      height: (item) => listHeight(item.id),
      position:
        mode === "positioned-list"
          ? (item) => ({ top: listTop(item.id), lane: ((item.id % 4) + 4) % 4 })
          : undefined,
      boot: "start",
      pinning: false,
      overscanPx: 400,
    });
    await list.scrollTo(`k${Math.floor(count / 2)}`, { align: "start" });
    await pause(100);
    require(viewport.scrollTop > 1000 &&
      list.state.count === count, "List did not navigate");
  }
  status.textContent = `${mode}: ${count} items`;
  await frame();
}
async function phase(name, edge) {
  if (!diagnostic) return;
  performance.mark(`structure:${mode}:${count}:${name}:${edge}`);
}
async function timed(name, operation, operations, samples = 5) {
  await phase(name, "start");
  operation(Math.min(operations, 5000));
  const durations = [];
  for (let i = 0; i < samples; i++) {
    await frame();
    const start = performance.now();
    checksum += operation(operations);
    durations.push(performance.now() - start);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  results.push({
    name,
    operations,
    samples,
    durations,
    totalMs: durations.reduce((a, b) => a + b, 0),
    medianMs: sorted[Math.floor(samples / 2)],
  });
  await phase(name, "end");
}
function validateGeometry() {
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const id = Number(key.slice(1));
    const measured = mode !== "geometry-sparse" || id < 64;
    const expected = measured ? rowHeight(id) : 40;
    require(geometry.isMeasured(key) === measured &&
      geometry.heightOf(key) === expected, "Learned height lost");
    require(geometry.offsetOf(key) === total, "Incorrect prefix after rebuild");
    total += expected;
  }
  require(geometry.contentSize === total, "Incorrect total");
}
async function exercise() {
  require(!busy, "Operation already running");
  busy = true;
  try {
    if (mode.startsWith("geometry")) {
      await timed(
        "read-and-search",
        (operations) => {
          let sum = 0;
          for (let i = 0; i < operations; i++) {
            const key = keys[(i * 8191) % count];
            const top = geometry.offsetOf(key);
            sum +=
              geometry.heightOf(key) +
              geometry.window({ scrollTop: top, height: 924 }, 400).start;
          }
          return sum;
        },
        50000,
      );
      await timed(
        "height-update",
        (operations) => {
          for (let i = 0; i < operations; i++) {
            const at = (i * 8191) % (mode === "geometry-sparse" ? 64 : count);
            geometry.measure(
              keys[at],
              rowHeight(Number(keys[at].slice(1))) + (i % 2 ? 0.25 : 0.5),
            );
          }
          return geometry.contentSize;
        },
        50000,
      );
      keys.slice(0, mode === "geometry-sparse" ? 64 : count).forEach((key) => {
        geometry.measure(key, rowHeight(Number(key.slice(1))));
      });
      await timed(
        "reorder",
        (operations) => {
          for (let i = 0; i < operations; i++) {
            keys = [...keys.slice(1), keys[0]];
            geometry.setKeys(keys);
          }
          return geometry.contentSize;
        },
        10,
        3,
      );
      validateGeometry();
      if (diagnostic) {
        const values = new Float64Array(count).fill(40);
        await timed(
          "fenwick-rebuild",
          (operations) => {
            let sum = 0;
            for (let i = 0; i < operations; i++)
              sum += new FenwickTree(values).total();
            return sum;
          },
          20,
          3,
        );
      }
    } else if (mode === "positioned" || mode === "positioned-overlap") {
      await timed(
        "window-and-anchor",
        (operations) => {
          let sum = 0;
          for (let i = 0; i < operations; i++) {
            // Keep the reading point inside a row: gap fallback is a separate
            // algorithm and would dominate this representation comparison.
            const top =
              Math.floor(
                ((i * 17) % Math.max(1, positioned.totalSize - 1600)) / 64,
              ) *
                64 +
              1;
            const range = positioned.window(top, top + 924);
            sum +=
              range.start +
              range.end +
              positioned.anchorAt(
                top,
                (index) => mode === "positioned-overlap" && index === 0,
                true,
              );
          }
          return sum;
        },
        mode === "positioned-overlap" ? 1000 : 10000,
      );
      if (diagnostic) {
        await timed(
          "anchor-gaps",
          (operations) => {
            let sum = 0;
            for (let i = 0; i < operations; i++) {
              const top = ((i * 8191) % (count / 4)) * 64 + 60;
              sum += positioned.anchorAt(
                top,
                (index) => mode === "positioned-overlap" && index === 0,
                true,
              );
            }
            return sum;
          },
          1000,
          3,
        );
        const items = positions();
        const excluded = (index) =>
          mode === "positioned-overlap" && index === 0;
        for (const top of [-1, 0, 60, 124, 1000, count * 16 + 60]) {
          let containing = -1,
            following = -1,
            previous = -1;
          for (let index = 0; index < items.length; index++) {
            if (excluded(index)) continue;
            const item = items[index];
            if (item.top <= top && item.top + item.height > top) {
              containing = index;
              break;
            }
            if (item.top > top) {
              if (following < 0 || item.top < items[following].top)
                following = index;
            } else if (
              previous < 0 ||
              item.top + item.height >
                items[previous].top + items[previous].height
            )
              previous = index;
          }
          const expected =
            containing >= 0
              ? containing
              : following >= 0
                ? following
                : previous;
          require(positioned.anchorAt(top, excluded, true) ===
            expected, "Incorrect gap/overlap anchor");
        }
      }
      await timed(
        "rebuild",
        (operations) => {
          for (let i = 0; i < operations; i++)
            positioned = new PositionedGeometry(positions());
          return positioned.totalSize;
        },
        10,
        3,
      );
      for (const top of [0, 127.5, 18000.25, positioned.totalSize - 1000]) {
        const expected = positions().flatMap((item, index) =>
          item.top < top + 924 && item.top + item.height > top ? [index] : [],
        );
        require(JSON.stringify(positioned.window(top, top + 924).indices) ===
          JSON.stringify(expected), "Incorrect positioned window");
      }
    } else {
      const id = Math.floor(count / 2);
      const times = [];
      await phase("update-item", "start");
      for (let edit = 0; edit < 70; edit++) {
        await frame();
        const item = { id, edit };
        const start = performance.now();
        list.updateItem(`k${id}`, item, { anchor: "none" });
        if (edit >= 10) times.push(performance.now() - start);
        source[id] = item;
      }
      const sorted = [...times].sort((a, b) => a - b);
      results.push({
        name: "updateItem",
        operations: 60,
        totalMs: times.reduce((a, b) => a + b, 0),
        medianMs: sorted[30],
        p95Ms: sorted[57],
      });
      await phase("update-item", "end");
      require(list.elementOf(`k${id}`)?.textContent ===
        `Row ${id}, edit 69`, "Edit did not commit");
      await timed(
        "replace-order",
        (operations) => {
          for (let i = 0; i < operations; i++) {
            source = [...source.slice(1), source[0]];
            list.setItems(source, { anchor: "none", interrupt: true });
          }
          return list.state.totalSize;
        },
        4,
        3,
      );
      for (const edge of ["append", "prepend"]) {
        await timed(
          `${edge}-remove`,
          (operations) => {
            for (let i = 0; i < operations; i++) {
              const item = { id: edge === "append" ? count : -1, edit: 0 };
              const changed =
                edge === "append" ? [...source, item] : [item, ...source];
              list.setItems(changed, { anchor: "none", interrupt: true });
              require(list.state.count ===
                count + 1, "Structural insertion failed");
              list.setItems(source, { anchor: "none", interrupt: true });
              require(list.state.count === count, "Structural removal failed");
            }
            return list.state.totalSize;
          },
          4,
          3,
        );
      }
      await list.scrollTo("end");
      await pause(80);
      await list.scrollTo("start");
      await pause(80);
      require(scrolls >= 3 &&
        ends > 0 &&
        distance > 10000, "Stationary list case");
      const total =
        mode === "list"
          ? source.reduce((sum, item) => sum + listHeight(item.id), 0)
          : listTop(count - 1) + listHeight(count - 1);
      require(Math.abs(list.state.totalSize - total) <
        1, "Incorrect list extent");
    }
    return { mode, count, results, checksum };
  } finally {
    busy = false;
  }
}
globalThis.__dataStructures = {
  prepare,
  exercise,
  release,
  // Diagnostic only: .buffer can materialize the engine's backing-store wrapper.
  materializeBuffers: () => {
    const buffers = geometry
      ? [geometry.heights.buffer, geometry.tree.tree.buffer]
      : positioned
        ? [positioned.tops.buffer, positioned.bottoms.buffer]
        : [];
    return buffers.reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
  },
  snapshot: () => ({
    documentId,
    mode,
    count,
    results,
    checksum,
    scrolls,
    ends,
    distance,
    errors: [...errors],
    activeItems: list?.state.count ?? 0,
    mountedRows: viewport.querySelectorAll(".row").length,
  }),
};
