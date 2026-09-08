// Regression for a pinned prompt changing dates after edit/stop/version-back.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1420, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/`,
  );
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  const prompt = page.locator("#viewport .message.user").last();
  const originalKey = await prompt.getAttribute("data-key");
  const offset = (key) =>
    page
      .locator(`#viewport .message[data-key="${key}"]`)
      .evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document.getElementById("viewport").getBoundingClientRect().top,
      );
  const before = await offset(originalKey);
  assert.ok(
    Math.abs(before - 44) < 1,
    `fixture prompt must start below sticky band: ${before}`,
  );
  await prompt.locator(".message-content").hover();
  await prompt.locator(".message-edit-btn").click();
  const editor = page.getByRole("textbox", {
    name: "Edit user message",
    exact: true,
  });
  await editor.fill("Edited version anchor regression");
  await editor.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Stop",
  );
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  const edited = page
    .locator(".message.user")
    .filter({ hasText: "Edited version anchor regression" });
  const editedKey = await edited.getAttribute("data-key");
  const afterEdit = await offset(editedKey);
  await edited.locator(".message-content").hover();
  await edited.getByRole("button", { name: "Previous version" }).click();
  await page.waitForFunction(
    (key) => !document.querySelector(`#viewport .message[data-key="${key}"]`),
    editedKey,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const restoredKey = await page
    .locator("#viewport .message.user")
    .last()
    .getAttribute("data-key");
  const restored = await offset(restoredKey);
  console.log(JSON.stringify({ engine, before, afterEdit, restored }));
  assert.ok(
    Math.abs(restored - before) < 1,
    `restored prompt moved into the date pill: ${before} → ${restored}`,
  );
  for (const direction of [
    "Previous",
    "Next",
    "Next",
    "Previous",
    "Previous",
  ]) {
    const current = page.locator("#viewport .message.user").last();
    await current.locator(".message-content").hover();
    await current.getByRole("button", { name: `${direction} version` }).click();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const key = await page
      .locator("#viewport .message.user")
      .last()
      .getAttribute("data-key");
    const top = await offset(key);
    console.log(JSON.stringify({ engine, direction, key, top }));
    assert.ok(
      Math.abs(top - before) < 1,
      `${direction} version lost pinned offset: ${top}`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
