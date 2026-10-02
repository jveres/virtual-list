// Correctness checks, not native-input or physical presentation measurements.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const kind of ["blocks", "table"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/__staged-row", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="viewport" style="width:600px;height:300px;overflow:auto;position:relative"></div>',
        }),
      );
      await page.goto(`${base}/__staged-row`);
      const result = await page.evaluate(async (kind) => {
        const { createVirtualList } = await import("/src/virtual-list.ts");
        const { stageMessageLayout } = await import(
          "/demos/streaming/staged-message.ts"
        );
        const viewport = document.querySelector("#viewport");
        const items = Array.from({ length: 20 }, (_, id) => ({
          id: String(id),
        }));
        const records = new Map();
        const steps = [];
        const mounts = [];
        const destroyed = [];
        const controller = new AbortController();
        let returns = 0;
        let clicks = 0;
        const selector = kind === "table" ? "tbody > tr" : "p";
        const list = createVirtualList(viewport, {
          items,
          key: (item) => item.id,
          boot: "start",
          render(item, existing) {
            if (existing) return existing;
            const row = document.createElement("article");
            row.style.minHeight = "80px";
            if (item.large) {
              row.innerHTML =
                '<div class="message-content"><div class="markdown-viewer"><div class="markdown"></div></div></div>';
              const host = row.querySelector(".markdown");
              if (kind === "table") {
                host.innerHTML = `<table><thead><tr><th>Value</th></tr></thead><tbody>${Array.from({ length: 1200 }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join("")}</tbody></table>`;
              } else {
                for (let i = 0; i < 80; i++) {
                  const p = document.createElement("p");
                  p.textContent = `Block ${i}: ${"Long reply content. ".repeat(20)}`;
                  host.append(p);
                }
              }
              const first = host.querySelector(selector);
              first.addEventListener("click", () => clicks++);
              records.set(item.id, { row, first, html: row.innerHTML });
            } else row.textContent = item.id;
            return row;
          },
          stage(item, row) {
            const iterator = stageMessageLayout(row);
            if (!iterator) return;
            return {
              next() {
                const slot = row.parentElement;
                steps.push({
                  connected: row.isConnected,
                  hidden: getComputedStyle(slot).visibility,
                  inert: slot.inert,
                  ariaHidden: slot.getAttribute("aria-hidden"),
                  height: slot.getBoundingClientRect().height,
                  count: list.state.count,
                  mounted: list.elementOf(item.id) !== null,
                });
                const next = iterator.next();
                if (item.id === "cancelled") controller.abort();
                return next;
              },
              return() {
                returns++;
                return iterator.return();
              },
            };
          },
          onMount(row, item) {
            if (item.large) mounts.push(row.querySelectorAll(selector).length);
          },
          onDestroy(row, item) {
            if (item.large)
              destroyed.push({
                id: item.id,
                blocks: row.querySelectorAll(selector).length,
              });
          },
        });
        try {
          void list.scrollTo("end", { behavior: "smooth" });
          const committed = await list.updateWindow(
            () => ({ items: [...items, { id: "large", large: true }] }),
            undefined,
            { interrupt: "commit" },
          );
          const completed = await list.scrollTo("end", { behavior: "smooth" });
          const { row, first, html } = records.get("large");
          first.click();
          const bottom =
            row.lastElementChild.lastElementChild.lastElementChild.lastElementChild.getBoundingClientRect()
              .bottom;
          const committedSteps = steps.splice(0);
          const measured = {
            committed,
            completed,
            count: list.state.count,
            mounted: list.elementOf("large") === row,
            intact:
              row.innerHTML === html && row.querySelector(selector) === first,
            heightError: Math.abs(
              list.positionOf("large").height -
                row.getBoundingClientRect().height,
            ),
            bottomError: Math.abs(
              bottom - viewport.getBoundingClientRect().bottom,
            ),
          };
          const cancelled = await list.updateWindow(
            () => ({
              items: [
                ...items,
                { id: "large", large: true },
                { id: "cancelled", large: true },
              ],
            }),
            controller.signal,
            { interrupt: "commit" },
          );
          return {
            measured,
            committedSteps,
            cancelled,
            returns,
            clicks,
            mounts,
            destroyed,
            finalCount: list.state.count,
          };
        } finally {
          list.dispose();
        }
      }, kind);
      assert.equal(result.measured.committed, true);
      assert.equal(result.measured.completed, true);
      assert.equal(result.measured.count, 21);
      assert.equal(result.measured.mounted, true);
      assert.equal(result.measured.intact, true);
      assert.ok(
        result.measured.heightError < 1,
        JSON.stringify(result.measured),
      );
      assert.ok(
        result.measured.bottomError <= 17,
        JSON.stringify(result.measured),
      );
      assert.equal(result.committedSteps.length, kind === "table" ? 12 : 5);
      for (const step of result.committedSteps)
        assert.deepEqual(step, {
          connected: true,
          hidden: "hidden",
          inert: true,
          ariaHidden: "true",
          height: 0,
          count: 20,
          mounted: false,
        });
      assert.equal(result.cancelled, false);
      assert.equal(result.returns, 1);
      assert.equal(result.clicks, 1);
      const blocks = kind === "table" ? 1200 : 80;
      assert.deepEqual(result.mounts, [blocks]);
      assert.deepEqual(result.destroyed, [
        { id: "cancelled", blocks },
        { id: "large", blocks },
      ]);
      assert.equal(result.finalCount, 21);
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()}/${kind}: staged layout, native end handoff, node identity, cancellation, and cleanup passed`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
