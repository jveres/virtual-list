// Run against an existing Vite dev server, with no other benchmark running:
// node scripts/browser-benchmark.mjs --url=http://127.0.0.1:4175
// Optional: --engine=chromium|firefox|webkit
// Synthetic fixed-height rows isolate runtime cost, not application rendering.
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
const browserTypes = { chromium, firefox, webkit };
if (selectedEngine && !Object.hasOwn(browserTypes, selectedEngine)) {
  throw new Error(`Unknown engine: ${selectedEngine}`);
}
const results = [];
for (const [engine, type] of Object.entries(browserTypes)) {
  if (selectedEngine && engine !== selectedEngine) continue;
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // A blank same-origin fixture avoids demo timers and background workloads.
    await page.route("**/__benchmark__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Runtime benchmark</title></head><body></body></html>",
      }),
    );
    await page.goto(`${baseUrl}/__benchmark__`);
    const measurements = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      const samples = [];
      for (const count of [1_000, 10_000]) {
        for (const declared of [false, true]) {
          for (const api of ["updateItem", "setItems"]) {
            for (let repeat = 0; repeat < 3; repeat++) {
              const viewport = document.createElement("div");
              viewport.style.cssText =
                "width:600px;height:600px;overflow:auto;overflow-anchor:none";
              document.body.appendChild(viewport);
              let built = 0;
              let destroyed = 0;
              const initial = Array.from({ length: count }, (_, id) => ({
                id,
                text: `Row ${id}`,
              }));
              const started = performance.now();
              const list = createVirtualList(viewport, {
                items: initial,
                key: (item) => String(item.id),
                height: declared ? () => 40 : undefined,
                boot: "start",
                settleStrategy: "default",
                render: (item, existing) => {
                  const element = existing ?? document.createElement("div");
                  if (!existing) built++;
                  element.dataset.benchmarkRow = "";
                  element.style.cssText =
                    "height:40px;box-sizing:border-box;overflow:hidden";
                  element.textContent = item.text;
                  return element;
                },
                onDestroy: () => {
                  destroyed++;
                },
              });
              const bootMs = performance.now() - started;
              try {
                viewport.scrollTop = 2_000;
                viewport.dispatchEvent(new Event("scroll"));
                await new Promise(requestAnimationFrame);
                if (!list.elementOf("55"))
                  throw new Error("Streaming row is not mounted");
                const items = [
                  ...Array.from({ length: 10 }, (_, i) => ({
                    id: i - 10,
                    text: `Prepend ${i}`,
                  })),
                  ...initial,
                ];
                list.setItems(items, { anchor: "viewport" });
                if (!list.state.held || list.state.count !== count)
                  throw new Error("Prepend was not held");
                const durations = [];
                // No timer yield: all updates belong to the same held phase.
                // First 10 calls warm the update path; time the next 100.
                for (let tick = 0; tick < 110; tick++) {
                  const item = { id: 55, text: `Token ${tick}` };
                  items[65] = item;
                  const before = performance.now();
                  if (api === "updateItem") list.updateItem("55", item);
                  else list.setItems(items);
                  if (tick >= 10) durations.push(performance.now() - before);
                }
                if (!list.state.held || list.state.count !== count)
                  throw new Error("Update lost the held prepend");
                const retainedRows = built - destroyed;
                const mountedRows = viewport.querySelectorAll(
                  "[data-benchmark-row]",
                ).length;
                // A command takes over the gesture and synchronously commits
                // held work. This measures commit + jump, not pure commit time.
                const beforeCommit = performance.now();
                const jumped = list.scrollTo("start", { behavior: "auto" });
                const commitAndJumpMs = performance.now() - beforeCommit;
                if (
                  !(await jumped) ||
                  list.state.count !== count + 10 ||
                  list.state.held
                ) {
                  throw new Error("Held snapshot did not commit");
                }
                await list.scrollTo("55", { behavior: "auto" });
                if (list.elementOf("55")?.textContent !== "Token 109")
                  throw new Error("Latest token lost");
                samples.push({
                  count,
                  declared,
                  api,
                  repeat,
                  bootMs,
                  durations,
                  retainedRows,
                  mountedRows,
                  commitAndJumpMs,
                });
              } finally {
                list.dispose();
                viewport.remove();
              }
              if (built !== destroyed)
                throw new Error(`Leaked ${built - destroyed} row elements`);
            }
          }
        }
      }
      return samples;
    });
    const percentile = (values, fraction) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor((sorted.length - 1) * fraction)];
    };
    for (const count of [1_000, 10_000]) {
      for (const declared of [false, true]) {
        for (const api of ["updateItem", "setItems"]) {
          const group = measurements.filter(
            (sample) =>
              sample.count === count &&
              sample.declared === declared &&
              sample.api === api,
          );
          const durations = group.flatMap((sample) => sample.durations);
          const result = {
            engine,
            browserVersion: browser.version(),
            count,
            heights: declared ? "declared" : "measured",
            api,
            samples: durations.length,
            updateMedianMs: percentile(durations, 0.5),
            updateP95Ms: percentile(durations, 0.95),
            updateMeanMs:
              durations.reduce((sum, time) => sum + time, 0) / durations.length,
            bootMedianMs: percentile(
              group.map((sample) => sample.bootMs),
              0.5,
            ),
            commitAndJumpMedianMs: percentile(
              group.map((sample) => sample.commitAndJumpMs),
              0.5,
            ),
            retainedRows: group[0].retainedRows,
            mountedRows: group[0].mountedRows,
          };
          results.push(result);
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
      }
    }
  } finally {
    await browser.close();
  }
}
const output = resolve("browser-artifacts/runtime-benchmark.json");
await mkdir(resolve("browser-artifacts"), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), baseUrl, results },
    null,
    2,
  ),
);
process.stdout.write(`Saved ${output}\n`);
