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
    seconds: { type: "string", default: "20" },
    "stream-ms": { type: "string", default: "12000" },
    sections: { type: "string", default: "48" },
    history: { type: "string", default: "160" },
    trail: { type: "string", default: "long" },
    output: { type: "string", default: "browser-artifacts/chat-profile" },
  },
});
if (values.help) {
  console.log(`Profile the real streaming chat with deterministic local SSE; no account or remote inference.
  --browser firefox|chrome|safari  Installed browser; default Firefox
            engine-firefox|engine-chromium|engine-webkit  Headless correctness checks only
  --scenario follow|scrollback|buttons|manual  Safari automation requires Safari 27+
  --mode timing|diagnostic       Optional synchronous spans, access and mutation counters
  --trace-invalidations         Chrome diagnostic only; use a short, reduced fixture
  --scheduler                   Timer/task latency, rAF work, and trail lifecycle diagnostics
  --safari-detached             Disconnect the Safari driver before follow/button captures
  --safari-sample S:D:I         Native diagnostic: start seconds, duration seconds, interval ms
  --safari-snapshots            Browser pixel checks; diagnostic buttons, driver connected
  --display INDEX|NAME           Default first external display, otherwise built-in
  --refresh-hz N                 Actual display rate if different from reported maximum
  --seconds N                   Measurement window (default 20; scripted Firefox rounds up)
  --stream-ms N                 Fixed stream deadlines (default 12000; allow >=3s after completion)
  --sections N --history N       Complex reply sections / initial history turns (48 / 160)
  --trail off|short|long          Renderer trail (long)
  --output DIRECTORY            Creates a unique directory; keeps summaries and replay metadata
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
if (!["follow", "scrollback", "manual", "buttons"].includes(values.scenario))
  throw new Error("Invalid --scenario");
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
const seconds = Number(values.seconds);
const durationMs = Number(values["stream-ms"]);
if (
  !Number.isSafeInteger(seconds) ||
  seconds < 5 ||
  seconds > 50 ||
  !Number.isSafeInteger(durationMs) ||
  durationMs < 1000 ||
  durationMs > seconds * 1000 - 3000
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
  seconds,
  durationMs,
  sections: Number(values.sections),
  history: Number(values.history),
  trail: values.trail,
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
