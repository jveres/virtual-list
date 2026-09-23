// Compare the runtime of two servers on the same synthetic workloads:
//   node next/bench/compare.mjs --main=http://127.0.0.1:4274 \
//     --next=http://127.0.0.1:4273 [--engine=chromium] [--rounds=5]
// Start main with the default Vite config and next with vite.next.config.ts;
// each resolves /src/virtual-list.ts to its own runtime. Rows carry
// markdown-like content so measurement and mounting do real layout work.
// Headless CPU timing only: it does not measure physical presentation.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium, firefox, webkit } from "playwright";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const servers = {
  main: option("main", "http://127.0.0.1:4274"),
  next: option("next", "http://127.0.0.1:4273"),
};
const rounds = Number(option("rounds", "5"));
const engines = { chromium, firefox, webkit };
const selected = option("engine");

/** Runs in the page: one round of every workload on one runtime. */
async function workload() {
  const { createVirtualList } = await import("/src/virtual-list.ts");
  const words =
    "the virtual list keeps geometry exact while rows stream in and pages arrive from either edge".split(
      " ",
    );
  const text = (seed, count) =>
    Array.from(
      { length: count },
      (_, i) => words[(seed * 7 + i) % words.length],
    ).join(" ");
  const build = (item) => {
    const row = document.createElement("article");
    row.className = "bench-row";
    const title = document.createElement("h3");
    title.textContent = `Message ${item.id}`;
    const body = document.createElement("div");
    body.innerHTML = `<p>${text(item.id, 40 + (item.id % 30))}</p><p>${text(item.id + 3, 25)}</p><pre><code>${text(item.id + 5, 12)}\n${text(item.id + 9, 10)}</code></pre><ul><li>${text(item.id, 8)}</li><li>${text(item.id + 1, 6)}</li></ul>`;
    row.append(title, body);
    return row;
  };
  const render = (item, existing) => {
    if (existing && item.tail !== undefined) {
      existing.lastElementChild.lastElementChild.textContent = item.tail;
      return existing;
    }
    return build(item);
  };
  const style = document.createElement("style");
  style.textContent =
    ".bench-row{font:15px/1.5 system-ui,sans-serif;padding:8px 16px}.bench-row pre{white-space:pre-wrap;background:#eee;padding:8px}";
  document.head.append(style);
  const frame = () =>
    new Promise((done) => requestAnimationFrame(() => done()));
  const settleFrames = async () => {
    await frame();
    await frame();
  };
  const mountList = (items, extra = {}) => {
    const viewport = document.createElement("div");
    viewport.style.cssText =
      "width:720px;height:800px;overflow:auto;overflow-anchor:none";
    document.body.append(viewport);
    const list = createVirtualList(viewport, {
      items,
      key: (item) => String(item.id),
      render,
      settleStrategy: "default",
      scrollingUpdates: "live",
      overscanPx: 800,
      ...extra,
    });
    return { list, viewport };
  };
  const range = (from, to) =>
    Array.from({ length: to - from }, (_, i) => ({ id: from + i }));
  const result = {};

  // A. Boot 300 measured rows at the end.
  {
    const started = performance.now();
    const { list, viewport } = mountList(range(0, 300));
    void viewport.offsetHeight;
    result.bootMs = performance.now() - started;
    list.dispose();
    viewport.remove();
  }

  // B. Idle page commit: prepend 60 fresh rows, anchored, then lay out.
  {
    const { list, viewport } = mountList(range(0, 100));
    await settleFrames();
    const started = performance.now();
    list.setItems(range(-60, 100), { anchor: "viewport" });
    void viewport.offsetHeight;
    result.prependCommitMs = performance.now() - started;
    await settleFrames();
    list.dispose();
    viewport.remove();
  }

  // C. Append in view: 20 fresh rows at the end while following.
  {
    const items = range(0, 100);
    const { list, viewport } = mountList(items);
    await settleFrames();
    const started = performance.now();
    list.setItems([...items, ...range(100, 120)], { anchor: "end" });
    void viewport.offsetHeight;
    result.appendInViewMs = performance.now() - started;
    await settleFrames();
    list.dispose();
    viewport.remove();
  }

  // D. Scroll sweep: 60 steps of 240px, each reconciled and laid out.
  {
    const { list, viewport } = mountList(range(0, 400), { boot: "start" });
    await settleFrames();
    let total = 0;
    for (let step = 1; step <= 60; step++) {
      const started = performance.now();
      viewport.scrollTop = step * 240;
      viewport.dispatchEvent(new Event("scroll"));
      void viewport.offsetHeight;
      total += performance.now() - started;
      await frame();
    }
    result.scrollStepMs = total / 60;
    list.dispose();
    viewport.remove();
  }

  // E. Streaming: 120 tokens grow the last row in place while following.
  {
    const items = range(0, 60);
    const { list, viewport } = mountList(items);
    await settleFrames();
    let total = 0;
    let tail = "";
    for (let token = 0; token < 120; token++) {
      tail += ` ${words[token % words.length]}`;
      const item = { id: 59, tail };
      const started = performance.now();
      list.updateItem("59", item);
      void viewport.offsetHeight;
      total += performance.now() - started;
      await frame();
    }
    result.tokenMs = total / 120;
    list.dispose();
    viewport.remove();
  }
  style.remove();
  return result;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const report = [];
for (const [engine, type] of Object.entries(engines)) {
  if (selected && selected !== engine) continue;
  const browser = await type.launch({ headless: true });
  try {
    const samples = { main: [], next: [] };
    for (let round = 0; round < rounds; round++) {
      // Alternate the order so neither runtime always runs first.
      const order = round % 2 === 0 ? ["main", "next"] : ["next", "main"];
      for (const name of order) {
        const page = await browser.newPage();
        await page.route("**/__bench__", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><html><body></body></html>",
          }),
        );
        await page.goto(`${servers[name]}/__bench__`);
        samples[name].push(await page.evaluate(workload));
        await page.close();
      }
    }
    for (const metric of Object.keys(samples.main[0])) {
      const main = median(samples.main.map((sample) => sample[metric]));
      const next = median(samples.next.map((sample) => sample[metric]));
      const row = {
        engine,
        version: browser.version(),
        metric,
        mainMs: Number(main.toFixed(2)),
        nextMs: Number(next.toFixed(2)),
        change: `${(((next - main) / main) * 100).toFixed(0)}%`,
      };
      report.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  } finally {
    await browser.close();
  }
}
const output = resolve("browser-artifacts/next-compare.json");
await mkdir(resolve("browser-artifacts"), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), servers, rounds, report },
    null,
    2,
  ),
);
process.stdout.write(`Saved ${output}\n`);
