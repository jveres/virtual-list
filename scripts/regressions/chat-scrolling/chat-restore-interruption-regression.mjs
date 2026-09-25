// Correctness only: synthetic input does not measure native scroll performance.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { createChatProfileServer } from "../../firefox-profile/chat-server.mjs";

const server = await createChatProfileServer({
  scenario: "manual",
  sections: 48,
  history: 160,
  durationMs: 30000,
});

try {
  const engines = { firefox, chromium, webkit };
  const selected = process.env.BROWSER_ENGINE;
  if (selected && !engines[selected]) throw new Error("Unknown BROWSER_ENGINE");
  for (const engine of selected
    ? [engines[selected]]
    : Object.values(engines)) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 850 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.url);
      await page.waitForFunction(() => globalThis.__chatProfile?.ready());
      await page.evaluate(() => globalThis.__chatProfile.start());
      await page.locator("#send-btn.stop-btn").waitFor();
      await page.waitForTimeout(700);
      const range = () =>
        page.locator("#window-status").evaluate((node) => {
          const match = /loaded ([\d,]+)-([\d,]+)\/([\d,]+)/.exec(
            node.textContent,
          );
          return match.slice(1).map((n) => Number(n.replaceAll(",", "")));
        });
      for (let step = 0; step < 4; step++) {
        const before = await range();
        if (before[1] < before[2]) break;
        await page.locator("#viewport").evaluate((viewport) => {
          viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
          viewport.scrollTop = 0;
          viewport.dispatchEvent(new Event("scrollend"));
        });
        await page.waitForFunction((first) => {
          const text = document.querySelector("#window-status").textContent;
          const next = Number(
            /loaded ([\d,]+)-/.exec(text)[1].replaceAll(",", ""),
          );
          return next < first && !text.includes("loading");
        }, before[0]);
      }
      const before = await range();
      assert.ok(before[1] < before[2], "the streaming reply must be evicted");

      const interrupted = await page.evaluate(async () => {
        document.querySelector("#scroll-bottom-btn").click();
        await new Promise(requestAnimationFrame);
        const staging = document.querySelector("#window-status").textContent;
        document
          .querySelector("#viewport")
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
          );
        return staging;
      });
      assert.match(
        interrupted,
        /loading bottom/,
        "input must interrupt pending staging",
      );
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#window-status")
            .textContent.includes("loading"),
      );
      assert.deepEqual(
        await range(),
        before,
        "keyboard input cancels tail restoration",
      );

      const stopped = await page.evaluate(async () => {
        document.querySelector("#scroll-bottom-btn").click();
        await new Promise(requestAnimationFrame);
        const staging = document.querySelector("#window-status").textContent;
        const stop = document.querySelector("#send-btn.stop-btn");
        stop?.click();
        return { staging, streaming: !!stop };
      });
      assert.equal(
        stopped.streaming,
        true,
        "stop must occur before completion",
      );
      assert.match(
        stopped.staging,
        /loading bottom/,
        "stop must occur during staging",
      );
      await page.waitForFunction((last) => {
        const row = document.querySelector(`#viewport [data-key="${last}"]`);
        return (
          row?.querySelector(".role-label")?.dataset.status === "cancelled" &&
          !!row.querySelector(".message-stopped")
        );
      }, before[2]);
      await page.waitForFunction(() => {
        const viewport = document.querySelector("#viewport");
        return (
          Math.abs(
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          ) <= 1
        );
      });
      assert.equal(
        (await range())[1],
        before[2],
        "restoration reaches the latest reply",
      );
      await page.evaluate(() => globalThis.__chatProfile.stop());
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()}: staged restoration respects keyboard cancellation and a concurrent stream stop`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
