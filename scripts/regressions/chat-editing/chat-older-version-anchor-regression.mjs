import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const engines = { chromium, firefox, webkit };
const selected = process.env.BROWSER_ENGINE;
assert.ok(
  !selected || Object.hasOwn(engines, selected),
  "Unknown browser engine",
);
for (const [engine, type] of Object.entries(engines)) {
  if (selected && selected !== engine) continue;
  const browser = await type.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1420, height: 1000 },
      deviceScaleFactor: 2,
    });
    const errors = await openStreamingDemo(page, base, {
      path: "/demos/streaming/",
    });
    const versionPrompt = page
      .locator('.message.user:has([aria-label="Next version"])')
      .last();
    const firstKey = await versionPrompt.getAttribute("data-key");
    await page.locator("#prompt").fill("fast");
    await page.locator("#prompt").press("Enter");
    await page.locator('.role-label[data-status="streaming"]').waitFor();
    await page.locator("#viewport").hover();
    await page.mouse.wheel(0, -650);
    await page.waitForTimeout(150);
    await versionPrompt.evaluate((row) => {
      const viewport = document.getElementById("viewport");
      viewport.scrollTop +=
        row.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        24;
    });
    assert.equal(await page.locator("#send-btn").textContent(), "Stop");
    await page.waitForFunction(
      () => document.querySelector("#send-btn").textContent === "Send",
      undefined,
      { timeout: 60000 },
    );
    assert.equal(await versionPrompt.getAttribute("data-key"), firstKey);
    const completedTop = await versionPrompt.evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        document.getElementById("viewport").getBoundingClientRect().top,
    );
    assert.ok(
      Math.abs(completedTop + 24) <= 1,
      "stream completion must preserve the reading position",
    );
    for (const [direction, offset] of [
      ["Next", -24],
      ["Previous", 30],
      ["Next", 200],
      ["Previous", -24],
    ]) {
      const key = await versionPrompt.getAttribute("data-key");
      const row = page.locator(`.message[data-key="${key}"]`);
      await page.locator("#viewport").hover();
      for (const delta of [-500, -500, 500, 500]) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(60);
      }
      await row.evaluate((row, offset) => {
        const viewport = document.getElementById("viewport");
        // Exercise clipped, under-pill, and fully visible placements.
        viewport.scrollTop +=
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          offset;
      }, offset);
      await page.waitForTimeout(250);
      await row.getByRole("button", { name: `${direction} version` }).hover();
      await page.evaluate(() => {
        window.olderAnchorSamples = [];
        window.sampleOlderAnchor = true;
        const sample = () => {
          const viewport = document.getElementById("viewport");
          const row = [
            ...viewport.querySelectorAll(
              '.message.user:has([aria-label="Next version"])',
            ),
          ].at(-1);
          window.olderAnchorSamples.push(
            row
              ? row.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top
              : null,
          );
          if (window.sampleOlderAnchor) requestAnimationFrame(sample);
        };
        sample();
      });
      await row.getByRole("button", { name: `${direction} version` }).click();
      await page.waitForFunction(
        (key) =>
          [
            ...document.querySelectorAll(
              '.message.user:has([aria-label="Next version"])',
            ),
          ].at(-1)?.dataset.key !== key,
        key,
      );
      await page.waitForTimeout(300);
      const samples = await page.evaluate(() => {
        window.sampleOlderAnchor = false;
        return window.olderAnchorSamples;
      });
      assert.ok(samples.length > 1);
      if (key === firstKey && offset === -24)
        assert.ok(
          Math.abs(samples[0] + 24) <= 1,
          "the reported clipped placement must be exercised",
        );
      // Returning to a shorter branch can clamp the requested placement to
      // its pin. Preserve the actual pre-click position in later cycles.
      assert.ok(
        samples.every((top) => top !== null && Math.abs(top - samples[0]) <= 1),
        `${engine} ${direction}: older prompt shifted: ${[...new Set(samples)]}`,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: older prompt retains its top through branch replacements`,
    );
  } finally {
    await browser.close();
  }
}
