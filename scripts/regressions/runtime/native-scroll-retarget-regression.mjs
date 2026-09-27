// A changed target can arrive before the browser's original destination.
// An early scrollend must stop that outstanding animation before releasing it.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const mode of ["retarget", "cancel"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/__native-scroll-audit", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<div id="viewport" style="height:400px;overflow:auto"><div style="height:12000px"></div></div>',
        }),
      );
      await page.goto(`${base}/__native-scroll-audit`);
      const result = await page.evaluate(async (mode) => {
        const { startNativeGlide } = await import("/src/native-glide.ts");
        const viewport = document.querySelector("#viewport");
        let target = 10000;
        const outcomes = [];
        const glide = startNativeGlide(
          viewport,
          () => target,
          (done) => outcomes.push(done),
        );
        try {
          const deadline = performance.now() + 3000;
          while (viewport.scrollTop < 10 && performance.now() < deadline)
            await new Promise(requestAnimationFrame);
          const arrived = viewport.scrollTop;
          if (arrived < 10 || arrived >= 9999)
            throw new Error(`No intermediate native movement: ${arrived}`);
          if (mode === "retarget") {
            target = arrived;
            viewport.dispatchEvent(new Event("scrollend"));
          } else glide.cancel();
          await new Promise((resolve) => setTimeout(resolve, 500));
          return {
            arrived,
            final: viewport.scrollTop,
            outcomes,
            active: glide.active,
          };
        } finally {
          glide.cancel();
        }
      }, mode);
      assert.deepEqual(result.outcomes, [mode === "retarget"], engine.name());
      assert.equal(result.active, false, engine.name());
      assert.ok(
        Math.abs(result.final - result.arrived) <= 1,
        `${engine.name()}: old animation escaped ownership: ${JSON.stringify(result)}`,
      );
      assert.deepEqual(errors, []);
      console.log(engine.name(), mode, "native stop passed");
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
