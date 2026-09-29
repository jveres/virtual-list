import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
  if (process.env.BROWSER_ENGINE && process.env.BROWSER_ENGINE !== engine)
    continue;
  const browser = await type.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1420, height: 800 },
    });
    const errors = await openStreamingDemo(page, base);
    const prompt = page.locator(".message.user").last();
    const top = (row) =>
      row.evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document.getElementById("viewport").getBoundingClientRect().top,
      );
    // Intermediate positions, including a clipped prompt, must not require
    // reaching the exact bottom before collapse can reveal the prompt again.
    for (const delta of [60, 80, 120]) {
      await prompt
        .getByRole("button", { name: "Expand message", exact: true })
        .click();
      await page.waitForTimeout(200);
      await page.locator("#viewport").evaluate((v, delta) => {
        v.scrollTop += delta;
      }, delta);
      await page.waitForTimeout(200);
      assert.ok((await top(prompt)) < 0, `${engine}: prompt must be clipped`);
      await prompt
        .getByRole("button", { name: "Collapse message", exact: true })
        .click();
      await page.waitForTimeout(300);
      assert.ok(
        Math.abs((await top(prompt)) - 40) <= 1,
        `${engine}: collapsed prompt top is hidden`,
      );
    }
    const reply = page.locator(".message.assistant:has(.version-nav)").last();
    const key = await reply.getAttribute("data-key");
    const oldTop = await reply.evaluate(
      (r) =>
        r.getBoundingClientRect().top -
        document.getElementById("viewport").getBoundingClientRect().top +
        document.getElementById("viewport").scrollTop,
    );
    await page.locator("#prompt").fill("fast");
    await page.locator("#prompt").press("Enter");
    await page.waitForFunction(
      () => document.getElementById("send-btn").textContent === "Stop",
    );
    await page.waitForFunction(() =>
      document.querySelector('.role-label[data-status="streaming"]'),
    );
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => document.getElementById("send-btn").textContent === "Send",
    );
    for (const offset of [200, -100, -300, 200, -100, -300]) {
      await page.locator("#viewport").evaluate((v, value) => {
        v.scrollTop = value;
      }, oldTop - offset);
      await page.waitForTimeout(300);
      const old = page.locator(`.message[data-key="${key}"]`);
      // Dispatch the action without locator auto-scrolling changing the setup.
      await old
        .getByRole("button", { name: "Next version", exact: true })
        .evaluate((b) => b.click());
      await page.waitForTimeout(350);
      const position = await page.evaluate(() => {
        const v = document.getElementById("viewport");
        const origin = v.getBoundingClientRect().top;
        const prompt = [...v.querySelectorAll(".message.user")].at(-1);
        const reply = [...v.querySelectorAll(".message.assistant")].at(-1);
        const end = Math.max(
          0,
          v.scrollTop + prompt.getBoundingClientRect().top - origin - 40,
          v.scrollTop +
            reply.parentElement.getBoundingClientRect().bottom -
            origin -
            v.clientHeight,
        );
        return { top: v.scrollTop, end, max: v.scrollHeight - v.clientHeight };
      });
      assert.ok(
        Math.abs(position.top - position.end) <= 1,
        `${engine}/${offset}: wrong branch end ${JSON.stringify(position)}`,
      );
      assert.ok(
        Math.abs(position.max - position.end) <= 1,
        `${engine}/${offset}: stale reserve ${JSON.stringify(position)}`,
      );
      await page
        .locator(".message.assistant:has(.version-nav)")
        .last()
        .getByRole("button", { name: "Previous version", exact: true })
        .evaluate((b) => b.click());
      await page.waitForTimeout(250);
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: 3 partial collapse positions and 6 terminal branch switches passed`,
    );
  } finally {
    await browser.close();
  }
}
