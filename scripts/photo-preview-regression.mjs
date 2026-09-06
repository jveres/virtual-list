import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let failLarge = false;
    await page.route("https://picsum.photos/**", (route) => {
      const parts = new URL(route.request().url()).pathname.split("/");
      if (failLarge && Number(parts.at(-2)) > 640) return route.abort();
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#6389a1"/></svg>',
      });
    });
    await page.goto(`${base}/demos/gallery/`);
    const cards = page.locator(".tile.photo-preview-card");
    await cards.first().waitFor();
    const open = async (card = cards.first()) => {
      await card.click();
      await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
      await page.waitForTimeout(650);
      assert.equal(await page.locator(".photo-viewer").count(), 1);
    };
    const closed = async () => {
      await page.locator(".photo-viewer").waitFor({ state: "detached" });
      assert.equal(await page.locator(".is-photo-view-source").count(), 0);
      assert.equal(
        await page.locator("main").evaluate((el) => el.inert),
        false,
      );
    };
    const drag = async (distance, fromTop = true) => {
      if (fromTop)
        await page.locator(".photo-viewer-scroll").evaluate((el) => {
          el.scrollTop = 0;
        });
      await page.mouse.move(550, 260);
      await page.mouse.down();
      await page.mouse.move(550, 280, { steps: 3 });
      await page.mouse.move(550, 280 + distance, { steps: 10 });
      await page.waitForTimeout(100);
      await page.mouse.up();
    };
    for (const layout of ["rows", "masonry"]) {
      await page.click(`[data-layout="${layout}"]`);
      await page.waitForTimeout(300);
      const top = await page
        .locator("#viewport")
        .evaluate((el) => el.scrollTop);
      await open();
      const closeIcon = await page
        .locator(".photo-viewer-close")
        .evaluate((button) => {
          const svg = button.querySelector("svg");
          const box = button.getBoundingClientRect();
          const icon = svg.getBoundingClientRect();
          return {
            dx: icon.x + icon.width / 2 - (box.x + box.width / 2),
            dy: icon.y + icon.height / 2 - (box.y + box.height / 2),
            strokeWidth: svg.getAttribute("stroke-width"),
          };
        });
      assert.ok(
        Math.abs(closeIcon.dx) < 0.1,
        "close icon centered horizontally",
      );
      assert.ok(Math.abs(closeIcon.dy) < 0.1, "close icon centered vertically");
      assert.equal(closeIcon.strokeWidth, "1.5");
      assert.equal(await page.locator("main").evaluate((el) => el.inert), true);
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .locator(".photo-viewer-close")
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.evaluate(() => {
        const source = document.querySelector(".is-photo-view-source");
        const pieces = [
          ...document.querySelectorAll(".photo-preview-card"),
        ].filter((card) => card.dataset.photoId === source.dataset.photoId);
        window.previewHandoff = new Promise((resolve) => {
          let overlapFrames = 0;
          const sample = () => {
            const hero = document.querySelector(".photo-viewer-hero");
            if (!document.querySelector(".photo-viewer")) {
              resolve(overlapFrames);
              return;
            }
            if (
              hero &&
              pieces.every(
                (card) => getComputedStyle(card).visibility === "visible",
              )
            )
              overlapFrames++;
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      });
      await page.keyboard.press("Escape");
      await closed();
      assert.ok(
        (await page.evaluate(() => window.previewHandoff)) >= 1,
        "all thumbnail pieces are revealed beneath the hero before its removal",
      );
      assert.equal(
        await page.locator("#viewport").evaluate((el) => el.scrollTop),
        top,
      );
      assert.equal(
        await cards.first().evaluate((el) => el === document.activeElement),
        true,
      );
      await open();
      await drag(35);
      await page.waitForTimeout(400);
      assert.equal(
        await page.locator(".photo-viewer").count(),
        1,
        "short swipe springs back",
      );
      await drag(230);
      await closed();
    }
    // A whole masonry card scales independently from its layout translation.
    const pressedCard = cards.first();
    const beforePress = await pressedCard.evaluate((tile) => {
      const rect = tile.getBoundingClientRect();
      tile.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 7,
          pointerType: "mouse",
          button: 0,
          isPrimary: true,
          clientX: rect.left + 10,
          clientY: rect.top + 10,
        }),
      );
      return {
        width: rect.width,
        height: rect.height,
        translate: getComputedStyle(tile).translate,
      };
    });
    await page.waitForTimeout(200);
    const pressed = await pressedCard.evaluate((tile) => {
      const box = tile.getBoundingClientRect();
      return {
        pressed: tile.classList.contains("is-photo-pressed"),
        transform: getComputedStyle(tile).transform,
        translate: getComputedStyle(tile).translate,
        width: box.width,
        height: box.height,
        copies: document.querySelectorAll(
          `.tile[data-photo-id="${tile.dataset.photoId}"]`,
        ).length,
      };
    });
    assert.equal(pressed.copies, 1, "a photo has one complete thumbnail");
    assert.equal(pressed.pressed, true);
    assert.equal(
      pressed.translate,
      beforePress.translate,
      "press preserves layout translation",
    );
    assert.ok(Math.abs(pressed.width / beforePress.width - 0.975) < 0.001);
    assert.ok(Math.abs(pressed.height / beforePress.height - 0.975) < 0.001);
    await pressedCard.dispatchEvent("pointercancel", {
      pointerId: 7,
      pointerType: "mouse",
    });
    assert.equal(await page.locator(".is-photo-pressed").count(), 0);
    // A wheel-scrolled tall photo can still be dragged to dismiss from the middle.
    await open();
    const scroller = page.locator(".photo-viewer-scroll");
    const max = await scroller.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    assert.ok(max > 20, "fixture must overflow");
    await page.mouse.move(550, 350);
    await page.mouse.wheel(0, Math.round(max / 2));
    await page.waitForTimeout(350);
    const middle = await scroller.evaluate((el) => el.scrollTop);
    assert.ok(middle > 0 && middle < max, `mid-photo scroll ${middle}/${max}`);
    await drag(35, false);
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".photo-viewer").count(), 1);
    assert.ok(
      Math.abs((await scroller.evaluate((el) => el.scrollTop)) - middle) <= 1,
      "cancelled drag preserves the tall photo's scroll position",
    );
    await drag(230, false);
    await closed();
    // Exercise the touch-specific edge arbitration and animated dismissal on mobile.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(300);
    for (const direction of [1, -1]) {
      await open();
      const dragged = await page
        .locator(".photo-viewer-scroll")
        .evaluate((scroll, direction) => {
          scroll.scrollTop = direction > 0 ? 0 : scroll.scrollHeight;
          function touchEvent(type, y) {
            const touch = { identifier: 1, clientX: 180, clientY: y };
            const list = [touch];
            list.item = (index) => list[index] ?? null;
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
              touches: { value: type === "touchend" ? [] : list },
              changedTouches: { value: list },
            });
            scroll.dispatchEvent(event);
          }
          touchEvent("touchstart", 400);
          touchEvent("touchmove", 400 + direction * 20);
          touchEvent("touchmove", 400 + direction * 250);
          const stage = scroll.querySelector(".photo-viewer-stage");
          const transform = stage.style.transform;
          touchEvent("touchend", 400 + direction * 250);
          return {
            transform,
            hero: document.querySelectorAll(".photo-viewer-hero").length,
            animations: document
              .querySelector(".photo-viewer")
              .getAnimations({ subtree: true }).length,
          };
        }, direction);
      assert.match(dragged.transform, /translate3d/);
      assert.equal(dragged.hero, 1, "swipe animates a hero back to the source");
      assert.ok(dragged.animations > 0, "dismissal is animated");
      await closed();
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(300);
    // High-resolution failure must not replace a working thumbnail.
    failLarge = true;
    await open(cards.nth(2));
    assert.equal(
      await page.locator(".photo-viewer-image-hires.is-loaded").count(),
      0,
    );
    assert.equal(
      await page.locator(".photo-viewer-image.is-visible").count(),
      1,
    );
    await page.click(".photo-viewer-close");
    await closed();
    // Keyboard and reduced motion use the same lifecycle without a spring.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await cards.first().focus();
    await page.keyboard.press("Enter");
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    assert.equal(
      await page
        .locator(".photo-viewer")
        .evaluate((el) => el.getAnimations({ subtree: true }).length),
      0,
    );
    await page.keyboard.press("Escape");
    await closed();
    // Closing still works if virtualization has removed the source tile.
    await open();
    await page.locator("#viewport").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await closed();
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: rows/masonry preview, swipe dismiss/reset, focus, reduced motion, failure and detached-source checks passed`,
    );
  } finally {
    await browser.close();
  }
}
