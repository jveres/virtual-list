// Run against Vite with BROWSER_MATRIX_URL (default: http://127.0.0.1:4193).
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://picsum.photos/**", (route) => route.abort());
    await page.goto(new URL("/demos/gallery/", baseUrl).href);
    await page.locator("#status").filter({ hasText: "120" }).waitFor();
    for (const width of [1345, 845, 1600, 1100, 760, 600, 375]) {
      await page.setViewportSize({ width, height: 800 });
      const measurements = await page.evaluate(() => {
        const header = document.querySelector("header");
        const viewport = document.querySelector("#viewport");
        const status = document.querySelector("#status");
        const metrics = document.querySelector("#loader-metrics");
        const result = [];
        const previous = [status.textContent, metrics.textContent];
        for (const count of [0, 9, 99, 120, 999, 1320, 1440, 3000, 999999]) {
          status.textContent = `${count.toLocaleString()} of 3,000 photos · 480 retained · 480 cards · 6 columns`;
          metrics.textContent = `queue ${count} (peak ${count}) · loading 6/6 · loaded ${count} · reused ${count} · cancelled ${count} · failed ${count}`;
          result.push({
            count,
            headerHeight: header.getBoundingClientRect().height,
            viewportTop: viewport.getBoundingClientRect().top,
            viewportHeight: viewport.clientHeight,
          });
        }
        [status.textContent, metrics.textContent] = previous;
        return result;
      });
      const initial = measurements[0];
      for (const actual of measurements) {
        assert.equal(
          actual.headerHeight,
          initial.headerHeight,
          `${engine.name()} at ${width}px: header changed with count ${actual.count}`,
        );
        assert.equal(
          actual.viewportTop,
          initial.viewportTop,
          "gallery moved on screen",
        );
        assert.equal(
          actual.viewportHeight,
          initial.viewportHeight,
          "gallery viewport resized",
        );
      }
    }
    console.log(
      `${engine.name()}: changing counters preserves header height and gallery position at all tested widths`,
    );
  } finally {
    await browser.close();
  }
}
