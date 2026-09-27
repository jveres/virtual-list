// Exercise actual gallery mounting/overscan, not just a standalone CSS image.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const fixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#5c89a8"/></svg>';
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const layout of ["rows", "masonry"]) {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        reducedMotion: "no-preference",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let pendingDownloads = null;
      await page.route("https://picsum.photos/**", async (route) => {
        if (pendingDownloads) await pendingDownloads;
        return route.fulfill({
          contentType: "image/svg+xml",
          headers: { "cache-control": "public, max-age=3600" },
          body: fixture,
        });
      });
      await page.goto(`${base}/demos/gallery/`);
      await page.locator(`[data-layout="${layout}"]`).click();
      const image = page.locator('.tile[data-id="0"] img.photo');
      await page.waitForFunction(() =>
        document
          .querySelector('.tile[data-id="0"] img.photo')
          ?.classList.contains("revealed"),
      );
      assert.equal(
        await image.evaluate((img) => img.getAnimations().length),
        0,
        "initial load appears immediately",
      );
      for (const distance of [400, 2400]) {
        await page.locator("#viewport").evaluate((v, top) => {
          v.scrollTop = top;
        }, distance);
        await page.waitForFunction(
          () =>
            !document
              .querySelector('.tile[data-id="0"] img.photo')
              ?.classList.contains("revealed"),
        );
        if (distance === 400) {
          assert.equal(
            await image.count(),
            1,
            "overscan keeps the first photo mounted",
          );
          assert.equal(
            await image.evaluate(
              (img) => img.complete && img.classList.contains("loaded"),
            ),
            true,
          );
        } else
          assert.equal(
            await image.count(),
            0,
            "far scroll unmounts the first photo",
          );
        await page.waitForTimeout(300); // Let the old 240 ms entrance expire.
        await page.locator("#viewport").evaluate((v) => {
          v.scrollTop = 0;
        });
        await page.waitForFunction(() =>
          document
            .querySelector('.tile[data-id="0"] img.photo')
            ?.classList.contains("revealed"),
        );
        const result = await image.evaluate((img) => {
          const animation = img
            .getAnimations()
            .find((a) => a.animationName === "gallery-photo-appear");
          if (!animation) return { fading: false };
          const running = animation.playState === "running";
          animation.pause();
          animation.currentTime = 120;
          const opacity = Number(getComputedStyle(img).opacity);
          animation.finish();
          return { fading: running, opacity };
        });
        assert.equal(
          result.fading,
          true,
          `${engine.name()} ${layout} ${distance}: fresh visible entrance`,
        );
        assert.ok(result.opacity > 0 && result.opacity < 1);
      }
      // First-time downloads must also fade when they arrive during scrolling.
      // Hold transport until the newly visible images have entered the viewport.
      let releaseDownloads;
      pendingDownloads = new Promise((resolve) => {
        releaseDownloads = resolve;
      });
      try {
        await page.locator("#viewport").evaluate((v) => {
          v.scrollTop = 6000;
        });
        const waiting = await page.waitForFunction(() => {
          const viewport = document
            .querySelector("#viewport")
            .getBoundingClientRect();
          const image = [...document.querySelectorAll("img.photo")].find(
            (img) => {
              const rect = img.getBoundingClientRect();
              return (
                !img.classList.contains("loaded") &&
                rect.bottom > viewport.top &&
                rect.top < viewport.bottom
              );
            },
          );
          return image?.closest(".tile").dataset.id;
        });
        const id = await waiting.jsonValue();
        await page.waitForTimeout(100); // Intersection delivery precedes download completion.
        releaseDownloads();
        pendingDownloads = null;
        await page.waitForFunction(
          (id) =>
            document
              .querySelector(`.tile[data-id="${id}"] img.photo`)
              ?.classList.contains("revealed"),
          id,
        );
        assert.equal(
          await page
            .locator(`.tile[data-id="${id}"] img.photo`)
            .evaluate((img) => img.classList.contains("fade-in")),
          true,
          "first-time scroll download fades",
        );
      } finally {
        releaseDownloads();
        pendingDownloads = null;
      }
      assert.deepEqual(errors, []);
      console.log(
        engine.name(),
        layout,
        "initial load, cached entries, and first-time scroll downloads passed",
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
