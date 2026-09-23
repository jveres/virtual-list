// Reuses the gallery viewer in real chat DOM; no live API requests.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  pendingOpenAIMock,
  seedAISettings,
} from "../shared/openai-stream.mjs";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
// The viewer displays data URLs through object URLs; compare the bytes shown.
const displayedBytes = (image) =>
  image.evaluate(async (element) =>
    btoa(
      String.fromCharCode(
        ...new Uint8Array(await (await fetch(element.src)).arrayBuffer()),
      ),
    ),
  );
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
      hasTouch: true,
    });
    const assertSquareCorners = async (selector) => {
      const corners = await page.locator(selector).evaluate((element) => ({
        radius: getComputedStyle(element).borderRadius,
        clip: getComputedStyle(element).clipPath,
        animatedRadii: element
          .getAnimations()
          .flatMap((animation) =>
            animation.effect
              .getKeyframes()
              .flatMap((frame) =>
                frame.borderRadius === undefined ? [] : [frame.borderRadius],
              ),
          ),
      }));
      assert.equal(corners.radius, "0px");
      assert.match(corners.clip, /^inset\(0px(?: round 0px)?\)$/);
      for (const radius of corners.animatedRadii) assert.equal(radius, "0px");
    };
    await page.addInitScript(seedAISettings, OFFLINE_AI_SETTINGS);
    await page.addInitScript(pendingOpenAIMock, {
      started: "previewRequestStarted",
      aborted: "previewRequestAborted",
    });
    const errors = await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
      acceptDialogs: true,
    });
    const url = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d");
      context.fillStyle = "#6389a1";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    });
    const markdown = `**User**\n\nShow a picture\n\n**Assistant**\n\n[![Landscape](${url})](https://example.test/should-not-navigate)\n`;
    await importTranscript(page, markdown, { name: "photo.md" });
    const photo = page.locator("#viewport img.photo-preview-card").first();
    await photo.waitFor();
    assert.equal(
      await photo.evaluate((image) => getComputedStyle(image).cursor),
      "default",
    );
    assert.equal(await photo.getAttribute("aria-label"), "Preview Landscape");
    const touch = (type) =>
      photo.evaluate((image, type) => {
        const box = image.getBoundingClientRect();
        image.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 42,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            buttons: type === "pointerdown" ? 1 : 0,
            clientX: box.x + box.width / 2,
            clientY: box.y + box.height / 2,
          }),
        );
      }, type);
    // No app scaling while a native long-press is still being recognized.
    await touch("pointerdown");
    await page.waitForTimeout(700);
    assert.equal(
      await photo.evaluate((image) =>
        image.classList.contains("is-photo-pressed"),
      ),
      false,
    );
    assert.equal(
      await photo.evaluate((image) => getComputedStyle(image).transform),
      "none",
    );
    assert.equal(await page.locator(".photo-viewer").count(), 0);
    assert.equal(
      await photo.evaluate((image) =>
        image.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
          }),
        ),
      ),
      true,
    );
    await touch("pointerup");
    await photo.dispatchEvent("click", { button: 0 });
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator(".photo-viewer").count(),
      0,
      "long-press release must not open a preview",
    );
    // A subsequent short tap waits for the browser's click, then presses/opens.
    await touch("pointerdown");
    await touch("pointerup");
    assert.equal(await page.locator(".photo-viewer").count(), 0);
    assert.equal(
      await photo.evaluate((image) =>
        image.classList.contains("is-photo-pressed"),
      ),
      false,
    );
    await photo.dispatchEvent("click", { button: 0 });
    assert.equal(
      await photo.evaluate((image) =>
        image.classList.contains("is-photo-pressed"),
      ),
      true,
    );
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    // Exercise the browser-generated touch/click sequence too.
    await photo.tap();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    // The image itself remains a native Save Image / Copy Image target.
    assert.equal(
      await photo.evaluate((image) =>
        image.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
          }),
        ),
      ),
      true,
    );
    await photo.click({ button: "right" });
    assert.equal(await page.locator(".photo-viewer").count(), 0);
    await page.keyboard.press("Escape");
    await photo.click({ modifiers: ["Control"] });
    assert.equal(await page.locator(".photo-viewer").count(), 0);
    await page.keyboard.press("Escape");
    const initialUrl = page.url();
    const initialTop = await page
      .locator("#viewport")
      .evaluate((viewport) => viewport.scrollTop);
    await photo.click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    assert.equal(page.url(), initialUrl);
    assert.equal(await page.locator(".photo-viewer").count(), 1);
    assert.equal(
      await page.locator(".photo-viewer-details").textContent(),
      "Landscape",
    );
    await assertSquareCorners(".photo-viewer-frame");
    await page.locator(".photo-viewer-frame").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await assertSquareCorners(".photo-viewer-frame");
    await page.keyboard.press("Escape");
    await assertSquareCorners(".photo-viewer-hero");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    assert.equal(await photo.isVisible(), true);
    assert.equal(
      await page.locator(".shell").evaluate((shell) => shell.inert),
      false,
    );
    assert.ok(
      Math.abs(
        (await page
          .locator("#viewport")
          .evaluate((viewport) => viewport.scrollTop)) - initialTop,
      ) <= 1,
    );
    assert.equal(
      await photo.evaluate((image) => image === document.activeElement),
      true,
    );

    // Keyboard access uses the same gallery binding.
    await photo.press("Enter");
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page
      .getByRole("button", { name: "Close photo", exact: true })
      .click();
    await page.locator(".photo-viewer").waitFor({ state: "detached" });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await photo.click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await assertSquareCorners(".photo-viewer-frame");
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // A dynamically rendered image gets a binding, including late decoding.
    await page.evaluate((source) => {
      const image = document.createElement("img");
      image.alt = "New streamed image";
      document.querySelector(".message.assistant .markdown").append(image);
      image.src = source;
    }, url);
    const streamed = page.getByRole("button", {
      name: "Preview New streamed image",
      exact: true,
    });
    await streamed.waitFor();
    await streamed.click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });

    // Imported attachments use the original bytes, not the 40px thumbnail.
    const attachment = {
      name: "attached.png",
      mimeType: "image/png",
      dataUrl: url,
      size: Buffer.from(url.split(",")[1], "base64").length,
    };
    const attachmentMarkdown = `**User**\n<!-- turn ${JSON.stringify({ attachments: [attachment] })} -->\n\nAttached picture\n`;
    await importTranscript(page, attachmentMarkdown, { name: "attachment.md" });
    const attached = page.getByRole("button", {
      name: "Preview attached.png",
      exact: true,
    });
    await attached.waitFor();
    await attached.click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    assert.equal(
      await displayedBytes(page.locator(".photo-viewer-image").first()),
      url.split(",")[1],
    );
    assert.equal(
      await page.locator(".photo-viewer-details").textContent(),
      "attached.png",
    );
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    // Closing a modal must not also cancel a generation behind it.
    await page.locator("#prompt").fill("Keep generating while I preview");
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => window.previewRequestStarted);
    await attached.click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    assert.equal(await page.locator("#send-btn").textContent(), "Stop");
    assert.equal(
      await page.evaluate(() => window.previewRequestAborted === true),
      false,
    );
    // Once the modal is gone, Escape still cancels generation normally.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.previewRequestAborted === true);
    await page.waitForFunction(
      () => document.getElementById("send-btn").textContent === "Send",
    );
    assert.deepEqual(errors, []);
    if (engine === webkit) {
      // Exercise both iPhone identification and iPadOS's desktop platform.
      for (const platform of ["iPhone", "MacIntel"]) {
        const mobile = await browser.newPage({
          hasTouch: true,
          isMobile: true,
          viewport:
            platform === "iPhone"
              ? { width: 390, height: 844 }
              : { width: 820, height: 1180 },
        });
        await mobile.addInitScript((platform) => {
          Object.defineProperty(navigator, "platform", { get: () => platform });
          Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
        }, platform);
        await openStreamingDemo(mobile, base, {
          path: "/demos/streaming/index.html",
          acceptDialogs: true,
        });
        await importTranscript(mobile, markdown, { name: "mobile-photo.md" });
        const source = mobile
          .locator("#viewport img.photo-preview-card")
          .first();
        await source.waitFor();
        assert.equal(await source.evaluate((image) => image.draggable), false);
        assert.equal(
          await source.evaluate((image) =>
            getComputedStyle(image).getPropertyValue("-webkit-user-drag"),
          ),
          "none",
        );
        assert.equal(
          await source.evaluate((image) =>
            getComputedStyle(image.closest("a")).getPropertyValue(
              "-webkit-user-drag",
            ),
          ),
          "none",
        );
        assert.equal(
          await source.evaluate((image) =>
            image.classList.contains("native-image-menu"),
          ),
          false,
        );
        const menuAllowed = (element) =>
          element.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              button: 2,
            }),
          );
        assert.equal(
          await source.evaluate(menuAllowed),
          false,
          "iOS chat source suppresses native callout",
        );
        // If a platform callout/drag event arrives anyway, release must not
        // stack the custom viewer on top of the native image lift.
        await source.evaluate((image) => {
          const box = image.getBoundingClientRect();
          const pointer = {
            bubbles: true,
            isPrimary: true,
            pointerId: 7,
            pointerType: "touch",
            button: 0,
            clientX: box.x + box.width / 2,
            clientY: box.y + box.height / 2,
          };
          image.dispatchEvent(new PointerEvent("pointerdown", pointer));
          image.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
          );
          image.dispatchEvent(new PointerEvent("pointerup", pointer));
          image.dispatchEvent(
            new MouseEvent("click", { bubbles: true, button: 0 }),
          );
        });
        await mobile.waitForTimeout(250);
        assert.equal(await mobile.locator(".photo-viewer").count(), 0);
        assert.equal(
          await source.evaluate((image) =>
            image.dispatchEvent(
              new DragEvent("dragstart", { bubbles: true, cancelable: true }),
            ),
          ),
          false,
        );
        await source.tap();
        await mobile.locator(".photo-viewer:not(.is-preparing)").waitFor();
        assert.equal(
          await mobile
            .locator(".photo-viewer")
            .evaluate((viewer) =>
              viewer.classList.contains("native-image-menu"),
            ),
          true,
        );
        const fullImage = mobile
          .locator(".photo-viewer-image.is-visible")
          .first();
        await mobile.locator(".photo-viewer-frame").evaluate(async (frame) => {
          await Promise.all(
            frame.getAnimations().map((animation) => animation.finished),
          );
        });
        assert.equal(
          await fullImage.evaluate(menuAllowed),
          true,
          "iOS preview allows native callout",
        );
        assert.equal(await displayedBytes(fullImage), url.split(",")[1]);
        await mobile.keyboard.press("Escape");
        await mobile.locator(".photo-viewer").waitFor({ state: "detached" });
        await mobile.close();
      }
    }
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
