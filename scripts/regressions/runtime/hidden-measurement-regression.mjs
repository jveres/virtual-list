import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/__hidden-measurement", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><button id="outside">Outside</button><div id="viewport" style="width:600px;height:300px;overflow:auto;position:relative"></div>',
      }),
    );
    await page.goto(`${base}/__hidden-measurement`);
    await page.evaluate(async () => {
      const subscriptions = [];
      const NativeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback) {
          super(callback);
          this.targets = new Set();
          subscriptions.push(this.targets);
        }
        observe(target, options) {
          super.observe(target, options);
          this.targets.add(target);
        }
        unobserve(target) {
          super.unobserve(target);
          this.targets.delete(target);
        }
        disconnect() {
          super.disconnect();
          this.targets.clear();
        }
      };
      const { createVirtualList } = await import("/src/virtual-list.ts");
      const viewport = document.querySelector("#viewport");
      const rows = new Map();
      const mounted = [];
      const destroyed = [];
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        text: `Row ${i}`,
      }));
      const list = createVirtualList(viewport, {
        items,
        key: (item) => item.id,
        boot: "start",
        pinning: false,
        overscanPx: 0,
        render(item, existing) {
          const row = existing ?? document.createElement("article");
          row.style.minHeight = "80px";
          row.style.font = "16px/20px monospace";
          row.textContent = item.text;
          rows.set(item.id, row);
          return row;
        },
        onMount: (_, item) => mounted.push(item.id),
        onDestroy: (_, item) => destroyed.push(item.id),
      });
      window.probe = {
        list,
        viewport,
        rows,
        mounted,
        destroyed,
        items,
        subscriptions,
      };
      list.updateItem("99", { id: "99", text: "Streaming ".repeat(100) });
      const row = rows.get("99");
      const root = row.parentElement;
      const observer = new MutationObserver(() => {});
      observer.observe(root, { childList: true });
      list.updateItem("99", { id: "99", text: "Streaming ".repeat(150) });
      window.probe.reconnections = observer.takeRecords().length;
      observer.disconnect();
      const button = document.createElement("button");
      button.textContent = "Hidden resident unique action";
      button.style.visibility = "visible";
      row.append(button);
      document.querySelector("#outside").focus();
      button.focus();
      Object.assign(window.probe, { row, root, button });
    });
    const hidden = await page.evaluate(() => {
      const {
        list,
        row,
        root,
        mounted,
        reconnections,
        viewport,
        subscriptions,
      } = window.probe;
      return {
        connected: row.isConnected,
        offScroller: !viewport.contains(row),
        mounted: list.elementOf("99") !== null || mounted.includes("99"),
        count: root.childElementCount,
        opacity: getComputedStyle(root).opacity,
        inert: root.inert,
        ariaHidden: root.getAttribute("aria-hidden"),
        focus: document.activeElement.id,
        reconnections,
        observed: subscriptions.some((targets) => targets.has(row)),
        found: window.find("Hidden resident unique action"),
      };
    });
    const { found, ...hiddenState } = hidden;
    // WebKit's legacy window.find can match visibility overrides even inside
    // an inert, aria-hidden, transparent subtree. Do not mistake this API for
    // an accessibility audit or silently claim native Find UI coverage.
    if (engine !== webkit) assert.equal(found, false);
    else console.log(`webkit: window.find with visibility override = ${found}`);
    assert.equal(
      await page.evaluate(() => {
        const { button } = window.probe;
        button.style.visibility = "";
        const found = window.find("Hidden resident unique action");
        button.style.visibility = "visible";
        return found;
      }),
      false,
    );
    assert.deepEqual(hiddenState, {
      connected: true,
      offScroller: true,
      mounted: false,
      count: 1,
      opacity: "0",
      inert: true,
      ariaHidden: "true",
      focus: "outside",
      reconnections: 0,
      observed: false,
    });
    assert.equal(
      await page
        .getByRole("button", { name: "Hidden resident unique action" })
        .count(),
      0,
    );
    // Decode a late resource while hidden. The mounted-only remeasure API is
    // still a no-op here; the initial mount observation must publish growth.
    const growth = await page.evaluate(async () => {
      const { list, row } = window.probe;
      const before = list.positionOf("99").height;
      const image = document.createElement("img");
      image.style.display = "block";
      image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="137"/>')}`;
      row.append(image);
      await image.decode();
      const actual = row.getBoundingClientRect().height;
      list.remeasure("99");
      await new Promise(requestAnimationFrame);
      return { before, actual, committed: list.positionOf("99").height };
    });
    assert.ok(growth.actual > growth.before);
    assert.equal(growth.committed, growth.before);
    await page.evaluate(async () => {
      await window.probe.list.scrollTo("99", { align: "start" });
    });
    await page.waitForFunction(() => {
      const { list, row } = window.probe;
      return (
        list.elementOf("99") === row &&
        Math.abs(
          list.positionOf("99").height - row.getBoundingClientRect().height,
        ) < 1
      );
    });
    await page.evaluate(() => {
      window.probe.viewport.style.width = "360px";
    });
    await page.waitForFunction(() => {
      const { list, row } = window.probe;
      return (
        row.getBoundingClientRect().width === 360 &&
        Math.abs(
          list.positionOf("99").height - row.getBoundingClientRect().height,
        ) < 1
      );
    });
    assert.deepEqual(
      await page.evaluate(() => {
        const { row, root, button, mounted, viewport } = window.probe;
        button.focus();
        return {
          visible: viewport.contains(row),
          rootEmpty: root.childElementCount === 0,
          interactive: document.activeElement === button,
          mountCount: mounted.filter((key) => key === "99").length,
          opacity: getComputedStyle(row).opacity,
        };
      }),
      {
        visible: true,
        rootEmpty: true,
        interactive: true,
        mountCount: 1,
        opacity: "1",
      },
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Hidden resident unique action" })
        .count(),
      1,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const { list, rows, root, items, destroyed, subscriptions } =
          window.probe;
        list.updateItem("0", { id: "0", text: "Offscreen update" });
        const resident = rows.get("0");
        const retained = resident.parentElement === root;
        list.setItems(items.slice(1));
        const removed = resident.parentElement === null;
        list.dispose();
        return {
          retained,
          removed,
          destroyedOnce: destroyed.filter((key) => key === "0").length === 1,
          rootRemoved: !root.isConnected && root.childElementCount === 0,
          connectedRows: [...rows.values()].filter((row) => row.isConnected)
            .length,
          hiddenRoots: document.querySelectorAll('[inert][aria-hidden="true"]')
            .length,
          subscriptions: subscriptions.reduce(
            (sum, targets) => sum + targets.size,
            0,
          ),
        };
      }),
      {
        retained: true,
        removed: true,
        destroyedOnce: true,
        rootRemoved: true,
        connectedRows: 0,
        hiddenRoots: 0,
        subscriptions: 0,
      },
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: hidden retention, focus exclusion, growth, width, mount, removal, and disposal passed`,
    );
  } finally {
    await browser.close();
  }
}
