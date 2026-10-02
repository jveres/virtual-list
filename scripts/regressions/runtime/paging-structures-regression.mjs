// Correctness coverage only; installed Firefox supplies performance evidence.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const engines = { firefox, chromium, webkit };
const selected = process.env.PAGING_BROWSER;
assert.ok(!selected || engines[selected], "Unknown paging regression browser");
const workload = process.env.PAGING_WORKLOAD;
assert.ok(
  !workload || workload === "measured",
  "Unknown paging regression workload",
);
for (const engine of selected ? [engines[selected]] : Object.values(engines)) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/paging-structures.html`,
    );
    await page.waitForFunction(() => !!globalThis.__pagingStructures);
    for (const [mode, budget] of [
      ["stacked", 480],
      ["positioned", 2000],
      ["stacked", 10000],
      ["measured", 480],
      ["measured", 2000],
    ].filter(([mode]) => !workload || mode === workload)) {
      await page.evaluate(
        ({ mode, budget }) => __pagingStructures.prepare(mode, budget),
        { mode, budget },
      );
      for (let index = 0; index < 12; index++)
        await page.evaluate(() => __pagingStructures.cycle(12));
      const result = await page.evaluate(() => __pagingStructures.snapshot());
      assert.deepEqual(result.errors, []);
      assert.equal(result.cycles, 12);
      assert.equal(result.cancelled, 3);
      assert.equal(result.completedReaches, 3);
      if (mode === "measured") {
        assert.equal(result.streamUpdates, 72);
        assert.equal(result.widthChanges, 3);
        assert.equal(result.calls.height, 0);
        assert.ok(result.imageLoads > 12);
        assert.ok(result.frameGaps.count > 12);
      }
      assert.ok(result.evicted >= budget);
      assert.ok(result.activeItems <= budget && result.activeItems > 0);
      assert.ok(
        result.distance > 10000 && result.scrolls > 12 && result.ends > 0,
      );
      await page.evaluate(() => __pagingStructures.release());
      const released = await page.evaluate(() => __pagingStructures.snapshot());
      assert.equal(released.activeItems, 0);
      assert.equal(released.mountedRows, 0);
      assert.equal(released.calls.render, released.calls.destroy);
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: paging overlap, cancellation, measured streaming, images, widths and eviction passed`,
    );
  } finally {
    await browser.close();
  }
}
