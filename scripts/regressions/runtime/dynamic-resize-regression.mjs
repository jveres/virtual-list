import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeObserver = window.ResizeObserver;
      window.resizeSubscriptions = [];
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback) {
          super(callback);
          this.targets = new Set();
          window.resizeSubscriptions.push(this.targets);
        }
        observe(target, options) {
          super.observe(target, options);
          this.targets.add(target);
        }
        unobserve(target) {
          super.unobserve(target);
          this.targets.delete(target);
        }
        disconnect() {
          super.disconnect();
          this.targets.clear();
        }
      };
    });
    // The final probe deliberately violates the contract; keep that test
    // report out of the user's device-report log.
    await page.route("**/__lab/report", (route) =>
      route.fulfill({ status: 200, body: "ok" }),
    );
    await page.goto(`${base}/demos/dynamic-height/`);
    await page.waitForSelector("#viewport > div");
    await page.waitForTimeout(300);

    assert.equal(
      await page
        .locator("#viewport > div")
        .evaluate((canvas) => getComputedStyle(canvas).transformStyle),
      engine === webkit ? "preserve-3d" : "flat",
      `${engine.name()}: 3D preservation is scoped to WebKit`,
    );

    // A width change explicitly takes over the old scroll phase. These
    // events exercise the detector contract, not native momentum timing.
    const beforeWidth = await page
      .locator("#viewport")
      .evaluate((viewport) => viewport.clientWidth);
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      document.querySelector("#width").click();
    });
    await page.waitForFunction(
      (before) => document.querySelector("#viewport").clientWidth !== before,
      beforeWidth,
    );
    await page.waitForTimeout(300);
    const widthViolations = await page.evaluate(() =>
      window.labTrace.filter((line) => line.includes("VIOLATION")),
    );
    assert.deepEqual(widthViolations, [], `${engine.name()}: width takeover`);
    assert.deepEqual(
      await page.evaluate(() =>
        window.resizeSubscriptions.flatMap((targets) =>
          [...targets]
            .filter((target) => !target.isConnected)
            .map((target) => target.dataset.id ?? target.tagName),
        ),
      ),
      [],
      `${engine.name()}: observers must release detached rows`,
    );

    await page.click("#glide-bottom");
    await page.waitForTimeout(100);
    await page.locator("#width").evaluate((button) => button.click());
    await page.waitForTimeout(300);
    const glideViolations = await page.evaluate(() =>
      window.labTrace.filter((line) => line.includes("VIOLATION")),
    );
    assert.deepEqual(glideViolations, [], `${engine.name()}: resized glide`);
    assert.equal(
      await page.evaluate(() =>
        window.labTrace.some((line) => line.includes("glide end interrupted")),
      ),
      true,
      `${engine.name()}: the old glide must actually be cancelled`,
    );

    // The resize exception must not hide a subsequent, unrelated write
    // under fresh input. Assert the exact violation class still fires.
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      viewport.scrollTop = Math.max(0, viewport.scrollTop - 20);
    });
    const writes = await page.evaluate(() =>
      window.labTrace.filter((line) => line.includes("VIOLATION W:")),
    );
    assert.equal(
      writes.length,
      1,
      `${engine.name()}: fresh input must remain protected`,
    );
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `${engine.name()}: width takeover, glide cancellation, and fresh-input write detection passed`,
    );
  } finally {
    await browser.close();
  }
}
