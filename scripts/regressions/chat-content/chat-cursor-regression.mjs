// Offline streaming cursor lifecycle: idle while virtualized away, then remount.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  openAIStreamMock,
} from "../shared/openai-stream.mjs";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

const CURSOR_DELTA = "Waiting for the image. ";

for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    await page.addInitScript(openAIStreamMock, {
      settings: OFFLINE_AI_SETTINGS,
      emitText: "sendCursorDelta",
      initialText: CURSOR_DELTA,
    });
    await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
      acceptDialogs: true,
    });
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
    await importTranscript(page, transcript, { name: "cursor.md" });
    await page.getByText("Turn 23.", { exact: false }).waitFor();
    await page.locator("#prompt").fill("Generate an image");
    await page.locator("#send-btn").click();
    const cursor = page.locator("#viewport [data-cursor]");
    await page.waitForFunction(
      () => typeof window.sendCursorDelta === "function",
    );
    await cursor.waitFor({ state: "attached" });
    await page.evaluate((delta) => {
      window.cursorBeforeDetach = document.querySelector(
        "#viewport [data-cursor]",
      );
      window.sendCursorDelta(delta);
    }, CURSOR_DELTA);
    await page.waitForFunction(() =>
      window.cursorBeforeDetach.classList.contains("cursor-active"),
    );
    const redundantClassWrites = await page.evaluate(async (delta) => {
      const mutations = [];
      const observer = new MutationObserver((records) =>
        mutations.push(...records),
      );
      observer.observe(window.cursorBeforeDetach, {
        attributes: true,
        attributeFilter: ["class"],
      });
      window.sendCursorDelta(delta);
      await new Promise((resolve) => setTimeout(resolve, 200));
      mutations.push(...observer.takeRecords());
      observer.disconnect();
      return mutations.length;
    }, CURSOR_DELTA);
    assert.equal(
      redundantClassWrites,
      0,
      "continued streaming must not rewrite an already active cursor class",
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
    assert.equal(
      await page.evaluate(() =>
        window.cursorBeforeDetach.classList.contains("cursor-active"),
      ),
      false,
      "the retained cursor becomes idle even while detached",
    );
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
    await page.evaluate((delta) => window.sendCursorDelta(delta), CURSOR_DELTA);
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
