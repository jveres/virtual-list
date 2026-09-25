// Paging geometry under synthetic touch/release events, not native iOS momentum.
import assert from "node:assert/strict";
import { webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const browser = await webkit.launch();
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 1366 },
  ]) {
    const page = await browser.newPage({
      viewport,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const errors = await openStreamingDemo(page, base);
    await page.evaluate(() => {
      window.firstLoaded = () =>
        Number(
          /loaded ([\d,]+)-/
            .exec(document.querySelector("#window-status").textContent)[1]
            .replaceAll(",", ""),
        );
    });
    const windows = [await page.evaluate(() => window.firstLoaded())];
    while (windows.at(-1) > 1 && windows.length < 5) {
      const before = windows.at(-1);
      await page.evaluate(() => {
        const viewport = document.querySelector("#viewport");
        viewport.dispatchEvent(new Event("touchstart"));
        viewport.scrollTop = 0;
      });
      // The fetch resolves while the touch is still held at the boundary.
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const viewport = document.querySelector("#viewport");
        const end = new Event("touchend");
        Object.defineProperty(end, "touches", { value: [] });
        viewport.dispatchEvent(end);
        viewport.dispatchEvent(new Event("scrollend"));
      });
      await page.waitForFunction(
        (before) => window.firstLoaded() < before,
        before,
      );
      await page.waitForTimeout(500);
      const anchor = await page.evaluate(
        () => document.querySelector("#viewport").scrollTop,
      );
      assert.ok(
        anchor > 1200,
        `prepend preserves the old reading position: ${anchor}`,
      );
      await page.evaluate(() => {
        document.querySelector("#viewport").scrollTop -= 400;
      });
      await page.waitForFunction(
        (anchor) =>
          document.querySelector("#viewport").scrollTop < anchor - 300,
        anchor,
      );
      const visible = await page.evaluate(() => {
        const viewport = document.querySelector("#viewport");
        const bounds = viewport.getBoundingClientRect();
        return [...viewport.querySelectorAll(".message[data-key]")]
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          })
          .map((row) => Number(row.dataset.key));
      });
      assert.ok(
        visible.some((key) => key < before),
        `newly loaded rows are reachable: ${JSON.stringify({ before, visible })}`,
      );
      windows.push(await page.evaluate(() => window.firstLoaded()));
    }
    assert.equal(windows.at(-1), 1, "default chat reaches its first page");
    assert.deepEqual(errors, []);
    console.log(
      `webkit ${viewport.width}x${viewport.height}: reachable pages ${windows.join(" -> ")}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
