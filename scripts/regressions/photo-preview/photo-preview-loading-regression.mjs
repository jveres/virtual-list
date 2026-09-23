import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const pending = [];
    await page.route("**/__preview_loading__/**", (route) => {
      pending.push(route);
    });
    const errors = await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
    });
    const url = await page.evaluate(async () => {
      const { createPhotoPreview } = await import(
        "/demos/shared/photo-preview.ts"
      );
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d");
      context.fillStyle = "#6389a1";
      context.fillRect(0, 0, 640, 480);
      const url = canvas.toDataURL();
      const source = document.createElement("img");
      source.src = url;
      source.style.cssText = "position:fixed;top:100px;left:100px;width:100px";
      document.body.append(source);
      await source.decode();
      const photos = [0, 1].map((id) => ({
        id,
        width: 640,
        height: 480,
        aspectRatio: 0.75,
      }));
      let requestId = 0;
      window.loadingController = createPhotoPreview({
        viewport: document.body,
        thumbnailUrl: () => url,
        previewUrl: (photo) =>
          photo.id
            ? `/__preview_loading__/next.png?request=${++requestId}`
            : url,
        getAdjacentPhoto: (photo, direction) =>
          photos[photo.id + direction] ?? null,
      });
      window.loadingController.bind(source, photos[0]);
      source.click();
      return url;
    });
    const modal = page.locator(".photo-viewer");
    const spinner = page.getByRole("status", {
      name: "Loading image",
      exact: true,
    });
    await modal.waitFor();
    assert.equal(await spinner.isVisible(), false);
    await page.keyboard.press("ArrowRight");
    await spinner.waitFor();
    assert.equal(await modal.getAttribute("aria-busy"), "true");
    assert.equal(
      await modal.getAttribute("data-photo-id"),
      "0",
      "current image stays visible while loading",
    );
    await page.waitForTimeout(3300);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      true,
    );
    assert.equal(
      await spinner.isVisible(),
      true,
      "spinner outlives the navigation fade timer",
    );
    assert.equal(
      await spinner.evaluate(
        (element) => getComputedStyle(element).pointerEvents,
      ),
      "none",
    );
    assert.equal(pending.length, 1);
    await pending.shift().fulfill({
      contentType: "image/png",
      body: Buffer.from(url.split(",")[1], "base64"),
    });
    await page.waitForFunction(
      () => document.querySelector(".photo-viewer")?.dataset.photoId === "1",
    );
    assert.equal(await spinner.isVisible(), false);
    assert.equal(await modal.getAttribute("aria-busy"), "false");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      () => document.querySelector(".photo-viewer")?.dataset.photoId === "0",
    );
    await page.getByRole("button", { name: "Next image", exact: true }).click();
    await spinner.waitFor();
    // Wait for the blocked request to reach the browser route handler.
    for (let attempt = 0; pending.length === 0 && attempt < 100; attempt++)
      await page.waitForTimeout(20);
    assert.equal(pending.length, 1);
    await pending.shift().abort();
    await page.waitForFunction(() =>
      document
        .querySelector(".photo-viewer-details")
        ?.textContent.includes("Unable to load"),
    );
    assert.equal(await spinner.isVisible(), false);
    assert.equal(await modal.getAttribute("aria-busy"), "false");
    assert.equal(await modal.getAttribute("data-photo-id"), "0");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("ArrowRight");
    await spinner.waitFor();
    assert.equal(
      await spinner.evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
      "none",
    );
    for (let attempt = 0; pending.length === 0 && attempt < 100; attempt++)
      await page.waitForTimeout(20);
    assert.equal(pending.length, 1);
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    await pending.shift().abort();
    assert.equal(await page.locator(".photo-viewer-loading").count(), 0);
    await page.evaluate(() => window.loadingController.dispose());
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: preview loading, success, failure, close, and reduced motion passed`,
    );
  } finally {
    await browser.close();
  }
}
