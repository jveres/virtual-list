// Counts and times updateItem on declared-height lists, headless.
// Run against an existing Vite dev server, with no other benchmark running:
// node scripts/declared-update-benchmark.mjs --url=http://127.0.0.1:4175
// Optional: --engine=chromium|firefox|webkit, --rounds=5, and
// --baseline=/baseline-src/virtual-list.ts to compare a second copy of the
// runtime that the same server serves.
// Counters are exact. Timings are JavaScript and DOM work without paint.
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
const baseline = option("baseline");
const rounds = Number(option("rounds") ?? 5);
const browserTypes = { firefox, chromium, webkit };
if (selectedEngine && !Object.hasOwn(browserTypes, selectedEngine)) {
  throw new Error(`Unknown engine: ${selectedEngine}`);
}
const modules = {
  ...(baseline ? { baseline } : {}),
  candidate: "/src/virtual-list.ts",
};

// Rows sit around the anchor row, in the middle of the list. `phase` runs
// the batch inside one scroll phase; `prepend` holds a snapshot first.
const scenarios = [
  { name: "idle, mounted row, same height", target: "below" },
  { name: "idle, mounted row, new height", target: "below", grow: true },
  { name: "idle, unmounted row, same height", target: "last" },
  { name: "idle, unmounted row, new height", target: "last", grow: true },
  {
    name: "phase, mounted row below the anchor, same height",
    target: "below",
    phase: true,
  },
  {
    name: "phase, mounted row below the anchor, new height",
    target: "below",
    grow: true,
    phase: true,
  },
  {
    name: "phase, mounted row above the anchor, new height (held)",
    target: "above",
    grow: true,
    phase: true,
    held: true,
  },
  {
    name: "phase, unmounted row above the anchor, new height (held)",
    target: "first",
    grow: true,
    phase: true,
    held: true,
  },
  {
    name: "phase, held prepend, mounted row, same height (held)",
    target: "below",
    phase: true,
    prepend: true,
    held: true,
  },
];

const results = [];
let failed = false;
for (const [engine, type] of Object.entries(browserTypes)) {
  if (selectedEngine && engine !== selectedEngine) continue;
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // A blank same-origin fixture avoids demo timers and background workloads.
    await page.route("**/__benchmark__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Declared update benchmark</title></head><body></body></html>",
      }),
    );
    await page.goto(`${baseUrl}/__benchmark__`);
    const samples = await page.evaluate(
      async ({ modules, scenarios, rounds }) => {
        const runtimes = {};
        for (const [variant, path] of Object.entries(modules))
          runtimes[variant] = (await import(path)).createVirtualList;
        const frame = () => new Promise(requestAnimationFrame);
        const WARM = 10;
        const CALLS = 300;

        /** Count Map work, layout reads and DOM mutations while `work` runs. */
        const counted = (viewport, work) => {
          const tally = {
            mapSet: 0,
            mapGet: 0,
            mapHas: 0,
            mapSteps: 0,
            rectReads: 0,
          };
          const stepper = Object.getPrototypeOf(new Map().entries());
          const original = {
            set: Map.prototype.set,
            get: Map.prototype.get,
            has: Map.prototype.has,
            next: stepper.next,
            rect: Element.prototype.getBoundingClientRect,
          };
          const observer = new MutationObserver(() => {});
          observer.observe(viewport, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["style"],
          });
          Map.prototype.set = function (key, value) {
            tally.mapSet += 1;
            return original.set.call(this, key, value);
          };
          Map.prototype.get = function (key) {
            tally.mapGet += 1;
            return original.get.call(this, key);
          };
          Map.prototype.has = function (key) {
            tally.mapHas += 1;
            return original.has.call(this, key);
          };
          stepper.next = function () {
            tally.mapSteps += 1;
            return original.next.call(this);
          };
          Element.prototype.getBoundingClientRect = function () {
            tally.rectReads += 1;
            return original.rect.call(this);
          };
          try {
            work();
          } finally {
            Map.prototype.set = original.set;
            Map.prototype.get = original.get;
            Map.prototype.has = original.has;
            stepper.next = original.next;
            Element.prototype.getBoundingClientRect = original.rect;
          }
          let inserted = 0;
          let removed = 0;
          let styleWrites = 0;
          for (const record of observer.takeRecords()) {
            if (record.type === "attributes") styleWrites += 1;
            inserted += record.addedNodes.length;
            removed += record.removedNodes.length;
          }
          observer.disconnect();
          return { ...tally, inserted, removed, styleWrites };
        };

        const run = async (variant, scenario, count, counting) => {
          const viewport = document.createElement("div");
          viewport.style.cssText =
            "width:600px;height:600px;overflow:auto;overflow-anchor:none";
          document.body.appendChild(viewport);
          const host = { key: 0, height: 0, render: 0 };
          const initial = Array.from({ length: count }, (_, index) => ({
            id: String(index),
            height: 40 + (index % 5) * 12,
            text: `Item ${index}`,
          }));
          const list = runtimes[variant](viewport, {
            items: initial,
            key: (item) => {
              host.key += 1;
              return item.id;
            },
            height: (item) => {
              host.height += 1;
              return item.height;
            },
            boot: "start",
            anchoring: "runtime",
            settleStrategy: "default",
            render: (item, existing) => {
              host.render += 1;
              const row = existing ?? document.createElement("div");
              row.style.height = `${item.height}px`;
              row.textContent = item.text;
              return row;
            },
          });
          try {
            const anchor = Math.floor(count / 2);
            const index = {
              below: anchor + 3,
              above: anchor - 3,
              first: 1,
              last: count - 1,
            }[scenario.target];
            const key = String(index);
            await list.scrollTo(String(anchor), { behavior: "auto" });
            await new Promise((done) => setTimeout(done, 250));
            if (scenario.phase) {
              // An unmatched scroll event starts a scroll phase.
              viewport.scrollTop += 10;
              viewport.dispatchEvent(new Event("scroll"));
            }
            const mounted = list.elementOf(key) !== null;
            if (mounted !== ["below", "above"].includes(scenario.target))
              throw new Error(`row ${key} is ${mounted ? "" : "not "}mounted`);
            if (scenario.prepend) {
              list.setItems(
                [
                  ...Array.from({ length: 10 }, (_, i) => ({
                    id: `p${i}`,
                    height: 40,
                    text: `Prepend ${i}`,
                  })),
                  ...initial,
                ],
                { anchor: "viewport" },
              );
              if (!list.state.held) throw new Error("the prepend was not held");
            }
            const base = initial[index].height;
            const update = (tick) =>
              list.updateItem(key, {
                id: key,
                height: scenario.grow ? base + (tick % 2 ? 24 : 12) : base,
                text: `Token ${tick}`,
              });
            for (let tick = 0; tick < WARM; tick++) update(tick);
            host.key = host.height = host.render = 0;
            const batch = () => {
              for (let tick = WARM; tick < WARM + CALLS; tick++) update(tick);
            };
            let counters = null;
            let ms = null;
            if (counting) {
              counters = counted(viewport, batch);
              Object.assign(counters, {
                keyCalls: host.key,
                heightCalls: host.height,
                renderCalls: host.render,
              });
              for (const name of Object.keys(counters))
                counters[name] = counters[name] / CALLS;
            } else {
              const started = performance.now();
              batch();
              ms = (performance.now() - started) / CALLS;
            }
            if (list.state.held !== (scenario.held === true))
              throw new Error(`held=${list.state.held} after the batch`);
            if (scenario.phase) {
              // A witness: the phase outlived the batch if this one is held.
              list.updateItem("2", { ...initial[2], height: 200 });
              if (!list.state.held) throw new Error("the phase ended early");
              viewport.dispatchEvent(new Event("scrollend"));
              const deadline = performance.now() + 3000;
              while (list.state.held && performance.now() < deadline)
                await frame();
              if (list.state.held) throw new Error("held work never landed");
            }
            await frame();
            // The outcome: geometry of every key and the mounted DOM.
            const keys = [
              ...(scenario.prepend
                ? Array.from({ length: 10 }, (_, i) => `p${i}`)
                : []),
              ...initial.map((item) => item.id),
            ];
            const canvas = viewport.firstElementChild;
            const outcome = JSON.stringify({
              state: list.state,
              scrollTop: viewport.scrollTop,
              positions: keys.map((each) => list.positionOf(each)),
              dom: [...canvas.children].map(
                (slot) => `${slot.style.cssText}|${slot.textContent}`,
              ),
            });
            let hash = 2166136261;
            for (let at = 0; at < outcome.length; at++)
              hash = Math.imul(hash ^ outcome.charCodeAt(at), 16777619);
            return {
              variant,
              scenario: scenario.name,
              count,
              counters,
              ms,
              totalSize: list.state.totalSize,
              elements: viewport.querySelectorAll("*").length,
              outcome: (hash >>> 0).toString(16),
            };
          } finally {
            list.dispose();
            viewport.remove();
          }
        };

        const samples = [];
        const variants = Object.keys(runtimes);
        for (const count of [100, 1_000, 10_000]) {
          for (const scenario of scenarios) {
            // Counters twice: they must repeat exactly.
            for (let repeat = 0; repeat < 2; repeat++)
              for (const variant of variants)
                samples.push(await run(variant, scenario, count, true));
            // Timings alternate the order of the variants between rounds.
            for (let round = 0; round < rounds; round++) {
              const order = round % 2 ? [...variants].reverse() : variants;
              for (const variant of order)
                samples.push(await run(variant, scenario, count, false));
            }
          }
        }
        return samples;
      },
      { modules, scenarios, rounds },
    );

    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor((sorted.length - 1) / 2)];
    };
    for (const count of [100, 1_000, 10_000]) {
      for (const scenario of scenarios) {
        const group = samples.filter(
          (sample) =>
            sample.count === count && sample.scenario === scenario.name,
        );
        const outcomes = new Set(group.map((sample) => sample.outcome));
        for (const variant of Object.keys(modules)) {
          const own = group.filter((sample) => sample.variant === variant);
          const counters = own.filter((sample) => sample.counters !== null);
          const times = own
            .filter((sample) => sample.ms !== null)
            .map((sample) => sample.ms);
          const repeatable =
            JSON.stringify(counters[0].counters) ===
            JSON.stringify(counters[1].counters);
          const result = {
            engine,
            browserVersion: browser.version(),
            scenario: scenario.name,
            count,
            variant,
            perCall: counters[0].counters,
            countersRepeat: repeatable,
            msPerCallMedian: median(times),
            msPerCallMin: Math.min(...times),
            msPerCallMax: Math.max(...times),
            rounds: times.length,
            totalSize: own[0].totalSize,
            elements: own[0].elements,
            sameOutcome: outcomes.size === 1,
          };
          if (!repeatable || outcomes.size !== 1) failed = true;
          results.push(result);
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
      }
    }
  } finally {
    await browser.close();
  }
}
const output = resolve(
  option("output") ?? "browser-artifacts/declared-update-benchmark.json",
);
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), baseUrl, modules, results },
    null,
    2,
  ),
);
process.stdout.write(`Saved ${output}\n`);
if (failed) {
  process.stderr.write("Counters or outcomes differ between runs.\n");
  process.exitCode = 1;
}
