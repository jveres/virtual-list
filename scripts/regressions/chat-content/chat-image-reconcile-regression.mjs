import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await openStreamingDemo(page, base);
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
      const loads = [];
      const images = rows.map((row, index) => {
        const image = new Image();
        // The preview binds on load: a late load event must not land in a
        // measured window, so wait for it, not only for decoding.
        loads.push(
          new Promise((resolve) =>
            image.addEventListener("load", resolve, { once: true }),
          ),
        );
        image.src = canvas.toDataURL();
        image.alt = `Image ${index}`;
        row.append(image);
        return image;
      });
      await Promise.all(loads);
      await Promise.all(images.map((image) => image.decode()));
      const messages = [1, 2, 3].map((id) => ({
        id,
        markdown: `![Image ${id}](${canvas.toDataURL()})`,
      }));
      const normalizedReads = [0, 0];
      const normalizedSource = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        "src",
      );
      images.forEach((image, index) => {
        Object.defineProperty(image, "src", {
          configurable: true,
          get() {
            normalizedReads[index]++;
            return normalizedSource.get.call(this);
          },
        });
      });
      const preview = createChatImagePreview(host, () => messages);
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
      const replaceSource = async (image, url) => {
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timer);
            image.removeEventListener("load", onLoad);
            image.removeEventListener("error", onError);
            if (error) reject(error);
            else resolve();
          };
          const onLoad = () => finish();
          const onError = () => finish(new Error("Image replacement failed"));
          const timer = setTimeout(
            () => finish(new Error("Image replacement timed out")),
            5000,
          );
          image.addEventListener("load", onLoad);
          image.addEventListener("error", onError);
          image.setAttribute("src", url);
        });
        await image.decode();
        await settle();
      };
      let blobUrl;
      try {
        const query = rows[0].querySelectorAll;
        let batchScans = 0;
        rows[0].querySelectorAll = function (selector) {
          if (selector === "img") batchScans++;
          return query.call(this, selector);
        };
        try {
          for (let i = 0; i < 40; i++) {
            const text = document.createElement("span");
            text.textContent = `Streaming chunk ${i}`;
            rows[0].append(text);
          }
          await settle();
        } finally {
          rows[0].querySelectorAll = query;
        }
        reads.fill(0);
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
        canvas.width = canvas.height = 32;
        const replacement = canvas.toDataURL();
        await replaceSource(images[0], replacement);
        const replaced =
          images[0].currentSrc === replacement &&
          images[0].classList.contains("photo-preview-card");
        const dataSourceReads = [...normalizedReads];
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        blobUrl = URL.createObjectURL(blob);
        await replaceSource(images[0], blobUrl);
        const blobFallback = {
          selected: images[0].currentSrc === blobUrl,
          bound: images[0].classList.contains("photo-preview-card"),
          normalized: normalizedReads[0] > dataSourceReads[0],
        };
        return {
          batchScans,
          unrelated,
          rekeyed,
          label,
          moved,
          removed,
          restored,
          replaced,
          blobFallback,
          normalizedReads: dataSourceReads,
        };
      } finally {
        preview.dispose();
        host.remove();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    });
    assert.equal(
      result.batchScans,
      2,
      "a mutation batch scans each image row once, then resolves its ordinal",
    );
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
    assert.equal(result.replaced, true, "changed data sources stay bound");
    assert.deepEqual(
      result.blobFallback,
      { selected: true, bound: true, normalized: true },
      `${engine.name()}: blob sources retain src identity`,
    );
    assert.deepEqual(
      result.normalizedReads,
      [0, 0],
      "loaded data images reuse their selected URL without normalized src reads",
    );
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
