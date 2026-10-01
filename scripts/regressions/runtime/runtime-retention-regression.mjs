// Cross-engine lifecycle correctness; reachability is measured in installed Firefox.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    const gc =
      engine === chromium ? await page.context().newCDPSession(page) : null;
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/runtime-retention.html`,
    );
    await page.waitForFunction(() => !!globalThis.__runtimeRetention);
    for (const mode of ["replace", "paging", "dispose-drop", "dispose-keep"]) {
      await page.evaluate((mode) => __runtimeRetention.begin(mode), mode);
      for (let i = 0; i < 4; i++)
        await page.evaluate(() => __runtimeRetention.cycle());
      const state = await page.evaluate(() => __runtimeRetention.snapshot());
      assert.deepEqual(state.errors, []);
      assert.equal(state.cycles, 4);
      assert.ok(state.scrolls > 4 && state.ends > 0 && state.distance > 10000);
      if (mode.startsWith("dispose")) {
        assert.equal(state.renders, state.destroyed);
        assert.equal(state.canvasCount, 0);
        assert.equal(state.retainedHandles, mode === "dispose-keep" ? 4 : 0);
      } else {
        assert.equal(state.activeItems, 96);
        assert.equal(state.renders - state.destroyed, 96);
        if (mode === "paging") assert.equal(state.evicted, 64);
      }
      if (gc) {
        await gc.send("HeapProfiler.collectGarbage");
        const collected = await page.evaluate(() =>
          __runtimeRetention.snapshot(),
        );
        assert.equal(
          collected.cohorts.reduce((sum, row) => sum + row.aliveItems, 0),
          collected.activeItems,
          `${mode}: retired source items remain reachable`,
        );
        assert.equal(
          collected.cohorts.reduce((sum, row) => sum + row.aliveNodes, 0),
          collected.activeItems,
          `${mode}: retired row DOM remains reachable`,
        );
      }
      await page.evaluate(() => __runtimeRetention.release());
      const released = await page.evaluate(() => __runtimeRetention.snapshot());
      assert.equal(released.retainedHandles, 0);
      assert.equal(released.renders, released.destroyed);
      assert.equal(released.canvasCount, 0);
      if (gc) {
        await gc.send("HeapProfiler.collectGarbage");
        const collected = await page.evaluate(() =>
          __runtimeRetention.snapshot(),
        );
        assert.equal(
          collected.cohorts.reduce(
            (sum, row) => sum + row.aliveItems + row.aliveNodes,
            0,
          ),
          0,
          `${mode}: released objects remain reachable`,
        );
      }
    }
    console.log(`${engine.name()}: lifecycle fixture checks passed`);
  } finally {
    await browser.close();
  }
}
