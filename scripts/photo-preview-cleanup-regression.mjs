import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { createPhotoPreview } = await import(
        "/demos/shared/photo-preview.ts"
      );
      const viewport = document.createElement("div");
      document.body.append(viewport);
      const preview = createPhotoPreview({
        viewport,
        thumbnailUrl: () => "",
        previewUrl: () => "",
      });
      const cards = Array.from({ length: 200 }, (_, id) => {
        const card = document.createElement("div");
        viewport.append(card);
        preview.bind(card, { id, aspectRatio: 1, width: 100, height: 100 });
        return card;
      });
      const query = viewport.querySelectorAll.bind(viewport);
      let scans = 0;
      viewport.querySelectorAll = (...args) => {
        scans++;
        return query(...args);
      };
      const start = performance.now();
      for (let round = 0; round < 20; round++) {
        for (const card of cards) preview.unbind(card);
      }
      const cleanupMs = performance.now() - start;
      const idleScans = scans;
      // Removing a pressed drawing still clears every piece of that photo.
      const photo = { id: 0, aspectRatio: 1, width: 100, height: 100 };
      preview.bind(cards[0], photo);
      preview.bind(cards[1], photo);
      cards[0].dispatchEvent(
        new PointerEvent("pointerdown", {
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
        }),
      );
      const pressedBefore = cards
        .slice(0, 2)
        .every((card) => card.classList.contains("is-photo-pressed"));
      preview.unbind(cards[1]);
      const pressedAfter = cards.some((card) =>
        card.classList.contains("is-photo-pressed"),
      );
      preview.unbind(cards[0]);
      preview.dispose();
      viewport.remove();
      return { idleScans, cleanupMs, pressedBefore, pressedAfter };
    });
    console.log(engine.name(), result);
    assert.equal(
      result.idleScans,
      0,
      "idle cleanup must not scan the viewport",
    );
    assert.equal(result.pressedBefore, true);
    assert.equal(result.pressedAfter, false);
  } finally {
    await browser.close();
  }
}
