// Browser animation takeover and landing correctness. Synthetic touch events
// do not reproduce an iPhone's native momentum or physical presentation.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/demos/scroll-settle/`);
    await page.locator("#auto-load").uncheck();
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      const accessor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      const scrollTo = viewport.scrollTo.bind(viewport);
      window.commandProbe = { writes: 0, requests: [], start: 0 };
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => accessor.get.call(viewport),
        set: (value) => {
          window.commandProbe.writes++;
          accessor.set.call(viewport, value);
        },
      });
      viewport.scrollTo = (options) => {
        window.commandProbe.requests.push(options);
        scrollTo(options);
      };
    });
    for (const boundary of ["top", "bottom"]) {
      await page.evaluate((boundary) => {
        const viewport = document.querySelector("#viewport");
        Element.prototype.scrollTo.call(viewport, {
          top: (viewport.scrollHeight - viewport.clientHeight) / 2,
          behavior: "instant",
        });
        window.commandProbe.start = viewport.scrollTop;
        // An existing browser animation moving away from the requested edge.
        Element.prototype.scrollTo.call(viewport, {
          top: boundary === "top" ? viewport.scrollHeight : 0,
          behavior: "smooth",
        });
      }, boundary);
      await page.waitForFunction(
        () =>
          Math.abs(
            document.querySelector("#viewport").scrollTop -
              window.commandProbe.start,
          ) > 30,
      );
      await page.evaluate((boundary) => {
        window.commandProbe.writes = 0;
        window.commandProbe.requests = [];
        document.querySelector(`#glide-${boundary}`).click();
      }, boundary);
      await page.waitForFunction((boundary) => {
        const viewport = document.querySelector("#viewport");
        const target =
          boundary === "top"
            ? 0
            : viewport.scrollHeight - viewport.clientHeight;
        return Math.abs(viewport.scrollTop - target) <= 1;
      }, boundary);
      await page.waitForTimeout(450);
      const probe = await page.evaluate(() => window.commandProbe);
      assert.equal(
        probe.writes,
        0,
        `${engine.name()}: ${boundary} must not fight native motion with frame writes`,
      );
      assert.equal(
        probe.requests.filter((request) => request.behavior === "smooth")
          .length,
        1,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: both lab commands replace native animation and land`,
    );
  } finally {
    await browser.close();
  }
}
