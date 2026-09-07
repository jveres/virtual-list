// BROWSER_MATRIX_URL=http://localhost:5173 node scripts/chat-import-layout-regression.mjs
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 820 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(
    `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/index.html`,
  );
  await page.waitForSelector(".message");

  async function importTurns(count) {
    const lines = ["# streaming-chat transcript", ""];
    for (let i = 0; i < count; i++) {
      lines.push(
        i % 2 ? "**Assistant**" : "**User**",
        '<!-- turn {"sentAt":1788508800000} -->',
        "",
        `Imported turn ${i}. ${"Text content. ".repeat(20)}`,
        "",
      );
    }
    await page.locator("#import-file").setInputFiles({
      name: "layout.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(lines.join("\n")),
    });
    await page.waitForFunction(
      (total) =>
        document
          .getElementById("window-status")
          ?.textContent.includes(`/${total}`),
      count,
    );
    await page.evaluate(() => {
      document.getElementById("viewport").scrollTop = 0;
    });
    // Let import repaint and any unwanted reach-start load settle.
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const viewport = document.getElementById("viewport");
      const header = viewport.querySelector(".section-header");
      return {
        gap: header
          ? header.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top
          : null,
        loaders: viewport.querySelectorAll(".boundary-slot").length,
      };
    });
  }

  const short = await importTurns(2);
  console.log(JSON.stringify({ engine, short }));
  assert.equal(
    short.loaders,
    0,
    "short imports must not inherit the previous conversation's scrollback slot",
  );
  assert.ok(
    Math.abs(short.gap) <= 1,
    `unexpected gap before date header: ${short.gap}px`,
  );
  await importTurns(100);
  const shortAgain = await importTurns(4);
  assert.equal(shortAgain.loaders, 0);
  assert.ok(Math.abs(shortAgain.gap) <= 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, result: "passed" }));
} finally {
  await browser.close();
}
