import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const result = await page.evaluate(async () => {
      const { createChatImagePreview } = await import(
        "/demos/streaming/image-preview.ts"
      );
      const host = document.createElement("div");
      document.body.append(host);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      const rows = ["1", "2"].map((key) => {
        const row = document.createElement("div");
        row.dataset.key = key;
        host.append(row);
        return row;
      });
      const images = rows.map((row, index) => {
        const image = new Image();
        image.src = canvas.toDataURL();
        image.alt = `Image ${index}`;
        row.append(image);
        return image;
      });
      await Promise.all(images.map((image) => image.decode()));
      const preview = createChatImagePreview(host);
      const reads = [0, 0];
      const source = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        "currentSrc",
      );
      images.forEach((image, index) => {
        Object.defineProperty(image, "currentSrc", {
          configurable: true,
          get() {
            reads[index]++;
            return source.get.call(this);
          },
        });
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const textRow = document.createElement("div");
        textRow.textContent = "An unrelated virtual row";
        host.append(textRow);
        await settle();
        textRow.remove();
        await settle();
        const unrelated = [...reads];
        reads.fill(0);
        rows[0].dataset.key = "3";
        await settle();
        const rekeyed = [...reads];
        images[0].alt = "Updated image";
        await settle();
        const label = images[0].getAttribute("aria-label");
        reads.fill(0);
        rows[1].append(images[0]);
        await settle();
        const moved = [...reads];
        images[0].remove();
        await settle();
        const removed = images[0].classList.contains("photo-preview-card");
        rows[0].append(images[0]);
        await settle();
        const restored = images[0].classList.contains("photo-preview-card");
        return { unrelated, rekeyed, label, moved, removed, restored };
      } finally {
        preview.dispose();
        host.remove();
      }
    });
    assert.deepEqual(
      result.unrelated,
      [0, 0],
      "text-only rows skip image work",
    );
    assert.ok(result.rekeyed[0] > 0, "rekeyed row refreshes its image");
    assert.equal(result.rekeyed[1], 0, "other rows are not rebound");
    assert.equal(result.label, "Preview Updated image");
    assert.ok(
      result.moved.every((count) => count > 0),
      "move refreshes siblings",
    );
    assert.equal(result.removed, false);
    assert.equal(result.restored, true);
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
