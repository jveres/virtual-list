// Visual diagnostic, not a passing regression: WebKit paints highlight
// backgrounds above wrapped lines even when Range rectangles are tight.
// Run against a dev server; inspect the PNGs, not just the logged rectangles.
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const output = "browser-artifacts/streaming-trail";
await mkdir(output, { recursive: true });
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 700, height: 300 },
      deviceScaleFactor: 2,
    });
    await page.route("**/__trail-wrap-probe", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body style="margin:30px;background:white;color:black"><div id="root" style="width:600px;font:24px/2 Arial;--cursor-color:#f5a1ff"><p></p></div>',
      }),
    );
    await page.goto(`${base}/__trail-wrap-probe`);
    const rectangles = await page.evaluate(() => {
      const root = document.querySelector("#root");
      root.firstChild.textContent =
        "If those remain stable, the demo is covering the failure modes that are easy to miss with very short responses.";
      // No morphing, observer or animation: isolate native highlight painting.
      const range = document.createRange();
      range.setStart(root.firstChild.firstChild, 0);
      range.setEnd(
        root.firstChild.firstChild,
        root.firstChild.textContent.length,
      );
      CSS.highlights.set("wrap-probe", new Highlight(range));
      const style = document.createElement("style");
      style.textContent = [...CSS.highlights.keys()]
        .map((name) => `::highlight(${name}) { background-color: #f5a1ffaa; }`)
        .join("\n");
      document.head.append(style);
      return [...CSS.highlights.values()].flatMap((highlight) =>
        [...highlight].flatMap((range) =>
          [...range.getClientRects()].map((rect) => rect.toJSON()),
        ),
      );
    });
    await page.screenshot({ path: `${output}/${engine.name()}-wrap.png` });
    console.log(
      JSON.stringify({
        engine: engine.name(),
        version: browser.version(),
        rectangles,
      }),
    );
    await page.evaluate(() => CSS.highlights.clear());
  } finally {
    await browser.close();
  }
}
