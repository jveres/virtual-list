import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  const page = await browser.newPage();
  const errors = await openStreamingDemo(page, base, { acceptDialogs: true });
  await importTranscript(page, "**User**\n\nUnanswered question\n", {
    name: "unanswered.md",
  });
  await page.getByText("Unanswered question", { exact: true }).waitFor();
  const original = page.locator("#viewport .message.user");
  const key = await original.getAttribute("data-key");
  await original.locator(".message-content").hover();
  await original.locator(".message-edit-btn").click();
  const editor = page.getByRole("textbox", {
    name: "Edit user message",
    exact: true,
  });
  await editor.fill("Updated unanswered question");
  await editor.press("Enter");
  await page
    .getByText("Updated unanswered question", { exact: true })
    .waitFor();
  const updated = page.locator("#viewport .message.user");
  assert.equal(await updated.getAttribute("data-key"), key);
  assert.equal(await updated.locator(".version-nav").count(), 0);
  await page.locator("#send-btn").click();
  await page.locator(".message-stopped").waitFor();
  // Once a reply exists, editing must preserve it as a previous version.
  await updated.locator(".message-content").hover();
  await updated.locator(".message-edit-btn").click();
  await editor.fill("Now preserve the existing reply");
  await editor.press("Enter");
  await page
    .getByText("Now preserve the existing reply", { exact: true })
    .waitFor();
  assert.notEqual(await updated.getAttribute("data-key"), key);
  assert.equal(
    await updated.locator(".version-nav-count").textContent(),
    "2 / 2",
  );
  await page.locator("#send-btn").click();
  await page.locator(".message-stopped").waitFor();
  await updated.getByRole("button", { name: "Previous version" }).click();
  await page
    .getByText("Updated unanswered question", { exact: true })
    .waitFor();
  assert.equal(await updated.getAttribute("data-key"), key);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      unansweredEdit: "passed",
      answeredVersion: "passed",
    }),
  );
} finally {
  await browser.close();
}
