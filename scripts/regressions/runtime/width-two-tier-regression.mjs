// A viewport width change reads the mounted window in its delivery and the
// detached rows once the width has been quiet. Every frame of a width burst
// must paint rows that fill their slots and keep the reader's row in place,
// and the list must converge on the geometry of one built at the final width.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
const COUNT = 400;
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const anchoring of ["auto", "runtime"]) {
      const label = `${engine.name()} ${anchoring}`;
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/__width-two-tier", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><body style='margin:0'></body>",
        }),
      );
      await page.goto(`${base}/__width-two-tier`);
      const result = await page.evaluate(
        async ({ count, anchoring }) => {
          const nativeRect = Element.prototype.getBoundingClientRect;
          let reads = 0;
          Element.prototype.getBoundingClientRect = function () {
            reads += 1;
            return nativeRect.call(this);
          };
          // Construction order in the runtime: rows first, then the viewport.
          const deliveries = [];
          let observers = 0;
          const NativeObserver = window.ResizeObserver;
          window.ResizeObserver = class extends NativeObserver {
            constructor(callback) {
              const viewportObserver = observers++ % 2 === 1;
              super((entries, observer) => {
                const before = reads;
                callback(entries, observer);
                if (viewportObserver) deliveries.push(reads - before);
              });
            }
          };
          const { createVirtualList } = await import("/src/virtual-list.ts");
          const frame = () => new Promise(requestAnimationFrame);
          const wait = (ms) => new Promise((done) => setTimeout(done, ms));
          const items = Array.from({ length: count }, (_, id) => ({ id }));
          const build = (width) => {
            const viewport = document.createElement("div");
            viewport.style.cssText = `width:${width}px;height:600px;overflow:auto${anchoring === "runtime" ? ";overflow-anchor:none" : ""}`;
            document.body.appendChild(viewport);
            const list = createVirtualList(viewport, {
              items,
              key: (item) => String(item.id),
              boot: "start",
              render: (item, existing) => {
                const row = existing ?? document.createElement("div");
                row.dataset.row = String(item.id);
                row.style.cssText =
                  "padding:8px 12px;font:14px/20px sans-serif;overflow-wrap:anywhere";
                row.textContent = "lorem ipsum dolor sit amet "
                  .repeat(3 + ((item.id * 37) % 17))
                  .trim();
                return row;
              },
            });
            return { list, viewport };
          };
          const settled = async (list, checkFrame = () => {}) => {
            const deadline = performance.now() + 5000;
            while (list.state.held) {
              if (performance.now() > deadline)
                throw new Error("held never cleared");
              await frame();
              checkFrame();
            }
          };
          const positions = (list) =>
            items.map((item) => {
              const position = list.positionOf(String(item.id));
              return `${position.top}:${position.height}`;
            });
          /** Rows inside the viewport: their coordinate and their fit. */
          const painted = (viewport) => {
            const origin = nativeRect.call(viewport).top;
            const rows = [];
            for (const row of viewport.querySelectorAll("[data-row]")) {
              const slot = row.parentElement;
              if (getComputedStyle(slot).visibility === "hidden") continue;
              const box = nativeRect.call(slot);
              const top = box.top - origin;
              if (top + box.height <= 0 || top >= viewport.clientHeight)
                continue;
              rows.push({
                key: row.dataset.row,
                top,
                gap: Math.abs(box.height - nativeRect.call(row).height),
              });
            }
            return rows;
          };

          const { list, viewport } = build(800);
          const reader = String(count / 2);
          await list.scrollTo(reader, { align: "start" });
          await wait(400);
          await settled(list);
          const mounted = viewport.querySelectorAll("[data-row]").length;
          const frames = [];
          const check = (name) => {
            const rows = painted(viewport);
            frames.push({
              name,
              rows: rows.length,
              gap: Math.max(0, ...rows.map((row) => row.gap)),
              reader: rows.find((row) => row.key === reader)?.top ?? null,
            });
          };
          const burst = async (name, from, step) => {
            deliveries.length = 0;
            for (let index = 1; index <= 20; index++) {
              await frame();
              if (index > 1) check(`${name} ${index - 1}`);
              viewport.style.width = `${from + index * step}px`;
            }
            await frame();
            check(`${name} 20`);
            return [...deliveries];
          };

          const narrowed = await burst("narrow", 800, -8);
          const heldAfterNarrow = list.state.held;
          const started = performance.now();
          await settled(list, () => check("narrow drain"));
          const waited = performance.now() - started;
          check("narrow quiet");
          const narrow = build(640);
          await wait(400);
          await settled(narrow.list);
          const narrowMatches =
            list.state.totalSize === narrow.list.state.totalSize &&
            positions(list).join() === positions(narrow.list).join();
          narrow.list.dispose();
          narrow.viewport.remove();

          // Wider: rows wrap shorter, and waiting rows enter the window.
          const widened = await burst("widen", 640, 8);
          const heldAfterWiden = list.state.held;
          // A gesture during the wait mounts waiting rows below the reader.
          viewport.scrollTop += 1500;
          await frame();
          await frame();
          check("scroll during the wait");
          await wait(600);
          await settled(list);
          check("widen quiet");
          const wide = build(800);
          await wait(400);
          await settled(wide.list);
          const wideMatches =
            list.state.totalSize === wide.list.state.totalSize &&
            positions(list).join() === positions(wide.list).join();
          wide.list.dispose();
          wide.viewport.remove();

          const connected = viewport.querySelectorAll("[data-row]").length;
          const mode = viewport.firstElementChild.dataset.anchoring;
          list.dispose();
          viewport.remove();
          return {
            mode,
            mounted,
            connected,
            narrowed,
            widened,
            heldAfterNarrow,
            heldAfterWiden,
            waited,
            narrowMatches,
            wideMatches,
            frames,
          };
        },
        { count: COUNT, anchoring },
      );

      assert.deepEqual(errors, [], label);
      for (const [name, deliveries] of [
        ["narrowing", result.narrowed],
        ["widening", result.widened],
      ]) {
        assert.ok(
          deliveries.length >= 15,
          `${label}: ${name} delivered ${deliveries.length} width changes`,
        );
        assert.ok(
          Math.max(...deliveries) < COUNT / 2,
          `${label}: a ${name} delivery read ${Math.max(...deliveries)} rows of ${COUNT}`,
        );
      }
      assert.equal(result.heldAfterNarrow, true, `${label}: rows wait`);
      assert.equal(result.heldAfterWiden, true, `${label}: rows wait`);
      assert.ok(
        result.waited >= 100,
        `${label}: the pass ran ${result.waited}ms after the last change`,
      );
      for (const painted of result.frames) {
        assert.ok(painted.rows > 0, `${label}: ${painted.name} painted no row`);
        assert.ok(
          painted.gap <= 1,
          `${label}: ${painted.name} painted a row ${painted.gap}px off its slot`,
        );
        // The scroll moves the reader's row out; every other frame keeps it.
        if (painted.name.startsWith("narrow") || /^widen \d/.test(painted.name))
          assert.ok(
            painted.reader !== null && Math.abs(painted.reader) <= 1,
            `${label}: ${painted.name} moved the reader's row to ${painted.reader}`,
          );
      }
      assert.equal(result.narrowMatches, true, `${label}: narrow geometry`);
      assert.equal(result.wideMatches, true, `${label}: wide geometry`);
      assert.ok(
        result.connected < COUNT / 2,
        `${label}: ${result.connected} rows stayed connected`,
      );
      await page.close();
      console.log(
        `${label} (${result.mode}): ${result.mounted} mounted of ${COUNT}; deliveries read at most ${Math.max(...result.narrowed, ...result.widened)} rows; converged after ${Math.round(result.waited)}ms`,
      );
    }
  } finally {
    await browser.close();
  }
}
