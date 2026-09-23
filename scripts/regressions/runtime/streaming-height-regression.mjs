// Offline layout regression for the streaming demo's real message adapter.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const browser = await { firefox, chromium, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = await openStreamingDemo(page, base);
  for (const cursor of ["bar", "none"]) {
    const result = await page.evaluate(async (cursor) => {
      const { createMessageContent } = await import(
        "/demos/streaming/message-content.ts"
      );
      const row = document.createElement("div");
      row.className = "message assistant";
      row.style.width = "400px";
      const host = document.createElement("div");
      host.className = "message-content";
      row.append(host);
      document.body.append(row);
      const handle = createMessageContent(host, cursor);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      const source = (count) =>
        Array.from({ length: count }, (_, index) => `Paragraph ${index}.`).join(
          "\n\n",
        );
      const heights = [];
      try {
        for (const count of [20, 10, 15, 30]) {
          const text = source(count);
          handle.update({ markdown: text }, text, true);
          await settle();
          heights.push(host.getBoundingClientRect().height);
        }
        const text = source(30);
        handle.update({ markdown: text }, text, false);
        await settle();
        return {
          heights,
          completed: host.getBoundingClientRect().height,
          minimum: Number.parseFloat(
            host.querySelector(".markdown").style.minHeight,
          ),
        };
      } finally {
        handle.destroy();
        row.remove();
      }
    }, cursor);
    assert.equal(
      result.heights[1],
      result.heights[0],
      "shrinkage must retain height",
    );
    assert.equal(
      result.heights[2],
      result.heights[0],
      "growth must reuse retained space",
    );
    assert.ok(
      result.heights[3] > result.heights[0],
      "content must grow past the minimum",
    );
    assert.equal(
      result.completed,
      result.heights[3],
      "completion must retain height",
    );
    assert.ok(
      result.minimum > 0,
      "the demo must enable the viewer's height guard",
    );
    console.log(
      JSON.stringify({ engine, cursor, ...result, result: "passed" }),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
