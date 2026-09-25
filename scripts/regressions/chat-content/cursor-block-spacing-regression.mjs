// Real renderer lifecycle: only the block before a bare cursor loses its gap.
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
    const errors = await openStreamingDemo(page, base);
    const results = await page.evaluate(async () => {
      const { initMarkdown, createMarkdownViewer } = await import(
        "/demos/shared/markdown.ts"
      );
      await initMarkdown();
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:0;top:0;width:400px";
      document.body.append(host);
      const viewer = createMarkdownViewer(host, {
        text: "",
        isStreaming: true,
        cursor: "bar",
        throttleMs: 0,
      });
      const results = [];
      const frame = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      const measure = async (
        stage,
        text,
        isStreaming = true,
        reset = false,
      ) => {
        const options = { text, isStreaming, cursor: "bar" };
        if (reset) viewer.reset();
        viewer.update(options);
        await frame();
        const markdown = host.querySelector(".markdown");
        const blocks = [...markdown.children].filter(
          (node) => !node.classList.contains("cursor"),
        );
        const cursor = markdown.querySelector("[data-cursor]");
        results.push({
          stage,
          bare: cursor?.parentElement === markdown,
          margins: blocks.map((block) =>
            Number.parseFloat(getComputedStyle(block).marginBottom),
          ),
          nestedLastMargin: blocks.at(-1)?.lastElementChild
            ? Number.parseFloat(
                getComputedStyle(blocks.at(-1).lastElementChild).marginBottom,
              )
            : null,
        });
      };
      try {
        const two = "First paragraph.\n\nSecond paragraph.\n\n";
        await measure("bare", two);
        await measure("same block", two.replace("Second", "Updated second"));
        await measure("inline", `${two}Third paragraph.`);
        await measure("bare again", `${two}Third paragraph.\n\n`);
        await measure("finalized", `${two}Third paragraph.\n\n`, false);
        await measure("reset", two, true, true);
        await measure("nested math", "First paragraph.\n\n$$x^2$$\n\n");
        return results;
      } finally {
        viewer.destroy();
        host.remove();
      }
    });
    for (const result of results) {
      assert.equal(
        result.bare,
        !["inline", "finalized"].includes(result.stage),
        JSON.stringify(result),
      );
      assert.equal(result.margins.at(-1), 0, JSON.stringify(result));
      assert.ok(
        result.margins.slice(0, -1).every((margin) => margin === 16),
        JSON.stringify(result),
      );
      if (result.stage === "nested math")
        assert.equal(result.nestedLastMargin, 0, JSON.stringify(result));
    }
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${name}: cursor block spacing across edits, moves, reset, and finalization`,
    );
  } finally {
    await browser.close();
  }
}
