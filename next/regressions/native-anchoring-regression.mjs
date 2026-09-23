// virtual-list-next F5: an older page lands mid-gesture, away from the edge,
// and the engine's own scroll anchoring keeps the row under the reader
// still. Run against a next server (vite.next.config.ts) with
// BROWSER_MATRIX_URL. Synthetic input holds the gesture: motionless wheel
// events keep the settle sensor's phase open while the page commits.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openTranscript } from "./transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4273";

for (const [name, engine] of Object.entries({ firefox, chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const errors = await openTranscript(page, base, 34, /loaded 13-34\/34/);
    const result = await page.evaluate(async () => {
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
      const deadline = performance.now() + 5_000;
      while (/loaded 13-/.test(status()) && performance.now() < deadline) {
        hold();
        await new Promise((done) => setTimeout(done, 60));
        tops.push(top());
      }
      await frame();
      await frame();
      return {
        anchoring: canvas.dataset.anchoring,
        status: status(),
        before,
        after: { top: top(), scrollTop: viewport.scrollTop },
        connected: reading.isConnected,
        writes,
        drift: Math.max(
          ...tops.map((value) => Math.abs(value - before.top)),
          0,
        ),
      };
    });
    assert.equal(result.anchoring, "native", `${name}: native anchoring`);
    assert.match(result.status, /loaded 1-34\/34/, `${name}: the page landed`);
    assert.ok(result.connected, `${name}: the reading row survives`);
    assert.equal(result.writes, 0, `${name}: no script scroll write`);
    assert.ok(
      result.after.scrollTop > result.before.scrollTop + 1000,
      `${name}: the engine moved the viewport by the page (${JSON.stringify(result)})`,
    );
    assert.ok(
      result.drift <= 1 && Math.abs(result.after.top - result.before.top) <= 1,
      `${name}: the reading row stays still (${JSON.stringify(result)})`,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${name}: a mid-gesture page kept its reader still (scrollTop ${Math.round(result.before.scrollTop)} → ${Math.round(result.after.scrollTop)})`,
    );
  } finally {
    await browser.close();
  }
}
