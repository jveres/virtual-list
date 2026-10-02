// Fixture correctness and geometry, not performance or physical presentation.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const engines = { firefox, chromium, webkit };
const selected = process.env.RENDERING_BROWSER;
assert.ok(
  !selected || engines[selected],
  "Unknown rendering regression browser",
);
for (const engine of selected ? [engines[selected]] : Object.values(engines)) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/rendering-workload.html`,
    );
    await page.waitForFunction(() => !!globalThis.__renderingWorkload);
    for (const mode of [
      "ordinary",
      "blocks",
      "code",
      "table",
      "uniform",
      "mixed",
      "spike",
    ]) {
      for (const variant of [process.env.RENDERING_VARIANT ?? "plain"]) {
        await page.evaluate(
          ([mode, variant]) => __renderingWorkload.prepare(mode, variant),
          [mode, variant],
        );
        await page.evaluate(() => __renderingWorkload.exercise(4));
        const state = await page.evaluate(() => __renderingWorkload.snapshot());
        assert.deepEqual(state.errors, []);
        assert.equal(state.completed, true);
        assert.ok(
          state.distance > 10000 && state.scrolls > 2 && state.ends > 0,
        );
        assert.equal(state.renders - state.destroyed, state.activeItems);
        if (variant === "skip")
          assert.ok(
            state.result.autoEvents > 0,
            "Skipping was never activated",
          );
        await page.evaluate(() => __renderingWorkload.release());
        const released = await page.evaluate(() =>
          __renderingWorkload.snapshot(),
        );
        assert.equal(released.renders, released.destroyed);
        assert.equal(released.activeItems, 0);
        console.log(
          `${engine.name()}: ${mode}/${variant} geometry, content, movement and cleanup passed`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
