// A native-flow commit can defer its canvas floor to avoid suppressing the
// browser's anchor. The physical scroll limit must catch up at settlement.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      document.body.replaceChildren();
      const viewport = document.createElement("div");
      viewport.style.cssText = "height:600px;width:500px;overflow:auto";
      document.body.append(viewport);
      const items = Array.from({ length: 20 }, (_, id) => ({ id }));
      const requests = [];
      const scrollTo = viewport.scrollTo;
      viewport.scrollTo = function (options) {
        requests.push(options.top);
        scrollTo.call(this, options);
      };
      const list = createVirtualList(viewport, {
        items,
        key: (item) => String(item.id),
        render: (item) => {
          const row = document.createElement("div");
          row.style.cssText = "height:100px;box-sizing:border-box";
          row.textContent = `Message ${item.id}`;
          return row;
        },
        anchoring: "native",
        settleStrategy: "safari-wheel",
        boot: "start",
        followBehavior: "smooth",
        pinning: { match: (item) => item.id === 18, offset: 40 },
      });
      const canvas = viewport.firstElementChild;
      const state = () => ({
        top: viewport.scrollTop,
        max: viewport.scrollHeight - viewport.clientHeight,
        modeledMax: list.state.totalSize - viewport.clientHeight,
        floor: canvas.style.minHeight,
      });
      const settle = async () => {
        viewport.dispatchEvent(new Event("scrollend"));
        await new Promise((resolve) => setTimeout(resolve, 500));
      };
      try {
        viewport.dispatchEvent(
          new PointerEvent("pointerdown", { pointerId: 1, pointerType: "pen" }),
        );
        viewport.scrollTop = 100;
        viewport.dispatchEvent(new Event("scroll"));
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
        list.setItems(items.slice(1), { anchor: "viewport" });
        const held = state();
        window.dispatchEvent(
          new PointerEvent("pointerup", { pointerId: 1, pointerType: "pen" }),
        );
        await settle();
        const released = state();
        requests.length = 0;
        viewport.scrollTop = viewport.scrollHeight;
        viewport.dispatchEvent(new Event("scroll"));
        const arrival = state();
        await settle();
        return { held, released, arrival, settled: state(), requests };
      } finally {
        list.dispose();
      }
    });
    assert.equal(result.held.modeledMax, 1660);
    assert.equal(result.held.max, 1760, "floor stays untouched during input");
    assert.equal(result.released.max, 1660, JSON.stringify(result));
    assert.equal(result.released.top, 0, "settlement keeps the reader still");
    assert.equal(result.arrival.top, 1660);
    assert.equal(result.settled.top, result.arrival.top);
    assert.deepEqual(result.requests, [], "no backward follow correction");
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: native pin floor and bottom stay aligned`);
  } finally {
    await browser.close();
  }
}
