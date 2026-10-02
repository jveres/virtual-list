import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { writeReproduction } from "./firefox-profile/artifacts.mjs";
import {
  assertMemoryDocument,
  assessMemory,
  MiB,
  parseFootprints,
} from "./firefox-profile/memory-analysis.mjs";
import {
  delay,
  launchChrome,
  launchFirefox,
  launchSafari,
} from "./firefox-profile/memory-browser.mjs";
import {
  memoryPageState,
  startMemoryCycle,
} from "./firefox-profile/memory-workload.mjs";
import {
  cleanupCapture,
  validateDisplay,
} from "./firefox-profile/safari-validation.mjs";

const { values: options } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  options: {
    browser: { type: "string", default: "firefox" },
    workload: { type: "string", default: "text" },
    trail: { type: "string", default: "off" },
    cycles: { type: "string", default: "12" },
    display: { type: "string", default: "LU28R55" },
    input: { type: "string", default: "steps" },
    "message-layers": { type: "string", default: "default" },
    "canvas-layer": { type: "string", default: "default" },
    url: { type: "string" },
    transcript: { type: "string" },
    help: { type: "boolean" },
  },
});
if (options.help) {
  console.log(
    "Usage: pnpm run test:memory -- --browser=firefox|safari|chrome --workload=text|images|streaming --cycles=12 --display=LU28R55 [--trail=off|short|long] [--input=steps|native] [--message-layers=default|off] [--canvas-layer=default|off] [--url=http://localhost:5173] [--transcript=FILE]\nmacOS installed browsers, fresh sessions, closed DevTools. Fixed scroll allocation stress; not a physical trackpad momentum or presentation test. Temporary profiles and raw process reports are removed.",
  );
  process.exit(0);
}
assert.ok(
  ["off", "short", "long"].includes(options.trail),
  "Unknown trail mode",
);
assert.ok(
  options.trail === "off" || options.workload === "streaming",
  "Trail memory checks require --workload=streaming",
);
assert.equal(
  process.platform,
  "darwin",
  "Process and graphics memory checks require macOS",
);
assert.ok(["firefox", "safari", "chrome"].includes(options.browser));
assert.ok(["text", "images", "streaming"].includes(options.workload));
assert.ok(["steps", "native"].includes(options.input));
assert.ok(["default", "off"].includes(options["message-layers"]));
assert.ok(["default", "off"].includes(options["canvas-layer"]));
assert.ok(
  !options.transcript || (options.workload === "images" && !options.url),
  "--transcript requires --workload=images and the runner's own server",
);
const cycles = Number(options.cycles);
assert.ok(
  Number.isInteger(cycles) && cycles >= 6 && cycles <= 30,
  "cycles must be 6..30",
);
const output = resolve("browser-artifacts/memory");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(
  join(output, `${options.browser}-${options.workload}-`),
);
const cache = resolve("browser-artifacts/safari-native-scroll/.swift-cache");
await mkdir(cache, { recursive: true });
const native = join(directory, "native"),
  counter = join(directory, "footprint");
let browser, server, awake;
let privateInput;
const privateRoute = `/__memory-transcript/${randomUUID()}`;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  options,
  status: "running",
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  samples: [],
  checkpoints: [],
  started: new Date().toISOString(),
  system: {
    os: execFileSync("/usr/bin/sw_vers", { encoding: "utf8" }).trim(),
    architecture: process.arch,
    memoryBytes: Number(
      execFileSync("/usr/sbin/sysctl", ["-n", "hw.memsize"], {
        encoding: "utf8",
      }).trim(),
    ),
  },
  measurement:
    "macOS proc_pid_rusage physical footprint, resident bytes, and lifetime process peak; process totals may include shared accounting",
  processAttribution:
    options.browser === "safari"
      ? "Safari plus WebKit services with the isolated Safari PID as responsible application"
      : "Isolated browser and descendants in the process tree",
  workload:
    "80 upward and 80 downward 900 CSS-pixel instant steps, 40ms apart; 700ms edge waits; fresh installed browser; no forced GC" +
    (options.trail !== "off"
      ? "; start with rendered trail, with ten alternating 120px steps before the first instant-step traversal"
      : ""),
};
const save = () =>
  writeFile(join(directory, "summary.json"), JSON.stringify(report, null, 2));
function check() {
  if (interrupted) throw Error("Memory capture interrupted");
}
function checkDesktop() {
  const session = JSON.parse(
    execFileSync(native, ["session"], { encoding: "utf8" }),
  );
  assert.ok(
    session.onConsole && !session.locked,
    "Desktop is locked; display-memory measurements are invalid",
  );
}
async function waitFor(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    check();
    try {
      if (await browser.evaluate(expression)) return;
    } catch (error) {
      if (Date.now() + 250 >= deadline) throw error;
    }
    await delay(100);
  }
  throw Error(`Page readiness timeout: ${expression}`);
}
function processSnapshot() {
  check();
  checkDesktop();
  const owned = browser.processes();
  assert.ok(owned.length, "No owned processes");
  const measured = parseFootprints(
    execFileSync(
      counter,
      owned.map((p) => String(p.pid)),
      { encoding: "utf8" },
    ),
  );
  return measured.map((p) => ({
    ...p,
    name: owned.find((item) => item.pid === p.pid)?.name,
  }));
}
async function snapshot(label) {
  const processes = processSnapshot();
  const page = await browser.evaluate(`(${memoryPageState.toString()})()`);
  assert.deepEqual(page.errors, [], "Page errors invalidate the capture");
  assert.deepEqual(
    page.invalidations,
    [],
    "Capture lost foreground or visibility",
  );
  assert.equal(page.visible, true, "Capture is not visible and focused");
  assert.deepEqual(page.geometry, report.geometry, "Window geometry changed");
  assertMemoryDocument(page, report.checkpoints[0]?.page);
  return {
    label,
    at: Date.now(),
    processes,
    page,
  };
}
try {
  if (options.transcript) {
    privateInput = await readFile(options.transcript);
    const turns = [
      ...privateInput
        .toString("utf8")
        .matchAll(/^\*\*(?:User|Assistant)\*\*\s*$/gm),
    ].length;
    assert.ok(
      turns >= 2 && turns <= 48,
      "Private fixture must have 2..48 User/Assistant turns",
    );
    report.fixture = {
      turns,
      bytes: privateInput.length,
      sha256: createHash("sha256").update(privateInput).digest("hex"),
      private: true,
    };
  }
  await writeReproduction(directory, {
    revision: report.revision,
    environment: "summary.json",
    command: [
      "pnpm",
      "run",
      "test:memory",
      "--",
      ...Object.entries(options)
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => `--${key}=${value}`),
    ],
  });
  execFileSync(
    "/usr/bin/swiftc",
    [
      "-module-cache-path",
      cache,
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
  checkDesktop();
  awake = spawn("/usr/bin/caffeinate", ["-di", "-w", String(process.pid)], {
    stdio: "ignore",
  });
  await once(awake, "spawn");
  const displays = JSON.parse(
    execFileSync(native, ["displays"], { encoding: "utf8" }),
  );
  const display = displays.find(
    (item) =>
      item.name === options.display || String(item.index) === options.display,
  );
  assert.ok(display, "Requested display unavailable");
  report.display = display;
  let base = options.url;
  if (!base) {
    server = await createServer({
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      cacheDir: join(directory, "vite-cache"),
      plugins: privateInput
        ? [
            {
              name: "memory-private-input",
              configureServer(vite) {
                vite.middlewares.use((req, res, next) => {
                  if (req.url !== privateRoute || req.method !== "GET")
                    return next();
                  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
                  res.setHeader("Cache-Control", "no-store");
                  res.end(privateInput);
                });
              },
            },
          ]
        : [],
    });
    await server.listen();
    base = server.resolvedUrls.local[0];
  }
  browser = await {
    firefox: () => launchFirefox(directory),
    safari: () => launchSafari(counter),
    chrome: () => launchChrome(),
  }[options.browser]();
  report.browser = {
    version: browser.version,
    build: browser.build,
    pid: browser.pid,
  };
  // Navigation can finish before AppKit exposes the new window to AX.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync(
        native,
        [
          "place",
          String(browser.pid),
          String(display.x),
          String(display.y),
          String(display.width),
          String(display.height),
        ],
        { timeout: 10000, stdio: "pipe" },
      );
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(500);
    }
  }
  // Measure the fresh browser at the target geometry before loading the app.
  // A whole-browser total is not the chat's incremental allocation.
  await delay(10000);
  const geometry = await browser.evaluate(
    "({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})",
  );
  validateDisplay(display, geometry);
  report.geometry = geometry;
  report.browserBaseline = {
    label: "blank-before-chat",
    warmupMs: 10000,
    geometry,
    processes: processSnapshot(),
  };
  const url = new URL("/demos/streaming/index.html", base);
  url.searchParams.set("trail", options.trail);
  const compositing = [];
  if (options["message-layers"] === "off")
    compositing.push("no-message-layers");
  if (options["canvas-layer"] === "off") compositing.push("no-canvas-layer");
  if (compositing.length)
    url.searchParams.set("debug-compositing", compositing.join(","));
  await browser.navigate(url.href);
  await waitFor("Boolean(document.querySelector('#viewport article'))");
  assert.equal(
    await browser.evaluate("document.querySelector('#trail-mode').value"),
    options.trail,
    "Requested trail setting was not applied",
  );
  await delay(2000);
  const point = await browser.evaluate(`(()=>{
    const v=document.querySelector('#viewport'),r=v.getBoundingClientRect();
    const overlay=document.createElement('div');
    overlay.id='memory-focus';
    overlay.style.cssText='position:fixed;inset:0;z-index:2147483647';
    document.body.append(overlay);
    return {x:screenX+r.x+r.width/2,y:screenY+outerHeight-innerHeight+r.y+r.height/2};
  })()`);
  execFileSync(
    native,
    ["focus", String(browser.pid), String(point.x), String(point.y)],
    { timeout: 10000 },
  );
  await browser.evaluate(
    "(document.querySelector('#memory-focus').remove(),document.querySelector('#viewport').focus(),true)",
  );
  await browser.evaluate(`(()=>{
    window.__memoryDocumentId=${JSON.stringify(randomUUID())};
    window.__memoryErrors=[];
    const error=message=>{if(window.__memoryErrors.length<16)window.__memoryErrors.push(message)};
    addEventListener('error',e=>error(e.message));
    addEventListener('unhandledrejection',e=>error(String(e.reason)));
    window.__memoryInvalidations=[];
    const record=message=>{if(window.__memoryInvalidations.length<8)window.__memoryInvalidations.push(message)};
    addEventListener('blur',()=>record('window lost focus'));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)record('document hidden')});
    return true;
  })()`);
  if (options.input === "native") {
    report.inputPoint = point;
    report.workload =
      "720 native macOS pixel events each direction (100px, 8333us); 700ms edge waits. Began/ended gesture phases; no physical trackpad momentum.";
  }
  report.checkpoints.push(await snapshot("loaded"));
  if (options.workload === "images") {
    if (privateInput) {
      await browser.evaluate(`(async()=>{
        const source=await (await fetch(${JSON.stringify(privateRoute)})).text();
        window.confirm=()=>true;
        const transfer=new DataTransfer();
        transfer.items.add(new File([source],'local-memory-input.md',{type:'text/markdown'}));
        const input=document.querySelector('#import-file');
        input.files=transfer.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
    } else
      report.fixture = await browser.evaluate(
        (
          await readFile(
            "scripts/firefox-profile/fixtures/memory-chat.js",
            "utf8",
          )
        )
          .trim()
          .replace(/;$/, ""),
      );
    await waitFor("Boolean(document.querySelector('#viewport img'))");
    await delay(4000);
    // Native gesture reversals can defer a prepend until the gesture settles.
    // Load the entire finite fixture before measuring its repeated traversals.
    await browser.evaluate(
      "(document.querySelector('#viewport').scrollTop=0,true)",
    );
    await waitFor(
      `document.querySelector('#window-status').textContent.startsWith('loaded 1-${report.fixture.turns}/${report.fixture.turns}')`,
    );
    await delay(700);
  }
  if (options.workload === "streaming") {
    // The built-in reply uses random token delays. Fix that input in this
    // isolated capture; wall-clock delivery still depends on the scheduler.
    await browser.evaluate("(Math.random=()=>0.5,true)");
    await browser.evaluate(
      (
        await readFile(
          "scripts/firefox-profile/fixtures/streaming-chat.js",
          "utf8",
        )
      )
        .trim()
        .replace(/;$/, ""),
    );
    await delay(400);
    if (options.trail !== "off")
      await waitFor(
        "Boolean(document.querySelector('[data-trail-group] > div'))",
      );
  }
  if (options.trail === "off")
    await browser.evaluate(
      "(document.querySelector('#viewport').scrollTop=1000,true)",
    );
  await delay(700);
  report.checkpoints.push(await snapshot("baseline"));
  for (let cycle = 1; cycle <= cycles; cycle++) {
    check();
    await browser.evaluate(
      `(${startMemoryCycle.toString()})({external:${options.input === "native"},warmupSteps:${options.trail !== "off" && cycle === 1 ? 10 : 0}})`,
    );
    if (options.input === "native") {
      for (const delta of [100, -100]) {
        check();
        execFileSync(
          native,
          [
            "scroll",
            String(browser.pid),
            String(report.inputPoint.x),
            String(report.inputPoint.y),
            String(delta),
            "720",
            "8333",
          ],
          { timeout: 10000 },
        );
        await delay(700);
      }
      await waitFor("window.__memoryCycle.ends>0", 5000);
      await browser.evaluate("(window.__finishMemoryCycle(),true)");
    }
    await waitFor("window.__memoryCycle?.done===true", 20000);
    const sample = await snapshot(`cycle-${cycle}`);
    report.samples.push(sample);
    assert.equal(sample.page.error, undefined, "Workload error");
    if (options.input === "native") {
      assert.ok(sample.page.wheels > 20, "Native input missing");
      assert.ok(sample.page.ends > 0, "Native scrolling did not end");
    }
    if (options.workload === "images")
      assert.equal(
        sample.page.keys.length,
        report.fixture.turns,
        "Image traversal incomplete",
      );
    console.log(
      `${options.browser}/${options.workload} cycle ${cycle}: total ${Math.round(sample.processes.reduce((sum, p) => sum + p.footprint, 0) / MiB)} MiB; process peak ${Math.round(Math.max(...sample.processes.map((p) => p.peak)) / MiB)} MiB; ${sample.page.events} scroll events; ${sample.page.keys.length} keys visited`,
    );
    await save();
  }
  await delay(10000);
  report.checkpoints.push(await snapshot("idle"));
  report.budget = {
    processPeak: (options.browser === "safari" ? 768 : 600) * MiB,
    total: 1400 * MiB,
    growth: 64 * MiB,
    tailRange: 40 * MiB,
  };
  report.result = assessMemory(report.samples, report.budget);
  if (options.workload === "images") {
    const decoded = new Set(
      report.samples.flatMap((s) => s.page.decodedImageKeys),
    );
    if (report.fixture.private)
      assert.ok(decoded.size > 0, "No private-input images decoded");
    else
      assert.equal(
        decoded.size,
        report.fixture.images,
        "Some images never decoded during traversal",
      );
    const heights = report.samples.map((s) => s.page.height);
    assert.ok(
      Math.max(...heights) - Math.min(...heights) <= 1,
      "Image recycling changed document height",
    );
  }
  if (options.workload === "streaming") {
    assert.ok(
      report.samples.some((s) => s.page.streamingObserved),
      "No active streaming captured",
    );
    if (options.trail !== "off")
      assert.ok(
        report.samples.some((s) => s.page.trailObserved),
        "No rendered streaming trail captured",
      );
    assert.equal(
      report.checkpoints.at(-1).page.streaming,
      false,
      "Reply did not finish",
    );
  }
  // Raw VM-category reports are diagnostic inputs only; retain compact selected rows.
  report.categories = [];
  for (const p of browser.processes()) {
    const raw = execFileSync(
      "/usr/bin/footprint",
      ["-p", String(p.pid), "--wide"],
      { encoding: "utf8", timeout: 20000 },
    );
    report.categories.push({
      pid: p.pid,
      lines: raw
        .split("\n")
        .filter((line) =>
          /WebKit Malloc|IOSurface|IOAccelerator|unmapped.*graphics|phys_footprint|TOTAL/.test(
            line,
          ),
        ),
    });
  }
  report.status = report.result.failures.length ? "failed" : "passed";
  if (browser.memoryReport) report.memoryReport = await browser.memoryReport();
  await browser.navigate("about:blank");
  await delay(10000);
  report.afterUnload = {
    label: "blank-after-navigation-and-diagnostics",
    note: "Navigation can retain the chat in the browser's back/forward cache; this is not a fresh-browser floor.",
    warmupMs: 10000,
    processes: processSnapshot(),
  };
  if (report.status === "failed") process.exitCode = 1;
} catch (error) {
  report.status = "invalid";
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
  console.error(error);
} finally {
  report.cleanupErrors = [];
  const cleaned = await cleanupCapture(report, {
    browser: () => browser?.close(),
    server: () => server?.close(),
    "sleep assertion": async () => {
      if (awake && awake.exitCode === null && awake.signalCode === null) {
        const exited = once(awake, "exit");
        awake.kill("SIGTERM");
        await exited;
      }
    },
    "temporary files": async () => {
      for (const name of ["native", "footprint", "vite-cache", "profile"])
        await rm(join(directory, name), { recursive: true, force: true });
    },
  });
  if (!cleaned) {
    report.status = "invalid";
    process.exitCode = 1;
  }
  await save();
  console.log(`${report.status}: ${directory}`, report.result ?? report.error);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
