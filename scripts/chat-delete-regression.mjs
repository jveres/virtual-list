// Offline deletion regression; API requests never leave the browser.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const fixture = (count) =>
  Array.from(
    { length: count },
    (_, i) => `**${i % 2 === 0 ? "User" : "Assistant"}**\n\nTurn ${i}\n`,
  ).join("\n");

async function open(page) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("https://api.openai.com/**", (route) => route.abort());
  await page.goto(`${base}/demos/streaming/`);
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
}

async function importTurns(page, count) {
  await page.locator("#import-file").setInputFiles({
    name: "delete-fixture.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(fixture(count)),
  });
  await page.getByText(`Turn ${count - 1}`, { exact: true }).waitFor();
}

async function exported(page) {
  const download = page.waitForEvent("download");
  await page.locator("#download-btn").click();
  const stream = await (await download).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function confirmDelete(page, text) {
  const row = page.locator(".message.user").filter({ hasText: text });
  await row.locator(".message-content").hover();
  await row.locator(".message-delete-btn").click();
  await page.locator(".delete-message-confirm").click();
  await page.waitForFunction(
    () => document.getElementById("deletion-status").textContent !== "",
  );
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await importTurns(page, 6);
  const row = page.locator(".message.user").filter({ hasText: "Turn 2" });
  const button = row.locator(".message-delete-btn");
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el.parentElement).opacity),
    "0",
  );
  const before = await row.boundingBox();
  await row.hover({ position: { x: 1, y: 1 } });
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el.parentElement).opacity),
    "0",
    "empty row space must not reveal the delete icon",
  );
  await row.locator(".message-content").hover();
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el.parentElement).opacity),
    "1",
  );
  assert.ok(
    Math.abs((await row.boundingBox()).height - before.height) < 0.1,
    "hover must not change row height",
  );
  await button.hover();
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
    "delete icon must have no hover background",
  );
  const centered = await button.evaluate((el) => {
    const icon = el.getBoundingClientRect();
    const bubble = el
      .closest(".message")
      .querySelector(".message-content")
      .getBoundingClientRect();
    return Math.abs(icon.y + icon.height / 2 - bubble.y - bubble.height / 2);
  });
  assert.ok(centered < 1, "icon must be vertically centered beside the bubble");
  assert.equal(
    await page.locator(".message.assistant .message-delete-btn").count(),
    0,
  );
  await page.mouse.move(0, 0);
  await button.focus();
  assert.equal(
    await button.evaluate((el) => getComputedStyle(el.parentElement).opacity),
    "1",
  );
  await page.keyboard.press("Enter");
  assert.doesNotMatch(
    await page.locator("#delete-message-dialog").textContent(),
    /Turn 2/,
  );
  assert.equal(
    await page
      .locator("#delete-message-cancel")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.match(await exported(page), /Turn 5/);
  await confirmDelete(page, "Turn 2");
  const prefix = await exported(page);
  assert.match(prefix, /Turn 0/);
  assert.match(prefix, /Turn 1/);
  assert.doesNotMatch(prefix, /Turn [2-5]/);
  await confirmDelete(page, "Turn 0");
  await page.waitForFunction(
    () => document.querySelectorAll(".message").length === 0,
  );
  await importTurns(page, 60);
  await confirmDelete(page, "Turn 56");
  const longPrefix = await exported(page);
  for (let i = 0; i < 56; i++)
    assert.match(longPrefix, new RegExp(`Turn ${i}\\b`));
  assert.doesNotMatch(longPrefix, /Turn 5[6-9]/);
  assert.deepEqual(errors, []);
  await page.close();

  const streaming = await browser.newPage();
  await streaming.addInitScript(() => {
    localStorage.setItem(
      "virtual-list:ai-settings",
      JSON.stringify({
        provider: "openai",
        apiKey: "offline-test",
        model: "gpt-5-mini",
      }),
    );
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (!String(input).startsWith("https://api.openai.com/"))
        return originalFetch(input, init);
      return new Promise((_resolve, reject) => {
        const finish = () =>
          reject(new DOMException("Cancelled", "AbortError"));
        if (!window.finishOldRequest) window.finishOldRequest = finish;
        else window.finishNewRequest = finish;
      });
    };
  });
  await open(streaming);
  await importTurns(streaming, 6);
  await streaming.locator("#prompt").fill("Old request");
  await streaming.locator("#send-btn").click();
  await streaming.waitForFunction(
    () => typeof window.finishOldRequest === "function",
  );
  assert.equal(
    await streaming.locator(".message-delete-btn:visible").count(),
    0,
  );
  await streaming.locator("#send-btn").click();
  await streaming.evaluate(() => window.finishOldRequest());
  await streaming.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  await confirmDelete(streaming, "Old request");
  await streaming.locator("#prompt").fill("New request");
  await streaming.locator("#send-btn").click();
  await streaming.waitForFunction(
    () => typeof window.finishNewRequest === "function",
  );
  await streaming.evaluate(() => window.finishOldRequest());
  await streaming.waitForTimeout(100);
  assert.equal(await streaming.locator("#send-btn").textContent(), "Stop");
  assert.doesNotMatch(await exported(streaming), /Old request/);
  await streaming.locator("#send-btn").click();
  await streaming.evaluate(() => window.finishNewRequest());
  await streaming.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  await confirmDelete(streaming, "New request");
  await confirmDelete(streaming, "Turn 2");
  const saved = await streaming.evaluate(async () => {
    const api = await import("/demos/streaming/openai.ts");
    return (await api.loadOpenAIHistory()).map((turn) => turn.markdown);
  });
  assert.deepEqual(saved, ["Turn 0", "Turn 1"]);
  await streaming.reload();
  await streaming.getByText("Turn 1", { exact: true }).waitFor();
  assert.doesNotMatch(
    await exported(streaming),
    /Turn [2-5]|Old request|New request/,
  );
  await streaming.close();

  const touch = await browser.newPage({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  await open(touch);
  await importTurns(touch, 6);
  const touched = touch.locator(".message.user").filter({ hasText: "Turn 2" });
  await touched.locator(".message-content").tap();
  assert.equal(await touched.getAttribute("data-actions-visible"), "");
  await touched.locator(".message-delete-btn").tap();
  assert.equal(await touch.locator("#delete-message-dialog").isVisible(), true);
  await touch.screenshot({
    path: `browser-artifacts/delete-message-${engine}-mobile.png`,
  });
  await touch.locator("#delete-message-cancel").tap();
  await touch.close();
  console.log(
    JSON.stringify({
      engine,
      deletion: "passed",
      hover: "passed",
      persistence: "passed",
      streaming: "passed",
      touch: "passed",
    }),
  );
} finally {
  await browser.close();
}
