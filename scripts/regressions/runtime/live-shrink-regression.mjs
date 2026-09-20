import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const cases = [
  {
    name: "single clamp",
    updates: [[44, 200]],
    top: 4400,
    total: 5100,
    positions: [{ top: 4400, height: 200 }],
  },
  {
    name: "successive clamps",
    updates: [
      [44, 20],
      [43, 30],
      [42, 200],
    ],
    top: 4250,
    total: 4950,
    positions: [
      { top: 4430, height: 20 },
      { top: 4400, height: 30 },
      { top: 4200, height: 200 },
    ],
  },
];

// Real browser layout and clamping; synthetic input only opens the runtime's
// scroll phase. This is a correctness test, not native momentum profiling.
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/__live-shrink-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto(`${base}/__live-shrink-fixture`);
    for (const scenario of cases) {
      const result = await page.evaluate(async ({ updates }) => {
        const { createVirtualList } = await import("/src/virtual-list.ts");
        const viewport = document.createElement("div");
        viewport.style.cssText =
          "position:relative;width:500px;height:600px;overflow:auto;overflow-anchor:none";
        document.body.append(viewport);
        const nativeScrollTop = Object.getOwnPropertyDescriptor(
          Element.prototype,
          "scrollTop",
        );
        const writes = [];
        Object.defineProperty(viewport, "scrollTop", {
          configurable: true,
          get() {
            return nativeScrollTop.get.call(this);
          },
          set(value) {
            writes.push(value);
            nativeScrollTop.set.call(this, value);
          },
        });
        const items = Array.from({ length: 50 }, (_, id) => ({
          id: `m${id}`,
          height: id === 49 ? 1000 : 100,
        }));
        const list = createVirtualList(viewport, {
          items,
          key: (item) => item.id,
          scrollingUpdates: "live",
          settleStrategy: "default",
          pinning: false,
          render(item, existing) {
            const row = existing ?? document.createElement("article");
            row.style.height = `${item.height}px`;
            row.textContent = item.id;
            return row;
          },
        });
        try {
          // Drain initial native resize/scroll deliveries before starting the
          // synchronous case. No timer, frame or observer repairs the result.
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -2 }));
          viewport.scrollTop = 5298;
          viewport.dispatchEvent(new Event("scroll"));
          for (const [id, height] of updates)
            list.updateItem(`m${id}`, { id: `m${id}`, height });
          const before = {
            top: viewport.scrollTop,
            held: list.state.held,
            positions: updates.map(([id]) => list.positionOf(`m${id}`)),
          };
          writes.length = 0;

          list.updateItem("m49", { id: "m49", height: 100 });

          return {
            before,
            writes: [...writes],
            top: viewport.scrollTop,
            total: list.state.totalSize,
            held: list.state.held,
            positions: updates.map(([id]) => list.positionOf(`m${id}`)),
            rows: updates.map(([id]) => {
              const row = list.elementOf(`m${id}`);
              return {
                mounted: row !== null && viewport.contains(row),
                height: row?.getBoundingClientRect().height,
                slotHeight: row?.parentElement?.getBoundingClientRect().height,
              };
            }),
          };
        } finally {
          list.dispose();
          viewport.remove();
        }
      }, scenario);
      const label = `${engine.name()}/${scenario.name}`;
      assert.equal(result.before.top, 5298, label);
      assert.equal(result.before.held, true, label);
      assert.deepEqual(
        result.before.positions,
        scenario.updates.map(([id]) => ({ top: id * 100, height: 100 })),
        `${label}: updates above the original anchor remain held`,
      );
      assert.deepEqual(result.writes, [], `${label}: no scrollTop writes`);
      assert.equal(result.top, scenario.top, label);
      assert.equal(result.total, scenario.total, label);
      assert.equal(result.held, false, label);
      assert.deepEqual(result.positions, scenario.positions, label);
      assert.deepEqual(
        result.rows,
        scenario.updates.map(([, height]) => ({
          mounted: true,
          height,
          slotHeight: height,
        })),
        `${label}: newly exposed content fits its actual mounted slot`,
      );
      console.log(`${label}: immediate geometry and no-write checks passed`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
