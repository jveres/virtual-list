import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
      hasTouch: true,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const urls = await page.evaluate(() =>
      ["#6389a1", "#b87665"].map((color, index) => {
        const canvas = document.createElement("canvas");
        canvas.width = index ? 300 : 640;
        canvas.height = 480;
        const context = canvas.getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL();
      }),
    );
    // The first photo is deliberately unmounted, with repeated URLs at distinct positions.
    const markdown =
      `**User**\n\n![First](${urls[0]})\n\n` +
      Array.from(
        { length: 100 },
        (_, i) =>
          `**${i % 2 ? "Assistant" : "User"}**\n\nMessage ${i}: ${"text ".repeat(80)}\n\n`,
      ).join("") +
      `**Assistant**\n\n![Second](${urls[1]})\n\n![Third](${urls[0]})\n`;
    await page.locator("#import-file").setInputFiles({
      name: "navigation.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(markdown),
    });
    const third = page.locator('#viewport img[alt="Third"].photo-preview-card');
    await third.waitFor();
    assert.equal(await page.locator('#viewport img[alt="First"]').count(), 0);
    await third.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".photo-viewer")
          ?.getAnimations({ subtree: true }).length === 0,
    );
    const modal = page.locator(".photo-viewer");
    const frame = page.locator(".photo-viewer-frame");
    const arrowOffsets = await page
      .locator(".photo-viewer-nav")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          const glyph = button.querySelector("svg").getBoundingClientRect();
          return {
            label: button.getAttribute("aria-label"),
            opticalX: button.classList.contains("photo-viewer-previous")
              ? -1
              : 1,
            x: glyph.x + glyph.width / 2 - (box.x + box.width / 2),
            y: glyph.y + glyph.height / 2 - (box.y + box.height / 2),
          };
        }),
      );
    for (const offset of arrowOffsets) {
      assert.ok(
        Math.abs(offset.x - offset.opticalX) < 0.5,
        `${offset.label}: x=${offset.x}`,
      );
      assert.ok(Math.abs(offset.y) < 0.5, `${offset.label}: y=${offset.y}`);
    }
    const nativeDefaults = await frame.evaluate((element) => {
      const image = element.querySelector(".photo-viewer-image");
      return {
        dragAllowed: image.dispatchEvent(
          new Event("dragstart", { bubbles: true, cancelable: true }),
        ),
        selectionAllowed: image.dispatchEvent(
          new Event("selectstart", { bubbles: true, cancelable: true }),
        ),
        contextMenuAllowed: image.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
        userSelect:
          getComputedStyle(
            element.closest(".photo-viewer-scroll"),
          ).getPropertyValue("user-select") ||
          getComputedStyle(
            element.closest(".photo-viewer-scroll"),
          ).getPropertyValue("-webkit-user-select"),
        draggable: image.draggable,
      };
    });
    assert.deepEqual(nativeDefaults, {
      dragAllowed: false,
      selectionAllowed: false,
      contextMenuAllowed: true,
      userSelect: "none",
      draggable: false,
    });
    await page.evaluate(() => {
      window.previewNativeDrags = 0;
      document
        .querySelector(".photo-viewer")
        .addEventListener("dragstart", (event) => {
          if (!event.defaultPrevented) window.previewNativeDrags++;
        });
      window.getSelection().removeAllRanges();
    });
    const imageBox = await frame.boundingBox();
    const x = imageBox.x + imageBox.width / 2;
    const y = imageBox.y + imageBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 40, { steps: 10 });
    assert.equal(
      await page
        .locator(".photo-viewer-scroll")
        .evaluate((element) => element.classList.contains("is-swiping")),
      true,
    );
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.equal(await modal.count(), 1, "short image drag springs back");
    assert.deepEqual(
      await page.evaluate(() => ({
        drags: window.previewNativeDrags,
        selection: window.getSelection().toString(),
      })),
      { drags: 0, selection: "" },
    );
    await page.waitForFunction(() => {
      const arrow = document.querySelector(".photo-viewer-next");
      return arrow?.inert && getComputedStyle(arrow).opacity === "0";
    });
    assert.equal(
      await page
        .getByRole("button", { name: "Close photo", exact: true })
        .isVisible(),
      true,
    );
    await frame.click();
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
    );
    await frame.tap();
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      true,
    );
    await frame.tap();
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
    );
    await frame.click();
    await page.keyboard.press("Tab");
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
    );
    const previous = page.getByRole("button", {
      name: "Previous image",
      exact: true,
    });
    const next = page.getByRole("button", { name: "Next image", exact: true });
    assert.equal(await next.isDisabled(), true);
    await modal.evaluate((element) => {
      element.dataset.sameOverlay = "yes";
    });
    await previous.click();
    await page.waitForFunction(
      () =>
        document.querySelector(".photo-viewer-details")?.textContent ===
        "Second",
    );
    // Navigation uses the longer delay, reset from the most recent click/tap.
    await page.waitForTimeout(1700);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
    );
    await next.tap();
    await page.waitForTimeout(1700);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector(".photo-viewer")
          ?.classList.contains("is-navigation-hidden"),
      null,
      { timeout: 5000 },
    );
    await frame.click();
    await page.waitForTimeout(1750);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      true,
      "click-to-reveal restores the 1.5-second hide delay after navigation",
    );
    await frame.tap();
    await page.waitForTimeout(1750);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      true,
      "touch-to-reveal also restores the 1.5-second hide delay",
    );
    await frame.click();
    await previous.click();
    await page.waitForFunction(
      () =>
        document.querySelector(".photo-viewer-details")?.textContent ===
        "Second",
    );
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      () =>
        document.querySelector(".photo-viewer-details")?.textContent ===
        "First",
    );
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await modal.getAttribute("data-same-overlay"), "yes");
    await page.waitForTimeout(1700);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
      "keyboard navigation uses the longer delay",
    );
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector(".photo-viewer-details")?.textContent ===
        "Second",
    );
    await page.waitForTimeout(1700);
    assert.equal(
      await modal.evaluate((element) =>
        element.classList.contains("is-navigation-hidden"),
      ),
      false,
      "each arrow key resets the hide timer",
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector(".photo-viewer")
          ?.classList.contains("is-navigation-hidden"),
      null,
      { timeout: 2500 },
    );
    const dimensions = await page
      .locator(".photo-viewer-image")
      .first()
      .evaluate((image) => ({ width: image.width, height: image.height }));
    assert.ok(dimensions.height > dimensions.width);
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () => document.activeElement?.closest(".photo-viewer") !== null,
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    assert.equal(await page.locator(".is-photo-view-source").count(), 0);

    // Shared adapter: failed decode leaves the current image intact and retryable.
    await page.evaluate(async (url) => {
      const { createPhotoPreview } = await import(
        "/demos/shared/photo-preview.ts"
      );
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
      window.navigationController = createPhotoPreview({
        viewport: document.body,
        thumbnailUrl: () => url,
        previewUrl: (photo) =>
          photo.id ? "data:image/png;base64,invalid" : url,
        getAdjacentPhoto: (photo, direction) =>
          photos[photo.id + direction] ?? null,
      });
      window.navigationController.bind(source, photos[0]);
      source.click();
    }, urls[0]);
    await page.getByRole("button", { name: "Next image", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector(".photo-viewer-details")
        ?.textContent.includes("Unable to load"),
    );
    assert.equal(await modal.getAttribute("data-photo-id"), "0");
    assert.equal(await next.isEnabled(), true);
    await page.evaluate(() => window.navigationController.dispose());
    await modal.waitFor({ state: "detached" });

    // Real gallery order and edge controls with deterministic image responses.
    await page.route("https://picsum.photos/**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(urls[0].split(",")[1], "base64"),
      }),
    );
    await page.goto(`${base}/demos/gallery/index.html`);
    const first = page
      .locator('.photo-preview-card[data-photo-id="0"]')
      .first();
    await first.waitFor();
    await first.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".photo-viewer")
          ?.getAnimations({ subtree: true }).length === 0,
    );
    assert.equal(await previous.isDisabled(), true);
    await next.click();
    await page.waitForFunction(
      () => document.querySelector(".photo-viewer")?.dataset.photoId === "1",
    );
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      () => document.querySelector(".photo-viewer")?.dataset.photoId === "0",
    );
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    assert.equal(await page.locator(".is-photo-view-source").count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: preview navigation passed`);
  } finally {
    await browser.close();
  }
}
