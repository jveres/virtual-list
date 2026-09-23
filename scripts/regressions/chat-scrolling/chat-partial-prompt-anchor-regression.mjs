import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
try {
  for (const width of [1420, 1000, 800]) {
    for (const branch of ["assistant", "user"]) {
      const page = await browser.newPage({ viewport: { width, height: 600 } });
      const errors = await openStreamingDemo(page, base);
      const actions = page.locator("#viewport .message-actions[data-latest]");
      await actions
        .getByRole("button", { name: "Next version" })
        .evaluate((el) => el.click());
      await page.waitForTimeout(250);
      if (branch === "user") {
        await actions
          .getByRole("button", { name: "Next version" })
          .evaluate((el) => el.click());
        await page
          .locator("#viewport .message.user")
          .last()
          .getByRole("button", { name: "Next version" })
          .evaluate((el) => el.click());
        await page.waitForTimeout(250);
      }
      const prompt = page.locator("#viewport .message.user").last();
      await prompt.evaluate((row) => {
        const vp = document.getElementById("viewport");
        vp.scrollTop +=
          row.getBoundingClientRect().top - vp.getBoundingClientRect().top + 24;
      });
      await page.waitForTimeout(250);
      const button =
        branch === "assistant"
          ? actions.getByRole("button", { name: "Next version" })
          : prompt.getByRole("button", { name: "Previous version" });
      await button.hover();
      await page.evaluate(() => {
        window.anchorSamples = [];
        window.sampleAnchor = true;
        const sample = () => {
          const vp = document.getElementById("viewport");
          const row = vp
            .querySelector(".message-actions[data-latest]")
            ?.closest(".message");
          const prompt = [...vp.querySelectorAll(".message.user")].at(-1);
          window.anchorSamples.push({
            key: row?.getAttribute("data-key"),
            top: row
              ? row.getBoundingClientRect().top - vp.getBoundingClientRect().top
              : null,
            promptTop: prompt
              ? prompt.getBoundingClientRect().top -
                vp.getBoundingClientRect().top
              : null,
            scrollTop: vp.scrollTop,
          });
          if (window.sampleAnchor) requestAnimationFrame(sample);
        };
        sample();
      });
      await button.click();
      await page.waitForTimeout(600);
      const samples = await page.evaluate(() => {
        window.sampleAnchor = false;
        return window.anchorSamples;
      });
      console.log(
        JSON.stringify({
          engine,
          width,
          branch,
          before: samples[0],
          positions: [...new Set(samples.map((sample) => sample.top))],
          samples: samples.length,
        }),
      );
      assert.ok(
        samples[0].promptTop < 0,
        "fixture user prompt is partly scrolled out",
      );
      assert.ok(
        samples.every((sample) => Math.abs(sample.top - samples[0].top) < 1),
        "assistant anchor must remain stationary throughout replacement",
      );
      assert.notEqual(
        samples.at(-1).key,
        samples[0].key,
        "the version actually changed",
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
