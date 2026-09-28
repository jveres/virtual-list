// Counts the work of a viewport width burst on a measured list, headless.
// Run against an existing Vite dev server, with no other benchmark running:
// node scripts/width-resize-benchmark.mjs --url=http://127.0.0.1:4175
// Optional: --engine=chromium|firefox|webkit --counts=100,1000,10000
//   --rows=plain|rich --anchoring=auto|runtime --rounds=5 --steps=30
//   --width=800 --step-px=8 (negative: wider at every step)
//   --baseline=/baseline-src/virtual-list.ts
// With --baseline, that module runs in the same page, alternating with
// /src/virtual-list.ts, and the final geometry and every painted frame of
// the two are compared. Counters are the evidence; timings are secondary.
import "./firefox-app-data.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium, firefox, webkit } from "playwright";

const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const baseUrl = option("url") ?? "http://127.0.0.1:4175";
const selectedEngine = option("engine");
const counts = (option("counts") ?? "100,1000,10000").split(",").map(Number);
const rowKind = option("rows") ?? "plain";
const anchoring = option("anchoring") ?? "auto";
const rounds = Number(option("rounds") ?? 5);
const steps = Number(option("steps") ?? 30);
const stepPx = Number(option("step-px") ?? 8);
const startWidth = Number(option("width") ?? 800);
const baseline = option("baseline");
const variants = [
  ...(baseline ? [{ name: "baseline", module: baseline }] : []),
  { name: "candidate", module: "/src/virtual-list.ts" },
];
const browserTypes = { chromium, firefox, webkit };
if (selectedEngine && !Object.hasOwn(browserTypes, selectedEngine))
  throw new Error(`Unknown engine: ${selectedEngine}`);

/** Runs in the page: counters around the DOM, and one list at a time. */
function install() {
  const counters = {
    rects: 0,
    inserts: 0,
    removes: 0,
    followStart: 0,
    renders: 0,
    states: 0,
  };
  const nativeRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    counters.rects += 1;
    return nativeRect.call(this);
  };
  const nativeInsert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, reference) {
    counters.inserts += 1;
    return nativeInsert.call(this, node, reference);
  };
  const nativeRemove = Element.prototype.remove;
  Element.prototype.remove = function () {
    if (this.isConnected) counters.removes += 1;
    return nativeRemove.call(this);
  };
  let records = [];
  let styles = null;
  const styleWrites = () =>
    styles?.takeRecords().filter((record) => record.type === "attributes")
      .length ?? 0;
  const timed = (kind, detail, callback) =>
    function (...args) {
      const outside = styleWrites();
      const before = { ...counters };
      const started = performance.now();
      try {
        return callback.apply(this, args);
      } finally {
        const ms = performance.now() - started;
        const record = { kind, ...detail, ms, styles: styleWrites(), outside };
        for (const name of Object.keys(counters))
          record[name] = counters[name] - before[name];
        records.push(record);
      }
    };
  // Construction order in the runtime: rows first, then the viewport.
  let observers = 0;
  const NativeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback) {
      super(timed("resize", { observer: observers++ }, callback));
    }
  };
  const nativeTimeout = window.setTimeout;
  window.setTimeout = (callback, delay, ...args) =>
    nativeTimeout(
      typeof callback === "function"
        ? timed("timer", { delay }, callback)
        : callback,
      delay,
      ...args,
    );

  const frame = () => new Promise(requestAnimationFrame);
  const words =
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
      " ",
    );
  const sentence = (id, length) =>
    Array.from(
      { length },
      (_, index) => words[(id * 7 + index * 3) % words.length],
    ).join(" ");
  const plain = (item) => {
    const element = document.createElement("div");
    element.style.cssText =
      "padding:8px 12px;font:14px/20px sans-serif;overflow-wrap:anywhere";
    element.textContent = sentence(item.id, 8 + ((item.id * 37) % 90));
    return element;
  };
  const rich = (item) => {
    const element = document.createElement("div");
    element.style.cssText =
      "padding:8px 12px;font:14px/20px sans-serif;overflow-wrap:anywhere";
    if (item.id % 2 === 0) {
      element.textContent = sentence(item.id, 12 + (item.id % 20));
      return element;
    }
    const table = Array.from(
      { length: 8 },
      (_, row) =>
        `<tr><td>Stage ${row}</td><td>${item.id + row}</td><td>${sentence(item.id + row, 6)}</td></tr>`,
    ).join("");
    const steps = Array.from(
      { length: 6 },
      (_, step) => `<li>${sentence(item.id + step, 14)}</li>`,
    ).join("");
    element.innerHTML = `<h2>Rich response ${item.id}</h2>
<p>${sentence(item.id, 30)} <b>bold</b>, <em>emphasis</em>, <code>inline code</code>, and a <a href="#fixture">local link</a>.</p>
<table style="border-collapse:collapse;width:100%"><thead><tr><th>Component</th><th>Items</th><th>State</th></tr></thead><tbody>${table}</tbody></table>
<pre style="overflow:auto;padding:8px"><code>interface Item { id: string; value: number; }
export function total(items: readonly Item[]): number {
  return items.reduce((sum, item) =&gt; sum + item.value, 0);
}</code></pre>
<ol>${steps}</ol>
<blockquote>${sentence(item.id, 24)}</blockquote>`;
    return element;
  };

  let current = null;
  const modules = new Map();

  window.widthBenchmark = {
    async setup({ module, count, rows, anchoring, width, height }) {
      if (!modules.has(module)) modules.set(module, await import(module));
      const { createVirtualList } = modules.get(module);
      const viewport = document.createElement("div");
      viewport.style.cssText = `width:${width}px;height:${height}px;overflow:auto${anchoring === "runtime" ? ";overflow-anchor:none" : ""}`;
      document.body.appendChild(viewport);
      const items = Array.from({ length: count }, (_, id) => ({ id }));
      const build = rows === "rich" ? rich : plain;
      observers = 0;
      const list = createVirtualList(viewport, {
        items,
        key: (item) => String(item.id),
        boot: "start",
        render: (item, existing) => {
          counters.renders += 1;
          if (existing) return existing;
          const element = build(item);
          element.dataset.row = String(item.id);
          return element;
        },
        followStart: (_item, element) => {
          counters.followStart += 1;
          return element;
        },
        onState: () => {
          counters.states += 1;
        },
      });
      styles = new MutationObserver(() => {});
      styles.observe(viewport, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
      current = { list, viewport, items, width };
      await list.scrollTo(String(Math.floor(count / 2)), { align: "start" });
      // A classic scrollbar narrows the viewport once: let that settle too.
      await this.quiet(400);
      return {
        anchoring: viewport.firstElementChild.dataset.anchoring,
        clientWidth: viewport.clientWidth,
        mounted: this.painted().length,
        connected: viewport.querySelectorAll("[data-row]").length,
      };
    },
    /** Wait, then for `held` to clear; throws if it never does. */
    async quiet(ms) {
      await new Promise((done) => nativeTimeout(done, ms));
      const deadline = performance.now() + 5000;
      while (current.list.state.held) {
        if (performance.now() > deadline) throw new Error("held never cleared");
        await frame();
      }
      await frame();
      records = [];
      styleWrites();
    },
    /** The rows on screen: key, viewport coordinate, slot and content height. */
    painted() {
      const { viewport } = current;
      const origin = nativeRect.call(viewport).top;
      const rows = [];
      for (const element of viewport.querySelectorAll("[data-row]")) {
        const slot = element.parentElement;
        if (slot.style.visibility === "hidden") continue;
        const box = nativeRect.call(slot);
        rows.push({
          key: element.dataset.row,
          top: Math.round((box.top - origin) * 100) / 100,
          slot: Math.round(box.height * 100) / 100,
          content: Math.round(nativeRect.call(element).height * 100) / 100,
        });
      }
      return rows;
    },
    /** One width step per frame. `verify` reads what each frame painted. */
    async burst({ steps, stepPx, verify }) {
      const { viewport, width } = current;
      const frames = [];
      records = [];
      for (let step = 1; step <= steps; step++) {
        await frame();
        if (verify && step > 1) frames.push(this.visible());
        viewport.style.width = `${width - step * stepPx}px`;
      }
      await frame();
      if (verify) frames.push(this.visible());
      const taken = records;
      records = [];
      return { records: taken, frames };
    },
    /** Rows inside the viewport, and whether any paints clipped or gapped. */
    visible() {
      const height = current.viewport.clientHeight;
      return this.painted().filter(
        (row) => row.top + row.slot > 0 && row.top < height,
      );
    },
    async trailing({ waitMs }) {
      await new Promise((done) => nativeTimeout(done, waitMs));
      const heldAfterWait = current.list.state.held;
      const deadline = performance.now() + 5000;
      while (current.list.state.held) {
        if (performance.now() > deadline) throw new Error("held never cleared");
        await frame();
      }
      const taken = records;
      records = [];
      const { list, items, viewport } = current;
      return {
        records: taken,
        heldAfterWait,
        totalSize: list.state.totalSize,
        scrollTop: viewport.scrollTop,
        clientWidth: viewport.clientWidth,
        positions: items.map((item) => {
          const position = list.positionOf(String(item.id));
          return [position.top, position.height];
        }),
        visible: this.visible(),
        connected: viewport.querySelectorAll("[data-row]").length,
      };
    },
    teardown() {
      styles?.disconnect();
      styles = null;
      current.list.dispose();
      current.viewport.remove();
      current = null;
    },
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value) => Math.round(value * 100) / 100;
const spread = (values) => ({
  median: round(median(values)),
  min: round(Math.min(...values)),
  max: round(Math.max(...values)),
});
const sum = (records, name) =>
  records.reduce((total, record) => total + record[name], 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const results = [];
const failures = [];
for (const [engine, type] of Object.entries(browserTypes)) {
  if (selectedEngine && engine !== selectedEngine) continue;
  const browser = await type.launch({
    headless: true,
    // Whole-millisecond clocks hide a sub-millisecond delivery.
    firefoxUserPrefs:
      engine === "firefox"
        ? { "privacy.reduceTimerPrecision": false }
        : undefined,
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => failures.push(`${engine}: ${error}`));
    // A blank same-origin fixture avoids demo timers and background workloads.
    await page.route("**/__benchmark__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Width benchmark</title></head><body style='margin:0'></body></html>",
      }),
    );
    await page.goto(`${baseUrl}/__benchmark__`);
    await page.evaluate(install);
    const metrics =
      engine === "chromium" ? await page.context().newCDPSession(page) : null;
    await metrics?.send("Performance.enable");
    const layout = async () => {
      if (!metrics) return null;
      const { metrics: list } = await metrics.send("Performance.getMetrics");
      const value = (name) => list.find((m) => m.name === name)?.value ?? 0;
      return {
        count: value("LayoutCount"),
        ms: value("LayoutDuration") * 1000,
        styleMs: value("RecalcStyleDuration") * 1000,
      };
    };
    const run = async (variant, count, verify) => {
      const setup = await page.evaluate(
        (config) => window.widthBenchmark.setup(config),
        {
          module: variant.module,
          count,
          rows: rowKind,
          anchoring,
          width: startWidth,
          height: 700,
        },
      );
      try {
        const before = await layout();
        const burst = await page.evaluate(
          (config) => window.widthBenchmark.burst(config),
          { steps, stepPx, verify },
        );
        const between = await layout();
        const trailing = await page.evaluate(
          (config) => window.widthBenchmark.trailing(config),
          { waitMs: 500 },
        );
        const after = await layout();
        return { setup, burst, trailing, before, between, after };
      } finally {
        await page.evaluate(() => window.widthBenchmark.teardown());
      }
    };
    for (const count of counts) {
      // What each variant painted, frame by frame, and where it converged.
      const verified = {};
      for (const variant of variants)
        verified[variant.name] = await run(variant, count, true);
      const candidate = verified.candidate;
      for (const [index, rows] of candidate.burst.frames.entries()) {
        if (rows.length === 0)
          failures.push(`${engine} N=${count}: frame ${index} painted no row`);
        const clipped = rows.filter(
          (row) => Math.abs(row.slot - row.content) > 1,
        );
        if (clipped.length > 0)
          failures.push(
            `${engine} N=${count}: frame ${index} painted ${clipped.length} rows off their slot (${JSON.stringify(clipped[0])})`,
          );
      }
      if (verified.baseline) {
        const reference = verified.baseline;
        if (!same(reference.burst.frames, candidate.burst.frames)) {
          const at = reference.burst.frames.findIndex(
            (rows, index) => !same(rows, candidate.burst.frames[index]),
          );
          failures.push(
            `${engine} N=${count}: painted rows differ from the baseline at frame ${at}`,
          );
        }
        for (const name of [
          "totalSize",
          "clientWidth",
          "positions",
          "visible",
        ]) {
          if (!same(reference.trailing[name], candidate.trailing[name]))
            failures.push(
              `${engine} N=${count}: final ${name} differs from the baseline`,
            );
        }
      }
      const samples = Object.fromEntries(
        variants.map((variant) => [variant.name, []]),
      );
      for (let repeat = 0; repeat < rounds; repeat++) {
        const order = repeat % 2 === 0 ? variants : [...variants].reverse();
        for (const variant of order)
          samples[variant.name].push(await run(variant, count, false));
      }
      for (const variant of variants) {
        const runs = samples[variant.name];
        const deliveries = (sample) =>
          sample.burst.records.filter(
            (record) => record.kind === "resize" && record.observer === 1,
          );
        const drains = (sample) =>
          [...sample.burst.records, ...sample.trailing.records].filter(
            (record) => record.kind === "timer" && record.rects > 0,
          );
        const first = runs[0];
        const perDelivery = (name) =>
          spread(deliveries(first).map((record) => record[name]));
        const result = {
          engine,
          browserVersion: browser.version(),
          variant: variant.name,
          rows: rowKind,
          anchoring: first.setup.anchoring,
          count,
          mounted: first.setup.mounted,
          steps,
          stepPx,
          startWidth,
          rounds,
          deliveries: deliveries(first).length,
          perDelivery: {
            rects: perDelivery("rects"),
            followStart: perDelivery("followStart"),
            inserts: perDelivery("inserts"),
            removes: perDelivery("removes"),
            styleWrites: perDelivery("styles"),
            states: perDelivery("states"),
            renders: perDelivery("renders"),
          },
          burstTotals: {
            rects: sum(first.burst.records, "rects"),
            followStart: sum(first.burst.records, "followStart"),
            inserts: sum(first.burst.records, "inserts"),
            removes: sum(first.burst.records, "removes"),
            styleWrites: sum(first.burst.records, "styles"),
          },
          drain: {
            passes: drains(first).length,
            rects: sum(drains(first), "rects"),
            inserts: sum(drains(first), "inserts"),
            removes: sum(drains(first), "removes"),
            heldAfter500ms: first.trailing.heldAfterWait,
          },
          deliveryMs: spread(
            runs.map((sample) =>
              median(deliveries(sample).map((record) => record.ms)),
            ),
          ),
          slowestDeliveryMs: spread(
            runs.map((sample) =>
              Math.max(...deliveries(sample).map((record) => record.ms)),
            ),
          ),
          burstCallbackMs: spread(
            runs.map((sample) => sum(deliveries(sample), "ms")),
          ),
          drainMs: spread(runs.map((sample) => sum(drains(sample), "ms"))),
          totalSize: first.trailing.totalSize,
          verifiedFrames: verified[variant.name].burst.frames.length,
          paintedLikeBaseline: verified.baseline
            ? same(
                verified.baseline.burst.frames,
                verified[variant.name].burst.frames,
              )
            : null,
        };
        if (first.before) {
          result.burstLayouts = spread(
            runs.map((sample) => sample.between.count - sample.before.count),
          );
          result.burstLayoutMs = spread(
            runs.map((sample) => sample.between.ms - sample.before.ms),
          );
          result.burstStyleMs = spread(
            runs.map(
              (sample) => sample.between.styleMs - sample.before.styleMs,
            ),
          );
          result.drainLayoutMs = spread(
            runs.map((sample) => sample.after.ms - sample.between.ms),
          );
        }
        results.push(result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    }
  } finally {
    await browser.close();
  }
}
const output = resolve("browser-artifacts/width-resize-benchmark.json");
await mkdir(resolve("browser-artifacts"), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      baseUrl,
      baseline: baseline ?? null,
      results,
      failures,
    },
    null,
    2,
  ),
);
process.stdout.write(`Saved ${output}\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
}
