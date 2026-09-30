import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { parseSync } from "vite";
import {
  installScrollIsolation,
  instrumentScrollIsolation,
} from "./scroll-isolation.ts";

test("listener removal separates scroll from input and restores once/abort semantics", async () => {
  const dom = new JSDOM('<div id="viewport"></div>', {
    runScripts: "outside-only",
  });
  const w = dom.window;
  try {
    w.eval(`(${installScrollIsolation.toString()})();`);
    const api = w.__scrollIsolation;
    const viewport = w.document.querySelector("#viewport");
    viewport.scrollTop = 1000;
    api.attach({
      viewport,
      ready: () => true,
      prepare() {},
      resume() {},
      band: () => ({ top: 0, bottom: 10000, height: 500, rows: 20 }),
    });
    let scrolls = 0;
    let wheels = 0;
    let once = 0;
    let aborted = 0;
    let late = 0;
    const controller = new w.AbortController();
    const onScroll = () => scrolls++;
    viewport.addEventListener("scroll", onScroll);
    viewport.addEventListener("scroll", onScroll); // DOM duplicate semantics.
    viewport.addEventListener("wheel", () => wheels++, { passive: true });
    viewport.addEventListener("scroll", () => once++, { once: true });
    viewport.dispatchEvent(new w.Event("scroll"));
    assert.equal(once, 1);
    viewport.addEventListener("scroll", () => aborted++, {
      signal: controller.signal,
    });
    await api.setMode("disabled");
    const stylesheet = w.document.createElement("style");
    stylesheet.dataset.viteDevId = "/workspace/demos/shared/styles.css";
    stylesheet.textContent = "#viewport { overflow: auto; height: 500px; }";
    w.document.head.append(stylesheet);
    const originalCss = stylesheet.textContent;
    const originalSheet = stylesheet.sheet;
    api.reapplyStyles();
    assert.equal(stylesheet.textContent, originalCss);
    assert.notEqual(stylesheet.sheet, originalSheet);
    assert.equal(api.snapshot().mode, "disabled");
    assert.equal(api.snapshot().listeners.attached, 0);
    controller.abort();
    viewport.addEventListener("scroll", () => late++);
    for (const [mode, expectedScrolls, expectedWheels] of [
      ["scroll-off", 0, 1],
      ["input-off", 1, 0],
      ["disabled", 0, 0],
      ["retained", 1, 1],
    ]) {
      await api.setMode(mode);
      const before = { scrolls, wheels, late };
      viewport.dispatchEvent(new w.Event("scroll"));
      assert.equal(
        viewport.dispatchEvent(
          new w.WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: 12,
          }),
        ),
        true,
      );
      assert.equal(scrolls - before.scrolls, expectedScrolls, mode);
      assert.equal(late - before.late, expectedScrolls, mode);
      assert.equal(wheels - before.wheels, expectedWheels, mode);
      const listeners = api.snapshot().listeners;
      if (!expectedScrolls) assert.equal(listeners.scroll, 0);
      if (!expectedWheels) assert.equal(listeners.input, 0);
    }
    assert.equal(once, 1, "a fired once listener must not be reattached");
    assert.equal(aborted, 0, "an aborted listener must not be reattached");
    viewport.removeEventListener("scroll", onScroll);
    const before = scrolls;
    viewport.dispatchEvent(new w.Event("scroll"));
    assert.equal(scrolls, before);
  } finally {
    w.close();
  }
});

test("runtime isolation injection fails closed when its source hooks change", async () => {
  const source = await readFile(
    new URL("../../src/virtual-list.ts", import.meta.url),
    "utf8",
  );
  const transformed = instrumentScrollIsolation(source);
  assert.deepEqual(parseSync("virtual-list.ts", transformed).errors, []);
  assert.throws(
    () =>
      instrumentScrollIsolation(
        source.replace("  const overscanPx =", "  const differentOverscan ="),
      ),
    /Isolation hook changed/,
  );
});
