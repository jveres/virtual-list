import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  openAIStreamMock,
} from "../shared/openai-stream.mjs";
import { openStreamingDemo, waitForBoot } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
try {
  for (const partial of [false, true]) {
    const page = await browser.newPage();
    await page.addInitScript(openAIStreamMock, {
      settings: OFFLINE_AI_SETTINGS,
      emitText: "emitText",
    });
    const errors = await openStreamingDemo(page, base);
    await page.locator("#prompt").fill("Persist stopped response");
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => typeof window.emitText === "function");
    if (partial) {
      await page.evaluate(() => window.emitText("Some received text"));
      await page.getByText("Some received text", { exact: true }).waitFor();
    }
    await page.locator("#send-btn").click();
    await page.locator(".message-stopped").waitFor();
    // Wait for durable storage, rather than relying on a sleep before reload.
    await page.waitForFunction(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("virtual-list-demo");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const history = await new Promise((resolve, reject) => {
          const request = database
            .transaction("openai-history")
            .objectStore("openai-history")
            .get("history");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        // Stored as { turns, tree } since the conversation tree; arrays before.
        const turns = Array.isArray(history) ? history : history?.turns;
        return turns?.at(-1)?.stopped === true;
      } finally {
        database.close();
      }
    });
    for (let reload = 0; reload < 2; reload++) {
      await page.reload();
      await waitForBoot(page);
      const reply = page.locator("#viewport .message.assistant").last();
      await reply.locator(".message-stopped").waitFor();
      assert.equal(
        await reply.locator(".message-stopped").textContent(),
        "...stopped",
      );
      assert.equal(
        await reply.locator(".role-label .dot.cancelled").count(),
        1,
      );
      assert.equal(
        await reply
          .locator(".markdown")
          .innerText()
          .catch(() => ""),
        partial ? "Some received text...stopped" : "...stopped",
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ engine, partial, reloadMarkerAndDot: "passed" }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
