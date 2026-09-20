// Run against dev or preview with BROWSER_MATRIX_URL and BROWSER.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const browserName = process.env.BROWSER ?? "firefox";
const engine = { chromium, firefox, webkit }[browserName];
assert.ok(engine, `Unknown browser: ${browserName}`);
const galleryCss = await readFile(
  new URL("../../../demos/gallery/gallery.css", import.meta.url),
  "utf8",
);
const previewCss = await readFile(
  new URL("../../../demos/shared/photo-preview.css", import.meta.url),
  "utf8",
);
const browser = await engine.launch({ headless: true });

async function checkFade(page, label) {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    for (const cached of [false, true]) {
      const result = await page.evaluate(async (cached) => {
        const tile = document.createElement("div");
        tile.className = "tile photo-preview-card";
        tile.style.cssText =
          "position:fixed;top:0;left:0;width:80px;height:80px";
        const image = document.createElement("img");
        image.className = `photo photo-preview-image${cached ? " cached" : ""}`;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        canvas.getContext("2d").fillRect(0, 0, 1, 1);
        image.src = canvas.toDataURL();
        await image.decode();
        tile.append(image);
        document.body.append(tile);
        try {
          const before = Number(getComputedStyle(image).opacity);
          image.classList.add("loaded");
          const animations = image.getAnimations();
          const fade = animations.find(
            (animation) => animation.transitionProperty === "opacity",
          );
          let midpoint = null;
          let duration = null;
          if (fade) {
            fade.pause();
            duration = fade.effect.getTiming().duration;
            fade.currentTime = duration / 2;
            midpoint = Number(getComputedStyle(image).opacity);
            fade.finish();
          }
          return {
            before,
            after: Number(getComputedStyle(image).opacity),
            properties: getComputedStyle(image).transitionProperty,
            duration,
            midpoint,
            animations: animations.length,
          };
        } finally {
          tile.remove();
        }
      }, cached);
      const context = `${label}, motion=${reducedMotion}, cached=${cached}`;
      assert.equal(result.before, 0, `${context}: starts hidden`);
      assert.equal(result.after, 1, `${context}: finishes visible`);
      if (cached || reducedMotion === "reduce") {
        assert.equal(result.animations, 0, `${context}: must not fade`);
      } else {
        assert.equal(result.duration, 240, `${context}: entrance duration`);
        assert.ok(
          result.midpoint > 0 && result.midpoint < 1,
          `${context}: opacity must interpolate, got ${result.midpoint}`,
        );
        assert.deepEqual(
          result.properties.split(", "),
          ["opacity", "filter"],
          `${context}: preserve preview press feedback`,
        );
      }
    }
  }
  console.log(
    `${browserName}: ${label}: fresh, cached, and reduced-motion pass`,
  );
}

try {
  // Vite dev and production can emit the two stylesheets in opposite orders.
  for (const [label, styles] of [
    ["gallery then preview", [galleryCss, previewCss]],
    ["preview then gallery", [previewCss, galleryCss]],
  ]) {
    const page = await browser.newPage();
    try {
      await page.setContent("<!doctype html><html><body></body></html>");
      for (const content of styles) await page.addStyleTag({ content });
      await checkFade(page, label);
    } finally {
      await page.close();
    }
  }

  const page = await browser.newPage();
  try {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://picsum.photos/**", (route) => route.abort());
    await page.goto(new URL("/demos/gallery/", baseUrl).href);
    await page.locator("#status").filter({ hasText: "120" }).waitFor();
    await checkFade(page, "served gallery");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}
