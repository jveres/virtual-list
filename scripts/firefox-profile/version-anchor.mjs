import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createServer } from "vite";
import { discardRaw, writeReproduction } from "./artifacts.mjs";
import { nativeTools } from "./chat-browsers.mjs";
import { cleanupCapture, validateDisplay } from "./safari-validation.mjs";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "90" },
    display: { type: "string" },
    output: { type: "string", default: "browser-artifacts/version-anchor" },
  },
});
const seconds = Number(values.seconds);
assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 300);
await mkdir(values.output, { recursive: true });
const directory = await mkdtemp(join(resolve(values.output), "run-"));
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  command: [
    "node",
    "scripts/firefox-profile/version-anchor.mjs",
    ...process.argv.slice(2),
  ],
  procedure:
    "Default chat; switch prompt versions; repeatedly scroll away and back, including mid-viewport switches. Geometry is read only at version actions, not in a frame sampler.",
};
let browser;
let server;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
try {
  await writeReproduction(directory, report);
  server = await createServer({
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [
      {
        name: "version-anchor-probe",
        enforce: "pre",
        transform(source, id) {
          let needle;
          let replacement;
          if (id.endsWith("/demos/streaming/streaming.ts")) {
            needle =
              "const anchor = replacementAnchor(messageId, replacementId);";
            replacement = `${needle}\nglobalThis.__anchorProbe?.switching({messageId, replacementId, anchor}, virtualList);`;
          } else if (id.endsWith("/src/virtual-list.ts")) {
            needle = "if (!glideFollow && moves) {";
            replacement = `globalThis.__anchorProbe?.commit({policy,before,target,mode:result.mode,reserve:geometry.reserve,pin:geometry.pinned,pinTop:geometry.pinTop,native,moves});\n${needle}`;
          } else return null;
          assert.equal(
            source.split(needle).length,
            2,
            `Probe hook changed: ${id}`,
          );
          return { code: source.replace(needle, replacement), map: null };
        },
      },
    ],
  });
  await server.listen();
  const { display } = await nativeTools(directory, values.display);
  report.display = display;
  browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage({ viewport: null });
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: {
      left: display.x + 10,
      top: display.y + 10,
      width: display.width - 20,
      height: display.height - 20,
    },
  });
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "maximized" },
  });
  await page.addInitScript(() => {
    const events = [];
    let active = false;
    let dropped = 0;
    let switchId = 0;
    const record = (kind, data) => {
      if (!active) return;
      if (events.length >= 2000) {
        dropped++;
        return;
      }
      events.push({ time: performance.now(), kind, ...data });
    };
    const snapshot = (list) => {
      const viewport = document.querySelector("#viewport");
      const bounds = viewport.getBoundingClientRect();
      return {
        top: viewport.scrollTop,
        max: viewport.scrollHeight - viewport.clientHeight,
        height: bounds.height,
        clientHeight: viewport.clientHeight,
        canvas: viewport
          .querySelector("[data-anchoring]")
          ?.getAttribute("style"),
        status: document.querySelector("#window-status")?.textContent,
        state: list?.state,
        rows: [...viewport.querySelectorAll(".message")]
          .slice(-4)
          .map((row) => ({
            key: row.dataset.key,
            top: row.getBoundingClientRect().top - bounds.top,
            height: row.getBoundingClientRect().height,
            position: list?.positionOf(row.dataset.key),
            version: row.querySelector(".version-nav-count")?.textContent,
          })),
      };
    };
    globalThis.__anchorProbe = {
      start() {
        active = true;
        record("start", snapshot());
      },
      switching(action, list) {
        const id = ++switchId;
        record("switch", { id, action, ...snapshot(list) });
        setTimeout(
          () => record("after-switch", { id, ...snapshot(list) }),
          250,
        );
      },
      commit(data) {
        record("commit", data);
      },
      stop() {
        record("stop", snapshot());
        active = false;
        return { events, dropped };
      },
    };
    addEventListener(
      "scrollend",
      (event) => {
        if (event.target?.id === "viewport")
          record("scrollend", { top: event.target.scrollTop });
      },
      true,
    );
  });
  await page.goto(`${server.resolvedUrls.local[0]}demos/streaming/index.html`);
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  await page.bringToFront();
  report.browser = browser.version();
  report.geometry = await page.evaluate(() => ({
    x: screenX,
    y: screenY,
    outerWidth,
    outerHeight,
    innerWidth,
    innerHeight,
    dpr: devicePixelRatio,
  }));
  validateDisplay(display, report.geometry);
  await page.evaluate(() => globalThis.__anchorProbe.start());
  console.log(
    `RECORDING NOW for ${seconds} seconds: switch versions and scroll repeatedly in the foreground Chrome window. ${directory}`,
  );
  const deadline = Date.now() + seconds * 1000;
  while (!interrupted && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 200));
  const recording = await page.evaluate(() => globalThis.__anchorProbe.stop());
  // Retain action outcomes, not the raw stream of commits and scroll ends.
  const summary = {
    dropped: recording.dropped,
    switches: recording.events.flatMap((event, index) => {
      if (event.kind !== "switch") return [];
      const after = recording.events.find(
        (candidate) =>
          candidate.kind === "after-switch" && candidate.id === event.id,
      );
      const next = recording.events.findIndex(
        (candidate, at) => at > index && candidate.kind === "switch",
      );
      const commits = recording.events
        .slice(index + 1, next < 0 ? undefined : next)
        .filter((candidate) => candidate.kind === "commit");
      return [{ before: event, after: after ?? null, commits }];
    }),
  };
  report.status = interrupted ? "interrupted" : "complete";
  report.switches = summary.switches.length;
  if (!report.switches || summary.dropped) report.status = "invalid";
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      directory,
      switches: report.switches,
      dropped: summary.dropped,
    }),
  );
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    const cleaned = await cleanupCapture(report, {
      browser: () => browser?.close(),
      server: () => server?.close(),
      artifacts: () => discardRaw(directory),
    });
    if (!cleaned) process.exitCode = 1;
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify(report, null, 2),
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
  }
}
