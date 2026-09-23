// Offline reproduction: streaming growth arrives inside the final glide write.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const result = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      const viewport = document.createElement("div");
      viewport.style.cssText =
        "position:fixed;inset:0 auto auto 0;width:400px;height:600px;overflow:auto";
      document.body.append(viewport);
      let list;
      let armed = false;
      let grew = false;
      const following = [];
      list = createVirtualList(viewport, {
        items: Array.from({ length: 20 }, (_, id) => ({ id, height: 100 })),
        key: (item) => String(item.id),
        render(item, existing) {
          const row = existing ?? document.createElement("div");
          row.style.height = `${item.height}px`;
          row.textContent = `Row ${item.id}`;
          return row;
        },
        followBehavior: "smooth",
        onState: (state) => following.push(state.following),
        onViewport: (snapshot) => {
          if (armed && !grew && snapshot.scrollTop === 1500) {
            grew = true;
            list.updateItem("19", { id: 19, height: 400 });
          }
        },
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));
      const snapshot = () => ({
        top: viewport.scrollTop,
        max: viewport.scrollHeight - viewport.clientHeight,
        following: list.state.following,
      });
      try {
        await settle();
        armed = true;
        following.length = 0;
        list.updateItem("19", { id: 19, height: 200 });
        await settle();
        const first = snapshot();
        list.updateItem("19", { id: 19, height: 500 });
        await settle();
        return { grew, first, second: snapshot(), following };
      } finally {
        list.dispose();
        viewport.remove();
      }
    });
    assert.equal(result.grew, true);
    assert.deepEqual(result.first, { top: 1700, max: 1700, following: true });
    assert.deepEqual(result.second, { top: 1800, max: 1800, following: true });
    assert.ok(result.following.length > 0);
    assert.equal(result.following.includes(false), false);
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
