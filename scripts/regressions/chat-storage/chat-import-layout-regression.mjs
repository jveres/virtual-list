// BROWSER_MATRIX_URL=http://localhost:5173 node scripts/regressions/chat-storage/chat-import-layout-regression.mjs
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import {
  importTranscript,
  openStreamingDemo,
  transcriptMarkdown,
} from "../shared/transcript.mjs";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 820 },
  });
  const errors = await openStreamingDemo(
    page,
    process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173",
    { path: "/demos/streaming/index.html", acceptDialogs: true },
  );
  await page.waitForSelector(".message");

  async function importTurns(count, dates = [1788508800000]) {
    const transcript = transcriptMarkdown(
      Array.from({ length: count }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        sentAt: dates[Math.floor(i / 2) % dates.length],
        text: `Imported turn ${i}. ${"Text content. ".repeat(20)}`,
      })),
    );
    await importTranscript(page, transcript, { name: "layout.md" });
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
  // A date can occur in multiple separate runs (imports or refreshed replies).
  const repeatedDay = await importTurns(
    6,
    [1788508800000, 1788595200000, 1788508800000],
  );
  assert.equal(repeatedDay.loaders, 0);
  await page.getByText("Imported turn 0.", { exact: false }).waitFor();
  await importTurns(6, [1e100]);
  await page.getByText("Imported turn 0.", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, result: "passed" }));
} finally {
  await browser.close();
}
