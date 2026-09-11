// Deterministic VisualViewport geometry checks, not native iPad gesture emulation.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 820, height: 1180 },
      hasTouch: true,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await page.evaluate(async () => {
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
      source.style.cssText = "position:fixed;top:100px;left:100px;width:200px";
      document.body.append(source);
      await source.decode();
      const controller = createPhotoPreview({
        viewport: document.body,
        thumbnailUrl: () => url,
        previewUrl: () => url,
        nativeImageMenu: true,
      });
      controller.bind(source, {
        id: 1,
        aspectRatio: 0.75,
        width: 640,
        height: 480,
      });
      const animate = Element.prototype.animate;
      window.heldAnimations = [];
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (
          window.holdAnimations &&
          this.matches(".photo-viewer-frame,.photo-viewer-hero")
        ) {
          animation.pause();
          animation.currentTime = 0;
          window.heldAnimations.push(animation);
        }
        return animation;
      };
      source.click();
      window.zoomController = controller;
      window.zoomSource = source;
      window.testViewport = {
        width: visualViewport.width,
        height: visualViewport.height,
        scale: 1,
        offsetLeft: 0,
        offsetTop: 0,
      };
      for (const key of Object.keys(window.testViewport)) {
        Object.defineProperty(visualViewport, key, {
          configurable: true,
          get: () => window.testViewport[key],
        });
      }
      // WebKit reports visual (not layout) dimensions through window.inner*.
      window.originalInnerDimensions = {
        innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
        innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight"),
      };
      Object.defineProperties(window, {
        innerWidth: {
          configurable: true,
          get: () => window.testViewport.width,
        },
        innerHeight: {
          configurable: true,
          get: () => window.testViewport.height,
        },
      });
    });
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.waitForTimeout(650);
    const measure = () =>
      page.evaluate(() => {
        const frame = document.querySelector(".photo-viewer-frame");
        const overlay = document.querySelector(".photo-viewer");
        const close = document.querySelector(".photo-viewer-close");
        const rect = frame.getBoundingClientRect();
        const button = close.getBoundingClientRect();
        return {
          frame: [rect.x, rect.y, rect.width, rect.height],
          overlay: [overlay.clientWidth, overlay.clientHeight],
          button: [button.x, button.y, button.width, button.height],
        };
      });
    const normal = await measure();
    const setViewport = async (values) => {
      await page.evaluate((values) => {
        Object.assign(window.testViewport, values);
        visualViewport.dispatchEvent(new Event("resize"));
        visualViewport.dispatchEvent(new Event("scroll"));
      }, values);
      await page.waitForTimeout(50);
    };
    // A size notification can precede its matching scale notification.
    await setViewport({ width: 410, height: 590 });
    assert.deepEqual(
      await measure(),
      normal,
      "partial pinch metrics do not refit",
    );
    await setViewport({
      width: 410,
      height: 590,
      scale: 2,
      offsetLeft: 150,
      offsetTop: 200,
    });
    const zoomed = await measure();
    assert.deepEqual(zoomed.frame, normal.frame, "pinch must not refit image");
    assert.deepEqual(zoomed.overlay, normal.overlay, "pinch preserves layout");
    assert.deepEqual(zoomed.button, normal.button);
    // Safari may deliver size and scale in separate viewport updates.
    await setViewport({ width: 375, height: 540 });
    assert.deepEqual(
      await measure(),
      zoomed,
      "partial metrics cannot relayout",
    );
    await setViewport({ offsetLeft: 250, offsetTop: 350 });
    const panned = await measure();
    assert.deepEqual(panned.frame, normal.frame, "pan must not move image");
    assert.deepEqual(panned.button, normal.button);
    // One-finger movement while magnified belongs to native panning.
    const pan = await page.evaluate(() => {
      const scroll = document.querySelector(".photo-viewer-scroll");
      const touch = (y) => ({
        identifier: 7,
        target: scroll,
        clientX: 350,
        clientY: y,
      });
      const list = (items) => Object.assign(items, { item: (i) => items[i] });
      const event = (type, y) => {
        const result = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(result, {
          touches: { value: list(type === "touchend" ? [] : [touch(y)]) },
          changedTouches: { value: list([touch(y)]) },
        });
        return result;
      };
      scroll.dispatchEvent(event("touchstart", 400));
      const move = event("touchmove", 550);
      scroll.dispatchEvent(move);
      const swiping = scroll.classList.contains("is-swiping");
      scroll.dispatchEvent(event("touchend", 550));
      return { prevented: move.defaultPrevented, swiping };
    });
    assert.deepEqual(pan, { prevented: false, swiping: false });
    await setViewport({
      width: 820,
      height: 1180,
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
    });
    assert.deepEqual((await measure()).frame, normal.frame);
    await page.locator(".photo-viewer-close").click();
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    await setViewport({
      width: 410,
      height: 590,
      scale: 2,
      offsetLeft: 150,
      offsetTop: 200,
    });
    await page.evaluate(() => {
      window.holdAnimations = true;
      window.zoomSource.click();
    });
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    const opening = await page
      .locator(".photo-viewer-frame")
      .evaluate((frame) =>
        frame
          .getAnimations()
          .flatMap((animation) => animation.effect.getKeyframes()),
      );
    assert.ok(opening.length > 0, "zoomed opening animates");
    assert.ok(
      opening.every((frame) => typeof frame.transform === "string"),
      "zoomed opening retains the thumbnail transition",
    );
    const duringOpening = await measure();
    await setViewport({
      scale: 3,
      width: 820 / 3,
      height: 1180 / 3,
      offsetLeft: 200,
    });
    assert.deepEqual(
      await measure(),
      duringOpening,
      "pinch does not cancel or retarget an in-flight opening",
    );
    await page.evaluate(() => {
      for (const a of window.heldAnimations) a.finish();
    });
    await page.waitForTimeout(550);
    assert.deepEqual((await measure()).frame, normal.frame);
    // Exercise overlay-relative geometry with an origin different from the window.
    await page.locator(".photo-viewer").evaluate((overlay) => {
      overlay.style.transform = "translate(37px, 29px)";
    });
    const beforeClose = (await measure()).frame;
    await page.evaluate(() => {
      void window.zoomController.close();
    });
    const closing = await page
      .locator(".photo-viewer-hero")
      .evaluate((hero) => {
        const r = hero.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      });
    for (let i = 0; i < 4; i++)
      assert.ok(
        Math.abs(closing[i] - beforeClose[i]) < 0.1,
        "closing hero starts at the displayed image",
      );
    await page.evaluate(() => {
      for (const a of window.heldAnimations)
        if (a.playState !== "idle") a.finish();
    });
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    await page.evaluate(() => {
      Object.defineProperties(window, window.originalInnerDimensions);
      Object.assign(window.testViewport, {
        scale: 1,
        width: 820,
        height: 1180,
        offsetLeft: 0,
        offsetTop: 0,
      });
      window.holdAnimations = false;
      window.zoomSource.click();
    });
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.waitForTimeout(550);
    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForTimeout(100);
    const resized = await measure();
    assert.deepEqual(
      resized.overlay,
      [640, 900],
      "real window resize still relayouts preview",
    );
    assert.ok(
      resized.frame[2] < normal.frame[2],
      "image fits the resized window",
    );
    await page.evaluate(() => window.zoomController.close(false));
    await page.evaluate(() => window.zoomController.dispose());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
