import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit].filter(
  (engine) =>
    !process.env.BROWSER_ENGINE || process.env.BROWSER_ENGINE === engine.name(),
)) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1900, height: 964 },
    });
    const errors = await openStreamingDemo(page, base, {
      path: "/demos/streaming/index.html?scroll-isolation",
    });
    await page.waitForFunction(() => window.__scrollIsolation?.ready());
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
      window.isolationEvents = { target: 0, capture: 0 };
      viewport.addEventListener(
        "scroll",
        () => window.isolationEvents.target++,
      );
      window.addEventListener(
        "scroll",
        (event) => {
          if (event.target === viewport) window.isolationEvents.capture++;
        },
        true,
      );
    });
    await page.waitForFunction(
      () =>
        window.isolationEvents.capture > 0 && window.__scrollIsolation.ready(),
    );
    await page.evaluate(() => window.__scrollIsolation.setMode("retained"));
    const band = await page.evaluate(() => {
      window.isolationRows = [
        ...document.querySelectorAll("article.message"),
      ].filter((row) => !row.closest('[aria-hidden="true"]'));
      return window.__scrollIsolation.snapshot().band;
    });
    assert.ok(band.rows > 1 && band.rows <= 64);
    assert.ok(band.bottom - band.top >= band.height * 8, JSON.stringify(band));
    for (const mode of ["retained", "paused", "retained", "paused"]) {
      await page.waitForFunction(() => window.__scrollIsolation.ready());
      await page.evaluate(
        (value) => window.__scrollIsolation.setMode(value),
        mode,
      );
      const before = await page.evaluate(() => ({ ...window.isolationEvents }));
      await page.evaluate(() => {
        document.querySelector("#viewport").scrollTop += 350;
      });
      await page.waitForFunction(
        (count) => window.isolationEvents.capture > count,
        before.capture,
      );
      const after = await page.evaluate(() => ({
        ...window.isolationEvents,
        snapshot: window.__scrollIsolation.snapshot(),
        retained: window.isolationRows.every(
          (row) => row.isConnected && !row.closest('[aria-hidden="true"]'),
        ),
      }));
      assert.equal(after.snapshot.mode, mode, JSON.stringify(after.snapshot));
      assert.equal(after.retained, true);
      if (mode === "paused") assert.equal(after.target, before.target);
      else assert.ok(after.target > before.target);
    }
    await page.evaluate(() => window.__scrollIsolation.setMode("disabled"));
    const disabled = await page.evaluate(() => ({
      events: { ...window.isolationEvents },
      snapshot: window.__scrollIsolation.snapshot(),
      top: document.querySelector("#viewport").scrollTop,
    }));
    assert.equal(disabled.snapshot.listeners.attached, 0);
    assert.ok(disabled.snapshot.listeners.registered > 10);
    await page.evaluate(() => {
      const viewport = document.querySelector("#viewport");
      viewport.scrollTop += 200;
      viewport.dispatchEvent(new Event("scroll"));
      viewport.dispatchEvent(new Event("scrollend"));
      viewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 10 }),
      );
      window.lateIsolationEvents = 0;
      viewport.addEventListener("scroll", () => window.lateIsolationEvents++);
    });
    // Allow actual scroll events to dispatch, without installing a sampler.
    await page.waitForTimeout(150);
    const stillDisabled = await page.evaluate(() => ({
      events: { ...window.isolationEvents },
      lateEvents: window.lateIsolationEvents,
      snapshot: window.__scrollIsolation.snapshot(),
      top: document.querySelector("#viewport").scrollTop,
    }));
    assert.deepEqual(stillDisabled.events, disabled.events);
    assert.equal(stillDisabled.lateEvents, 0);
    assert.equal(stillDisabled.top, disabled.top + 200);
    assert.equal(stillDisabled.snapshot.mode, "disabled");
    assert.equal(stillDisabled.snapshot.listeners.attached, 0);
    assert.equal(
      stillDisabled.snapshot.blockedScrolls,
      disabled.snapshot.blockedScrolls,
    );
    await page.evaluate(() => window.__scrollIsolation.setMode("retained"));
    assert.equal(await page.evaluate(() => window.lateIsolationEvents), 0);
    await page.evaluate(() => {
      document.querySelector("#viewport").scrollTop += 20;
    });
    await page.waitForFunction(() => window.lateIsolationEvents > 0);
    const restoredListeners = await page.evaluate(
      () => window.__scrollIsolation.snapshot().listeners,
    );
    assert.equal(restoredListeners.attached, restoredListeners.registered);
    for (const [mode, removed, retained] of [
      ["scroll-off", "scroll", "input"],
      ["input-off", "input", "scroll"],
    ]) {
      await page.waitForFunction(() => window.__scrollIsolation.ready());
      await page.evaluate(
        (value) => window.__scrollIsolation.setMode(value),
        mode,
      );
      const listeners = await page.evaluate(
        () => window.__scrollIsolation.snapshot().listeners,
      );
      assert.equal(listeners[removed], 0, mode);
      assert.ok(listeners[retained] > 0, mode);
    }
    await page.waitForFunction(() => window.__scrollIsolation.ready());
    await page.evaluate(() => window.__scrollIsolation.setMode("paused"));
    // The guard must not cancel the browser's default wheel action.
    assert.equal(
      await page.evaluate(() =>
        document.querySelector("#viewport").dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: 50,
          }),
        ),
      ),
      true,
    );
    await page.evaluate(() => {
      document.querySelector("#viewport").scrollTop =
        window.__scrollIsolation.snapshot().band.top;
    });
    await page.waitForFunction(
      () => window.__scrollIsolation.snapshot().mode === "normal",
    );
    assert.match(
      await page.locator("#scroll-isolation").innerText(),
      /edge of the prepared region/,
    );
    await page.waitForFunction(() => window.__scrollIsolation.ready());
    await page.evaluate(() => window.__scrollIsolation.setMode("paused"));
    await page.setViewportSize({ width: 1800, height: 964 });
    await page.waitForFunction(
      () => window.__scrollIsolation.snapshot().mode === "normal",
    );
    assert.match(
      await page.locator("#scroll-isolation").innerText(),
      /Viewport resized/,
    );
    assert.deepEqual(errors, []);
    await page.goto(`${base}/demos/streaming/index.html`);
    assert.equal(
      await page.evaluate(() => typeof window.__scrollIsolation),
      "undefined",
    );
    console.log(
      `${engine.name()}: retained rows, bypassed/removed listeners, zero callbacks during movement, listener restoration, boundary/resize recovery, opt-in isolation passed`,
    );
  } finally {
    await browser.close();
  }
}
