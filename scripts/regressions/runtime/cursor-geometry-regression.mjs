import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const output = "browser-artifacts/cursor-geometry";
await mkdir(output, { recursive: true });

for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1100 },
      deviceScaleFactor: 2,
      reducedMotion: "no-preference",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/demos/cursor-geometry/`);
    const waitHeld = () =>
      page.waitForFunction(() => {
        const groups = [...document.querySelectorAll("[data-trail-group]")];
        return (
          groups.length === 6 &&
          groups.every(
            (group) =>
              group.children.length > 0 &&
              group.getAnimations().length > 0 &&
              group
                .getAnimations()
                .every((animation) => animation.playState === "paused"),
          )
        );
      });
    const cursorBoxes = () =>
      page
        .locator("[data-cursor]")
        .evaluateAll((cursors) =>
          cursors.map((cursor) => cursor.getBoundingClientRect().toJSON()),
        );
    const radii = () =>
      page
        .locator("[data-cursor]")
        .evaluateAll((cursors) =>
          cursors.map(
            (cursor) => getComputedStyle(cursor, "::after").borderRadius,
          ),
        );

    for (const theme of ["light", "dark"]) {
      await page.selectOption("#theme", theme);
      await waitHeld();
      assert.equal(await page.locator("#rounded").isChecked(), true);
      assert.deepEqual(await radii(), Array(6).fill("2px"));
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll(".sample")].map((row) => {
          const walker = document.createTreeWalker(
            row.querySelector(".markdown"),
            NodeFilter.SHOW_TEXT,
          );
          let text;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent.includes("fresh glyphs")) text = node;
          }
          if (!text) throw new Error("Missing appended words");
          const range = document.createRange();
          const start = text.textContent.indexOf("fresh glyphs");
          range.setStart(text, start);
          range.setEnd(text, start + "fresh glyphs".length);
          const box = range.getBoundingClientRect();
          const overlay = row
            .querySelector("[data-trail-group] > div")
            .getBoundingClientRect();
          const cursor = row.querySelector("[data-cursor]");
          return {
            label: row.querySelector(".sample-label").textContent,
            topDifference: overlay.top - box.top,
            bottomDifference: overlay.bottom - box.bottom,
            leftOverhang: box.left - overlay.left,
            gap:
              cursor.getBoundingClientRect().left +
              Number.parseFloat(getComputedStyle(cursor, "::after").left) -
              overlay.right,
          };
        }),
      );
      assert.equal(rows.length, 6);
      for (const row of rows) {
        assert.ok(
          Math.abs(row.topDifference) < 0.1,
          `${row.label}: full font-box top`,
        );
        assert.ok(
          Math.abs(row.bottomDifference) < 0.1,
          `${row.label}: full font-box bottom`,
        );
        assert.ok(
          row.gap > 0,
          `${row.label}: highlight must not touch cursor paint`,
        );
      }
      // This fixture deliberately starts Times italic text with an overhanging f.
      const italic = rows.find((row) => row.label.includes("italic tail"));
      assert.ok(
        italic.leftOverhang > 0,
        "Italic glyph overhang must be covered",
      );
      const before = await cursorBoxes();
      await page.uncheck("#rounded");
      assert.deepEqual(await radii(), Array(6).fill("0px"));
      assert.deepEqual(await cursorBoxes(), before);
      await page.check("#rounded");
      assert.deepEqual(await radii(), Array(6).fill("2px"));
      assert.deepEqual(await cursorBoxes(), before);
      await page.uncheck("#glow");
      await page.screenshot({
        path: `${output}/${engine.name()}-${theme}.png`,
        fullPage: true,
      });
    }
    await page.uncheck("#hold");
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.startsWith("Replaying"),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("[data-trail-group]").length === 0,
    );
    assert.equal(await page.locator("[data-cursor]").count(), 6);
    await page.check("#hold");
    await waitHeld();
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: geometry, italic gap, rounded default/toggle, themes, and replay passed`,
    );
  } finally {
    await browser.close();
  }
}
