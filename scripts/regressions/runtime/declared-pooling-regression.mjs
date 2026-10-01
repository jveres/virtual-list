// Correctness of the profiling prototype, not native-scroll performance.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const mode of ["off", "on"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `${base}/scripts/firefox-profile/fixtures/declared-pooling.html?pool=${mode}`,
      );
      await page.waitForFunction(() => !!globalThis.__declaredPooling);
      const first = await page.evaluate(() => __declaredPooling.snapshot());
      assert.equal(first.top, 900000);
      assert.equal(first.scrollHeight, 1800000);
      assert.equal(first.invalid, 0);
      await page.locator('[data-key="5000"] input').check();
      await page.evaluate(() => {
        globalThis.__originalCards = new Map(
          [...document.querySelectorAll(".card")].map((element) => [
            element,
            element.dataset.key,
          ]),
        );
        __runtimeAudit.start();
      });
      let crossItemReuse = false;
      // Large jumps replace the window; small advances exercise identity reuse.
      for (const key of ["5500", "5506", "5512", "5600", "5610", "5000"]) {
        await page.evaluate(
          (id) => __declaredPooling.list.scrollTo(id, { align: "start" }),
          key,
        );
        const state = await page.evaluate(() => __declaredPooling.snapshot());
        assert.equal(state.top, Number(key) * 180);
        assert.equal(state.invalid, 0);
        assert.ok(state.pooled <= state.poolLimitPerKind * 2);
        crossItemReuse ||= await page.evaluate(() =>
          [...__originalCards].some(
            ([element, id]) =>
              element.isConnected && element.dataset.key !== id,
          ),
        );
        const boxes = await page.evaluate(() => {
          const viewport = document.querySelector("#viewport");
          const bounds = viewport.getBoundingClientRect();
          const rows = [...viewport.querySelectorAll(".card")]
            .map((element) => element.getBoundingClientRect())
            .sort((a, b) => a.top - b.top);
          return {
            heights: rows.map((row) => row.height),
            gaps: rows.slice(1).map((row, i) => row.top - rows[i].bottom),
            covers:
              rows[0].top <= bounds.top && rows.at(-1).bottom >= bounds.bottom,
          };
        });
        assert.ok(boxes.heights.every((height) => height === 180));
        assert.ok(boxes.gaps.every((gap) => Math.abs(gap) < 0.01));
        assert.equal(boxes.covers, true);
        const target = page.locator(`[data-key="${key}"] button`);
        await target.click();
        assert.equal(
          await page.evaluate(() => __declaredPooling.snapshot().lastAction),
          key,
        );
      }
      assert.equal(
        await page.locator('[data-key="5000"] input').isChecked(),
        true,
      );
      assert.equal(
        await page.locator('[data-key="5001"] input').isChecked(),
        false,
      );
      const reuse = await page.evaluate(() => __declaredPooling.snapshot());
      if (mode === "on") assert.ok(reuse.reused > 0);
      else assert.equal(reuse.reused, 0);
      assert.equal(crossItemReuse, mode === "on");
      // A very tall window retires more cards than the bounded pool can retain.
      await page.evaluate(() => {
        document.querySelector("#viewport").style.height = "9000px";
      });
      await page.waitForFunction(
        () => __declaredPooling.snapshot().active > 40,
      );
      await page.evaluate(() =>
        __declaredPooling.list.scrollTo("6000", { align: "start" }),
      );
      const bounded = await page.evaluate(() => __declaredPooling.snapshot());
      assert.equal(bounded.invalid, 0);
      assert.ok(bounded.pooled <= bounded.poolLimitPerKind * 2);
      await page.evaluate(() => __declaredPooling.dispose());
      const final = await page.evaluate(() => __declaredPooling.snapshot());
      assert.equal(final.active, 0);
      assert.equal(final.pooled, 0);
      assert.equal(final.disposed, true);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      `${engine.name()}: declared pooling identity and cleanup passed`,
    );
  } finally {
    await browser.close();
  }
}
