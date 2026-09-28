// Large data-URL chat images show a worker-made display copy without moving
// their row, rebuilt rows adopt the copy before insertion, the viewer keeps the
// original, and inline images stay standard range (Safari HDR stalls).
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
      deviceScaleFactor: 2,
    });
    await openStreamingDemo(page, base);
    const result = await page.evaluate(async () => {
      const { adoptDisplayCopies, displaySource, useDisplayCopy } =
        await import("/demos/streaming/display-copies.ts");
      const photo = (width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.fillStyle = "#3a6";
        context.fillRect(0, 0, width, height);
        return canvas.toDataURL("image/jpeg", 0.8);
      };
      const mount = async (url) => {
        const content = document.createElement("div");
        content.className = "message-content";
        content.style.width = "640px";
        const image = new Image();
        image.src = url;
        content.append(image);
        document.body.append(content);
        await image.decode();
        return { content, image };
      };
      const large = photo(4000, 3000);
      const { image } = await mount(large);
      const before = image.getBoundingClientRect().height;
      useDisplayCopy(image, large);
      const deadline = performance.now() + 10000;
      while (image.currentSrc === large && performance.now() < deadline)
        await new Promise((done) => setTimeout(done, 50));
      await image.decode();
      const small = photo(1000, 750);
      const { image: plain } = await mount(small);
      useDisplayCopy(plain, small);
      await new Promise((done) => setTimeout(done, 500));
      // A rebuilt row: the copy is in place before the row is inserted.
      const rebuilt = document.createElement("div");
      rebuilt.innerHTML = '<img width="4000" height="3000">';
      rebuilt.firstChild.setAttribute("src", large);
      adoptDisplayCopies(rebuilt);
      return {
        copied: image.currentSrc.startsWith("blob:"),
        natural: [image.naturalWidth, image.naturalHeight],
        box: [before, image.getBoundingClientRect().height],
        identity: displaySource(image, image.currentSrc) === large,
        smallKept: plain.currentSrc === small,
        adopted: rebuilt.firstChild.src.startsWith("blob:"),
        adoptedIdentity:
          displaySource(rebuilt.firstChild, rebuilt.firstChild.src) === large,
        rangeLimit: CSS.supports("dynamic-range-limit", "standard")
          ? getComputedStyle(image).getPropertyValue("dynamic-range-limit")
          : "standard",
      };
    });
    assert.equal(result.copied, true, JSON.stringify(result));
    assert.deepEqual(result.natural, [2048, 1536]);
    assert.ok(Math.abs(result.box[0] - result.box[1]) <= 0.5, result.box);
    assert.equal(result.identity, true);
    assert.equal(result.smallKept, true);
    assert.equal(result.adopted, true);
    assert.equal(result.adoptedIdentity, true);
    assert.equal(result.rangeLimit, "standard");
    console.log(
      `${engine.name()}: display copies keep row boxes and identity; inline images standard range`,
    );
  } finally {
    await browser.close();
  }
}
