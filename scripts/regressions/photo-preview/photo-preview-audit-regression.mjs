import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const failures = [];
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
    });
    const results = await page.evaluate(async () => {
      const { createPhotoPreview } = await import(
        "/demos/shared/photo-preview.ts"
      );
      const { createChatImagePreview } = await import(
        "/demos/streaming/image-preview.ts"
      );
      const results = {};
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const finishPress = async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await frame();
      };
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 120;
      const context = canvas.getContext("2d");
      const urls = ["red", "blue", "green"].map((color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 160, 120);
        return canvas.toDataURL();
      });
      const viewport = document.createElement("div");
      viewport.style.cssText =
        "position:fixed;top:100px;left:100px;width:500px";
      document.body.append(viewport);
      const image = document.createElement("img");
      image.src = urls[0];
      image.setAttribute("aria-label", "Original label");
      viewport.append(image);
      await image.decode();
      const originalAttributes = image.outerHTML;
      const options = {
        viewport,
        thumbnailUrl: (photo) => urls[photo.id],
        previewUrl: (photo) => urls[photo.id],
      };
      const photo = (id) => ({
        id,
        width: 160,
        height: 120,
        aspectRatio: 0.75,
      });
      const preview = createPhotoPreview(options);
      preview.bind(image, photo(0));
      preview.dispose();
      results.disposeRemovesHandlers = image.dispatchEvent(
        new MouseEvent("contextmenu", { cancelable: true }),
      );
      results.disposeRestoresAttributes =
        image.outerHTML === originalAttributes;

      const replacement = createPhotoPreview(options);
      replacement.bind(image, photo(0));
      image.click();
      replacement.unbind(image);
      replacement.bind(image, photo(1));
      // Press feedback intentionally awaits an animation frame before opening.
      await finishPress();
      results.rebindCancelsPendingOpen =
        !document.querySelector(".photo-viewer");
      replacement.dispose();
      image.remove();

      const messages = [
        { id: 1, markdown: `![First](${urls[0]})\n\n![Second](${urls[1]})` },
        { id: 2, markdown: `![Third](${urls[2]})` },
      ];
      const row = document.createElement("div");
      row.dataset.key = "1";
      const images = [0, 1].map((id) => {
        const image = document.createElement("img");
        image.src = urls[id];
        image.alt = id ? "Second" : "First";
        row.append(image);
        return image;
      });
      viewport.append(row);
      await Promise.all(images.map((image) => image.decode()));
      const chat = createChatImagePreview(viewport, () => messages);
      messages[0].markdown = `![Second](${urls[1]})`;
      images[0].remove();
      await frame();
      images[1].click();
      await finishPress();
      const next = document.querySelector(".photo-viewer-next");
      results.removalRebindsRemainingImages =
        !!next && !next.hidden && !next.disabled;
      next?.focus();
      next?.click();
      await finishPress();
      results.navigationKeepsUsableFocus =
        document.activeElement instanceof HTMLButtonElement &&
        !document.activeElement.disabled &&
        !!document.activeElement.closest(".photo-viewer");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      chat.dispose();

      // A new failed source must not retain a click binding to the old photo.
      const freshChat = createChatImagePreview(viewport);
      images[1].src = "data:image/png;base64,invalid";
      try {
        await images[1].decode();
      } catch {
        /* Expected failure. */
      }
      await frame();
      images[1].click();
      await finishPress();
      results.brokenImageCannotOpenStalePhoto =
        !document.querySelector(".photo-viewer");
      freshChat.dispose();
      viewport.remove();
      return results;
    });
    console.log(engine.name(), results);
    for (const [name, passed] of Object.entries(results)) {
      if (!passed) failures.push(`${engine.name()}: ${name}`);
    }
  } finally {
    await browser.close();
  }
}
assert.deepEqual(failures, []);
