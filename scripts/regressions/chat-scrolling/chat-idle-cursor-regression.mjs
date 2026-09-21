import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const boot = () =>
      page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
    await page.goto(`${base}/demos/streaming/`);
    await boot();
    assert.equal(await page.locator("#cursor-mode").inputValue(), "bar");
    const select = (mode) =>
      page.locator("#cursor-mode").evaluate((select, mode) => {
        select.value = mode;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, mode);
    await select("idle");
    await page.reload();
    await boot();
    assert.equal(await page.locator("#cursor-mode").inputValue(), "idle");
    await page.locator("#prompt").fill("slow");
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => {
      const cursor = document.querySelector(
        '[data-cursor-mode="idle"] .cursor-active',
      );
      return cursor && getComputedStyle(cursor, "::after").opacity === "0";
    });
    await page.waitForFunction(() => {
      const cursor = document.querySelector(
        '[data-cursor-mode="idle"] [data-cursor]:not(.cursor-active)',
      );
      return (
        cursor &&
        getComputedStyle(cursor, "::after").animationName.startsWith(
          "cursor-blink",
        )
      );
    });
    await page.waitForFunction(() => {
      const cursor = document.querySelector(
        '[data-cursor-mode="idle"] .cursor-active',
      );
      return cursor && getComputedStyle(cursor, "::after").opacity === "0";
    });
    await select("bar");
    await page.waitForFunction(() => {
      const cursor = document.querySelector(
        '[data-cursor-mode="bar"] .cursor-active',
      );
      return cursor && getComputedStyle(cursor, "::after").opacity === "1";
    });
    await select("none");
    await page.waitForFunction(() => !document.querySelector("[data-cursor]"));
    await select("idle");
    await page.waitForFunction(
      () => !!document.querySelector('[data-cursor-mode="idle"] [data-cursor]'),
    );
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => !document.querySelector("[data-cursor]"));
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: idle cursor settings persist, hide during chunks, blink during pauses, switch live, and clear on stop`,
    );
  } finally {
    await browser.close();
  }
}
