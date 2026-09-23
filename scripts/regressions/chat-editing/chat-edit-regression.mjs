// Offline inline-editing checks; no API requests leave the browser.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  pendingOpenAIMock,
  seedAISettings,
} from "../shared/openai-stream.mjs";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  const page = await browser.newPage();
  await page.addInitScript(seedAISettings, OFFLINE_AI_SETTINGS);
  await page.addInitScript(pendingOpenAIMock, {
    counter: "requests",
    body: "requestBody",
  });
  await openStreamingDemo(page, base, { acceptDialogs: true });
  await importTranscript(
    page,
    "**User**\n\nOriginal question\n\n**Assistant**\n\nOriginal answer\n\n**User**\n\nLater question\n\n**Assistant**\n\nLater answer\n",
    { name: "edit.md" },
  );
  await page.getByText("Later answer", { exact: true }).waitFor();
  await page.locator("#prompt").fill("Keep my composer draft");
  const originalRow = page
    .locator(".message.user")
    .filter({ hasText: "Original question" });
  await originalRow.locator(".markdown").click();
  assert.equal(await page.locator(".message.user.is-editing").count(), 0);
  await originalRow.locator(".markdown").dblclick();
  assert.equal(await page.locator(".message.user.is-editing").count(), 0);
  await originalRow.locator(".message-content").hover();
  await originalRow.locator(".message-edit-btn").click();
  const editor = page.getByRole("textbox", {
    name: "Edit user message",
    exact: true,
  });
  assert.equal(await editor.getAttribute("contenteditable"), "plaintext-only");
  assert.equal(
    await originalRow.locator(".markdown").count(),
    1,
    "editing must not duplicate the text",
  );
  assert.equal(await originalRow.locator("textarea").count(), 0);
  assert.equal(
    await editor.evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  await editor.fill("Discard this edit");
  await page
    .locator(".message.user.is-editing")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await editor.count(), 0);
  assert.equal(await page.evaluate(() => window.requests), 0);
  await originalRow.locator(".message-content").hover();
  await originalRow.locator(".message-edit-btn").click();
  await editor.fill("Cancel by clicking outside");
  await page.locator("#prompt").click();
  assert.equal(await editor.count(), 0);
  assert.equal(
    await originalRow.locator(".markdown").textContent(),
    "Original question\n",
  );
  await originalRow.locator(".message-content").hover();
  await originalRow.locator(".message-edit-btn").click();
  await editor.fill("Changed question");
  await editor.press("Shift+Enter");
  await editor.press("N");
  assert.equal(await page.evaluate(() => window.requests), 0);
  await editor.press("Enter");
  await page.waitForFunction(() => window.requests === 1);
  const today = page
    .locator("#viewport .section-header-pill")
    .filter({ hasText: /^Today$/ });
  const newPrompt = page
    .locator(".message.user")
    .filter({ hasText: "Changed question" });
  assert.ok(
    (await today.boundingBox()).y < (await newPrompt.boundingBox()).y,
    "editing must place Today above the edited prompt and reply",
  );
  assert.equal(await editor.count(), 0);
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "Keep my composer draft",
  );
  const body = await page.evaluate(() => JSON.stringify(window.requestBody));
  assert.match(body, /Changed question/);
  assert.doesNotMatch(
    body,
    /Original question|Original answer|Later question|Later answer|Keep my composer draft/,
  );
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  const editedRow = page
    .locator(".message.user")
    .filter({ hasText: "Changed question" });
  assert.equal(
    await editedRow.locator(".version-nav-count").textContent(),
    "2 / 2",
  );
  await editedRow.getByRole("button", { name: "Previous version" }).click();
  await page.getByText("Later answer", { exact: true }).waitFor();
  await originalRow.locator(".message-content").hover();
  await originalRow.locator(".message-edit-btn").hover();
  const deletion = originalRow.locator(".message-delete-btn");
  await deletion.hover();
  assert.equal(
    await originalRow
      .locator(".message-user-actions")
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  await deletion.click();
  assert.equal(await page.locator("#delete-message-dialog").isVisible(), true);
  await page.locator("#delete-message-cancel").click();
  await originalRow.locator(".message-content").hover();
  await originalRow.locator(".message-edit-btn").click();
  assert.equal(
    await page.locator(".message.user.is-editing .version-nav").isVisible(),
    false,
  );
  await editor.fill("Saved with button");
  await page
    .locator(".message.user.is-editing")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.waitForFunction(() => window.requests === 2);
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  assert.equal(
    await page
      .locator(".message.user")
      .filter({ hasText: "Saved with button" })
      .locator(".version-nav-count")
      .textContent(),
    "3 / 3",
  );
  const savedRow = page
    .locator(".message.user")
    .filter({ hasText: "Saved with button" });
  await savedRow.locator(".message-content").hover();
  await savedRow.locator(".message-delete-btn").click();
  await page.locator(".delete-message-confirm").click();
  await editedRow.waitFor();
  assert.equal(
    await editedRow.locator(".version-nav-count").textContent(),
    "2 / 2",
  );
  await editedRow.getByRole("button", { name: "Previous version" }).click();
  await page.getByText("Later answer", { exact: true }).waitFor();
  console.log(
    JSON.stringify({
      engine,
      inlineEditing: "passed",
      versions: "passed",
      cancel: "passed",
      save: "passed",
      userActionHover: "passed",
    }),
  );
} finally {
  await browser.close();
}
