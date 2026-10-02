// Host-owned table geometry and content checks, not native-scroll timing.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const engines = { firefox, chromium, webkit };
const selected = process.env.RENDERING_BROWSER;
assert.ok(!selected || engines[selected], "Unknown table regression browser");
for (const engine of selected ? [engines[selected]] : Object.values(engines)) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/table-layout.html`,
    );
    await page.waitForFunction(() => !!globalThis.__renderingWorkload);
    for (const mode of ["table-ordinary", "table-long", "table-images"]) {
      let baselineHashes;
      for (const variant of ["plain", "fixed"]) {
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
        assert.equal(
          state.result.initialGeometry.images,
          mode === "table-images" ? 100 : 0,
        );
        const hashes = [
          state.result.initialGeometry.textHash,
          ...state.result.phases
            .filter((phase) => phase.geometry)
            .map((phase) => phase.geometry.textHash),
        ];
        if (variant === "plain") baselineHashes = hashes;
        else
          assert.deepEqual(
            hashes,
            baselineHashes,
            "Both table algorithms must preserve identical content through edits",
          );
        await page.evaluate(() => __renderingWorkload.release());
        const released = await page.evaluate(() =>
          __renderingWorkload.snapshot(),
        );
        assert.equal(released.renders, released.destroyed);
        assert.equal(released.activeItems, 0);
        console.log(
          `${engine.name()}: ${mode}/${variant} wrapping, selection, edits, geometry and disposal passed`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
