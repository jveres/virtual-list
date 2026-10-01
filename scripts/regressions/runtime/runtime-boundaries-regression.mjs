// Fixture correctness only. Performance evidence comes from installed Firefox.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/runtime-boundaries.html`,
    );
    await page.waitForFunction(() => !!globalThis.__runtimeBoundaries);
    await page.evaluate(() => __runtimeBoundaries.run());
    const result = await page.evaluate(() => __runtimeBoundaries.snapshot());
    assert.equal(result.failure, null);
    assert.equal(result.completed, true);
    assert.equal(result.results.length, 12);
    for (const row of result.results) {
      if (row.name.startsWith("resize-")) {
        assert.equal(row.heldSeen, true);
        assert.ok(row.height > row.beforeHeight);
      } else {
        assert.equal(row.operations, 60);
        assert.equal(
          row.calls.render,
          row.name.startsWith("edge-slot-") ? 0 : 60,
        );
        if (row.name.startsWith("positioned-"))
          assert.equal(row.calls.position, row.count * row.operations);
        if (row.name.startsWith("pin-no-match-"))
          assert.equal(row.calls.pin, row.count * row.operations);
      }
    }
    assert.equal(await page.locator("#viewport > *").count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: runtime boundary fixture checks passed`);
  } finally {
    await browser.close();
  }
}
