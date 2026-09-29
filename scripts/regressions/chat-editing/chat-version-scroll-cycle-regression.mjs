import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1420, height: 1000 },
      deviceScaleFactor: 2,
    });
    const errors = await openStreamingDemo(page, base);
    // Fractional viewport heights occur naturally in the maximized demo.
    await page.addStyleTag({
      content: ".viewport-wrap {flex: none; height: 812.6px}",
    });
    await page.waitForTimeout(300);
    const viewport = page.locator("#viewport");
    const prompt = () => page.locator("#viewport .message.user").last();
    const position = () =>
      prompt().evaluate((row) => {
        const viewport = document.getElementById("viewport");
        return {
          key: row.dataset.key,
          top:
            row.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
          max: viewport.scrollHeight - viewport.clientHeight,
          scrollTop: viewport.scrollTop,
        };
      });
    const switchVersion = async (role, direction) => {
      const before = await position();
      const row = page.locator(`#viewport .message.${role}`).last();
      await row.locator(".message-content").hover();
      await row.getByRole("button", { name: `${direction} version` }).click();
      await page.waitForTimeout(200);
      const after = await position();
      assert.ok(
        Math.abs(after.top - before.top) <= 1,
        `${engine} ${role} ${direction}: prompt moved ${before.top} → ${after.top}`,
      );
      if (role === "user")
        assert.notEqual(
          after.key,
          before.key,
          "the prompt version must change",
        );
    };
    const scroll = async (delta, count) => {
      await viewport.hover();
      for (let i = 0; i < count; i++) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(300);
    };
    await scroll(400, 2);
    const initial = await position();
    for (const direction of ["Next", "Next", "Previous"]) {
      await switchVersion("assistant", direction);
      await scroll(-400, 6);
      await scroll(400, 8);
      const returned = await position();
      assert.ok(
        Math.abs(returned.top - initial.top) <= 1,
        `${engine}: reserve accumulated across scroll cycles`,
      );
      await switchVersion("user", "Next");
      await switchVersion("user", "Previous");
      await scroll(-250, 1);
      const middle = await position();
      assert.ok(
        middle.top > 200 && middle.top < 500,
        "prompt must be mid-viewport",
      );
      await switchVersion("user", "Next");
      await scroll(-400, 6);
      await scroll(400, 6);
      await switchVersion("user", "Previous");
      await scroll(400, 2);
      assert.ok(
        Math.abs((await position()).max - initial.max) <= 1,
        `${engine}: trailing reserve grew`,
      );
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, initial, final: await position() }));
  } finally {
    await browser.close();
  }
}
