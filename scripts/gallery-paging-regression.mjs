// Run against Vite with BROWSER_MATRIX_URL (default: http://127.0.0.1:4193).
import assert from "node:assert/strict";
import { firefox } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const browser = await firefox.launch({ headless: true });
try {
  for (const [layout, deviceScaleFactor] of [
    ["rows", 1],
    ["masonry", 1],
    ["masonry", 1.25],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
      deviceScaleFactor,
    });
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    await page.route("https://picsum.photos/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="teal"/></svg>',
      }),
    );
    // Test-only access to committed source and layout state; no production globals.
    await page.route("**/demos/gallery/gallery.ts*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `${await response.text()}
        window.__gallery = { get photos() { return photos; }, get items() { return items; },
          list, get paging() { return paging; }, pointUnderViewportTop, anchorFor };`,
      });
    });
    await page.addInitScript((layout) => {
      localStorage.setItem(
        "virtual-list:gallery-options",
        JSON.stringify({ layout }),
      );
      window.__imageBoundsReads = 0;
      const bounds = HTMLImageElement.prototype.getBoundingClientRect;
      HTMLImageElement.prototype.getBoundingClientRect = function () {
        window.__imageBoundsReads++;
        return bounds.call(this);
      };
    }, layout);
    await page.goto(new URL("/demos/gallery/", baseUrl).href);
    await page.waitForFunction(
      () => window.__gallery?.photos.length === 120,
      null,
      { timeout: 10000 },
    );

    async function load(edge) {
      const before = await page.evaluate((edge) => {
        const v = document.querySelector("#viewport");
        const g = window.__gallery;
        v.scrollTop = edge === "end" ? v.scrollHeight : 0;
        v.dispatchEvent(new Event("scroll"));
        const point = g.pointUnderViewportTop();
        const bands = [...document.querySelectorAll("#viewport .band")]
          .map((band) => band.getBoundingClientRect())
          .sort((a, b) => a.top - b.top);
        const seam = Math.max(
          0,
          ...bands.slice(1).map((band, i) => band.top - bands[i].bottom),
        );
        return { first: g.photos[0].id, last: g.photos.at(-1).id, point, seam };
      }, edge);
      assert.ok(before.seam < 0.02, `white seam before load: ${before.seam}px`);
      await page.waitForFunction(
        ({ edge, before }) => {
          const g = window.__gallery;
          return (
            !g.paging.loading &&
            !g.list.state.held &&
            (edge === "end"
              ? g.photos.at(-1).id > before.last
              : g.photos[0].id < before.first)
          );
        },
        { edge, before },
        { timeout: 15000 },
      );
      const after = await page.evaluate((point) => {
        const g = window.__gallery;
        const anchor = point ? g.anchorFor(point) : "viewport";
        const position =
          typeof anchor === "object" ? g.list.positionOf(anchor.key) : null;
        return {
          count: g.photos.length,
          rows: g.list.state.count,
          first: g.photos[0].id,
          last: g.photos.at(-1).id,
          error: position
            ? position.top -
              document.querySelector("#viewport").scrollTop -
              anchor.offset
            : null,
          nodes: document.querySelectorAll("#viewport .tile").length,
          clippedHeads:
            g.items[0]?.kind === "band"
              ? g.photos.filter(
                  (photo) =>
                    !g.items.some((band) =>
                      band.cards.some(
                        (card) =>
                          card.id === photo.id &&
                          card.part === 0 &&
                          card.top >= band.start,
                      ),
                    ),
                ).length
              : 0,
        };
      }, before.point);
      assert.ok(
        after.count <= 480,
        `source window exceeded budget: ${JSON.stringify(after)}`,
      );
      assert.ok(after.nodes < 150, `mounted tiles not bounded: ${after.nodes}`);
      assert.equal(
        after.clippedHeads,
        0,
        "top loading must preserve every retained photo's top",
      );
      if (before.point)
        assert.ok(
          after.error !== null && Math.abs(after.error) <= 1,
          `reading anchor moved: ${JSON.stringify(after)}`,
        );
      return after;
    }

    let state;
    for (let i = 0; i < 9; i++) state = await load("end");
    assert.ok(state.first >= 600, "old pages should have been evicted");
    for (let i = 0; i < 4; i++) state = await load("start");
    assert.ok(state.first < 600, "trimmed history should reload");
    for (const width of [1000, 981, 800, 600, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.ok(
        await page.evaluate(() => window.__gallery.photos.length <= 480),
      );
    }
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(() => window.__imageBoundsReads),
      0,
      "image priorities must not force DOM measurements during scrolling or reflow",
    );
    console.log(
      `Firefox ${layout} DPR ${deviceScaleFactor}: 9 forward / 4 backward loads, <=480 retained photos, bounded DOM, no clipped tops/seams, stable anchors and resize`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
