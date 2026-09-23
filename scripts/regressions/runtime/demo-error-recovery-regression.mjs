import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const [demo, storageKey, row] of [
      ["streaming", "virtual-list:chat-options", ".message"],
      ["gallery", "virtual-list:gallery-options", ".photo-row"],
    ]) {
      for (const stored of [
        "null",
        "[]",
        "{invalid",
        '{"concurrency":{"toString":null,"valueOf":null}}',
      ]) {
        const page = await browser.newPage();
        try {
          await page.addInitScript(
            ({ key, value }) => {
              localStorage.setItem(key, value);
              window.auditErrors = [];
              window.addEventListener("error", (event) =>
                window.auditErrors.push(event.message),
              );
            },
            { key: storageKey, value: stored },
          );
          await page.goto(`${base}/demos/${demo}/?instant`);
          await page.waitForFunction(
            (selector) =>
              window.auditErrors.length ||
              document.querySelector(`#viewport ${selector}`),
            row,
          );
          assert.deepEqual(
            await page.evaluate(() => window.auditErrors),
            [],
            `${demo}: ${stored} settings must fall back to defaults`,
          );
        } finally {
          await page.close();
        }
      }
    }

    const page = await browser.newPage();
    const reports = [];
    page.on("console", (message) => {
      if (message.type() === "error") reports.push(message.text());
    });
    const errors = await openStreamingDemo(page, base, {
      path: "/demos/streaming/?instant",
    });
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "innerHTML",
      );
      Object.defineProperty(Element.prototype, "innerHTML", {
        ...original,
        set(value) {
          if (
            this.matches(".markdown") &&
            value.includes("audit-send-failure")
          ) {
            Object.defineProperty(Element.prototype, "innerHTML", original);
            throw new Error("injected send render failure");
          }
          original.set.call(this, value);
        },
      });
    });
    await page.locator("#prompt").fill("audit-send-failure");
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => document.querySelector("#send-btn").textContent === "Send",
    );
    // The next browser task also delivers any unhandled rejection.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(
      errors,
      [],
      "send failures must be caught at the event boundary",
    );
    assert.equal(
      reports.filter((message) => message.includes("Could not send message."))
        .length,
      1,
    );
    const previousReply = await page
      .locator("#viewport .message.assistant")
      .last()
      .getAttribute("data-key");
    await page.locator("#prompt").fill("Retry after render failure");
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => document.querySelector("#send-btn").textContent === "Send",
    );
    const reply = page.locator("#viewport .message.assistant").last();
    assert.notEqual(await reply.getAttribute("data-key"), previousReply);
    assert.ok(
      (await reply.locator(".markdown").allInnerTexts()).join("").length > 100,
      "retry must produce a completed reply",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: invalid settings and send failure recovery passed`,
    );
  } finally {
    await browser.close();
  }
}
