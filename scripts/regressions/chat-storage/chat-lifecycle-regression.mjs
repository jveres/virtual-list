// Offline lifecycle and storage fault injection; no API requests leave the browser.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  pendingOpenAIMock,
  seedAISettings,
} from "../shared/openai-stream.mjs";
import {
  importTranscript,
  openStreamingDemo,
  waitForBoot,
} from "../shared/transcript.mjs";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  for (const abortWrite of [true, false]) {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const result = await page.evaluate(async (abortWrite) => {
      const legacy = [{ role: "user", markdown: "Keep this history" }];
      localStorage.setItem(
        "virtual-list:openai-history",
        JSON.stringify(legacy),
      );
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = originalPut.apply(this, args);
        if (abortWrite) {
          request.addEventListener("success", () => this.transaction.abort());
        }
        return request;
      };
      try {
        const api = await import("/demos/streaming/openai.ts");
        const loaded = await api.loadOpenAIHistory();
        const reloaded = await api.loadOpenAIHistory();
        return {
          loaded,
          reloaded,
          legacy: localStorage.getItem("virtual-list:openai-history"),
        };
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }
    }, abortWrite);
    const expected = [{ role: "user", markdown: "Keep this history" }];
    assert.deepEqual(result.loaded, expected);
    assert.deepEqual(
      result.reloaded,
      expected,
      "migration must survive an aborted write",
    );
    assert.equal(result.legacy, abortWrite ? JSON.stringify(expected) : null);
    await page.close();
  }

  const page = await browser.newPage();
  await page.addInitScript(seedAISettings, OFFLINE_AI_SETTINGS);
  await page.addInitScript(pendingOpenAIMock, {
    started: "requestStarted",
    finishers: true,
  });
  const errors = await openStreamingDemo(page, base, {
    path: "/demos/streaming/index.html",
  });
  await page.locator("#prompt").fill("Old request");
  await page.locator("#send-btn").click();
  await page.waitForFunction(() => window.requestStarted);
  page.on("dialog", (dialog) => dialog.accept());
  await importTranscript(
    page,
    "**User**\n\nNew question\n\n**Assistant**\n\nNew answer\n",
    { name: "replacement.md" },
  );
  await page.getByText("New answer", { exact: true }).waitFor();
  await page.locator("#prompt").fill("New request");
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => typeof window.finishNewRequest === "function",
  );
  await page.evaluate(() => window.finishOldRequest());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(
    await page.locator("#send-btn").textContent(),
    "Stop",
    "old cleanup must not release the new stream's Stop control",
  );
  assert.equal(
    await page.locator('[data-status="cancelled"]').count(),
    0,
    "old stream cleanup must not cancel the replacement answer",
  );
  await page.locator("#send-btn").click();
  await page.evaluate(() => window.finishNewRequest());
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  assert.deepEqual(errors, []);
  await page.close();

  const switching = await browser.newPage();
  await openStreamingDemo(switching, base, {
    path: "/demos/streaming/index.html",
  });
  await switching.evaluate(async () => {
    const api = await import("/demos/streaming/openai.ts");
    api.saveOpenAIHistory([
      { role: "user", markdown: "History about to be cleared" },
    ]);
    await api.loadOpenAIHistory();
  });
  // Saving also populates the session cache. Reload before fault injection so
  // switching providers genuinely reads IndexedDB instead of returning it.
  await switching.reload();
  await waitForBoot(switching);
  await switching.evaluate(() => {
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      const request = originalGet.apply(this, args);
      if (this.name !== "openai-history" || args[0] !== "history")
        return request;
      IDBObjectStore.prototype.get = originalGet;
      request.addEventListener("success", (event) => {
        event.stopImmediatePropagation();
        window.releaseHistoryRead = () =>
          request.onsuccess?.call(request, event);
      });
      return request;
    };
  });
  await switching.locator("#ai-settings-btn").click();
  await switching.locator("#ai-provider").selectOption("openai");
  await switching.waitForFunction(
    () => typeof window.releaseHistoryRead === "function",
  );
  assert.equal(
    await switching.locator("#send-btn").isDisabled(),
    true,
    "sending must be disabled while the provider's history is loading",
  );
  switching.on("dialog", (dialog) => dialog.accept());
  await switching.locator("#ai-clear-history").click();
  await switching.evaluate(async () => {
    window.releaseHistoryRead();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  assert.equal(
    await switching
      .getByText("History about to be cleared", { exact: true })
      .count(),
    0,
    "a stale provider read must not restore cleared history",
  );
  console.log(
    JSON.stringify({
      engine,
      migration: "passed",
      replacement: "passed",
      provider: "passed",
    }),
  );
} finally {
  await browser.close();
}
