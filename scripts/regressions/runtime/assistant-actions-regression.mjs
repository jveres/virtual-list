import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
    });
    await openStreamingDemo(page, base);
    await page.waitForSelector("#viewport .message.assistant");
    const key = await page
      .locator("#viewport .message.assistant")
      .nth(-2)
      .getAttribute("data-key");
    await page.locator("#prompt").fill("slow");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForSelector("#viewport .message.assistant .cursor", {
      state: "attached",
    });
    await page.locator("#viewport").hover();
    await page.mouse.wheel(0, -5000);
    // Firefox bounds an individual wheel event. After taking user ownership,
    // move well beyond overscan so the target really leaves the mounted range.
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.scrollTop = Math.max(1, viewport.scrollTop - 5000);
    });
    await page.waitForFunction(
      (key) => !document.querySelector(`#viewport .message[data-key="${key}"]`),
      key,
    );
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    await page.locator("#scroll-bottom-btn").click();
    const row = page.locator(`#viewport .message[data-key="${key}"]`);
    await row.waitFor();
    await page.waitForTimeout(800);
    const buttons = await row
      .locator(".message-actions > button")
      .evaluateAll((buttons) =>
        buttons.map((button) => ({
          label: button.getAttribute("aria-label"),
          disabled: button.disabled,
        })),
      );
    assert.equal(
      buttons.find((button) => button.label === "Regenerate response")
        ?.disabled,
      false,
      `${engine.name()}: ${JSON.stringify(buttons)}`,
    );
    assert.equal(
      buttons.find((button) => button.label === "Copy message")?.disabled,
      false,
    );
    await row.locator(".message-content").hover();
    await row.getByRole("button", { name: "Regenerate response" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    console.log(
      `${engine.name()}: offscreen completion restores assistant actions and regeneration works`,
    );
  } finally {
    await browser.close();
  }
}
