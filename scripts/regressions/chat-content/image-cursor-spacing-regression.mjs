// Real renderer geometry, synthetic embedded image; no API requests.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const [name, engine] of Object.entries({ firefox, webkit })) {
  if (process.env.BROWSER_ENGINE && process.env.BROWSER_ENGINE !== name)
    continue;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://api.openai.com/**", (route) => route.abort());
    await page.route("**/__chatgpt/**", (route) => route.abort());
    await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html",
    });
    const measurements = await page.evaluate(async () => {
      const { initMarkdown, createMarkdownViewer } = await import(
        "/demos/shared/markdown.ts"
      );
      await initMarkdown();
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const image = `![Generated](${canvas.toDataURL("image/png")})`;
      const text = `Before the image.\n\n${image}\n\n`;
      const results = [];
      for (const footer of [false, true]) {
        const row = document.createElement("article");
        row.className = "message assistant";
        row.style.cssText = "position:fixed;left:0;top:0;width:400px";
        const host = document.createElement("div");
        row.append(host);
        if (footer) {
          const actions = document.createElement("div");
          actions.className = "message-actions";
          row.append(actions);
        }
        document.body.append(row);
        const viewer = createMarkdownViewer(host, {
          text,
          isStreaming: true,
          cursor: "bar",
          unfocusedCursorStyle: "block",
        });
        const frame = () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        await frame();
        const img = host.querySelector("img");
        const cursor = host.querySelector(".markdown > .cursor");
        const previous = host.querySelector(".markdown > p");
        if (!img || !cursor || !previous)
          throw new Error("Missing image/cursor fixture");
        await img.decode();
        const imageRect = img.getBoundingClientRect();
        const beforeHeight = row.getBoundingClientRect().height;
        const cursorHeight = cursor.getBoundingClientRect().height;
        const above = imageRect.top - previous.getBoundingClientRect().bottom;
        const below = cursor.getBoundingClientRect().top - imageRect.bottom;
        viewer.update({ text, isStreaming: false });
        await frame();
        results.push({
          footer,
          cursorHeight,
          rendererLineSize: getComputedStyle(host.querySelector(".markdown"))
            .getPropertyValue("--cursor-line-size")
            .trim(),
          above,
          below,
          beforeHeight,
          afterHeight: row.getBoundingClientRect().height,
        });
        viewer.destroy();
        row.remove();
      }
      return results;
    });
    for (const result of measurements) {
      if (process.env.MARKDOWN_VIEWER_LOCAL === "1") {
        assert.equal(
          result.rendererLineSize,
          "1lh",
          "Local preview must use the rebuilt cursor CSS",
        );
      }
      assert.ok(result.above > 0, JSON.stringify(result));
      assert.ok(
        Math.abs(result.above - result.below) < 0.5,
        JSON.stringify(result),
      );
      assert.ok(
        Math.abs(result.beforeHeight - result.afterHeight) < 0.5,
        JSON.stringify(result),
      );
    }
    console.log(
      `PASS ${name}: equal image top/bottom gaps, stable stream-end height ${JSON.stringify(measurements)}`,
    );
  } finally {
    await browser.close();
  }
}
