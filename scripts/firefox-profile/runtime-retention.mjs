// Installed Firefox memory diagnostic, not a scroll-speed benchmark.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { writeReproduction } from "./artifacts.mjs";
import { parseFootprints } from "./memory-analysis.mjs";
import { delay, launchFirefox } from "./memory-browser.mjs";
import { summarizeRetentionMemory } from "./retention-analysis.mjs";
import { validateDisplay } from "./safari-validation.mjs";
import { summarizeStructureProfile } from "./structure-analysis.mjs";

const { values: options } = parseArgs({
  options: {
    cycles: { type: "string", default: "12" },
    workload: { type: "string", default: "lifecycle" },
    display: { type: "string", default: "LU28R55" },
    output: { type: "string", default: "browser-artifacts/runtime-retention" },
    url: { type: "string" },
    diagnostic: { type: "boolean", default: false },
    help: { type: "boolean" },
  },
});
if (options.help) {
  console.log(
    "Usage: node scripts/firefox-profile/runtime-retention.mjs [--workload=lifecycle|structures|structures-natural|paging-natural] [--diagnostic] [--cycles=12] [--display=LU28R55] [--output=browser-artifacts/runtime-retention] [--url=http://127.0.0.1:4193]\nInstalled macOS Firefox, fresh profile, closed DevTools. Collects before/after GC+CC memory. Lifecycle measures weak item/node counts for replacement, paging, and disposal; structures measures geometry and list API operations at 1k, 10k, and 100k items. structures-natural additionally records post-operation memory before requesting collection. paging-natural runs overlapping pages, cancellation, live edits and eviction without forced collection between cycles; use --cycles=120 for a sustained workload (maximum 240). --diagnostic requires structures or paging-natural and an owned server; adds GC/sample attribution and, for structures, gap/overlap queries, tree-build controls, and a buffer-accounting probe. No native gesture timing claims.",
  );
  process.exit(0);
}
const cycles = Number(options.cycles);
assert.ok(
  ["lifecycle", "structures", "structures-natural", "paging-natural"].includes(
    options.workload,
  ),
  "Unknown workload",
);
const structures = options.workload.startsWith("structures");
const paging = options.workload === "paging-natural";
assert.ok(
  !options.diagnostic || ((structures || paging) && !options.url),
  "Diagnostic capture requires structures or paging-natural and an owned server",
);
assert.ok(
  Number.isInteger(cycles) &&
    cycles >= 4 &&
    cycles <= (paging ? 240 : 24) &&
    cycles % 4 === 0,
  `cycles must be 4..${paging ? 240 : 24} in groups of four`,
);
assert.equal(
  process.platform,
  "darwin",
  "Installed-browser measurement requires macOS",
);
const output = resolve(options.output);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "run-"));
const native = join(directory, "native");
const counter = join(directory, "footprint");
let browser, server, awake;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  status: "running",
  options,
  started: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  system: execFileSync("/usr/bin/sw_vers", { encoding: "utf8" }).trim(),
  checkpoints: [],
  footprintRetries: [],
  profiles: [],
  naturalSamples: [],
  measurement: `${structures ? "Geometry/list API wall timings and storage" : paging ? "Paging API wall timings, ownership and storage" : "WeakRef counts"}; explicit window reporter bytes; owned-process physical footprints. Checkpoints request Firefox minimizeMemoryUsage (GC, cycle collection, memory pressure) unless minimize=false; structures-natural and paging-natural add an unforced checkpoint after exercise. Paging cycles have no forced collection or diagnostic tabs; naturalSamples records process footprints every twenty cycles and at the end. Forced collection between cases alters natural cache/GC behavior. Diagnostics add per-case 2 ms sampled JS profiles and clipped GC/CC slices during marked workload phases, including warmup and frame waits but excluding diagnostic collections. Profiler overhead affects timing and memory. Instant API scrolling, not native gesture timing.`,
};
const geometryExpression =
  "({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})";
const fixturePath = `/scripts/firefox-profile/fixtures/${structures ? "data-structures" : paging ? "paging-structures" : "runtime-retention"}.html`;
const fixtureAPI = structures
  ? "__dataStructures"
  : paging
    ? "__pagingStructures"
    : "__runtimeRetention";
function check() {
  assert.equal(interrupted, false, "Capture interrupted");
  const session = JSON.parse(
    execFileSync(native, ["session"], { encoding: "utf8" }),
  );
  assert.ok(session.onConsole && !session.locked, "Desktop is locked");
}
function footprints() {
  for (let attempt = 0; ; attempt++) {
    const owned = browser.processes();
    assert.ok(owned.length, "No owned browser processes");
    const sample = execFileSync(
      counter,
      owned.map((p) => String(p.pid)),
      { encoding: "utf8" },
    );
    try {
      return parseFootprints(sample);
    } catch (error) {
      // Current and lifetime-peak counters can be sampled across an update.
      // Preserve the rejected counters and require a subsequent valid sample.
      report.footprintRetries.push({ sample, error: String(error) });
      if (attempt === 2) throw error;
    }
  }
}
async function checkpoint(label, minimize = true) {
  check();
  assert.deepEqual(
    await browser.evaluate(geometryExpression),
    report.geometry,
    "Display geometry changed",
  );
  assert.equal(
    await browser.evaluate("document.visibilityState"),
    "visible",
    "Fixture hidden outside diagnostic collection",
  );
  const before = footprints();
  // about:memory runs privileged collection in a temporary diagnostic tab.
  // No fixture objects are returned through the automation protocol.
  const rows = await browser.memoryReport({ minimize, minBytes: 0 });
  await delay(100);
  const page = await browser.evaluate(`${fixtureAPI}.snapshot()`);
  assert.deepEqual(page.errors, [], "Fixture errors");
  if (report.documentId)
    assert.equal(page.documentId, report.documentId, "Fixture reloaded");
  report.documentId = page.documentId;
  const memory = summarizeRetentionMemory(rows, fixturePath);
  report.checkpoints.push({
    label,
    minimize,
    page,
    memory,
    beforeCollection: before,
    afterCollection: footprints(),
  });
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    label,
    JSON.stringify({
      windowMiB: +(memory.windowBytes / 1024 ** 2).toFixed(2),
      aliveItems: page.cohorts?.reduce((sum, row) => sum + row.aliveItems, 0),
      aliveNodes: page.cohorts?.reduce((sum, row) => sum + row.aliveNodes, 0),
      activeItems: page.activeItems,
      retainedHandles: page.retainedHandles,
      operations: page.results,
    }),
  );
}
try {
  await writeReproduction(directory, {
    revision: report.revision,
    environment: "summary.json",
    command: [
      "node",
      "scripts/firefox-profile/runtime-retention.mjs",
      ...process.argv.slice(2),
    ],
  });
  execFileSync(
    "/usr/bin/swiftc",
    [
      "-module-cache-path",
      join(directory, "swift-cache"),
      resolve("scripts/firefox-profile/native.swift"),
      "-o",
      native,
    ],
    { timeout: 120000 },
  );
  execFileSync(
    "/usr/bin/clang",
    [resolve("scripts/firefox-profile/memory-footprint.c"), "-o", counter],
    { timeout: 30000 },
  );
  check();
  awake = spawn("/usr/bin/caffeinate", ["-di", "-w", String(process.pid)], {
    stdio: "ignore",
  });
  await once(awake, "spawn");
  const displays = JSON.parse(
    execFileSync(native, ["displays"], { encoding: "utf8" }),
  );
  const display = displays.find(
    (entry) =>
      entry.name === options.display || String(entry.index) === options.display,
  );
  assert.ok(display, "Requested display unavailable");
  report.display = display;
  let base = options.url;
  if (!base) {
    server = await createServer({
      logLevel: "error",
      cacheDir: join(directory, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    });
    await server.listen();
    base = server.resolvedUrls.local[0];
  }
  browser = await launchFirefox(directory, { profiler: options.diagnostic });
  report.browser = {
    version: browser.version,
    build: browser.build,
    pid: browser.pid,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync(
        native,
        [
          "place",
          String(browser.pid),
          String(display.x + 10),
          String(display.y + 10),
          String(display.width - 20),
          String(display.height - 20),
        ],
        { timeout: 10000 },
      );
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(500);
    }
  }
  await delay(2000);
  await browser.navigate(new URL(fixturePath, base).href);
  for (
    let i = 0;
    !(await browser.evaluate(`Boolean(globalThis.${fixtureAPI})`));
    i++
  ) {
    assert.ok(i < 100, "Fixture did not load");
    await delay(100);
  }
  await delay(1000);
  report.geometry = await browser.evaluate(geometryExpression);
  validateDisplay(display, report.geometry);
  await checkpoint("empty");
  if (paging) {
    for (const [mode, count] of [
      ["stacked", 480],
      ["positioned", 2000],
      ["stacked", 10000],
    ]) {
      await browser.evaluate(
        `${fixtureAPI}.prepare(${JSON.stringify(mode)}, ${count})`,
      );
      await checkpoint(`${mode}:${count}:loaded`);
      if (options.diagnostic) {
        await browser.startProfile();
        await browser.evaluate("performance.mark('ff-profile-start')");
      }
      for (let index = 1; index <= cycles; index++) {
        check();
        await browser.evaluate(`${fixtureAPI}.cycle(${cycles})`);
        if (index % 20 === 0 || index === cycles) {
          assert.deepEqual(
            await browser.evaluate(geometryExpression),
            report.geometry,
            "Display geometry changed",
          );
          report.naturalSamples.push({
            label: `${mode}:${count}:${index}`,
            processes: footprints(),
          });
          console.log(`${mode}:${count}:cycles=${index}`);
        }
      }
      if (options.diagnostic)
        await browser.evaluate("performance.mark('ff-profile-end')");
      await checkpoint(`${mode}:${count}:natural`, false);
      const last = report.checkpoints.at(-1).page;
      assert.equal(last.cycles, cycles);
      assert.equal(last.cancelled, cycles / 4);
      assert.equal(last.completedReaches, last.cancelled);
      assert.ok(
        last.evicted > 0 && last.activeItems <= count,
        "Missing bounded eviction",
      );
      assert.ok(
        last.distance > 10000 && last.scrolls > cycles && last.ends > 0,
        "Stationary paging workload",
      );
      await checkpoint(`${mode}:${count}:exercised`);
      if (options.diagnostic)
        report.profiles.push({
          label: `${mode}:${count}`,
          ...summarizeStructureProfile(await browser.finishProfile()),
        });
      await browser.evaluate(`${fixtureAPI}.release()`);
      await checkpoint(`${mode}:${count}:released`);
    }
  } else if (structures) {
    for (const mode of [
      "geometry",
      "geometry-sparse",
      "positioned",
      "list",
      "positioned-list",
      ...(options.diagnostic ? ["positioned-overlap"] : []),
    ]) {
      for (const count of [1000, 10000, 100000]) {
        check();
        await browser.evaluate(
          `${fixtureAPI}.prepare(${JSON.stringify(mode)}, ${count}, ${options.diagnostic})`,
        );
        await checkpoint(`${mode}:${count}:loaded`);
        if (options.diagnostic) {
          await browser.startProfile();
          await browser.evaluate("performance.mark('ff-profile-start')");
        }
        await browser.evaluate(`${fixtureAPI}.exercise()`);
        if (options.diagnostic)
          await browser.evaluate("performance.mark('ff-profile-end')");
        if (options.workload === "structures-natural")
          await checkpoint(`${mode}:${count}:natural`, false);
        await checkpoint(`${mode}:${count}:exercised`);
        if (options.diagnostic && !mode.includes("list")) {
          const bytes = await browser.evaluate(
            `${fixtureAPI}.materializeBuffers()`,
          );
          assert.ok(bytes >= count * 16, "Missing live geometry buffers");
          await checkpoint(`${mode}:${count}:buffers-materialized`);
        }
        if (options.diagnostic)
          report.profiles.push({
            label: `${mode}:${count}`,
            ...summarizeStructureProfile(await browser.finishProfile()),
          });
        await browser.evaluate(`${fixtureAPI}.release()`);
        await checkpoint(`${mode}:${count}:released`);
      }
    }
  } else
    for (const mode of ["replace", "paging", "dispose-drop", "dispose-keep"]) {
      check();
      await browser.evaluate(
        `__runtimeRetention.begin(${JSON.stringify(mode)})`,
      );
      await checkpoint(`${mode}:loaded`);
      for (let i = 1; i <= cycles; i++) {
        check();
        await browser.evaluate("__runtimeRetention.cycle()");
        if (i % 4 === 0) await checkpoint(`${mode}:${i}`);
      }
      const last = report.checkpoints.at(-1).page;
      assert.equal(last.cycles, cycles);
      assert.ok(
        last.distance > 10000 && last.scrolls > cycles && last.ends > 0,
        "Invalid stationary or incomplete workload",
      );
      if (mode === "paging")
        assert.ok(last.evicted > 0, "Paging did not evict");
      await browser.evaluate("__runtimeRetention.release()");
      await delay(200);
      await checkpoint(`${mode}:released`);
    }
  report.status = "completed";
} catch (error) {
  report.status = "invalid";
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
  console.error(error);
} finally {
  report.cleanupErrors = [];
  for (const [name, action] of [
    ["browser", () => browser?.close()],
    ["server", () => server?.close()],
    [
      "sleep assertion",
      async () => {
        if (awake && awake.exitCode === null && awake.signalCode === null) {
          const exited = once(awake, "exit");
          awake.kill("SIGTERM");
          await exited;
        }
      },
    ],
    [
      "temporary files",
      async () => {
        for (const name of [
          "native",
          "footprint",
          "swift-cache",
          "vite-cache",
          "profile",
        ])
          await rm(join(directory, name), { recursive: true, force: true });
      },
    ],
  ]) {
    try {
      await action();
    } catch (error) {
      report.cleanupErrors.push(`${name}: ${error}`);
    }
  }
  if (report.cleanupErrors.length) {
    report.status = "invalid";
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(report, null, 2),
  );
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  console.log(report.status, directory);
}
