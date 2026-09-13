// Correctness only: synthetic scrolling here is not native performance evidence.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const transcript = Array.from(
      { length: 160 },
      (_, index) =>
        `**${index % 2 ? "Assistant" : "User"}**\n\nHistory turn ${index + 1}. ${"Synthetic paging content. ".repeat(20)}\n`,
    ).join("\n");
    await page.locator("#import-file").setInputFiles({
      name: "paged-history.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(transcript),
    });
    await page.locator('#viewport [data-key="160"]').waitFor();
    const readRange = () =>
      page.locator("#window-status").evaluate((node) => {
        const match = /loaded ([\d,]+)-([\d,]+)\/([\d,]+)/.exec(
          node.textContent,
        );
        return match
          ?.slice(1)
          .map((value) => Number(value.replaceAll(",", "")));
      });
    for (let step = 0; step < 9; step++) {
      await page.locator("#viewport").evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scrollend"));
      });
      await page.waitForTimeout(800);
    }
    const [first, last, total] = await readRange();
    assert.equal(total, 160);
    assert.equal(first, 1);
    assert.ok(last < 159, "latest prompt page must be evictable");
    assert.ok(
      last - first + 1 <= 72,
      `retained ${last - first + 1} source messages`,
    );
    await page.locator("#scroll-bottom-btn").click();
    await page.locator('#viewport [data-key="160"]').waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector("#viewport");
      return (
        Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1
      );
    });
    const restored = await readRange();
    assert.equal(restored[1], 160);
    assert.ok(restored[1] - restored[0] + 1 <= 72);
    assert.match(
      await page.locator('#viewport [data-key="160"]').innerText(),
      /History turn 160/,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: bounded full-demo history, offscreen pin eviction, and explicit tail restoration passed`,
    );
  } finally {
    await browser.close();
  }
}
