// Reuses the gallery viewer in real chat DOM; no live API requests.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.addInitScript(() => {
      localStorage.setItem(
        "virtual-list:ai-settings",
        JSON.stringify({
          provider: "openai",
          apiKey: "offline-test",
          model: "gpt-5-mini",
        }),
      );
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (!String(input).startsWith("https://api.openai.com/"))
          return originalFetch(input, init);
        window.previewRequestStarted = true;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              window.previewRequestAborted = true;
              reject(new DOMException("Cancelled", "AbortError"));
            },
            { once: true },
          );
        });
      };
    });
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
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
    await page.locator("#import-file").setInputFiles({
      name: "photo.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(markdown),
    });
    const photo = page.locator("#viewport img.photo-preview-card").first();
    await photo.waitFor();
    assert.equal(
      await photo.evaluate((image) => getComputedStyle(image).cursor),
      "default",
    );
    assert.equal(await photo.getAttribute("aria-label"), "Preview Landscape");
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
    await page.keyboard.press("Escape");
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
    await page.locator("#import-file").setInputFiles({
      name: "attachment.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(attachmentMarkdown),
    });
    const attached = page.getByRole("button", {
      name: "Preview attached.png",
      exact: true,
    });
    await attached.waitFor();
    await attached.click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    assert.equal(
      await page.locator(".photo-viewer-image").first().getAttribute("src"),
      url,
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
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
