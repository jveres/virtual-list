import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const [engine, type] of Object.entries({ firefox, webkit, chromium })) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 3 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/runtime-pin-replacement-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto(`${base}/runtime-pin-replacement-fixture`);
    // Generic list only: no chat renderer, importer, sticky headers or timers.
    // This checks lifecycle recovery and geometry, not Safari's native-drop
    // compositor failure, which a synthetic event cannot reliably reproduce.
    const result = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      const viewport = document.createElement("div");
      viewport.style.cssText =
        "width:500px;height:400.3px;overflow-y:auto!important";
      document.body.append(viewport);
      const heightGetter = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetHeight",
      ).get;
      const repairs = [];
      Object.defineProperty(viewport, "offsetHeight", {
        get() {
          repairs.push({
            overflow: getComputedStyle(viewport).overflowY,
            top: viewport.scrollTop,
          });
          return heightGetter.call(viewport);
        },
      });
      const frames = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      const items = Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        height: index === 0 ? 100.1 : 100,
        text: `Row ${index}`,
      }));
      const mount = () =>
        createVirtualList(viewport, {
          items,
          key: (item) => item.id,
          height: (item) => item.height,
          render: (item) => {
            const row = document.createElement("div");
            row.textContent = item.text;
            row.style.height = `${item.height}px`;
            row.style.background = "#dbeafe";
            return row;
          },
        });
      let list = mount();
      try {
        await frames();
        const firstMountRepairs = repairs.length;
        await list.scrollTo("start");
        const snapshots = [];
        viewport.addEventListener("scroll", () =>
          snapshots.push(viewport.scrollTop),
        );
        const completed = await list.scrollTo("end", {
          pin: { key: "28", offset: 44 },
        });
        await frames();
        const landed = viewport.scrollTop;
        const rawPin = list.positionOf("28").top - 44;
        list.updateItem("29", {
          ...items[29],
          height: 250,
          text: "Growing final row",
        });
        await frames();
        const afterGrowth = viewport.scrollTop;
        list.dispose();
        list = mount();
        await list.scrollTo("end", { pin: { key: "28", offset: 44 } });
        const beforeRepair = viewport.scrollTop;
        await frames();
        const afterRepair = viewport.scrollTop;
        const replacementRepairs = repairs.length;
        list.updateItem("29", { ...items[29], text: "Ordinary item update" });
        await frames();
        const updateRepairs = repairs.length;
        list.dispose();
        list = mount();
        list.dispose(); // A superseded mount must not repaint its successor.
        list = mount();
        await frames();
        return {
          completed,
          firstMountRepairs,
          landed,
          rawPin,
          afterGrowth,
          beforeRepair,
          afterRepair,
          replacementRepairs,
          updateRepairs,
          finalRepairs: repairs.length,
          repairs,
          snapshots,
          overflow: viewport.style.getPropertyValue("overflow-y"),
          priority: viewport.style.getPropertyPriority("overflow-y"),
        };
      } finally {
        list.dispose();
        viewport.remove();
      }
    });
    assert.equal(result.completed, true);
    assert.equal(result.firstMountRepairs, 0);
    assert.equal(result.landed, Math.ceil(result.rawPin));
    assert.equal(
      result.afterGrowth,
      result.landed,
      "a streaming commit undid the boundary landing",
    );
    assert.equal(result.afterRepair, result.beforeRepair);
    const expected = engine === "webkit" ? 1 : 0;
    assert.equal(result.replacementRepairs, expected);
    assert.equal(result.updateRepairs, expected);
    assert.equal(result.finalRepairs, expected * 2);
    assert.ok(result.repairs.every((repair) => repair.overflow === "hidden"));
    assert.equal(result.overflow, "auto");
    assert.equal(result.priority, "important");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, ...result }));
  } finally {
    await browser.close();
  }
}
