// Web Share is stubbed: validates the integration without transferring user data.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of ["firefox", "webkit"]) {
  const browser = await { firefox, webkit }[engine].launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const alerts = [];
    let downloads = 0;
    page.on("download", () => downloads++);
    page.on("dialog", async (dialog) => {
      if (dialog.type() === "alert") alerts.push(dialog.message());
      await dialog.accept();
    });
    await page.addInitScript(() => {
      window.shareMode = "markdown";
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: ({ files }) => {
          return (
            window.shareMode !== "unsupported" &&
            (window.shareMode !== "plain" || files[0].type === "text/plain")
          );
        },
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: (data) => {
          window.sharedFile = data.files[0];
          window.sharedWithActivation = navigator.userActivation.isActive;
          if (window.shareMode === "cancel")
            return Promise.reject(new DOMException("Cancelled", "AbortError"));
          if (window.shareMode === "error")
            return Promise.reject(
              new DOMException("Permission denied", "NotAllowedError"),
            );
          return new Promise((resolve) => {
            window.finishShare = resolve;
          });
        },
      });
    });
    const errors = await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
    });
    const attachment = {
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      dataUrl: "data:text/plain;base64,aGVsbG8=",
    };
    await page.locator("#import-file").setInputFiles({
      name: "share.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        `**User**\n<!-- turn ${JSON.stringify({ attachments: [attachment] })} -->\n\nShare this chat.\n\n**Assistant**\n\nComplete answer.\n`,
      ),
    });
    await page.getByText("Complete answer.", { exact: true }).waitFor();
    for (const mode of ["markdown", "plain"]) {
      await page.evaluate((mode) => {
        window.shareMode = mode;
      }, mode);
      await page.locator("#share-btn").click();
      assert.equal(await page.locator("#share-btn").isDisabled(), true);
      const shared = await page.evaluate(async () => {
        const { parseTranscriptMarkdown } = await import(
          "/demos/streaming/transcript.ts"
        );
        return {
          name: window.sharedFile.name,
          activation: window.sharedWithActivation,
          turns: parseTranscriptMarkdown(await window.sharedFile.text()),
        };
      });
      assert.equal(shared.activation, true);
      assert.equal(
        shared.name.endsWith(mode === "plain" ? ".txt" : ".md"),
        true,
      );
      assert.deepEqual(shared.turns, [
        {
          role: "user",
          markdown: "Share this chat.",
          attachments: [attachment],
        },
        { role: "assistant", markdown: "Complete answer." },
      ]);
      await page.evaluate(() => window.finishShare());
      await page.waitForFunction(
        () => !document.getElementById("share-btn").disabled,
      );
    }
    for (const mode of ["cancel", "error", "unsupported"]) {
      await page.evaluate((mode) => {
        window.shareMode = mode;
      }, mode);
      await page.locator("#share-btn").click();
      await page.waitForFunction(
        () => !document.getElementById("share-btn").disabled,
      );
    }
    assert.equal(
      downloads,
      0,
      "cancelling or failing a share must not trigger a download",
    );
    assert.equal(alerts.length, 2);
    assert.equal(
      alerts.every((message) => message.includes("Download")),
      true,
    );
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const fits = await page.evaluate(() =>
        [...document.querySelectorAll(".header-actions button")].every(
          (button) => {
            const rect = button.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          },
        ),
      );
      assert.equal(fits, true, `header controls fit at ${width}px`);
    }
    await page.screenshot({
      path: `browser-artifacts/chat-share-${engine}.png`,
    });
    const download = page.waitForEvent("download");
    await page.locator("#download-btn").click();
    assert.match((await download).suggestedFilename(), /^chat-.*\.md$/);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        sharing: "passed",
        nativeTransfer: "not exercised",
      }),
    );
  } finally {
    await browser.close();
  }
}
