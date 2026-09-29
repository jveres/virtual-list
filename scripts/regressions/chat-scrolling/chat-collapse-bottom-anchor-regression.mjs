import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
  if (process.env.BROWSER_ENGINE && process.env.BROWSER_ENGINE !== engine)
    continue;
  const browser = await type.launch();
  try {
    for (const replyVersion of [1, 2]) {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 962 },
        deviceScaleFactor: 2,
      });
      const errors = await openStreamingDemo(page, base);
      if (replyVersion === 2) {
        await page
          .locator(".message.assistant")
          .last()
          .getByRole("button", { name: "Next version", exact: true })
          .click();
        await page.waitForTimeout(200);
      }
      const row = page.locator(".message.user").last();
      const key = await row.getAttribute("data-key");
      await row
        .getByRole("button", { name: "Expand message", exact: true })
        .click();
      await page.waitForTimeout(350);
      await page.locator("#viewport").hover();
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(700);
      // Scripted wheel delivery can omit Firefox's protected-edge release.
      // Model that boundary explicitly; this is a correctness test, not a
      // measurement of native trackpad momentum or physical presentation.
      await page
        .locator("#viewport")
        .evaluate((v) => v.dispatchEvent(new Event("scrollend")));
      await page.waitForTimeout(250);
      const before = await row.evaluate((row) => {
        const viewport = document.getElementById("viewport");
        return {
          top:
            row.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
          height: row.getBoundingClientRect().height,
          distance:
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        };
      });
      assert.ok(
        Math.abs(before.distance) <= 1,
        "the expanded conversation must reach the bottom",
      );
      assert.ok(
        before.top < 39,
        "the reading position must be beyond the prompt's pin",
      );
      await page.evaluate((key) => {
        window.disclosureTops = [];
        window.sampleDisclosure = true;
        const sample = () => {
          const row = document.querySelector(`.message[data-key="${key}"]`);
          const viewport = document.getElementById("viewport");
          window.disclosureTops.push(
            row
              ? row.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top
              : null,
          );
          if (window.sampleDisclosure) requestAnimationFrame(sample);
        };
        sample();
      }, key);
      await row
        .getByRole("button", { name: "Collapse message", exact: true })
        .click();
      await page.waitForTimeout(500);
      await page.waitForFunction((key) => {
        const row = document.querySelector(`.message[data-key="${key}"]`);
        return (
          Math.abs(
            row.parentElement.getBoundingClientRect().height -
              row.getBoundingClientRect().height,
          ) <= 1
        );
      }, key);
      const samples = await page.evaluate(() => {
        window.sampleDisclosure = false;
        return window.disclosureTops;
      });
      assert.ok(samples.length > 1);
      const expectedTop = before.top < 0 ? 40 : before.top;
      assert.ok(
        Math.abs(samples.at(-1) - expectedTop) <= 1,
        `${engine}/reply-${replyVersion}: collapse must retain a visible prompt top or restore its pin: before=${before.top}, samples=${[...new Set(samples)]}`,
      );
      if (before.top >= 0)
        assert.ok(
          samples.every(
            (top) => top !== null && Math.abs(top - before.top) <= 1,
          ),
        );
      assert.ok(
        (await row.evaluate((row) => row.getBoundingClientRect().height)) <
          before.height,
      );
      // Reverse within one input phase: retained reading space must not become
      // the end again merely because the reader did not stop on the way up.
      await page.locator("#viewport").hover();
      const startTop = await page
        .locator("#viewport")
        .evaluate((v) => v.scrollTop);
      await page.mouse.wheel(0, -500);
      await page.waitForFunction(
        (start) => document.getElementById("viewport").scrollTop < start - 250,
        startTop,
      );
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(350);
      const returned = await row.evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document.getElementById("viewport").getBoundingClientRect().top,
      );
      assert.ok(
        Math.abs(returned - 40) <= 1,
        `${engine}: gesture returned to stale reading space: ${returned}`,
      );
      assert.deepEqual(errors, []);
      console.log(
        `${engine}/reply-${replyVersion}: expand → bottom → collapse ${before.top} → ${expectedTop}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
