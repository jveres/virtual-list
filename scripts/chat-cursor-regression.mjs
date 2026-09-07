// Offline streaming cursor lifecycle: idle while virtualized away, then remount.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
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
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            window.sendCursorDelta = () =>
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "response.output_text.delta",
                    delta: "Waiting for the image. ",
                  })}\n\n`,
                ),
              );
            window.sendCursorDelta();
            init.signal.addEventListener(
              "abort",
              () =>
                controller.error(new DOMException("Cancelled", "AbortError")),
              { once: true },
            );
          },
        });
        return Promise.resolve(
          new Response(body, {
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      };
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(
      `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/index.html`,
    );
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 240;
      return canvas.toDataURL();
    });
    const transcript = Array.from(
      { length: 24 },
      (_, index) =>
        `${index % 2 ? "**Assistant**" : "**User**"}\n\n${index === 1 ? `![Earlier image](${image})\n\n` : ""}Turn ${index}. ${"Readable history content. ".repeat(index % 2 ? 60 : 5)}\n`,
    ).join("\n");
    await page.locator("#import-file").setInputFiles({
      name: "cursor.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(transcript),
    });
    await page.getByText("Turn 23.", { exact: false }).waitFor();
    await page.locator("#prompt").fill("Generate an image");
    await page.locator("#send-btn").click();
    const cursor = page.locator("#viewport [data-cursor]");
    await page.waitForFunction(
      () => typeof window.sendCursorDelta === "function",
    );
    await cursor.waitFor({ state: "attached" });
    await page.evaluate(() => {
      window.cursorBeforeDetach = document.querySelector(
        "#viewport [data-cursor]",
      );
      window.sendCursorDelta();
    });
    await page.waitForFunction(() =>
      window.cursorBeforeDetach.classList.contains("cursor-active"),
    );
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -1000, bubbles: true }),
      );
      viewport.scrollTop = 0;
    });
    await cursor.waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: "Preview Earlier image", exact: true })
      .click();
    await page.locator(".photo-viewer:not(.is-preparing)").waitFor();
    await page.waitForTimeout(750);
    await page.keyboard.press("Escape");
    await page.locator(".photo-viewer").waitFor({ state: "detached" });
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    await cursor.waitFor({ state: "attached" });
    assert.equal(
      await cursor.evaluate((element) => element === window.cursorBeforeDetach),
      true,
      "retained cursor remounts",
    );
    assert.equal(
      await cursor.evaluate((element) =>
        element.classList.contains("cursor-active"),
      ),
      false,
      "an idle remounted cursor must blink",
    );
    await page.evaluate(() => window.sendCursorDelta());
    await page.waitForFunction(() =>
      document
        .querySelector("#viewport [data-cursor]")
        ?.classList.contains("cursor-active"),
    );
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#viewport [data-cursor]")
          ?.classList.contains("cursor-active"),
    );
    await page.locator("#send-btn").click();
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
