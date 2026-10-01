// Installed Firefox lifecycle/collection diagnostic, not a scroll-speed benchmark.
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

const { values: options } = parseArgs({
  options: {
    cycles: { type: "string", default: "12" },
    display: { type: "string", default: "LU28R55" },
    output: { type: "string", default: "browser-artifacts/runtime-retention" },
    url: { type: "string" },
    help: { type: "boolean" },
  },
});
if (options.help) {
  console.log(
    "Usage: node scripts/firefox-profile/runtime-retention.mjs [--cycles=12] [--display=LU28R55] [--output=browser-artifacts/runtime-retention] [--url=http://127.0.0.1:4193]\nInstalled macOS Firefox, fresh profile, closed DevTools. Collects before/after GC+CC memory and weak item/node counts for replacement, paging, and disposal. No native gesture or timing claims.",
  );
  process.exit(0);
}
const cycles = Number(options.cycles);
assert.ok(
  Number.isInteger(cycles) && cycles >= 4 && cycles <= 24 && cycles % 4 === 0,
  "cycles must be 4..24 in groups of four",
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
  measurement:
    "WeakRef counts after Firefox minimizeMemoryUsage (GC, cycle collection, memory pressure); explicit window reporter bytes; owned-process physical footprints. Forced collection alters natural cache/GC behavior. Instant API scrolling, not native gesture timing.",
};
const geometryExpression =
  "({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})";
const fixturePath = "/scripts/firefox-profile/fixtures/runtime-retention.html";
function check() {
  assert.equal(interrupted, false, "Capture interrupted");
  const session = JSON.parse(
    execFileSync(native, ["session"], { encoding: "utf8" }),
  );
  assert.ok(session.onConsole && !session.locked, "Desktop is locked");
}
function footprints() {
  const owned = browser.processes();
  assert.ok(owned.length, "No owned browser processes");
  return parseFootprints(
    execFileSync(
      counter,
      owned.map((p) => String(p.pid)),
      { encoding: "utf8" },
    ),
  );
}
async function checkpoint(label) {
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
  const rows = await browser.memoryReport({ minimize: true, minBytes: 0 });
  await delay(100);
  const page = await browser.evaluate("__runtimeRetention.snapshot()");
  assert.deepEqual(page.errors, [], "Fixture errors");
  if (report.documentId)
    assert.equal(page.documentId, report.documentId, "Fixture reloaded");
  report.documentId = page.documentId;
  const memory = summarizeRetentionMemory(rows, fixturePath);
  report.checkpoints.push({
    label,
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
      aliveItems: page.cohorts.reduce((sum, row) => sum + row.aliveItems, 0),
      aliveNodes: page.cohorts.reduce((sum, row) => sum + row.aliveNodes, 0),
      activeItems: page.activeItems,
      retainedHandles: page.retainedHandles,
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
  browser = await launchFirefox(directory);
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
    !(await browser.evaluate("Boolean(globalThis.__runtimeRetention)"));
    i++
  ) {
    assert.ok(i < 100, "Fixture did not load");
    await delay(100);
  }
  await delay(1000);
  report.geometry = await browser.evaluate(geometryExpression);
  validateDisplay(display, report.geometry);
  await checkpoint("empty");
  for (const mode of ["replace", "paging", "dispose-drop", "dispose-keep"]) {
    check();
    await browser.evaluate(`__runtimeRetention.begin(${JSON.stringify(mode)})`);
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
    if (mode === "paging") assert.ok(last.evicted > 0, "Paging did not evict");
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
