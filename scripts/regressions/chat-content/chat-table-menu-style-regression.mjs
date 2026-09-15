import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, webkit]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto(base);
    const weights = await page.evaluate(async () => {
      await import("/demos/shared/styles.css");
      const { createMarkdownViewer, initMarkdown } = await import(
        "/demos/shared/markdown.ts"
      );
      await initMarkdown();
      const host = document.createElement("div");
      const appButton = document.createElement("button");
      document.body.append(host, appButton);
      const viewer = createMarkdownViewer(host, {
        text: "| Item | Value |\n| --- | --- |\n| First | Text |",
      });
      try {
        return {
          app: getComputedStyle(appButton).fontWeight,
          menu: [...host.querySelectorAll(".table-copy-option")].map(
            (option) => getComputedStyle(option).fontWeight,
          ),
        };
      } finally {
        viewer.destroy();
        host.remove();
        appButton.remove();
      }
    });
    assert.equal(weights.app, "600");
    assert.deepEqual(weights.menu, ["400", "400", "400", "400"]);
    console.log(
      `${engine.name()}: chat button weight does not leak into renderer copy menus`,
    );
  } finally {
    await browser.close();
  }
}
