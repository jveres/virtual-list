import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discardRaw, writeReproduction } from "./firefox-profile/artifacts.mjs";
import { analyzeChat, distribution } from "./firefox-profile/chat-analysis.mjs";
import {
  captureFirefox,
  capturePlaywright,
  captureSafari,
} from "./firefox-profile/chat-browsers.mjs";
import { createChatProfileServer } from "./firefox-profile/chat-server.mjs";
import { sampleOptions } from "./firefox-profile/safari-sample.mjs";
import { steadyScrollPlan } from "./firefox-profile/steady-scroll.mjs";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    help: { type: "boolean" },
    browser: { type: "string", default: "firefox" },
    scenario: { type: "string", default: "follow" },
    mode: { type: "string", default: "timing" },
    "trace-invalidations": { type: "boolean", default: false },
    scheduler: { type: "boolean", default: false },
    "safari-detached": { type: "boolean", default: false },
    "safari-sample": { type: "string" },
    "safari-snapshots": { type: "boolean", default: false },
    display: { type: "string" },
    "refresh-hz": { type: "string" },
    "pointer-x": { type: "string" },
    seconds: { type: "string", default: "20" },
    "stream-ms": { type: "string", default: "12000" },
    sections: { type: "string", default: "48" },
    history: { type: "string" },
    "history-content": { type: "string", default: "rich" },
    content: { type: "string", default: "rich" },
    trail: { type: "string", default: "long" },
    output: { type: "string", default: "browser-artifacts/chat-profile" },
  },
});
if (values.help) {
  console.log(`Profile the real streaming chat with deterministic local SSE; no account or remote inference.
  --browser firefox|chrome|safari  Installed browser; default Firefox
            engine-firefox|engine-chromium|engine-webkit  Headless correctness checks only
  --scenario follow|scrollback|buttons|manual|steady  Safari automation requires Safari 27+
    steady: Firefox only, 20 fully loaded turns, no reply; fixed 3 down/3 up gestures
    of 90 ticks at 16px (about 15s including pauses/control; --seconds is ignored)
  --mode timing|diagnostic       Optional synchronous spans, access and mutation counters
  --trace-invalidations         Chrome diagnostic only; use a short, reduced fixture
  --scheduler                   Timer/task latency, rAF work, and trail lifecycle diagnostics
  --safari-detached             Disconnect the Safari driver before follow/button captures
  --safari-sample S:D:I         Native diagnostic: start seconds, duration seconds, interval ms
  --safari-snapshots            Browser pixel checks; diagnostic buttons, driver connected
  --display INDEX|NAME           Default first external display, otherwise built-in
  --refresh-hz N                 Actual display rate if different from reported maximum
  --pointer-x F                 Horizontal pointer fraction 0.01..0.99; Firefox scrollback/steady only
  --seconds N                   Measurement window (default 20; scripted Firefox rounds up)
  --stream-ms N                 Fixed stream deadlines (default 12000; allow >=3s after completion)
  --sections N --history N       Complex reply sections / initial history turns (48 / 160)
  --history-content rich|tools|images  Rich history, closed tool payloads, or inline rasters
    tools: <=320 turns; images: exactly 20 turns, 10 known-size PNGs
  --content rich|prose           Rich Markdown or growing plain prose; same history/tools
  --trail off|short|long          Renderer trail (long)
  --output DIRECTORY            Creates a unique directory; keeps summaries and replay metadata
  MARKDOWN_VIEWER_LOCAL=1        Preview built ../markdown-viewer; record its revision and source patch
  COMRAK_WASM_LOCAL=1            Preview built ../comrak-wasm; record its revision and source patch
See docs/streaming-chat-profiling.md for overhead controls, interpretation, and Safari timelines.`);
  process.exit(0);
}
if (
  ![
    "firefox",
    "chrome",
    "safari",
    "engine-firefox",
    "engine-chromium",
    "engine-webkit",
  ].includes(values.browser)
)
  throw new Error("Invalid --browser");
if (
  !["follow", "scrollback", "manual", "buttons", "steady"].includes(
    values.scenario,
  )
)
  throw new Error("Invalid --scenario");
const steady = values.scenario === "steady";
const pointerX =
  values["pointer-x"] === undefined ? undefined : Number(values["pointer-x"]);
if (pointerX !== undefined) {
  if (!Number.isFinite(pointerX) || pointerX < 0.01 || pointerX > 0.99)
    throw new Error(
      "Invalid --pointer-x: expected a fraction from 0.01 to 0.99",
    );
  if (
    values.browser !== "firefox" ||
    !["scrollback", "steady"].includes(values.scenario)
  )
    throw new Error(
      "--pointer-x requires installed Firefox scrollback or steady",
    );
}
const history = Number(
  values.history ?? (steady ? steadyScrollPlan.history : 160),
);
if (steady && values.browser !== "firefox")
  throw new Error("The steady scenario requires --browser=firefox");
if (steady && history !== steadyScrollPlan.history)
  throw new Error(
    "The steady scenario requires --history=20 (the whole history)",
  );
if (!["timing", "diagnostic"].includes(values.mode))
  throw new Error("Invalid --mode");
if (
  values["safari-detached"] &&
  (values.browser !== "safari" ||
    !["follow", "buttons"].includes(values.scenario))
)
  throw new Error(
    "--safari-detached requires --browser=safari --scenario=follow or buttons",
  );
if (
  values["trace-invalidations"] &&
  (values.browser !== "chrome" || values.mode !== "diagnostic")
)
  throw new Error(
    "--trace-invalidations requires --browser=chrome --mode=diagnostic",
  );
if (!["off", "short", "long"].includes(values.trail))
  throw new Error("Invalid --trail");
if (!["rich", "prose"].includes(values.content))
  throw new Error("Invalid --content");
if (!["rich", "tools", "images"].includes(values["history-content"]))
  throw new Error("Invalid --history-content");
if (values["history-content"] === "images" && history !== 20)
  throw new Error("Image history requires exactly 20 turns");
const seconds = steady ? 15 : Number(values.seconds);
const durationMs = Number(values["stream-ms"]);
if (
  !Number.isSafeInteger(seconds) ||
  seconds < 5 ||
  seconds > 50 ||
  !Number.isSafeInteger(durationMs) ||
  durationMs < 1000 ||
  (steady ? durationMs > 120000 : durationMs > seconds * 1000 - 3000)
)
  throw new Error(
    "Use 5..50 seconds with at least 3 seconds after stream completion",
  );
if (
  values.scenario === "buttons" &&
  (durationMs < 8000 || seconds * 1000 < durationMs + 7500)
)
  throw new Error(
    "The buttons scenario needs an 8-second stream and at least 7.5 seconds after it",
  );
const refreshHz =
  values["refresh-hz"] === undefined ? undefined : Number(values["refresh-hz"]);
if (
  refreshHz !== undefined &&
  (!Number.isFinite(refreshHz) || refreshHz < 1 || refreshHz > 1000)
)
  throw new Error("Invalid --refresh-hz");
if (values.browser.startsWith("engine-") && values.scenario === "manual")
  throw new Error("Manual input requires a headed installed browser");
const safariSample = sampleOptions(values["safari-sample"], seconds);
if (
  values["safari-snapshots"] &&
  (values.browser !== "safari" ||
    values.mode !== "diagnostic" ||
    values.scenario !== "buttons" ||
    values["safari-detached"])
)
  throw new Error(
    "--safari-snapshots requires Safari diagnostic buttons with the driver connected",
  );
if (
  safariSample &&
  (values.browser !== "safari" || values.mode !== "diagnostic")
)
  throw new Error(
    "--safari-sample requires --browser=safari --mode=diagnostic",
  );
const options = {
  browser: values.browser,
  scenario: values.scenario,
  diagnostic: values.mode === "diagnostic",
  traceInvalidations: values["trace-invalidations"],
  scheduler: values.scheduler,
  safariDetached: values["safari-detached"],
  safariSample,
  safariSnapshots: values["safari-snapshots"],
  display: values.display,
  refreshHz,
  pointerX,
  seconds,
  durationMs,
  sections: Number(values.sections),
  history,
  historyContent: values["history-content"],
  content: values.content,
  trail: values.trail,
  rendererPreview: process.env.MARKDOWN_VIEWER_LOCAL === "1",
  parserPreview: process.env.COMRAK_WASM_LOCAL === "1",
};
await mkdir(values.output, { recursive: true });
const directory = await mkdtemp(
  join(resolve(values.output), `${values.browser}-${values.mode}-`),
);
console.log(`Chat profile: ${directory}`);
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Capture interrupted"));
// A terminal and package runner can both forward the same interruption.
// Keep handlers installed throughout cleanup, including a terminal hangup.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, interrupt);
const report = {
  status: "starting",
  startedAt: new Date().toISOString(),
  options,
  cpuContention: process.env.VIRTUAL_LIST_CPU_CONTENTION
    ? JSON.parse(process.env.VIRTUAL_LIST_CPU_CONTENTION)
    : undefined,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirtyFiles: execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean),
};
let server;
try {
  await writeReproduction(directory, report);
  server = await createChatProfileServer(options);
  report.workload = server.workload;
  report.url = server.url;
  const capture =
    options.browser === "firefox"
      ? captureFirefox
      : options.browser === "safari"
        ? captureSafari
        : capturePlaywright;
  const result = await capture(
    server,
    directory,
    {
      ...options,
      onBrowser: (metadata) => {
        report.browser = metadata;
      },
    },
    controller.signal,
  );
  controller.signal.throwIfAborted();
  report.browser = result.metadata;
  if (steady) result.recording.steady.responseRequests = server.requests.length;
  const summary = analyzeChat(result.recording, result);
  await writeFile(
    join(directory, "recording.json"),
    JSON.stringify(result.recording),
  );
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  report.status = summary.valid ? "complete" : "invalid";
  if (!summary.valid) process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        status: report.status,
        reasons: summary.invalidReasons,
        moving: summary.frames.movingMs,
        expensive: summary.work.expensive.slice(0, 8),
      },
      null,
      2,
    ),
  );
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  report.sources = server?.sources ?? {};
  report.serverDelivery = (server?.requests ?? []).map(
    ({ lateMs, ...request }) => ({
      ...request,
      latenessMs: distribution(lateMs),
    }),
  );
  try {
    await server?.close();
    report.serverClosed = true;
  } catch (error) {
    report.cleanupError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  }
  try {
    await discardRaw(directory);
    report.rawDataRemoved = true;
  } catch (error) {
    report.rawDataRemoved = false;
    report.cleanupError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  }
  await writeFile(join(directory, "run.json"), JSON.stringify(report, null, 2));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.removeListener(signal, interrupt);
}
