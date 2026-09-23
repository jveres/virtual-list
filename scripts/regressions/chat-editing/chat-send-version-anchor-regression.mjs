import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
try {
  for (const extraOffset of [0, 100]) {
    const page = await browser.newPage({
      viewport: { width: 1420, height: 1200 },
    });
    await openStreamingDemo(page, base);
    const pinnedInset = await page
      .locator(".section-header")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    const inset = pinnedInset + extraOffset;
    const key = await page
      .locator(".message.user")
      .last()
      .getAttribute("data-key");
    const initialScrollTop = await page
      .locator("#viewport")
      .evaluate((el) => el.scrollTop);
    await page.locator("#prompt").fill("fast");
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => document.getElementById("send-btn").textContent === "Send",
      undefined,
      { timeout: 60000 },
    );
    // Return to the last seeded prompt; the newly appended prompt has no
    // alternate versions. Upward input disengages end-follow; positioning
    // the viewport must not use scrollTo's prompt command, which re-pins it.
    await page.locator("#viewport").hover();
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(500);
    await page.locator("#viewport").evaluate((el, top) => {
      el.scrollTop = top;
    }, initialScrollTop);
    const row = page.locator(`.message[data-key="${key}"]`);
    await row.waitFor();
    await row.evaluate((el, inset) => {
      const vp = document.getElementById("viewport");
      vp.scrollTop +=
        el.getBoundingClientRect().top - vp.getBoundingClientRect().top - inset;
    }, inset);
    await page.waitForTimeout(250);
    const top = (row) =>
      row.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          document.getElementById("viewport").getBoundingClientRect().top,
      );
    const before = await top(row);
    await row.locator(".message-content").hover();
    await row.getByRole("button", { name: "Next version" }).click();
    await page.waitForTimeout(250);
    const after = await top(page.locator(".message.user").last());
    console.log(JSON.stringify({ engine, inset, before, after }));
    assert.ok(
      Math.abs(before - after) < 1,
      `send then version: ${before} → ${after}`,
    );
    const restored = page.locator(".message.user").last();
    await page.locator("#viewport").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    assert.ok(
      Math.abs((await top(restored)) - pinnedInset) < 1,
      "the replacement must still be scrollable to the top using its reserve",
    );
    await page.setViewportSize({ width: 1420, height: 1320 });
    await page.waitForTimeout(200);
    assert.ok(
      Math.abs((await top(restored)) - pinnedInset) < 1,
      "the replacement pin must survive a taller viewport",
    );
    await page.setViewportSize({ width: 1420, height: 1200 });
    await restored.evaluate((el, inset) => {
      const vp = document.getElementById("viewport");
      vp.scrollTop +=
        el.getBoundingClientRect().top - vp.getBoundingClientRect().top - inset;
    }, before);
    await page.waitForTimeout(200);
    await restored.locator(".message-content").hover();
    await restored.getByRole("button", { name: "Previous version" }).click();
    await page.waitForTimeout(250);
    const back = await top(page.locator(`.message[data-key="${key}"]`));
    console.log(JSON.stringify({ engine, inset, back }));
    assert.ok(
      Math.abs(before - back) < 1,
      `return to shorter version: ${before} → ${back}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
