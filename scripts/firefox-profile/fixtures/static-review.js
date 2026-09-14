// Component timings, not a chat smoothness test. Native gestures move a separate
// declared-height control. No layout reads run in the frame sampler.
const params = new URLSearchParams(location.search);
const root = params.get("root");
if (!/^\/browser-artifacts\/static-review-[a-zA-Z0-9]+$/.test(root ?? "")) {
  throw new Error(
    "Pass the directory produced by prepare-static-review.mjs as root",
  );
}
const importSource = (variant, file) =>
  import(/* @vite-ignore */ `${root}/${variant}/src/${file}.ts`);
const [{ createVirtualList }, { createStickyHeaders }] = await Promise.all([
  importSource("baseline", "virtual-list"),
  importSource("baseline", "companions/sticky-headers"),
]);
const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const width = viewport.clientWidth;
const control = createVirtualList(viewport, {
  items: Array.from({ length: 10000 }, (_, id) => ({ id: String(id) })),
  key: (item) => item.id,
  height: () => 64,
  render(item) {
    const element = document.createElement("div");
    element.className = "control-row";
    element.textContent = `Native scroll control ${item.id}`;
    return element;
  },
});
await control.scrollTo("5000", { align: "start" });
const frame = () => new Promise(requestAnimationFrame);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const results = [];
const probe = () => {
  const element = document.createElement("div");
  element.className = "probe";
  element.style.width = `${width}px`;
  document.body.append(element);
  return element;
};
function renderRich(item, existing) {
  const element = existing ?? document.createElement("div");
  element.className = "rich";
  // Fixed synthetic content only. No imported transcript or external resources.
  element.innerHTML =
    `<h3>Row ${item.id}</h3>` +
    Array.from(
      { length: 12 },
      (_, i) =>
        `<table><tr><td>Section ${i}</td><td>Deterministic nested table content for layout measurement.</td></tr></table><pre>const result = compute(value);\nreturn result;</pre>`,
    ).join("");
  return element;
}
async function detached(variant, round) {
  const { createItemMeasurer } = await importSource(variant, "premeasure");
  const surface = probe();
  const measurer = createItemMeasurer({
    viewport: surface,
    viewportWidth: () => width,
  });
  const row = renderRich({ id: 1 });
  const text = document.createTextNode("");
  row.append(text);
  const durations = [];
  let height = 0;
  try {
    measurer.measureMany([row]);
    for (let i = 0; i < 200; i++) {
      text.appendData(" deterministic streaming token");
      const start = performance.now();
      height = measurer.measureMany([row])[0];
      durations.push(performance.now() - start);
      if (i % 5 === 4) await frame();
    }
    assert(height > 0, "Missing detached geometry");
    results.push({ kind: "detached", variant, round, durations, height });
  } finally {
    row.remove();
    measurer.dispose();
    surface.remove();
  }
}
async function pager(variant, round) {
  const { createPagedWindow } = await importSource(variant, "paging");
  const items = Array.from({ length: 160 }, (_, i) => ({
    id: String(i),
    value: 0,
  }));
  let submitted = 0;
  const fakeList = {
    state: { start: 0, end: 0 },
    async updateWindow(update) {
      const next = update({ protectedItems: [] });
      if (!next) return false;
      next.onCommit?.();
      return true;
    },
    updateItem(key, row) {
      assert(key === row.id, "Changed live key");
      submitted++;
    },
  };
  const boundary = (cursor) => ({ available: true, cursor });
  const page = (start, end) => ({
    items: items.slice(start, end),
    start: boundary(start),
    end: boundary(end),
  });
  const window = createPagedWindow({
    list: fakeList,
    initial: page(0, 60),
    key: (item) => item.id,
    maxItems: 160,
    project: (values) => values,
    keysOf: (item) => [item.id],
    live: { project: (item) => ({ ...item }), key: (row) => row.id },
    load: async ({ cursor }) => page(cursor, Math.min(160, cursor + 50)),
  });
  try {
    await window.load("end");
    await window.load("end");
    assert(window.items.length === 160, "Expected three retained pages");
    const durations = [];
    for (let batch = 0; batch < 20; batch++) {
      const start = performance.now();
      for (let token = 0; token < 500; token++) {
        assert(
          await window.updateItemLive("159", (item) => ({
            ...item,
            value: item.value + 1,
          })),
          "Live update rejected",
        );
      }
      durations.push(performance.now() - start);
      await frame();
    }
    assert(
      submitted === 10000 && window.items[159].value === 10000,
      "Live data lost",
    );
    results.push({
      kind: "pager",
      variant,
      round,
      durations,
      updatesPerBatch: 500,
      submitted,
    });
  } finally {
    window.dispose();
  }
}
async function staged(variant, round, rich) {
  const { createVirtualList: create } = await importSource(
    variant,
    "virtual-list",
  );
  const surface = probe();
  const initial = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
  const list = create(surface, {
    items: initial,
    key: (item) => item.id,
    render: rich
      ? renderRich
      : (item) => {
          const element = document.createElement("div");
          element.textContent = item.id;
          element.style.height = "40px";
          return element;
        },
  });
  try {
    await frame();
    const start = performance.now();
    const applied = await list.updateWindow(() => ({
      items: Array.from(
        { length: 100 },
        (_, i) => initial[i] ?? { id: String(i) },
      ),
      anchor: "viewport",
    }));
    const duration = performance.now() - start;
    assert(applied && list.state.count === 100, "Staged append failed");
    results.push({
      kind: rich ? "stage-rich" : "stage-simple",
      variant,
      round,
      duration,
      start,
      end: start + duration,
      size: list.state.totalSize,
    });
    // Keep teardown and the next case out of this commit's refresh tick.
    await frame();
  } finally {
    list.dispose();
    surface.remove();
  }
}
async function structure(round) {
  const surface = probe();
  const items = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) }));
  const list = createVirtualList(surface, {
    items,
    key: (item) => item.id,
    height: () => 40,
    render: (item) => {
      const element = document.createElement("div");
      element.textContent = item.id;
      return element;
    },
  });
  const durations = [];
  try {
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      list.setItems([{ id: `new-${i}` }, ...items], { anchor: "viewport" });
      durations.push(performance.now() - start);
      await frame();
    }
    results.push({ kind: "structure", variant: "baseline", round, durations });
  } finally {
    list.dispose();
    surface.remove();
  }
}
async function sticky(round) {
  const surface = probe();
  const keys = Array.from({ length: 100 }, (_, i) => String(i));
  const headers = createStickyHeaders({
    container: surface,
    viewport: surface,
    headerKeys: () => keys,
    positionOf: (key) => ({ top: Number(key) * 600, height: 30 }),
    renderHeader: (element, ordinal) => {
      element.textContent = String(ordinal);
    },
  });
  try {
    const start = performance.now();
    for (let i = 0; i < 2000; i++) headers.refresh(i % 500);
    results.push({
      kind: "sticky",
      variant: "baseline",
      round,
      duration: performance.now() - start,
      calls: 2000,
    });
  } finally {
    headers.destroy();
    surface.remove();
  }
}
async function run() {
  // Begin only after the native runner installs its recorder.
  while (!window.__ffProfile) await frame();
  window.__ffProfile.components = { status: "running", results };
  try {
    for (let round = 0; round < 3; round++) {
      for (const variant of round % 2
        ? ["resident", "baseline"]
        : ["baseline", "resident"])
        await detached(variant, round);
      for (const variant of round % 2
        ? ["paging", "baseline"]
        : ["baseline", "paging"])
        await pager(variant, round);
      for (const rich of [false, true])
        for (const variant of round % 2
          ? ["stage64", "baseline"]
          : ["baseline", "stage64"])
          await staged(variant, round, rich);
      await structure(round);
      await sticky(round);
    }
    for (const kind of ["detached", "stage-simple", "stage-rich"]) {
      const values = results
        .filter((result) => result.kind === kind)
        .map((result) => result.height ?? result.size);
      assert(
        values.every((value) => value === values[0]),
        `Geometry differs for ${kind}`,
      );
    }
    window.__ffProfile.components.status = "complete";
    status.textContent =
      "Component measurements complete; native control remains scrollable";
  } catch (error) {
    window.__ffProfile.components.status = "failed";
    window.__ffProfile.components.error = String(error);
    status.textContent = String(error);
  }
}
void run();
window.addEventListener("pagehide", () => control.dispose(), { once: true });
