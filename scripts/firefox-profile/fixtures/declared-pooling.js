import { createVirtualList } from "/src/virtual-list.ts";

const viewport = document.querySelector("#viewport");
const mode = new URL(location.href).searchParams.get("pool") ?? "off";
if (!["off", "on"].includes(mode))
  throw new Error("Expected pool=off or pool=on");
const poolLimitPerKind = 16;
const pools = { task: [], alert: [] };
const poolSize = () => pools.task.length + pools.alert.length;
const items = Array.from({ length: 10000 }, (_, index) => ({
  id: String(index),
  kind: index % 2 ? "task" : "alert",
  title: `Work item ${index}`,
  summary: `Deterministic card ${index}: review the local build and deployment details.`,
  metrics: [index % 97, index % 31, index % 13, index % 7],
  tags: ["Local", `Team ${index % 9}`, `Batch ${index % 17}`, "Ready"],
}));
const views = new WeakMap();
const active = new Set();
const selected = new Set();
let measuring = false;
let disposed = false;
let lastAction = null;
let initial;
let counts;
function resetCounts() {
  counts = {
    created: 0,
    reused: 0,
    rendered: 0,
    mounted: 0,
    destroyed: 0,
    renderMs: 0,
    renderMaxMs: 0,
    peakActive: active.size,
    peakOwned: active.size + poolSize(),
  };
}
resetCounts();

function createCard() {
  const element = document.createElement("article");
  element.className = "card";
  element.innerHTML = `<div class="surface">
    <header><h2></h2><span class="kind"></span></header>
    <p></p>
    <dl class="metrics">${["Builds", "Reviews", "Tasks", "Alerts"]
      .map((label) => `<div class="metric"><dt>${label}</dt><dd></dd></div>`)
      .join("")}</dl>
    <footer><div class="tags"><span></span><span></span><span></span><span></span></div>
    <label><input type="checkbox"> Select</label><button type="button">Open</button></footer>
  </div>`;
  const view = {
    id: "",
    kind: "",
    title: element.querySelector("h2"),
    badge: element.querySelector(".kind"),
    summary: element.querySelector("p"),
    metrics: [...element.querySelectorAll("dd")],
    tags: [...element.querySelectorAll(".tags span")],
    input: element.querySelector("input"),
    button: element.querySelector("button"),
  };
  view.button.addEventListener("click", () => {
    lastAction = view.id;
  });
  view.input.addEventListener("change", () => {
    if (view.input.checked) selected.add(view.id);
    else selected.delete(view.id);
  });
  views.set(element, view);
  if (measuring) counts.created++;
  return element;
}

function renderCard(item) {
  const start = measuring ? performance.now() : 0;
  const recycled = mode === "on" ? pools[item.kind].pop() : undefined;
  const element = recycled ?? createCard();
  if (measuring && recycled) counts.reused++;
  const view = views.get(element);
  view.id = item.id;
  view.kind = item.kind;
  element.dataset.key = item.id;
  element.dataset.kind = item.kind;
  view.title.id = `card-title-${item.id}`;
  element.setAttribute("aria-labelledby", view.title.id);
  view.title.textContent = item.title;
  view.badge.textContent = item.kind;
  view.summary.textContent = item.summary;
  view.metrics.forEach((node, i) => {
    node.textContent = String(item.metrics[i]);
  });
  view.tags.forEach((node, i) => {
    node.textContent = item.tags[i];
  });
  view.input.checked = selected.has(item.id);
  view.input.setAttribute("aria-label", `Select ${item.title}`);
  view.button.setAttribute("aria-label", `Open ${item.title}`);
  if (measuring) {
    const duration = performance.now() - start;
    counts.rendered++;
    counts.renderMs += duration;
    counts.renderMaxMs = Math.max(counts.renderMaxMs, duration);
  }
  return element;
}

const list = createVirtualList(viewport, {
  items,
  key: (item) => item.id,
  height: () => 180,
  boot: "start",
  overscanPx: 900,
  render: renderCard,
  onMount(element) {
    active.add(element);
    if (measuring) {
      counts.mounted++;
      counts.peakActive = Math.max(counts.peakActive, active.size);
      counts.peakOwned = Math.max(counts.peakOwned, active.size + poolSize());
    }
  },
  onDestroy(element, item) {
    active.delete(element);
    if (measuring) counts.destroyed++;
    // The runtime has detached this element and ended ownership for its key.
    // Listeners read the mutable view identity, never a former item's closure.
    if (mode === "on" && !disposed) {
      const pool = pools[item.kind];
      if (pool.length < poolLimitPerKind) {
        const view = views.get(element);
        view.id = "";
        view.input.checked = false;
        element.removeAttribute("data-key");
        element.removeAttribute("aria-labelledby");
        view.title.removeAttribute("id");
        pool.push(element);
      }
    }
  },
});
await list.scrollTo("5000", { align: "start", behavior: "instant" });

// Boundary-only reads. The native runner's rAF sampler reads no geometry.
function snapshot() {
  const mounted = [...active];
  const invalid = mounted.filter((element) => {
    const view = views.get(element);
    const item = items[Number(view.id)];
    return (
      !element.isConnected ||
      element.dataset.key !== item.id ||
      view.title.textContent !== item.title ||
      view.badge.textContent !== item.kind ||
      view.summary.textContent !== item.summary ||
      view.input.checked !== selected.has(item.id) ||
      view.title.id !== `card-title-${item.id}` ||
      view.metrics.some(
        (node, i) => node.textContent !== String(item.metrics[i]),
      ) ||
      view.tags.some((node, i) => node.textContent !== item.tags[i])
    );
  });
  return {
    mode,
    totalItems: items.length,
    rowHeight: 180,
    overscanPx: 900,
    top: viewport.scrollTop,
    height: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    active: active.size,
    activeElements: mounted.reduce(
      (sum, element) => sum + 1 + element.querySelectorAll("*").length,
      0,
    ),
    poolLimitPerKind,
    pooled: poolSize(),
    pooledElements: [...pools.task, ...pools.alert].reduce(
      (sum, element) => sum + 1 + element.querySelectorAll("*").length,
      0,
    ),
    invalid: invalid.length,
    keys: mounted.map((element) => element.dataset.key).sort(),
    lastAction,
    disposed,
    ...counts,
  };
}

globalThis.__declaredPooling = {
  list,
  snapshot,
  dispose() {
    disposed = true;
    list.dispose();
    pools.task.length = 0;
    pools.alert.length = 0;
  },
};
globalThis.__runtimeAudit = {
  start() {
    resetCounts();
    initial = snapshot();
    measuring = true;
  },
  stop() {
    measuring = false;
    const final = snapshot();
    if (
      initial.invalid ||
      final.invalid ||
      initial.scrollHeight !== final.scrollHeight ||
      final.rendered < 100
    )
      throw new Error("Invalid declared-pooling workload or geometry");
    return { fixtureSummary: { name: "declared-pooling-v1", initial, final } };
  },
};
