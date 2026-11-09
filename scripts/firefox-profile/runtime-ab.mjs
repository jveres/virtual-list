// Interleaved A/B of a baseline runtime revision and the working tree, in one
// page of a headless Playwright browser. Both runtimes run the synthetic
// workloads of fixtures/runtime-ab.js in alternating order. The timings cover
// JavaScript and layout only: no paint, native input, or presentation.
//
//   node scripts/firefox-profile/runtime-ab.mjs --baseline=<commit>
//     [--browser=firefox|chromium] [--trials=1..3] [--scenarios=a,b] [--port=4198]
//
// Owns its diagnostic server and browser, never an existing application
// server. The baseline's src/ tree is extracted under ignored
// browser-artifacts/ and removed when the run ends.
import "../firefox-app-data.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROUNDS = 14;
const WARMUP_ROUNDS = 2;
const MAX_TRIALS = 3;

export function parseArguments(argv) {
  const options = {
    baseline: "",
    browser: "firefox",
    trials: MAX_TRIALS,
    scenarios: [],
    port: 4198,
  };
  for (const argument of argv) {
    const [name, value = ""] = argument.split("=");
    if (name === "--baseline") options.baseline = value;
    else if (name === "--browser") options.browser = value;
    else if (name === "--trials") options.trials = Number(value);
    else if (name === "--scenarios")
      options.scenarios = value.split(",").filter(Boolean);
    else if (name === "--port") options.port = Number(value);
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!/^[a-f0-9]{7,40}$/.test(options.baseline))
    throw new Error("Expected --baseline=<hexadecimal commit ID>");
  if (options.browser !== "firefox" && options.browser !== "chromium")
    throw new Error("Expected --browser=firefox or --browser=chromium");
  if (
    !Number.isInteger(options.trials) ||
    options.trials < 1 ||
    options.trials > MAX_TRIALS
  )
    throw new Error(`Expected --trials from 1 through ${MAX_TRIALS}`);
  if (
    !Number.isInteger(options.port) ||
    options.port < 1024 ||
    options.port > 65535
  )
    throw new Error("Expected --port from 1024 through 65535");
  return options;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

/** Per scenario: each trial's medians, and the median of the trial deltas. */
export function summarize(trials) {
  const summary = {};
  for (const name of Object.keys(trials[0] ?? {})) {
    const rows = trials.map((trial) => {
      const baseline = median(trial[name].baseline);
      const candidate = median(trial[name].candidate);
      return {
        baselineMs: Number(baseline.toFixed(2)),
        candidateMs: Number(candidate.toFixed(2)),
        deltaPct: Number(
          (((candidate - baseline) / baseline) * 100).toFixed(1),
        ),
      };
    });
    summary[name] = {
      trials: rows,
      medianDeltaPct: median(rows.map((row) => row.deltaPct)),
    };
  }
  return summary;
}

async function runTrial(page, baselinePath, scenarios, rounds, warmup) {
  return page.evaluate(
    async ({ baselinePath, scenarios, rounds, warmup }) => {
      const [baseline, candidate, fixture] = await Promise.all([
        import(`${baselinePath}/virtual-list.ts`),
        import("/src/virtual-list.ts"),
        import("/scripts/firefox-profile/fixtures/runtime-ab.js"),
      ]);
      const modules = { baseline, candidate };
      const names =
        scenarios.length > 0 ? scenarios : Object.keys(fixture.scenarios);
      const samples = {};
      for (const name of names) {
        const run = fixture.scenarios[name];
        if (!run) throw new Error(`Unknown scenario ${name}`);
        samples[name] = { baseline: [], candidate: [] };
        for (let round = 0; round < rounds; round++) {
          const order =
            round % 2 === 0
              ? ["baseline", "candidate"]
              : ["candidate", "baseline"];
          for (const side of order) {
            const elapsed = await run(modules[side]);
            if (round >= warmup) samples[name][side].push(elapsed);
          }
        }
      }
      return samples;
    },
    { baselinePath, scenarios, rounds, warmup },
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const relative = join("browser-artifacts", `runtime-ab-${process.pid}`);
  const directory = join(root, relative);
  let server = null;
  let browser = null;
  const cleanup = async () => {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => cleanup().finally(() => process.exit(1)));
  try {
    mkdirSync(directory, { recursive: true });
    const archive = execFileSync(
      "git",
      ["archive", "--format=tar", options.baseline, "src"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    const { createServer } = await import("vite");
    server = await createServer({
      root,
      logLevel: "error",
      server: {
        host: "127.0.0.1",
        port: options.port,
        strictPort: true,
        hmr: false,
        open: false,
      },
    });
    await server.listen();
    const playwright = await import("playwright");
    browser =
      options.browser === "firefox"
        ? await playwright.firefox.launch({
            headless: true,
            firefoxUserPrefs: {
              "privacy.reduceTimerPrecision": false,
              "privacy.resistFingerprinting": false,
            },
          })
        : await playwright.chromium.launch({ headless: true });
    const trials = [];
    for (let trial = 0; trial < options.trials; trial++) {
      // A fresh page per trial: independent module instances and heap.
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      await page.route("**/__runtime-ab__", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>runtime A/B</title><body style=margin:0></body>",
        }),
      );
      await page.goto(`http://127.0.0.1:${options.port}/__runtime-ab__`);
      trials.push(
        await runTrial(
          page,
          `/${relative.split("\\").join("/")}/src`,
          options.scenarios,
          ROUNDS,
          WARMUP_ROUNDS,
        ),
      );
      await page.close();
    }
    console.log(
      JSON.stringify(
        {
          baseline: options.baseline,
          browser: `${options.browser} ${browser.version()}`,
          rounds: ROUNDS - WARMUP_ROUNDS,
          results: summarize(trials),
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
