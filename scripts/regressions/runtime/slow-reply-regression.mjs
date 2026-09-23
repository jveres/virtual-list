import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = await openStreamingDemo(page, base);
    await page.locator("#prompt").fill("  SLOW  ");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => {
      const cursor = document.querySelector(".message.assistant .cursor");
      return (
        cursor &&
        !cursor.classList.contains("cursor-active") &&
        getComputedStyle(cursor, "::after").opacity === "0"
      );
    });
    const pausedText = await page
      .locator(".message.assistant")
      .last()
      .innerText();
    assert.match(pausedText, /quick rundown/);
    await page.waitForFunction((pausedText) => {
      const cursor = document.querySelector(
        ".message.assistant .cursor-active",
      );
      return cursor && cursor.closest(".message").innerText !== pausedText;
    }, pausedText);
    await page.waitForFunction(() => {
      const cursor = document.querySelector(".message.assistant .cursor");
      return (
        cursor &&
        !cursor.classList.contains("cursor-active") &&
        getComputedStyle(cursor, "::after").opacity === "0"
      );
    });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    assert.equal(await page.locator(".message.assistant .cursor").count(), 0);
    const stopped = await page.locator(".message.assistant").last().innerText();
    // Cross the scheduled pause deadline: a cancelled wait must not resume.
    await page.waitForTimeout(2700);
    assert.equal(
      await page.locator(".message.assistant").last().innerText(),
      stopped,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: slow trigger, idle blink, resume, and cancellation during a pause passed`,
    );
  } finally {
    await browser.close();
  }
}
