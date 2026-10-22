import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 700, height: 650 },
    });
    const errors = [];
    const markdownLogs = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        /^(\[highlights\]|Morph:|Throttle:|Streaming complete:)/.test(
          message.text(),
        )
      ) {
        markdownLogs.push(message.text());
      }
    });
    await page.goto(`${base}/examples/streaming-markdown/`);
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Ready",
    );
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("A multiline prompt\n".repeat(12));
    assert.equal(await input.evaluate((node) => node.offsetHeight), 160);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal(await input.evaluate((node) => node.offsetHeight), 42);
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Done",
    );
    await page.waitForFunction(() => {
      const v = document.querySelector("#viewport");
      return Math.abs(v.scrollHeight - v.clientHeight - v.scrollTop) <= 1;
    });
    assert.match(
      await page.locator("article.assistant pre").innerText(),
      /const answer = 42/,
    );
    assert.ok(
      (await page
        .locator(
          'article.assistant pre code [style*="--color-prettylights-syntax-keyword"]',
        )
        .count()) > 0,
      "Code is highlighted by Highlights",
    );
    assert.equal(
      await page.locator("article.assistant table tbody tr").count(),
      2,
    );
    assert.equal(await page.locator("article.assistant li").count(), 30);
    assert.equal(await page.locator("article.assistant .cursor").count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(markdownLogs, [], "Markdown logging is off by default");
    console.log(
      `${engine.name()}: standalone Markdown rendering, finalization, and composer sizing passed`,
    );
  } finally {
    await browser.close();
  }
}
