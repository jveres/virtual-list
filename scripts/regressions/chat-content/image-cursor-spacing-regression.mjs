// Real renderer geometry, synthetic embedded image; no API requests.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const [name, engine] of Object.entries({ firefox, chromium, webkit })) {
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
      const { initMarkdown, createMarkdownViewer, renderMarkdown } =
        await import("/demos/shared/markdown.ts");
      await initMarkdown();
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const image = `![Generated](${canvas.toDataURL("image/png")})`;
      const { buildToolCall } = await import("/demos/shared/chat-ui.ts");
      const results = [];
      for (const [footer, precedingTools] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ]) {
        const text = `${precedingTools ? "" : "Before the image.\n\n"}${image}\n\n`;
        const row = document.createElement("article");
        row.className = "message assistant";
        row.style.cssText = "position:fixed;left:0;top:0;width:400px";
        const host = document.createElement("div");
        const content = document.createElement("div");
        content.className = "message-content";
        const tools = document.createElement("div");
        tools.className = "tool-calls";
        if (precedingTools) {
          for (const name of ["thinking", "image_generation"])
            tools.append(
              buildToolCall({
                name,
                status: "done",
                durationMs: 1,
                input: "",
                output: "",
              }),
            );
          content.append(tools);
        }
        content.append(host);
        row.append(content);
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
        const previous = precedingTools
          ? tools
          : host.querySelector(".markdown > p");
        if (!img || !cursor || !previous)
          throw new Error("Missing image/cursor fixture");
        await img.decode();
        const imageRect = img.getBoundingClientRect();
        const beforeHeight = row.getBoundingClientRect().height;
        const cursorHeight = cursor.getBoundingClientRect().height;
        const rendererLineSize = getComputedStyle(
          host.querySelector(".markdown"),
        )
          .getPropertyValue("--cursor-line-size")
          .trim();
        const above = imageRect.top - previous.getBoundingClientRect().bottom;
        const below = cursor.getBoundingClientRect().top - imageRect.bottom;
        viewer.update({ text, isStreaming: false });
        await frame();
        const afterHeight = row.getBoundingClientRect().height;
        viewer.destroy();
        const staticHost = document.createElement("div");
        staticHost.className = "markdown-viewer";
        staticHost.innerHTML = `<div class="markdown">${renderMarkdown(text)}</div>`;
        host.replaceWith(staticHost);
        const staticImage = staticHost.querySelector("img");
        await staticImage.decode();
        const staticPrevious = precedingTools
          ? tools
          : staticHost.querySelector(".markdown > p");
        results.push({
          precedingTools,
          footer,
          cursorHeight,
          rendererLineSize,
          above,
          below,
          beforeHeight,
          afterHeight,
          staticHeight: row.getBoundingClientRect().height,
          staticAbove:
            staticImage.getBoundingClientRect().top -
            staticPrevious.getBoundingClientRect().bottom,
        });
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
      assert.equal(result.above, 16, JSON.stringify(result));
      assert.equal(result.staticAbove, result.above, JSON.stringify(result));
      assert.ok(
        Math.abs(result.staticHeight - result.afterHeight) < 0.5,
        JSON.stringify(result),
      );
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
