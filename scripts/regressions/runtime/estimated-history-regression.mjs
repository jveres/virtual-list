// A reference control with different geometry semantics, not a speed benchmark.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    await page.goto(
      `${base}/scripts/firefox-profile/fixtures/estimated-history.html`,
    );
    await page.waitForFunction(() => !!globalThis.__renderingWorkload);
    for (const mode of ["history-1000", "history-5000"]) {
      let exact;
      for (const variant of ["plain", "estimated"]) {
        await page.evaluate(
          ([mode, variant]) => __renderingWorkload.prepare(mode, variant),
          [mode, variant],
        );
        await page.evaluate(() => __renderingWorkload.exercise(4));
        const state = await page.evaluate(() => __renderingWorkload.snapshot());
        assert.deepEqual(state.errors, []);
        assert.equal(state.completed, true);
        const initial = state.result.checkpoints[0];
        const content = state.result.checkpoints
          .filter((point) => point.label.startsWith("jump-"))
          .map((point) => point.targetText);
        assert.ok(
          content.every(
            (text) => typeof text === "string" && text.length > 500,
          ),
        );
        if (variant === "plain") {
          exact = content;
          assert.equal(initial.rendered, Number(mode.split("-")[1]));
          assert.equal(initial.totalError, 0);
        } else {
          assert.ok(initial.rendered < 50);
          assert.ok(initial.measured < 50);
          assert.deepEqual(
            content,
            exact,
            "The reference renders identical target content",
          );
        }
        await page.evaluate(() => __renderingWorkload.release());
        const released = await page.evaluate(() =>
          __renderingWorkload.snapshot(),
        );
        assert.equal(released.renders, released.destroyed);
        assert.equal(released.activeItems, 0);
        console.log(
          `${engine.name()}: ${mode}/${variant} content, coverage, target alignment, geometry oracle and disposal passed`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
