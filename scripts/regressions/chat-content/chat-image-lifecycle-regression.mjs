import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const paragraph of [false, true]) {
      const page = await browser.newPage();
      const errors = await openStreamingDemo(page, base);
      const result = await page.evaluate(async (paragraph) => {
        const { suspendRowImages, resumeRowImages } = await import(
          "/demos/streaming/image-lifecycle.ts"
        );
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        canvas.getContext("2d").fillRect(0, 0, 800, 600);
        const source = canvas.toDataURL("image/png");
        const root = document.createElement("div");
        root.className = "markdown-viewer";
        root.style.width = "400px";
        const markup = '<img width="800" height="600" alt="Test image">';
        root.innerHTML = `<div class="markdown">${paragraph ? `<p>${markup}</p>` : markup}</div>`;
        const image = root.querySelector("img");
        image.src = source;
        document.body.append(root);
        await image.decode();
        const full = image.getBoundingClientRect().height;
        const fullRow = root.getBoundingClientRect().height;
        root.remove();
        suspendRowImages(root);
        const released = !image.hasAttribute("src");
        document.body.append(root);
        const reserved = image.getBoundingClientRect().height;
        const reservedRow = root.getBoundingClientRect().height;
        resumeRowImages(root);
        // A second retirement before load must retain the original style owner.
        suspendRowImages(root);
        resumeRowImages(root);
        await image.decode();
        await new Promise(requestAnimationFrame);
        const restored = image.getBoundingClientRect().height;
        const restoredRow = root.getBoundingClientRect().height;
        const restoredStyle = image.style.cssText;
        const identity = image.src === source;
        root.remove();
        suspendRowImages(root);
        image.src = `${source}#new`;
        resumeRowImages(root);
        const newerSource = image.src === `${source}#new`;
        const unknown = new Image();
        unknown.src = source;
        root.append(unknown);
        suspendRowImages(root);
        const responsive = new Image(800, 600);
        responsive.src = source;
        responsive.srcset = `${source} 1x`;
        root.append(responsive);
        suspendRowImages(root);
        return {
          full,
          fullRow,
          reserved,
          reservedRow,
          restored,
          restoredRow,
          restoredStyle,
          released,
          identity,
          newerSource,
          unknownKept: unknown.src === source,
          responsiveKept: responsive.src === source,
        };
      }, paragraph);
      assert.equal(result.full, 300);
      assert.equal(result.reserved, result.full);
      assert.equal(result.restored, result.full);
      assert.equal(result.reservedRow, result.fullRow);
      assert.equal(result.restoredRow, result.fullRow);
      assert.equal(result.restoredStyle, "");
      for (const field of [
        "released",
        "identity",
        "newerSource",
        "unknownKept",
        "responsiveKept",
      ])
        assert.equal(result[field], true, field);
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()} ${paragraph ? "block" : "inline"}: retired images release sources and remount without height changes`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
