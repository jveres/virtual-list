// Offline regeneration checks; no API requests leave the browser.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  const simulated = await browser.newPage({
    viewport: { width: 1420, height: 950 },
  });
  await simulated.goto(`${base}/demos/streaming/`);
  await simulated.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  const inset = await simulated
    .locator(".section-header")
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  await simulated.evaluate(() => {
    const viewport = document.querySelector("#viewport");
    const prompt = [...viewport.querySelectorAll(".message.user")].at(-1);
    const top = () =>
      prompt.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    window.refreshPromptPositions = [top()];
    window.sampleRefreshPrompt = true;
    const sample = () => {
      window.refreshPromptPositions.push(top());
      if (window.sampleRefreshPrompt) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    [...viewport.querySelectorAll(".message-refresh-btn")].at(-1).click();
    window.refreshPromptPositions.push(top());
  });
  await simulated.waitForTimeout(450);
  const positions = await simulated.evaluate(() => {
    window.sampleRefreshPrompt = false;
    return window.refreshPromptPositions;
  });
  assert.ok(
    Math.abs(positions[0] - inset) < 1,
    "fixture starts with the prompt pinned below the date pill",
  );
  assert.ok(
    positions.every((top) => Math.abs(top - positions[0]) < 1),
    `refresh must keep an already-pinned prompt stationary: ${JSON.stringify(positions)}`,
  );
  await simulated.close();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem(
      "virtual-list:ai-settings",
      JSON.stringify({
        provider: "openai",
        apiKey: "offline-test",
        model: "gpt-5-mini",
      }),
    );
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (!String(input).startsWith("https://api.openai.com/"))
        return original(input, init);
      window.requests = (window.requests ?? 0) + 1;
      window.requestBody = JSON.parse(init.body);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      });
    };
  });
  await page.goto(`${base}/demos/streaming/`);
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  assert.equal(await page.locator(".message-refresh-btn").count(), 0);
  await page.locator("#import-file").setInputFiles({
    name: "refresh.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "**User**\n\nFirst question\n\n**Assistant**\n\nFirst answer\n\n**User**\n\nLast question\n\n**Assistant**\n\nOriginal answer\n",
    ),
  });
  await page.getByText("Original answer", { exact: true }).waitFor();
  const refresh = page.locator(
    ".message-actions[data-latest] .message-refresh-btn",
  );
  const earlier = page
    .locator(".message.assistant")
    .filter({ hasText: "First answer" });
  await page.mouse.move(0, 0);
  assert.equal(
    await earlier
      .locator(".message-actions")
      .evaluate((el) => getComputedStyle(el).opacity),
    "0",
  );
  await earlier.locator(".message-content").hover();
  assert.equal(
    await earlier
      .locator(".message-actions")
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  assert.equal(await refresh.count(), 1);
  const placement = await refresh.evaluate((button) => {
    const content = button
      .closest(".message")
      .querySelector(".message-content")
      .getBoundingClientRect();
    const icon = button.getBoundingClientRect();
    const markdown = button.closest(".message").querySelector(".markdown");
    const reserved = Number.parseFloat(
      getComputedStyle(markdown).paddingBottom,
    );
    return {
      reserved,
      gap: Math.round(icon.top - content.bottom),
      left: Math.round(icon.left - content.left),
    };
  });
  // The actions keep the shared footer's 16px gap (chat-footer-regression).
  assert.deepEqual(
    placement,
    { reserved: 0, gap: 16, left: 0 },
    "refresh is left aligned below the reply, with no extra cursor padding",
  );
  await refresh.hover();
  assert.equal(
    await refresh.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
    "rgba(0, 0, 0, 0)",
  );
  await page.locator("#prompt").fill("Keep my draft");
  await refresh.click();
  await page.waitForFunction(() => window.requests === 1);
  const today = page
    .locator("#viewport .section-header-pill")
    .filter({ hasText: /^Today$/ });
  const refreshedPrompt = page
    .locator(".message.user")
    .filter({ hasText: "Last question" });
  assert.ok(
    (await today.boundingBox()).y < (await refreshedPrompt.boundingBox()).y,
    "refresh must place Today above the prompt, not between prompt and reply",
  );
  assert.equal(await refresh.count(), 1);
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await refresh.isVisible(), false);
  assert.equal(await page.locator(".message-delete-btn:visible").count(), 0);
  assert.equal(
    await page.locator(".message-actions .message-copy-btn:visible").count(),
    0,
  );
  assert.equal(await page.locator("#prompt").inputValue(), "Keep my draft");
  const request = await page.evaluate(() => JSON.stringify(window.requestBody));
  assert.doesNotMatch(request, /Original answer|Keep my draft/);
  assert.equal((request.match(/Last question/g) ?? []).length, 1);
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  assert.equal(await refresh.isEnabled(), true);
  const lastRow = page.locator(".message.assistant").filter({ has: refresh });
  assert.equal(
    await lastRow.locator(".message-copy-btn").isDisabled(),
    true,
    "an empty cancelled reply has no text to copy",
  );
  const centers = await lastRow
    .locator(".message-actions button, .version-nav-count")
    .evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.y + rect.height / 2;
      }),
    );
  assert.ok(
    Math.max(...centers) - Math.min(...centers) < 1,
    "all actions share one vertical center",
  );
  await lastRow.getByRole("button", { name: "Previous version" }).click();
  await page.getByText("Original answer", { exact: true }).waitFor();
  assert.equal(
    await today.count(),
    0,
    "old response version restores its original date grouping",
  );
  assert.equal(await refresh.count(), 1);
  await lastRow.getByRole("button", { name: "Next version" }).click();
  assert.equal(
    await page.locator(".message-version-delete-btn").count(),
    0,
    "assistant actions contain refresh and copy, not deletion",
  );
  await lastRow.getByRole("button", { name: "Previous version" }).click();
  await page.getByText("Original answer", { exact: true }).waitFor();
  assert.equal(await lastRow.locator(".message-copy-btn").isEnabled(), true);
  await page.locator("#send-btn").click();
  await page.waitForFunction(() => window.requests === 2);
  assert.equal(
    await refresh.count(),
    1,
    "sending must remove the old answer's refresh control",
  );
  assert.equal(
    await page
      .locator(".message.assistant")
      .filter({ hasText: "Original answer" })
      .locator(".message-refresh-btn")
      .count(),
    1,
    "earlier replies retain a hover-only refresh control",
  );
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  await earlier.locator(".message-content").hover();
  await earlier.locator(".message-refresh-btn").click();
  await page.waitForFunction(() => window.requests === 3);
  assert.doesNotMatch(
    await page.evaluate(() => JSON.stringify(window.requestBody)),
    /Last question|Keep my draft|First answer/,
  );
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  const regeneratedEarlier = page
    .locator(".message.assistant")
    .filter({ has: refresh });
  await regeneratedEarlier
    .getByRole("button", { name: "Previous version" })
    .click();
  await page.getByText("Original answer", { exact: true }).waitFor();
  await page.getByText("Keep my draft", { exact: true }).waitFor();
  await page.screenshot({ path: `browser-artifacts/refresh-${engine}.png` });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      regeneration: "passed",
      versions: "passed",
      draft: "passed",
      placement: "passed",
    }),
  );
} finally {
  await browser.close();
}
