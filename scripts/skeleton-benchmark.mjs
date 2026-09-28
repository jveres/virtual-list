// Fast-scroll skeleton cost per commit, headless, against an existing Vite
// dev server, with no other benchmark running:
// node scripts/skeleton-benchmark.mjs --url=http://127.0.0.1:4175
// Optional: --engine=chromium|firefox|webkit --counts=100,1000,10000
//           --rounds=5 --candidate=/src --baseline=/baseline-src
//           --scale=1.5 --height=40.5 (device pixel ratio, row height)
// --baseline names a second copy of src/ served by the same server (for
// example `cp -R src baseline-src`); both copies then run in one page, in
// alternating order. Start the server after the copy exists: Vite versions
// the imports of a file it saw change, and the counters would then wrap a
// second instance of geometry.ts. Counters are exact; timings are batch sums.
// Synthetic fixed-height rows isolate runtime cost, not application rendering.
import "./firefox-app-data.mjs";
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
const rounds = Number(option("rounds") ?? 5);
const scale = Number(option("scale") ?? 1);
const rowHeight = Number(option("height") ?? 40);
const candidate = option("candidate") ?? "/src";
const baseline = option("baseline");
const browserTypes = { chromium, firefox, webkit };
if (selectedEngine && !Object.hasOwn(browserTypes, selectedEngine))
  throw new Error(`Unknown engine: ${selectedEngine}`);
const variants = {
  ...(baseline ? { baseline } : {}),
  candidate,
};

async function measure({ counts, rounds, variants, rowHeight }) {
  const TOKENS = 400;
  const GROWS = 100;
  const runtimes = {};
  for (const [name, root] of Object.entries(variants)) {
    const { createVirtualList } = await import(`${root}/virtual-list.ts`);
    const { Geometry } = await import(`${root}/geometry.ts`);
    runtimes[name] = { createVirtualList, Geometry };
  }
  const names = Object.keys(runtimes);

  function build(name, o, tally) {
    const viewport = document.createElement("div");
    viewport.style.cssText = "width:600px;height:600px;overflow:auto";
    document.body.appendChild(viewport);
    const items = Array.from({ length: o.count }, (_, id) => ({
      id,
      text: `Row ${id}`,
      height: rowHeight,
    }));
    const started = performance.now();
    const list = runtimes[name].createVirtualList(viewport, {
      items,
      key: (item) => String(item.id),
      height: o.declared ? (item) => item.height : undefined,
      settleStrategy: "default",
      scrollPlaceholders: o.placeholders,
      anchorable: (_item) => {
        if (tally) tally.anchorable += 1;
        return true;
      },
      renderScrollPlaceholder: o.hostSkeleton
        ? (_item, existing) => {
            if (tally) tally.skeletonRenders += 1;
            return existing ?? document.createElement("div");
          }
        : undefined,
      render: (item, existing) => {
        const element = existing ?? document.createElement("div");
        element.style.cssText = `height:${item.height}px;box-sizing:border-box;overflow:hidden`;
        element.textContent = item.text;
        return element;
      },
    });
    // The first layout belongs to the boot that made it necessary.
    viewport.getBoundingClientRect();
    const bootMs = performance.now() - started;
    return { list, viewport, bootMs };
  }

  /** Streamed tokens into the last row; every `line`th grows it by a line. */
  function tokens(list, count, line, after) {
    const id = count - 1;
    let height = rowHeight;
    for (let tick = 0; tick < TOKENS; tick++) {
      if (tick % line === line - 1) height += 20;
      list.updateItem(String(id), { id, text: `Token ${tick}`, height });
      after?.();
    }
  }

  /** A row near the top grows on every update: every later row moves. */
  function grows(list, after) {
    let height = rowHeight;
    for (let tick = 0; tick < GROWS; tick++) {
      height += 2;
      list.updateItem("3", { id: 3, text: `Grow ${tick}`, height });
      after?.();
    }
  }

  function toggles(list) {
    list.setScrollPlaceholders(false);
    list.setScrollPlaceholders(true);
  }

  const zero = () => ({
    anchorable: 0,
    skeletonRenders: 0,
    offsetOf: 0,
    heightOf: 0,
    rectReads: 0,
    skeletonStyleWrites: 0,
    skeletonInserted: 0,
    skeletonRemoved: 0,
    otherStyleWrites: 0,
  });

  // --- Counters: exact, with every probe installed ---------------------------
  const counters = [];
  for (const name of names) {
    const tally = zero();
    const { Geometry } = runtimes[name];
    const originals = {
      offsetOf: Geometry.prototype.offsetOf,
      heightOf: Geometry.prototype.heightOf,
    };
    for (const method of ["offsetOf", "heightOf"]) {
      Geometry.prototype[method] = function (...args) {
        tally[method] += 1;
        return originals[method].apply(this, args);
      };
    }
    const readRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      tally.rectReads += 1;
      return readRect.call(this);
    };
    try {
      for (const count of counts) {
        for (const declared of [false, true]) {
          for (const hostSkeleton of [false, true]) {
            for (const placeholders of [false, true]) {
              if (hostSkeleton && !placeholders) continue;
              const observer = new MutationObserver(() => {});
              const drain = () => {
                for (const record of observer.takeRecords()) {
                  const inside =
                    record.target instanceof Element &&
                    record.target.closest("[data-scroll-skeletons]") !== null;
                  if (record.type === "attributes") {
                    if (inside) tally.skeletonStyleWrites += 1;
                    else tally.otherStyleWrites += 1;
                  } else if (inside) {
                    tally.skeletonInserted += record.addedNodes.length;
                    tally.skeletonRemoved += record.removedNodes.length;
                  }
                }
              };
              const snapshot = (workload, calls, extra = {}) => {
                drain();
                counters.push({
                  variant: name,
                  count,
                  declared,
                  hostSkeleton,
                  placeholders,
                  workload,
                  calls,
                  ...tally,
                  ...extra,
                });
                Object.assign(tally, zero());
              };
              Object.assign(tally, zero());
              const o = { count, declared, hostSkeleton, placeholders };
              const { list, viewport } = build(name, o, tally);
              const surface = () =>
                viewport.querySelector("[data-scroll-skeletons]");
              observer.observe(viewport, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["style"],
              });
              try {
                snapshot("boot", 1, {
                  skeletonElements:
                    surface()?.querySelectorAll("*").length ?? 0,
                  elements: viewport.querySelectorAll("*").length,
                  anchoring: viewport.firstElementChild?.dataset.anchoring,
                });
                tokens(list, count, Number.POSITIVE_INFINITY, drain);
                snapshot("neutral", TOKENS);
                tokens(list, count, 20, drain);
                snapshot("tokens", TOKENS);
                grows(list, drain);
                snapshot("grows", GROWS);
                if (placeholders) {
                  toggles(list);
                  snapshot("toggle", 1, {
                    skeletonElements:
                      surface()?.querySelectorAll("*").length ?? 0,
                  });
                }
              } finally {
                observer.disconnect();
                list.dispose();
                viewport.remove();
              }
            }
          }
        }
      }
    } finally {
      Object.assign(Geometry.prototype, originals);
      Element.prototype.getBoundingClientRect = readRect;
    }
  }

  // --- Timings: no probes, variants alternating within each round ------------
  const timings = [];
  const timed = (work) => {
    const started = performance.now();
    work();
    return performance.now() - started;
  };
  for (const count of counts) {
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? names : [...names].reverse();
      for (const declared of [false, true]) {
        for (const placeholders of [false, true]) {
          for (const name of order) {
            const o = { count, declared, hostSkeleton: false, placeholders };
            const { list, viewport, bootMs } = build(name, o, null);
            try {
              const flush = () => viewport.getBoundingClientRect();
              const sample = {
                variant: name,
                count,
                declared,
                placeholders,
                round,
                bootMs,
                neutralMs: timed(() => {
                  tokens(list, count, Number.POSITIVE_INFINITY);
                  flush();
                }),
                tokensMs: timed(() => {
                  tokens(list, count, 20);
                  flush();
                }),
                growsMs: timed(() => {
                  grows(list);
                  flush();
                }),
              };
              if (placeholders)
                sample.toggleMs = timed(() => {
                  toggles(list);
                  flush();
                });
              timings.push(sample);
            } finally {
              list.dispose();
              viewport.remove();
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }
    }
  }
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio,
    tokens: TOKENS,
    grows: GROWS,
    counters,
    timings,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round3 = (value) => Math.round(value * 1000) / 1000;

const results = [];
for (const [engine, type] of Object.entries(browserTypes)) {
  if (selectedEngine && engine !== selectedEngine) continue;
  const browser = await type.launch({
    headless: true,
    // Batch sums need more than Firefox's default 1 ms clock.
    firefoxUserPrefs:
      engine === "firefox"
        ? {
            "privacy.reduceTimerPrecision": false,
            "privacy.resistFingerprinting": false,
          }
        : undefined,
  });
  try {
    const page = await browser.newPage({ deviceScaleFactor: scale });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    // A blank same-origin fixture avoids demo timers and background workloads.
    await page.route("**/__benchmark__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Skeleton benchmark</title></head><body></body></html>",
      }),
    );
    await page.goto(`${baseUrl}/__benchmark__`);
    const measured = await page.evaluate(measure, {
      counts,
      rounds,
      variants,
      rowHeight,
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const summary = [];
    const groups = new Map();
    for (const sample of measured.timings) {
      const id = `${sample.count}|${sample.declared}|${sample.placeholders}|${sample.variant}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(sample);
    }
    for (const samples of groups.values()) {
      const { count, declared, placeholders, variant } = samples[0];
      const row = { count, declared, placeholders, variant };
      for (const metric of [
        "bootMs",
        "neutralMs",
        "tokensMs",
        "growsMs",
        "toggleMs",
      ]) {
        const values = samples
          .map((sample) => sample[metric])
          .filter((value) => value !== undefined);
        if (values.length === 0) continue;
        row[metric] = {
          median: round3(median(values)),
          min: round3(Math.min(...values)),
          max: round3(Math.max(...values)),
        };
      }
      summary.push(row);
    }
    results.push({
      engine,
      version: browser.version(),
      userAgent: measured.userAgent,
      devicePixelRatio: measured.devicePixelRatio,
      rounds,
      tokens: measured.tokens,
      grows: measured.grows,
      counters: measured.counters,
      timings: summary,
    });
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify(results, null, 2));
