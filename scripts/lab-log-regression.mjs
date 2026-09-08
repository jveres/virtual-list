import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    for (const width of [1900, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/demos/scroll-settle/`);
      await page.waitForFunction(() =>
        document.querySelector("#s-strategy")?.textContent.includes("-wheel"),
      );
      const result = await page.evaluate(async () => {
        const { createTraceLog } = await import("/demos/shared/lab.ts");
        const log = document.querySelector("#log");
        log.replaceChildren();
        const trace = createTraceLog(log);
        for (let index = 0; index < 350; index++) {
          trace.log(
            index % 3 === 0
              ? "A long diagnostic entry ".repeat(8)
              : `short entry ${index}`,
          );
        }
        await new Promise(requestAnimationFrame);
        const measure = () => ({
          width: log.clientWidth,
          height: log.clientHeight,
          scrollHeight: log.scrollHeight,
        });
        const block = measure();
        const bottomError = log.scrollHeight - log.clientHeight - log.scrollTop;
        const display = getComputedStyle(log.firstElementChild).display;
        const text = log.textContent;
        const expected = `${trace.ring.join("\n")}\n`;
        const override = document.createElement("style");
        override.textContent = "#log > span { display: inline }";
        document.head.append(override);
        const inline = measure();
        override.remove();
        trace.clear();
        return { block, inline, bottomError, display, text, expected };
      });
      assert.deepEqual(
        result.block,
        result.inline,
        `geometry at width ${width}`,
      );
      assert.equal(result.display, "block");
      assert.equal(result.text, result.expected);
      assert.ok(
        Math.abs(result.bottomError) <= 1,
        "log follows the last entry",
      );
    }
    console.log(
      `${engine.name()}: log wrapping, geometry, trace text and follow passed`,
    );
  } finally {
    await browser.close();
  }
}
