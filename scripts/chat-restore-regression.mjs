// Simulated history edits must expose the way back to the built-in sample.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  for (const mutation of ["version", "delete", "refresh", "send"]) {
    const page = await browser.newPage();
    await page.route("https://api.openai.com/**", (route) => route.abort());
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const latest = page
      .locator(".message.assistant")
      .filter({ has: page.locator(".message-actions[data-latest]") });
    const original = await latest.locator(".markdown").textContent();
    await page.locator("#ai-settings-btn").click();
    assert.equal(
      await page.locator("#ai-restore-conversation").isVisible(),
      false,
    );
    await page.locator("#ai-settings-panel").evaluate((panel) => panel.close());
    if (mutation === "version") {
      await latest.getByRole("button", { name: "Next version" }).click();
    } else if (mutation === "delete") {
      await latest
        .getByRole("button", { name: "Delete response version" })
        .click();
      await page.locator(".delete-message-confirm").click();
      await page.waitForFunction(
        () => document.getElementById("deletion-status").textContent !== "",
      );
    } else {
      if (mutation === "refresh")
        await latest
          .getByRole("button", { name: "Regenerate response" })
          .click();
      else {
        await page.locator("#prompt").fill("Change the built-in history");
        await page.locator("#send-btn").click();
      }
      await page.waitForFunction(
        () => document.getElementById("send-btn").textContent === "Stop",
      );
      await page.locator("#send-btn").click();
      await page.waitForFunction(
        () => document.getElementById("send-btn").textContent === "Send",
      );
    }
    await page.locator("#ai-settings-btn").click();
    assert.equal(
      await page.locator("#ai-restore-conversation").isVisible(),
      true,
      `${mutation} must make the built-in history restorable`,
    );
    await page.locator("#ai-restore-conversation").click();
    assert.equal(
      await page.locator("#ai-restore-conversation").isVisible(),
      false,
    );
    await page.locator("#ai-settings-panel").evaluate((panel) => panel.close());
    assert.equal(await latest.locator(".markdown").textContent(), original);
    assert.equal(
      await latest.locator(".version-nav-count").textContent(),
      "1 / 3",
    );
    await page.close();
  }
  console.log(JSON.stringify({ engine, restoreAfterEdits: "passed" }));
} finally {
  await browser.close();
}
