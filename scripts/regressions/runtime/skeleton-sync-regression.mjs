// The fast-scroll skeleton layer follows committed geometry commit by commit,
// on whole and fractional device pixel grids, and a token into the last row
// costs the same whatever the loaded count.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, chromium, webkit]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch();
  try {
    for (const deviceScaleFactor of [1, 1.5]) {
      for (const anchoring of ["runtime", "auto"]) {
        const context = await browser.newContext({
          deviceScaleFactor,
          viewport: { width: 800, height: 700 },
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/__skeleton-sync", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><div id="viewport" style="width:600px;height:400px;overflow:auto;--virtual-list-placeholder-color:rgb(255, 0, 0)"></div>',
          }),
        );
        await page.goto(`${base}/__skeleton-sync`);
        const result = await page.evaluate(async (anchoring) => {
          const { createVirtualList } = await import("/src/virtual-list.ts");
          const viewport = document.querySelector("#viewport");
          const frames = async (count) => {
            for (let frame = 0; frame < count; frame++)
              await new Promise(requestAnimationFrame);
          };
          const make = (id) => ({
            id: String(id),
            text: `Row ${id}`,
            height: 40 + ((Math.abs(id) * 7) % 23) / 3,
            separator: false,
          });
          let asked = 0;
          const open = (count) => {
            const items = Array.from({ length: count }, (_, id) => make(id));
            const list = createVirtualList(viewport, {
              items,
              key: (item) => item.id,
              boot: "start",
              pinning: false,
              anchoring,
              scrollPlaceholders: true,
              anchorable: (item) => {
                asked += 1;
                return !item.separator;
              },
              render(item, existing) {
                const row = existing ?? document.createElement("div");
                row.style.cssText = `height:${item.height}px;box-sizing:border-box;overflow:hidden`;
                row.textContent = item.text;
                return row;
              },
            });
            return { list, items };
          };

          // Boxes, not style text: engines serialize a length with fewer
          // digits than they lay out. One layout unit is 1/64 or 1/60 px.
          const UNIT = 0.03;
          const failures = [];
          const check = (label, list, items) => {
            const surface = viewport.querySelector("[data-scroll-skeletons]");
            const area = surface.getBoundingClientRect();
            const found = new Map(
              [...surface.children].map((element) => [
                element.dataset.scrollPlaceholder,
                element,
              ]),
            );
            const expected = items.filter((item) => !item.separator);
            if (found.size !== expected.length)
              failures.push(
                `${label}: ${found.size} skeletons for ${expected.length} items`,
              );
            for (const item of expected) {
              const skeleton = found.get(item.id);
              const position = list.positionOf(item.id);
              if (!skeleton) {
                failures.push(`${label}: no skeleton for ${item.id}`);
                continue;
              }
              const box = skeleton.getBoundingClientRect();
              if (
                Math.abs(box.top - area.top - position.top) > UNIT ||
                Math.abs(box.height - position.height) > UNIT
              )
                failures.push(
                  `${label}: ${item.id} drawn at ${box.top - area.top}+${box.height}, committed ${position.top}+${position.height}`,
                );
              // A mounted row sits under its skeleton. Rows in native flow
              // stack in layout units, a drift well under half a pixel.
              const row = list.elementOf(item.id);
              if (!row) continue;
              const slot = row.parentElement.getBoundingClientRect();
              if (
                Math.abs(slot.top - box.top) > 0.5 ||
                Math.abs(slot.height - box.height) > UNIT
              )
                failures.push(
                  `${label}: ${item.id} drawn at ${box.top}+${box.height}, row at ${slot.top}+${slot.height}`,
                );
            }
            if (Math.abs(area.height - list.state.totalSize) > UNIT)
              failures.push(
                `${label}: surface ${area.height}, content ${list.state.totalSize}`,
              );
          };

          // The cost of one token, at two loaded counts.
          const tokenCost = [];
          for (const count of [200, 2000]) {
            const { list, items } = open(count);
            const last = count - 1;
            asked = 0;
            for (let tick = 0; tick < 20; tick++) {
              items[last] = { ...items[last], text: `Token ${tick}` };
              list.updateItem(String(last), items[last]);
            }
            tokenCost.push(asked);
            check(`tokens at ${count}`, list, items);
            list.dispose();
          }

          const { list, items } = open(300);
          check("boot", list, items);
          const surface = viewport.querySelector("[data-scroll-skeletons]");
          const content = surface.lastElementChild.firstElementChild;
          const computed = getComputedStyle(content);
          const builtIn = {
            mask: computed.maskImage || computed.webkitMaskImage,
            color: computed.backgroundColor,
          };
          const kept = surface.querySelector('[data-scroll-placeholder="250"]');

          items[299] = { ...items[299], height: 93.4 };
          list.updateItem("299", items[299]);
          check("last row grows", list, items);

          items[3] = { ...items[3], height: 77.7 };
          list.updateItem("3", items[3]);
          check("row near the top grows", list, items);

          items[5] = { ...items[5], separator: true };
          list.updateItem("5", items[5]);
          check("item stops anchoring", list, items);
          items[5] = { ...items[5], separator: false };
          list.updateItem("5", items[5]);
          check("item anchors again", list, items);

          const older = Array.from({ length: 10 }, (_, id) => make(id - 10));
          items.unshift(...older);
          list.setItems(items, { anchor: "viewport" });
          check("prepend", list, items);

          const slot = (height) => ({
            key: "loader",
            height,
            render: () => document.createElement("div"),
          });
          list.setEdgeSlot("start", slot(48));
          check("edge slot", list, items);
          list.setEdgeSlot("start", slot(64.5));
          check("edge slot resized", list, items);
          list.setEdgeSlot("start", null);
          check("edge slot removed", list, items);

          await list.scrollTo("150", { align: "start" });
          await frames(2);
          check("scrolled", list, items);

          // An observed resize of a mounted row, outside any update.
          list.elementOf("152").style.height = "90.5px";
          await frames(3);
          check("observed resize", list, items);

          const same =
            surface.querySelector('[data-scroll-placeholder="250"]') === kept;
          list.setScrollPlaceholders(false);
          const removed =
            viewport.querySelector("[data-scroll-skeletons]") === null;
          list.setScrollPlaceholders(true);
          check("option off and on", list, items);
          list.dispose();
          return { failures, tokenCost, builtIn, same, removed };
        }, anchoring);
        const label = `${engine.name()} @${deviceScaleFactor}x ${anchoring}`;
        assert.deepEqual(errors, [], label);
        assert.deepEqual(result.failures, [], label);
        assert.equal(
          result.tokenCost[0],
          result.tokenCost[1],
          `${label}: host calls per token grow with the loaded count`,
        );
        assert.ok(
          result.tokenCost[1] <= 20 * 8,
          `${label}: ${result.tokenCost}`,
        );
        assert.match(result.builtIn.mask, /data:image\/svg\+xml/, label);
        assert.equal(result.builtIn.color, "rgb(255, 0, 0)", label);
        assert.ok(result.same, `${label}: skeleton elements are kept`);
        assert.ok(result.removed, `${label}: the option removes the layer`);
        await context.close();
      }
    }
    console.log(
      `${engine.name()}: skeletons follow committed geometry at 1x and 1.5x; token cost is independent of the loaded count`,
    );
  } finally {
    await browser.close();
  }
}
