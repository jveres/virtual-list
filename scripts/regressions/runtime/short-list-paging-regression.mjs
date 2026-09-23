import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";

for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/__short-list-paging", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><div id="viewport" style="height:600px;width:400px;overflow:auto;position:relative"></div>',
      }),
    );
    await page.goto(`${base}/__short-list-paging`);

    for (const count of [0, 1, 8]) {
      const result = await page.evaluate(async (count) => {
        const { createVirtualList } = await import("/src/index.ts");
        const { createPagedWindow } = await import("/src/paging.ts");
        const viewport = document.querySelector("#viewport");
        const initialItems = Array.from({ length: count }, (_, i) => i + 5);
        let paging;
        let complete;
        let fail;
        let timeout;
        const loaded = new Promise((resolve, reject) => {
          complete = resolve;
          fail = reject;
          timeout = setTimeout(
            () => reject(new Error("Missing start load")),
            5000,
          );
        });
        const list = createVirtualList(viewport, {
          items: initialItems,
          boot: "start",
          key: String,
          render: (item) => {
            const row = document.createElement("div");
            row.style.height = "80px";
            row.textContent = `Item ${item}`;
            return row;
          },
          onReachStart: (context) => {
            // Boot publishes before the pager is assigned.
            Promise.resolve()
              .then(() => paging.load("start", context))
              .then(complete, fail);
          },
        });
        paging = createPagedWindow({
          list,
          initial: {
            items: initialItems,
            start: { available: true, cursor: 0 },
            end: { available: false },
          },
          maxItems: 30,
          key: String,
          keysOf: (item) => [String(item)],
          project: (items) => items,
          load: async () => ({
            items: [0, 1, 2, 3, 4],
            start: { available: false },
            end: { available: count > 0, cursor: 5 },
          }),
        });
        try {
          return {
            applied: await loaded,
            items: [...paging.items],
            count: list.state.count,
            loading: paging.loading,
          };
        } finally {
          clearTimeout(timeout);
          paging.dispose();
          list.dispose();
        }
      }, count);

      assert.equal(
        result.applied,
        true,
        `${engine.name()}: ${count}-row start load`,
      );
      assert.deepEqual(
        result.items,
        Array.from({ length: count + 5 }, (_, i) => i),
      );
      assert.equal(result.count, count + 5);
      assert.equal(result.loading, false);
    }
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: empty and short lists commit start pages without self-cancellation`,
    );
  } finally {
    await browser.close();
  }
}
