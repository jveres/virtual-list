// Run against Vite with BROWSER_MATRIX_URL (default: http://127.0.0.1:4193).
import assert from "node:assert/strict";
import { firefox } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const browser = await firefox.launch({ headless: true });

async function stableMasonryColumns(page) {
  const seen = new Map();
  let previous = new Map();
  let previousWidth = 0;
  let comparisons = 0;
  for (const width of [
    1000,
    ...Array.from({ length: 20 }, (_, i) => 999 - i),
    1000,
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const fadingCached = await page.locator(".photo.cached").evaluateAll(
      (images) =>
        images.filter((img) => {
          const style = getComputedStyle(img);
          return style.opacity !== "1" || style.transitionDuration !== "0s";
        }).length,
    );
    assert.equal(
      fadingCached,
      0,
      "cached photos must not fade again during reflow",
    );
    const tiles = await page.locator(".band .tile").evaluateAll((tiles) =>
      tiles.map((tile) => {
        const rect = tile.getBoundingClientRect();
        return {
          id: tile.dataset.id,
          column: Math.round(
            Number.parseFloat(tile.style.left) /
              (tile.parentElement.clientWidth / 4),
          ),
          top: rect.top,
        };
      }),
    );
    const frame = new Map();
    for (const tile of tiles) {
      if (seen.has(tile.id)) {
        assert.equal(
          tile.column,
          seen.get(tile.id),
          `photo ${tile.id} changed column at ${width}px`,
        );
        comparisons++;
      }
      seen.set(tile.id, tile.column);
      if (frame.has(tile.id)) {
        assert.ok(
          Math.abs(tile.top - frame.get(tile.id)) <= 1,
          `photo ${tile.id} has misaligned band fragments`,
        );
      }
      frame.set(tile.id, tile.top);
    }
    if (Math.abs(width - previousWidth) === 1) {
      for (const [id, top] of frame) {
        if (previous.has(id)) {
          assert.ok(
            Math.abs(top - previous.get(id)) <= 8,
            `photo ${id} jumped ${top - previous.get(id)}px during a one-pixel resize`,
          );
        }
      }
    }
    previous = frame;
    previousWidth = width;
  }
  assert.ok(
    comparisons > 100,
    "must compare mounted photos across resize frames",
  );
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function roundTrip(page, label) {
  const before = await page.locator("#viewport").evaluate((v) => v.scrollTop);
  for (const width of [
    ...Array.from({ length: 25 }, (_, i) => 1080 - i * 20),
    ...Array.from({ length: 25 }, (_, i) => 620 + i * 20),
    1100,
  ]) {
    await page.setViewportSize({ width, height: 800 });
    // Give each width its own layout/ResizeObserver delivery, like dragging.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  }
  const after = await page.locator("#viewport").evaluate((v) => v.scrollTop);
  assert.ok(
    Math.abs(after - before) <= 1,
    `${label}: drifted ${after - before}px`,
  );
}

try {
  for (const layout of ["rows", "masonry"]) {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((layout) => {
      localStorage.setItem(
        "virtual-list:gallery-options",
        JSON.stringify({ layout }),
      );
    }, layout);
    await page.route("https://picsum.photos/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="steelblue"/></svg>',
      }),
    );
    await page.goto(new URL("/demos/gallery/", baseUrl).href);
    await page.locator("#status").filter({ hasText: "120" }).waitFor();
    await roundTrip(page, `${layout}: initial top`);

    const initialHeight = await page.locator("#viewport").evaluate((v) => {
      v.scrollTop = v.scrollHeight;
      return v.scrollHeight;
    });
    await page.waitForFunction(
      (height) => document.querySelector("#viewport").scrollHeight > height,
      initialHeight,
    );
    await page.locator("#status").filter({ hasText: "240" }).waitFor();
    // This masonry position crosses different candidate anchors as columns change.
    if (layout === "masonry") {
      await page.locator("#viewport").evaluate((v) => {
        v.scrollTop = 4000;
      });
      await stableMasonryColumns(page);
    }
    await roundTrip(page, `${layout}: after append`);
    await page.waitForTimeout(300);
    await roundTrip(page, `${layout}: after resize pause`);

    await page.locator("#viewport").evaluate((v) => {
      v.scrollTop = 2200;
    });
    await roundTrip(page, `${layout}: after navigation`);

    await page.locator('[data-size="s"]').click();
    await roundTrip(page, `${layout}: after size control`);
    const other = layout === "rows" ? "masonry" : "rows";
    await page.locator(`[data-layout="${other}"]`).click();
    await roundTrip(page, `${layout}: after layout control`);
    assert.ok(
      (await page.locator(".photo.cached").count()) > 0,
      "must exercise loaded image remounts",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${layout}: resize round trips preserve position after append, navigation, and controls`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
