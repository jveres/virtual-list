import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [webkit, firefox, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
      acceptDialogs: true,
    });
    const markdown = Array.from(
      { length: 6 },
      (_, index) =>
        `**${index % 2 ? "Assistant" : "User"}**\n\nTurn ${index}. ${"Scrollable conversation content. ".repeat(90)}\n\n`,
    ).join("");
    await importTranscript(page, markdown, { name: "composer.md" });
    await page.getByText("Turn 5.", { exact: false }).waitFor();
    const prompt = page.locator("#prompt");
    await prompt.fill("First line\n");
    await page.locator("#viewport").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(200);
    const snapshot = () =>
      page.evaluate(() => {
        const viewport = document.querySelector("#viewport");
        const prompt = document.querySelector("#prompt");
        return {
          top: viewport.scrollTop,
          gap:
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          viewportHeight: viewport.clientHeight,
          promptHeight: prompt.getBoundingClientRect().height,
        };
      });
    const before = await snapshot();
    const samples = [];
    for (const character of "abc") {
      await prompt.press(character);
      await page.waitForTimeout(100);
      samples.push(await snapshot());
    }
    console.log(JSON.stringify({ engine: engine.name(), before, samples }));
    assert.ok(
      samples.every((sample) => sample.promptHeight === before.promptHeight),
      "typing within the second line must not resize the composer",
    );
    assert.ok(
      samples.every(
        (sample) =>
          Math.abs(sample.top - before.top) <= 1 && Math.abs(sample.gap) <= 1,
      ),
      "typing within the second line must not move the bottom-aligned chat",
    );
    for (const value of [
      "First line\nSecond line\nThird line",
      "Line\n".repeat(20),
      "Short",
    ]) {
      await prompt.fill(value);
      await page.waitForTimeout(150);
      const resized = await snapshot();
      assert.ok(
        Math.abs(resized.gap) <= 1,
        "actual composer growth/shrink must preserve bottom alignment",
      );
      assert.ok(resized.promptHeight <= 160, "composer height remains capped");
    }
    await prompt.fill("First line\nSecond line");
    await page.locator("#viewport").evaluate((element) => {
      element.scrollTop -= 180;
    });
    await page.waitForTimeout(150);
    const away = await snapshot();
    await prompt.press("x");
    await page.waitForTimeout(100);
    assert.ok(
      Math.abs((await snapshot()).top - away.top) <= 1,
      "typing must not pull a scrolled-up chat to the bottom",
    );
  } finally {
    await browser.close();
  }
}
