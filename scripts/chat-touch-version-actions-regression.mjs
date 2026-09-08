import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "webkit";
const browser = await { chromium, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/`,
  );
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  await page.evaluate(() => {
    window.actionSamples = [];
    const sample = () => {
      for (const actions of document.querySelectorAll(
        "#viewport .message-user-actions",
      ))
        window.actionSamples.push(Number(getComputedStyle(actions).opacity));
    };
    // Observe both the press and release, not just the rebuilt row afterward.
    document.addEventListener("pointerdown", sample);
    document.addEventListener("pointerup", sample, true);
  });
  for (const direction of ["Next", "Previous", "Next", "Previous"]) {
    const row = page.locator("#viewport .message.user").last();
    const oldKey = await row.getAttribute("data-key");
    await row.getByRole("button", { name: `${direction} version` }).tap();
    await page.waitForTimeout(100);
    assert.notEqual(
      await page
        .locator("#viewport .message.user")
        .last()
        .getAttribute("data-key"),
      oldKey,
    );
    assert.equal(
      await page
        .locator("#viewport .message.user")
        .last()
        .locator(".message-user-actions")
        .evaluate((el) => getComputedStyle(el).opacity),
      "0",
    );
  }
  const samples = await page.evaluate(() => window.actionSamples);
  assert.ok(samples.length > 0);
  assert.ok(
    samples.every((opacity) => opacity === 0),
    `navigator revealed actions: ${JSON.stringify(samples)}`,
  );

  const row = page.locator("#viewport .message.user").last();
  await row.locator(".message-content").tap({ position: { x: 12, y: 12 } });
  assert.equal(
    await row
      .locator(".message-user-actions")
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  await row.locator(".message-edit-btn").tap();
  await page
    .getByRole("textbox", { name: "Edit user message", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      touchNavigation: "passed",
      bubbleActions: "passed",
      edit: "passed",
    }),
  );
} finally {
  await browser.close();
}
