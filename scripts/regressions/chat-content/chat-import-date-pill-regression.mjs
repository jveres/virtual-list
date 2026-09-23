// The first painted import frame must use the replacement list's geometry.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  importTranscript,
  openStreamingDemo,
  transcriptMarkdown,
} from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    // Freeze calendar time only; real animation frames still expose a flash.
    await page.clock.setFixedTime(new Date("2026-09-16T12:00:00Z"));
    const errors = await openStreamingDemo(page, base, { acceptDialogs: true });
    const dates = await page.evaluate(() => {
      const today = new Date();
      today.setHours(12, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return [yesterday.getTime(), today.getTime()];
    });
    const transcript = (earlierWords, latestWords, marker) =>
      transcriptMarkdown(
        [
          "Yesterday prompt",
          "Earlier text. ".repeat(earlierWords),
          "Today prompt",
          `${marker} ${"Latest text. ".repeat(latestWords)}`,
        ].map((text, index) => ({
          role: index % 2 ? "assistant" : "user",
          sentAt: dates[index < 2 ? 0 : 1],
          text,
        })),
      );
    const importChat = (source) =>
      importTranscript(page, source, { name: "date-pill.md" });

    for (const [earlierWords, latestWords] of [
      [1200, 100],
      [600, 200],
      [2000, 400],
    ]) {
      await importChat(transcript(earlierWords, 100, "Old ending"));
      await page.getByText("Old ending", { exact: false }).waitFor();
      // Establish a settled previous list, then reuse its day keys with
      // different geometry. Do not resize or scroll to repair the new header.
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const viewport = document.getElementById("viewport");
        const state = {
          samples: [],
          frames: 0,
          observer: null,
          frame: 0,
        };
        window.importDatePillProbe = state;
        const sample = (phase) => {
          if (!viewport.textContent.includes("New ending")) return;
          const overlay = document.querySelector(".vl-sticky-header");
          state.samples.push({
            phase,
            label: overlay.querySelector(".sticky-group .section-header-pill")
              ?.textContent,
            visible: getComputedStyle(overlay).display !== "none",
          });
          if (phase === "frame") state.frames++;
        };
        state.observer = new MutationObserver(() => sample("mutation"));
        state.observer.observe(viewport.parentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        const tick = () => {
          sample("frame");
          state.frame = requestAnimationFrame(tick);
        };
        state.frame = requestAnimationFrame(tick);
      });
      let samples;
      try {
        await importChat(transcript(100, latestWords, "New ending"));
        await page.waitForFunction(
          () => window.importDatePillProbe.frames >= 12,
        );
      } finally {
        samples = await page.evaluate(() => {
          const state = window.importDatePillProbe;
          state.observer.disconnect();
          cancelAnimationFrame(state.frame);
          delete window.importDatePillProbe;
          return state.samples;
        });
      }
      assert.ok(samples.some((sample) => sample.phase === "mutation"));
      assert.ok(
        samples.filter((sample) => sample.phase === "frame").length >= 12,
      );
      assert.deepEqual(
        samples.filter((sample) => sample.label !== "Today" || !sample.visible),
        [],
        `stale date after import: ${JSON.stringify({ earlierWords, latestWords, samples })}`,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: imported date is correct before paint and across 12 frames (3 replacements)`,
    );
  } finally {
    await browser.close();
  }
}
