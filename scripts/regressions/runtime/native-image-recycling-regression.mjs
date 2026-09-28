// Geometry and recycling correctness. Physical momentum presentation is checked
// separately with installed Safari and real trackpad input.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
      deviceScaleFactor: 2,
    });
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      document.body.replaceChildren();
      const viewport = document.createElement("div");
      viewport.style.cssText = "height:600px;width:800px;overflow:auto";
      document.body.append(viewport);
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 768;
      canvas.getContext("2d").fillRect(0, 0, 1024, 768);
      const source = new Image();
      source.src = canvas.toDataURL();
      await source.decode();
      const list = createVirtualList(viewport, {
        items: Array.from({ length: 60 }, (_, i) => i),
        key: String,
        boot: "start",
        anchoring: "native",
        pinning: false,
        render: (item) => {
          const row = document.createElement("div");
          row.dataset.key = String(item);
          row.textContent = `Image message ${item}`;
          const image = source.cloneNode();
          image.style.cssText = "display:block;width:640px;height:auto";
          row.append(image);
          return row;
        },
      });
      const first = list.elementOf("0");
      const samples = [];
      try {
        for (const key of ["0", "12", "35", "58", "12", "0"]) {
          await list.scrollTo(key, { behavior: "instant" });
          await new Promise((done) => requestAnimationFrame(done));
          await new Promise((done) => requestAnimationFrame(done));
          const origin = viewport.getBoundingClientRect().top;
          const rows = [...viewport.querySelectorAll("[data-key]")];
          samples.push({
            count: rows.length,
            firstConnected: first.isConnected,
            expectedFirstConnected: key === "0",
            drift: Math.max(
              ...rows.map((row) =>
                Math.abs(
                  row.getBoundingClientRect().top +
                    viewport.scrollTop -
                    origin -
                    list.positionOf(row.dataset.key).top,
                ),
              ),
            ),
            layers: rows.every(
              (row) =>
                getComputedStyle(row.parentElement).willChange === "auto",
            ),
          });
        }
        return { samples, reused: list.elementOf("0") === first };
      } finally {
        list.dispose();
      }
    });
    for (const sample of result.samples) {
      assert.ok(sample.count > 0 && sample.count < 15, JSON.stringify(sample));
      assert.ok(sample.drift <= 0.5, JSON.stringify(sample));
      assert.equal(sample.firstConnected, sample.expectedFirstConnected);
      assert.equal(sample.layers, true);
    }
    assert.equal(result.reused, true);
    console.log(
      `${engine.name()}: image rows recycle with stable coordinates and bounded layer hints`,
    );
  } finally {
    await browser.close();
  }
}
