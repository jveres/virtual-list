import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discardRaw, writeReproduction } from "./artifacts.mjs";
import { capturePlaywright } from "./chat-browsers.mjs";
import { createChatProfileServer } from "./chat-server.mjs";
import { analyzeSend } from "./send-analysis.mjs";

const { values } = parseArgs({
  options: {
    transcript: { type: "string" },
    browser: { type: "string", default: "chrome" },
    mode: { type: "string", default: "timing" },
    display: { type: "string" },
    "refresh-hz": { type: "string", default: "60" },
    output: { type: "string", default: "browser-artifacts/imported-send" },
  },
});
assert.ok(values.transcript, "Use --transcript=/path/to/local-chat.md");
assert.ok(
  ["chrome", "engine-chromium", "engine-firefox", "engine-webkit"].includes(
    values.browser,
  ),
  "Unsupported browser",
);
assert.ok(["timing", "diagnostic"].includes(values.mode), "Invalid mode");
const refreshHz = Number(values["refresh-hz"]);
assert.ok(Number.isFinite(refreshHz) && refreshHz > 0 && refreshHz <= 1000);
const input = resolve(values.transcript);
const bytes = await readFile(input);
await mkdir(values.output, { recursive: true });
const directory = await mkdtemp(join(resolve(values.output), "run-"));
const options = {
  browser: values.browser,
  maximize: true,
  scenario: "follow",
  diagnostic: values.mode === "diagnostic",
  display: values.display,
  refreshHz,
  seconds: 4,
  durationMs: 1000,
  sections: 1,
  history: 40,
  trail: "long",
};
const report = {
  options,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  input: {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  },
  procedure:
    "Simulated provider; import supplied transcript; page upward until older history loads, then once more; settle; send; measure through landing",
  pagingInput:
    values.browser === "engine-webkit" ? "scripted headless setup" : "PageUp",
};
console.log(`Send profile: ${directory}`);
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Capture interrupted"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, interrupt);
let server;
let setup;
try {
  await writeReproduction(directory, report);
  server = await createChatProfileServer(options);
  const result = await capturePlaywright(
    server,
    directory,
    {
      ...options,
      preparePage: async (page) => {
        await page
          .locator("#ai-provider")
          .selectOption("simulated", { force: true });
        await page.waitForTimeout(1500);
        await page.evaluate(async () => {
          const { loadSimulatedHistory } = await import(
            "/demos/streaming/openai.ts"
          );
          globalThis.__sendProfileHistory = await loadSimulatedHistory();
        });
        await page.locator("#import-file").setInputFiles(input);
        await page.waitForFunction(
          async () => {
            const { loadSimulatedHistory } = await import(
              "/demos/streaming/openai.ts"
            );
            return (
              (await loadSimulatedHistory()) !== globalThis.__sendProfileHistory
            );
          },
          undefined,
          { timeout: 60000 },
        );
        await page.evaluate(() => {
          delete globalThis.__sendProfileHistory;
        });
        await page.waitForTimeout(4000);
        await page.locator("#viewport").focus();
        const status = () => page.locator("#window-status").textContent();
        const first = (text) =>
          Number(/loaded ([\d,]+)-/.exec(text)?.[1]?.replaceAll(",", ""));
        const beforeStart = first(await status());
        const pageUp = () =>
          values.browser === "engine-webkit"
            ? page.locator("#viewport").evaluate((viewport) => {
                viewport.scrollTop -= viewport.clientHeight;
              })
            : page.keyboard.press("PageUp");
        assert.ok(
          beforeStart > 1,
          "Transcript must have unloaded older history",
        );
        for (let n = 0; n < 60 && first(await status()) >= beforeStart; n++) {
          controller.signal.throwIfAborted();
          await pageUp();
          await page.waitForTimeout(350);
        }
        await page.waitForTimeout(1200);
        await pageUp();
        await page.waitForTimeout(1500);
        const afterStart = first(await status());
        const geometry = await page.locator("#viewport").evaluate((v) => ({
          viewportHeight: v.clientHeight,
          distanceFromEnd: v.scrollHeight - v.clientHeight - v.scrollTop,
        }));
        setup = { beforeStart, afterStart, ...geometry, refreshHz };
        assert.ok(afterStart < beforeStart, "Older history did not load");
      },
    },
    controller.signal,
  );
  report.browser = result.metadata;
  const summary = analyzeSend(result.recording, setup);
  summary.evidence = result.native
    ? "installed-browser timing"
    : "headless correctness only";
  report.status = summary.valid ? "complete" : "invalid";
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify(
      { ...summary, expensive: summary.expensive.slice(0, 8) },
      null,
      2,
    ),
  );
  if (!summary.valid) process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await server?.close();
    report.serverClosed = true;
  } catch (error) {
    report.status = "failed";
    report.cleanupError = String(error);
    process.exitCode = 1;
  }
  try {
    await discardRaw(directory);
    report.rawDataRemoved = true;
  } catch (error) {
    report.status = "failed";
    report.rawDataRemoved = false;
    report.cleanupError = String(error);
    process.exitCode = 1;
  } finally {
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify(report, null, 2),
    );
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.off(signal, interrupt);
  }
}
