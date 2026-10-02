// Staged DOM identity, cancellation and geometry; not a performance benchmark.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const engines = { firefox, chromium, webkit };
const selected = process.env.RENDERING_BROWSER;
assert.ok(
  !selected || engines[selected],
  "Unknown construction regression browser",
);
for (const engine of selected ? [engines[selected]] : Object.values(engines)) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/row-construction.html`,
    );
    await page.waitForFunction(() => !!globalThis.__renderingWorkload);
    for (const mode of [
      "construct-blocks",
      "construct-code",
      "construct-table",
    ]) {
      let baseline;
      for (const variant of ["plain", "nested"]) {
        await page.evaluate(
          ([mode, variant]) => __renderingWorkload.prepare(mode, variant),
          [mode, variant],
        );
        if (variant === "nested")
          for (const steps of [0, 1, 2])
            await page.evaluate(
              (steps) => __renderingWorkload.checkCancellation(steps),
              steps,
            );
        await page.evaluate(() => __renderingWorkload.exercise(4));
        const state = await page.evaluate(() => __renderingWorkload.snapshot());
        assert.deepEqual(state.errors, []);
        assert.equal(state.completed, true);
        assert.equal(state.renders - state.destroyed, state.activeItems);
        assert.ok(
          state.distance > 10000 && state.scrolls > 2 && state.ends > 0,
        );
        const content = {
          nodes: state.result.nodes,
          selectedCharacters: state.result.selectedCharacters,
        };
        if (variant === "plain") baseline = content;
        else
          assert.deepEqual(
            content,
            baseline,
            "Nested staging preserves the complete rendered result",
          );
        await page.evaluate(() => __renderingWorkload.release());
        const released = await page.evaluate(() =>
          __renderingWorkload.snapshot(),
        );
        assert.equal(released.renders, released.destroyed);
        assert.equal(released.activeItems, 0);
        console.log(
          `${engine.name()}: ${mode}/${variant} identity, selection, geometry, cancellation and disposal passed`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
