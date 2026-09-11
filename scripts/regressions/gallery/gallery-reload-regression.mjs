// Run against a local Vite server:
// BROWSER_MATRIX_URL=http://127.0.0.1:4193 node scripts/regressions/gallery/gallery-reload-regression.mjs
import assert from "node:assert/strict";
import { firefox } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const browser = await firefox.launch({ headless: true });
try {
  for (const layout of ["rows", "masonry"]) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((layout) => {
      localStorage.setItem(
        "virtual-list:gallery-options",
        JSON.stringify({ layout }),
      );
    }, layout);
    await page.addInitScript(() => {
      window.galleryScrollSamples = [];
      document.addEventListener(
        "scroll",
        (event) => {
          if (event.target.id === "viewport") {
            window.galleryScrollSamples.push(event.target.scrollTop);
          }
        },
        true,
      );
    });
    // Page loading and layout must work independently of the image service.
    await page.route("https://picsum.photos/**", (route) => route.abort());
    await page.goto(new URL("/demos/gallery/", baseUrl).href);
    const viewport = page.locator("#viewport");
    await page.locator("#status").filter({ hasText: "120" }).waitFor();

    for (let reload = 0; reload < 3; reload++) {
      await viewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      assert.ok(await viewport.evaluate((element) => element.scrollTop > 0));
      // Let Firefox remember the position, before the simulated page arrives.
      await page.waitForTimeout(80);
      await page.reload();
      // Observe beyond the 500ms page delay: no restoration or extra page
      // may arrive after an initially correct frame at the top.
      await page.waitForTimeout(1200);
      assert.equal(await viewport.evaluate((element) => element.scrollTop), 0);
      assert.match(await page.locator("#status").textContent(), /^120 of /);
      assert.equal(await page.locator('.tile[data-id="0"]').count(), 1);
      assert.equal(
        await page.locator(`[data-layout="${layout}"].active`).count(),
        1,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.galleryScrollSamples.filter((top) => top !== 0),
        ),
        [],
      );
      assert.deepEqual(errors, []);
      console.log(
        `${layout} reload ${reload + 1}: starts and stays at top, 120 photos`,
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
}
