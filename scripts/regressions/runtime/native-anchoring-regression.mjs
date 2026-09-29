// Native anchoring (F5): Firefox/Chromium can land an older page mid-gesture.
// WebKit holds the prepend until release and preserves the reader explicitly.
// Synthetic input checks geometry, not physical momentum presentation.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openTranscript } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const [name, engine] of Object.entries({ firefox, chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const errors = await openTranscript(page, base, 34, /loaded 13-34\/34/);
    const result = await page.evaluate(async (name) => {
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const viewport = document.getElementById("viewport");
      const canvas = viewport.firstElementChild;
      const status = () => document.getElementById("window-status").textContent;
      // A user scroll to 400px below the top: inside the reach zone, not at
      // the edge. Motionless wheels keep that gesture open from here on.
      viewport.scrollTop = 400;
      viewport.dispatchEvent(new Event("scroll"));
      const hold = () =>
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 0 }));
      hold();
      await frame();
      await frame();
      const rect = viewport.getBoundingClientRect();
      const reading = document
        .elementFromPoint(rect.left + 200, rect.top + 120)
        ?.closest("#viewport > div > div");
      const top = () => reading.getBoundingClientRect().top;
      const before = { top: top(), scrollTop: viewport.scrollTop };
      // From here on, only the engine may move the viewport.
      let writes = 0;
      const own = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get() {
          return own.get.call(this);
        },
        set(value) {
          writes += 1;
          own.set.call(this, value);
        },
      });
      const tops = [];
      const deadline = performance.now() + (name === "webkit" ? 800 : 5_000);
      while (/loaded 13-/.test(status()) && performance.now() < deadline) {
        hold();
        await new Promise((done) => setTimeout(done, 60));
        tops.push(top());
      }
      const beforeRelease = { status: status(), writes };
      if (name === "webkit") {
        viewport.dispatchEvent(new Event("scrollend"));
        const releaseDeadline = performance.now() + 5_000;
        while (
          /loaded 13-/.test(status()) &&
          performance.now() < releaseDeadline
        )
          await new Promise((done) => setTimeout(done, 30));
      }
      await frame();
      await frame();
      return {
        anchoring: canvas.dataset.anchoring,
        status: status(),
        before,
        beforeRelease,
        after: { top: top(), scrollTop: viewport.scrollTop },
        connected: reading.isConnected,
        writes,
        drift: Math.max(
          ...tops.map((value) => Math.abs(value - before.top)),
          0,
        ),
      };
    }, name);
    assert.equal(result.anchoring, "native", `${name}: native anchoring`);
    assert.match(result.status, /loaded 1-34\/34/, `${name}: the page landed`);
    assert.ok(result.connected, `${name}: the reading row survives`);
    if (name === "webkit") {
      assert.match(result.beforeRelease.status, /loaded 13-34\/34/);
      assert.equal(
        result.beforeRelease.writes,
        0,
        "no write during the gesture",
      );
      assert.equal(
        result.writes,
        1,
        "one preserved-anchor write after release",
      );
    } else assert.equal(result.writes, 0, `${name}: no script scroll write`);
    assert.ok(
      result.after.scrollTop > result.before.scrollTop + 1000,
      `${name}: the viewport moved by the page (${JSON.stringify(result)})`,
    );
    assert.ok(
      result.drift <= 1 && Math.abs(result.after.top - result.before.top) <= 1,
      `${name}: the reading row stays still (${JSON.stringify(result)})`,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${name}: a ${name === "webkit" ? "released" : "mid-gesture"} page kept its reader still (scrollTop ${Math.round(result.before.scrollTop)} → ${Math.round(result.after.scrollTop)})`,
    );
  } finally {
    await browser.close();
  }
}
