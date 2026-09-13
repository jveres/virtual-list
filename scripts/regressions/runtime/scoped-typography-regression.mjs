import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { checkScopedTypography } = await import(
        "/scripts/regressions/fixtures/scoped-typography.js"
      );
      return checkScopedTypography();
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine: engine.name(), ...result }));
  } finally {
    await browser.close();
  }
}
