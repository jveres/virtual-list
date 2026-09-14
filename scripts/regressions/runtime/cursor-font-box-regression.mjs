import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const output = "browser-artifacts/cursor-font-box";
await mkdir(output, { recursive: true });
const cases = [
  ["paragraph", `${"Wrapped paragraph with several words. ".repeat(5)}end`],
  ["heading", "## Heading end"],
  ["list", "- List end"],
  ["quote", "> Quote end"],
  ["table", "| A | B |\n|---|---|\n| x | end"],
  ["code", "```ts\nconst value = end"],
  ["inline-code", "Text `code end"],
];
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.route("**/__cursor-font-box", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body style="margin:30px;background:white"><div id="host" style="width:500px"></div><button id="outside">Outside</button>',
      }),
    );
    await page.goto(`${base}/__cursor-font-box`);
    await page.evaluate(async () => {
      const { createMarkdownViewer, initMarkdown } = await import(
        "/demos/shared/markdown.ts"
      );
      await initMarkdown();
      window.mountCursor = (text, trail) => {
        window.viewer?.destroy();
        window.viewer = createMarkdownViewer(document.querySelector("#host"), {
          text,
          isStreaming: true,
          streamingTrail: trail ? {} : false,
          throttleMs: 0,
          focusOnStreamingStart: false,
          unfocusedCursorStyle: "block",
        });
        window.viewer.getContainer().style.cssText =
          "font:24px/2 Arial;--cursor-color:rgb(245,161,255)";
      };
    });
    for (const [name, source] of cases) {
      const measures = [];
      for (const trail of [false, true]) {
        await page.evaluate(
          ([source, trail]) => window.mountCursor(source, trail),
          [source, trail],
        );
        const measured = await page.evaluate(() => {
          const root = window.viewer.getContainer();
          const cursor = root.querySelector("[data-cursor]");
          if (!cursor) throw new Error("Missing streaming cursor");
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let previous;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (
              node.data.trim() &&
              !node.parentElement.closest("button,[data-cursor]") &&
              node.compareDocumentPosition(cursor) &
                Node.DOCUMENT_POSITION_FOLLOWING
            )
              previous = node;
          }
          if (!previous) throw new Error("Missing preceding text");
          const range = document.createRange();
          range.selectNodeContents(previous);
          const reference = [...range.getClientRects()].at(-1);
          const box = cursor.getBoundingClientRect();
          const before = root.getBoundingClientRect().height;
          cursor.style.display = "none";
          const without = root.getBoundingClientRect().height;
          cursor.style.removeProperty("display");
          return {
            height: box.height,
            top: box.top,
            textHeight: reference.height,
            textTop: reference.top,
            width: box.width,
            before,
            without,
          };
        });
        assert.ok(
          Math.abs(measured.height - measured.textHeight) < 0.6,
          `${engine.name()} ${name} trail=${trail}: ${JSON.stringify(measured)}`,
        );
        assert.ok(
          Math.abs(measured.top - measured.textTop) < 0.6,
          `${engine.name()} ${name}: cursor must share the text baseline: ${JSON.stringify(measured)}`,
        );
        assert.ok(
          Math.abs(measured.width) < 0.1,
          `${name}: cursor must not advance text`,
        );
        assert.equal(
          measured.before,
          measured.without,
          `${name}: cursor must not change paragraph or table height`,
        );
        measures.push(measured);
        await page.screenshot({
          path: `${output}/${engine.name()}-${name}-${trail ? "trail" : "plain"}.png`,
        });
        const hollow = await page.evaluate(() => {
          window.viewer.update({ unfocusedCursorStyle: "hollow" });
          document.querySelector("#outside").focus();
          const style = getComputedStyle(
            window.viewer.getContainer().querySelector("[data-cursor]"),
            "::after",
          );
          return {
            background: style.backgroundColor,
            outline: style.backgroundImage,
            radius: style.borderRadius,
          };
        });
        assert.equal(hollow.background, "rgba(0, 0, 0, 0)");
        assert.notEqual(
          hollow.outline,
          "none",
          `${name}: unfocused cursor must remain visible`,
        );
        assert.equal(
          hollow.radius,
          "2px",
          `${name}: cursor corners are rounded by default`,
        );
      }
      assert.deepEqual(
        measures[0],
        measures[1],
        `${name}: cursor geometry must not depend on the trail`,
      );
    }
    for (const source of ["", "---\n\n"]) {
      await page.evaluate(
        (source) => window.mountCursor(source, false),
        source,
      );
      const bare = await page.evaluate(() => {
        const root = window.viewer.getContainer();
        const cursor = root.querySelector(":scope > [data-cursor]");
        if (!cursor) throw new Error("Expected standalone cursor");
        return {
          height: cursor.getBoundingClientRect().height,
          fontSize: parseFloat(getComputedStyle(cursor).fontSize),
        };
      });
      assert.equal(
        bare.height,
        bare.fontSize,
        "Standalone cursors retain their one-em layout reservation",
      );
    }
    await page.evaluate(() => window.viewer.destroy());
    console.log(
      `${engine.name()} ${browser.version()}: font-box height, baseline, zero advance, trail independence, hollow state, and standalone spacing passed`,
    );
  } finally {
    await browser.close();
  }
}
