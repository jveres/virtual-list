// Fixture validity and geometry/list behavior across engines; timings are not evidence.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/data-structures.html`,
    );
    await page.waitForFunction(() => !!globalThis.__dataStructures);
    for (const diagnostic of [false, true]) {
      for (const mode of [
        "geometry",
        "geometry-sparse",
        "positioned",
        "list",
        "positioned-list",
        ...(diagnostic ? ["positioned-overlap"] : []),
      ]) {
        await page.evaluate(
          ({ mode, diagnostic }) =>
            __dataStructures.prepare(mode, 1000, diagnostic),
          { mode, diagnostic },
        );
        await page.evaluate(() => __dataStructures.exercise());
        const state = await page.evaluate(() => __dataStructures.snapshot());
        assert.deepEqual(state.errors, []);
        assert.equal(
          state.results.length,
          mode.startsWith("geometry")
            ? diagnostic
              ? 4
              : 3
            : mode.includes("list")
              ? 4
              : diagnostic
                ? 3
                : 2,
        );
        if (mode.includes("list")) {
          assert.equal(state.activeItems, 1000);
          assert.ok(state.distance > 10000 && state.ends > 0);
        } else assert.ok(state.checksum > 0);
        if (diagnostic && !mode.includes("list"))
          assert.ok(
            (await page.evaluate(() =>
              __dataStructures.materializeBuffers(),
            )) >= 16000,
          );
        await page.evaluate(() => __dataStructures.release());
        const released = await page.evaluate(() => __dataStructures.snapshot());
        assert.equal(released.activeItems, 0);
        assert.equal(released.mountedRows, 0);
      }
    }
    console.log(`${engine.name()}: data structure fixture checks passed`);
  } finally {
    await browser.close();
  }
}
