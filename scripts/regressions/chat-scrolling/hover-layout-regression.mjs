// Hover must not change virtual-row geometry as content passes the pointer.
// Inspect the loaded cascade, including the pinned Markdown renderer's CSS.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, webkit]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch({ timeout: 15000 });
  try {
    for (const demo of ["streaming", "gallery"]) {
      const page = await browser.newPage();
      try {
        await page.goto(`${base}/demos/${demo}/`);
        await page.waitForFunction(
          () => !document.documentElement.classList.contains("booting"),
        );
        if (demo === "streaming")
          await page
            .locator(".message.assistant .markdown-viewer")
            .first()
            .waitFor();
        const result = await page.evaluate(() => {
          // An explicit allowlist also rejects custom properties that could
          // indirectly change padding, dimensions, typography, or transforms.
          const paintOnly = new Set([
            "color",
            "background",
            "background-color",
            "background-image",
            "background-position",
            "background-position-x",
            "background-position-y",
            "background-size",
            "background-repeat",
            "background-origin",
            "background-clip",
            "background-attachment",
            "border-color",
            "border-top-color",
            "border-right-color",
            "border-bottom-color",
            "border-left-color",
            "opacity",
            "pointer-events",
            "text-decoration",
            "text-decoration-line",
            "text-decoration-style",
            "text-decoration-color",
            "text-decoration-thickness",
          ]);
          let hoverRules = 0;
          const unexpected = [];
          function inspect(rules) {
            for (const rule of rules) {
              if (rule.selectorText?.includes(":hover")) {
                hoverRules++;
                for (const property of rule.style) {
                  if (!paintOnly.has(property))
                    unexpected.push({ selector: rule.selectorText, property });
                }
              }
              if (rule.cssRules) inspect(rule.cssRules);
              if (rule.styleSheet) inspect(rule.styleSheet.cssRules);
            }
          }
          // An unreadable stylesheet must fail instead of silently passing.
          for (const sheet of document.styleSheets) inspect(sheet.cssRules);
          return { hoverRules, unexpected };
        });
        assert.ok(result.hoverRules > 0, `${demo}: no hover rules inspected`);
        assert.deepEqual(
          result.unexpected,
          [],
          `${demo}: hover changes layout`,
        );
        console.log(
          `${engine.name()} ${demo}: ${result.hoverRules} paint-only hover rules`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
