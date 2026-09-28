import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  importTranscript,
  openStreamingDemo,
  transcriptMarkdown,
} from "../shared/transcript.mjs";

// A window moved to a display with another scale changes devicePixelRatio
// without changing any layout size, so neither resize observer reports it.
// Committed heights must still move onto the new device-pixel grid (I0).
// Chromium only: the CDP scale override is the one live ratio change a
// headless browser offers. It applies the ratio without firing the media
// query's change event, so the test delivers that event itself.
const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const turns = Array.from({ length: 80 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  text: `Message ${index}. ${"word ".repeat(7 + ((index * 37) % 90))}`,
}));

function offGrid(page) {
  return page.evaluate(() => {
    const ratio = devicePixelRatio;
    return [...document.querySelectorAll("#viewport .message")]
      .map((row) => Number.parseFloat(row.parentElement.style.height))
      .filter((height) => {
        const device = height * ratio;
        return Math.abs(device - Math.round(device)) > 0.01;
      });
  });
}

const browser = await chromium.launch();
try {
  // Each move crosses a fractional ratio in some direction.
  for (const [from, to] of [
    [2, 1.5],
    [1.5, 1],
    [1.5, 2],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: from,
    });
    await page.addInitScript(() => {
      const native = window.matchMedia.bind(window);
      window.__resolutionQueries = [];
      window.matchMedia = (query) => {
        const list = native(query);
        if (query.includes("resolution")) window.__resolutionQueries.push(list);
        return list;
      };
    });
    const errors = await openStreamingDemo(page, base);
    await importTranscript(page, transcriptMarkdown(turns));
    await page.waitForFunction(
      () => document.querySelectorAll("#viewport .message").length > 2,
    );
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.scrollTop = viewport.scrollHeight / 2;
    });
    await page.waitForTimeout(400);
    assert.deepEqual(await offGrid(page), [], `on the ${from}x grid`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1200,
      height: 800,
      deviceScaleFactor: to,
      mobile: false,
    });
    await page.waitForFunction((ratio) => devicePixelRatio === ratio, to);
    await page.evaluate(() => {
      for (const list of window.__resolutionQueries.splice(0))
        if (!list.matches) list.dispatchEvent(new Event("change"));
    });
    await page.waitForTimeout(400);
    assert.deepEqual(
      await offGrid(page),
      [],
      `heights re-quantized after ${from}x -> ${to}x`,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("pixel-ratio grid regression passed");
