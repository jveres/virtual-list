// Scroll correctness diagnostics, not a physical-presentation benchmark.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { discardRaw, writeReproduction } from "./firefox-profile/artifacts.mjs";
import {
  delay,
  launchFirefox,
  launchSafari,
} from "./firefox-profile/memory-browser.mjs";
import {
  installRuntimeAudit,
  instrumentRuntime,
} from "./firefox-profile/runtime-audit.mjs";
import {
  cleanupCapture,
  validateDisplay,
} from "./firefox-profile/safari-validation.mjs";
import {
  installScrollStateProbe,
  instrumentScrollState,
  summarizeScrollState,
} from "./firefox-profile/scroll-state-probe.mjs";

const { values: options } = parseArgs({
  options: {
    browser: { type: "string", default: "firefox" },
    scenario: { type: "string", default: "paging" },
    display: { type: "string", default: "LU28R55" },
    seconds: { type: "string", default: "45" },
    help: { type: "boolean" },
  },
});
if (options.help) {
  console.log(
    "Usage: node scripts/profile-scroll-state.mjs --browser=firefox|safari --scenario=paging|takeover|manual --display=LU28R55 [--seconds=45]\nFresh installed browser, DevTools closed. Manual captures begin after RECORDING; Ctrl+Option+M marks a visible failure. Only compact state transitions and reproduction metadata survive cleanup.",
  );
  process.exit(0);
}
assert.equal(process.platform, "darwin", "Native diagnostics require macOS");
assert.ok(["firefox", "safari"].includes(options.browser));
assert.ok(["paging", "takeover", "manual"].includes(options.scenario));
const seconds = Number(options.seconds);
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 120);
const root = resolve("browser-artifacts/scroll-state");
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, `${options.browser}-`));
const native = join(directory, "native");
const report = {
  options,
  status: "running",
  actions: [],
  checkpoints: [],
  started: new Date().toISOString(),
};
let browser, server, awake;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
function check() {
  assert.equal(interrupted, false, "Capture interrupted");
  const session = JSON.parse(helper("session"));
  assert.ok(session.onConsole && !session.locked, "Desktop is locked");
}
function helper(...args) {
  return execFileSync(native, args.map(String), {
    encoding: "utf8",
    timeout: 15000,
  });
}
async function waitFor(expression) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    check();
    if (await browser.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Page readiness timed out: ${expression}`);
}
async function checkpoint(label) {
  check();
  const capture = await browser.evaluate("__scrollStateProbe.snapshot()");
  const geometry = await browser.evaluate(
    "({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})",
  );
  assert.deepEqual(geometry, report.geometry, "Display geometry changed");
  assert.deepEqual(capture.errors, [], "Page errors");
  assert.deepEqual(
    capture.invalidations,
    [],
    "Capture lost foreground or resized",
  );
  report.checkpoints.push({ label, ...capture });
  console.log(
    JSON.stringify({ label, status: capture.status, ...capture.current }),
  );
  return capture;
}
async function click(id) {
  check();
  const point = await browser.evaluate(`(()=>{
    const button=document.getElementById(${JSON.stringify(id)}), r=button.getBoundingClientRect();
    return {hidden:button.hidden,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')?.id,
      x:screenX+r.x+r.width/2,y:screenY+outerHeight-innerHeight+r.y+r.height/2};
  })()`);
  report.actions.push({ id, ...point });
  if (point.hidden) return;
  assert.equal(point.hit, id, "Jump button is obscured");
  helper("focus", browser.pid, point.x, point.y);
}

try {
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  await writeReproduction(directory, {
    revision: report.revision,
    command: [
      "node",
      "scripts/profile-scroll-state.mjs",
      ...process.argv.slice(2),
    ],
    environment: "summary.json",
  });
  const cache = resolve("browser-artifacts/safari-native-scroll/.swift-cache");
  await mkdir(cache, { recursive: true });
  execFileSync(
    "swiftc",
    [
      "-module-cache-path",
      cache,
      "scripts/firefox-profile/native.swift",
      "-o",
      native,
    ],
    { timeout: 120000 },
  );
  check();
  awake = spawn("/usr/bin/caffeinate", ["-di", "-w", String(process.pid)], {
    stdio: "ignore",
  });
  const display = JSON.parse(helper("displays")).find(
    (entry) => entry.name === options.display,
  );
  assert.ok(display, "Requested display unavailable");
  report.display = display;
  server = await createServer({
    logLevel: "error",
    cacheDir: join(directory, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: "scroll-state-diagnostic",
        enforce: "pre",
        transform(source, id) {
          const changed = instrumentScrollState(source, id);
          return id.endsWith("/src/virtual-list.ts")
            ? instrumentRuntime(changed)
            : changed;
        },
        transformIndexHtml() {
          return [
            {
              tag: "script",
              children: `(${installRuntimeAudit})();`,
              injectTo: "head-prepend",
            },
          ];
        },
      },
    ],
  });
  await server.listen();
  browser = await (options.browser === "safari"
    ? launchSafari()
    : launchFirefox(directory));
  report.browser = { version: browser.version, build: browser.build };
  for (let attempt = 0; ; attempt++) {
    try {
      helper(
        "place",
        browser.pid,
        display.x,
        display.y,
        display.width,
        display.height,
      );
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(500);
    }
  }
  await browser.navigate(
    new URL("/demos/streaming/", server.resolvedUrls.local[0]).href,
  );
  await waitFor(
    "!document.documentElement.classList.contains('booting') && Boolean(globalThis.__scrollStateRead?.list)",
  );
  await delay(1200);
  const point = await browser.evaluate(`(()=>{
    const r=document.querySelector('#viewport').getBoundingClientRect();
    const focus=document.createElement('div');focus.id='diagnostic-focus';focus.style.cssText='position:fixed;inset:0;z-index:2147483647';document.body.append(focus);
    return {x:screenX+r.x+r.width/2,y:screenY+outerHeight-innerHeight+r.y+r.height/2};
  })()`);
  helper("focus", browser.pid, point.x, point.y);
  await browser.evaluate(
    "(document.getElementById('diagnostic-focus').remove(), true)",
  );
  report.geometry = await browser.evaluate(
    "({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})",
  );
  validateDisplay(display, report.geometry);
  await browser.evaluate(`(${installScrollStateProbe})()`);
  await browser.evaluate("(__runtimeAudit.start(), true)");
  await checkpoint("boot");
  if (options.scenario === "manual") {
    console.log(
      `RECORDING ${seconds}s: reproduce the failure; Ctrl+Option+M marks it. DevTools remain closed.`,
    );
    for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
      await delay(Math.min(5, seconds - elapsed) * 1000);
      await checkpoint(`manual-${Math.min(seconds, elapsed + 5)}s`);
    }
  } else {
    for (let i = 0; i < 4; i++) {
      await click("scroll-top-btn");
      await delay(3200);
      await checkpoint(`top-${i}`);
    }
    for (const pause of options.scenario === "takeover"
      ? [0, 100, 350]
      : [2400, 2400, 2400]) {
      check();
      helper(
        "scroll",
        browser.pid,
        point.x,
        point.y,
        options.scenario === "paging" ? -100 : -50,
        options.scenario === "paging" ? 420 : 100,
        8333,
      );
      await delay(pause);
      if (options.scenario === "takeover") {
        await click("scroll-top-btn");
        await delay(3200);
      }
      await checkpoint(`native-${report.checkpoints.length}`);
    }
  }
  report.capture = await browser.evaluate(
    `(${summarizeScrollState})(__scrollStateProbe.stop())`,
  );
  const audit = await browser.evaluate("__runtimeAudit.stop()");
  const counts = {};
  let heightChanges = 0;
  let largestHeightChange = 0;
  for (const [, name, before, after] of audit.records) {
    counts[name] = (counts[name] ?? 0) + 1;
    if (["resize-change", "commit-height"].includes(name) && before !== after) {
      heightChanges++;
      largestHeightChange = Math.max(
        largestHeightChange,
        Math.abs(after - before),
      );
    }
  }
  report.runtime = {
    duration: audit.duration,
    dropped: audit.dropped,
    counts,
    heightChanges,
    largestHeightChange,
  };
  assert.ok(report.capture.counts.scroll > 5, "Stationary capture");
  assert.equal(report.capture.dropped + audit.dropped, 0, "Capture overflowed");
  report.status = "captured";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await cleanupCapture(report, {
    browser: async () => {
      await browser?.close();
    },
    server: async () => {
      await server?.close();
    },
    awake: async () => {
      awake?.kill();
    },
  });
  if (report.cleanupErrors) process.exitCode = 1;
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(report, null, 2),
  );
  await discardRaw(directory);
  console.log(`${report.status}: ${directory}`);
}
