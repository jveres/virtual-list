// Synthetic counterpart of the transcript-specific keep-start/pointer probes.
// This is a correctness regression, not native Safari or Firefox profiling.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    for (const behavior of ["auto", "smooth"]) {
      const result = await page.evaluate(async (behavior) => {
        const { createVirtualList } = await import("/src/virtual-list.ts");
        const viewport = document.createElement("div");
        viewport.style.cssText =
          "position:fixed;inset:0 auto auto 0;width:400px;height:600px;overflow:auto";
        document.body.append(viewport);
        const following = [];
        const items = Array.from({ length: 20 }, (_, id) => ({
          id,
          height: 100,
        }));
        const list = createVirtualList(viewport, {
          items,
          key: (item) => String(item.id),
          render(item, existing) {
            const row = existing ?? document.createElement("div");
            row.style.height = `${item.height}px`;
            row.textContent = `Synthetic reply ${item.id}`;
            return row;
          },
          followBehavior: "smooth",
          followMode: "keep-start",
          followInset: 40,
          scrollingUpdates: "live",
          onState: (state) => following.push(state.following),
        });
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const snapshot = () => ({
          top: viewport.scrollTop,
          max: viewport.scrollHeight - viewport.clientHeight,
          following: list.state.following,
        });
        async function atTop(top) {
          for (let attempt = 0; attempt < 300; attempt++) {
            if (Math.abs(viewport.scrollTop - top) < 1) return;
            await pause(20);
          }
          throw new Error(`Expected top ${top}, got ${viewport.scrollTop}`);
        }
        try {
          await pause(900);
          list.updateItem("19", { id: 19, height: 800 });
          await atTop(1860);
          await pause(900);
          const limited = snapshot();
          const command = await list.scrollTo("end", { behavior });
          await atTop(2100);
          following.length = 0;
          const pointerSamples = [];
          for (const height of [900, 1000, 1100, 1200]) {
            list.updateItem("19", { id: 19, height });
            viewport.dispatchEvent(
              new PointerEvent("pointermove", {
                bubbles: true,
                pointerType: "mouse",
                buttons: 0,
                clientX: 100,
                clientY: 100,
              }),
            );
            pointerSamples.push(list.state.following);
            await pause(8);
          }
          await atTop(2500);
          // A quiet stream must not consume the explicit end-follow override.
          await pause(900);
          const stalled = snapshot();
          list.updateItem("19", { id: 19, height: 1600 });
          await atTop(2900);
          await pause(900);
          return {
            command,
            limited,
            stalled,
            final: snapshot(),
            following,
            pointerSamples,
          };
        } finally {
          list.dispose();
          viewport.remove();
        }
      }, behavior);
      assert.equal(result.command, true);
      assert.deepEqual(result.limited, {
        top: 1860,
        max: 2100,
        following: true,
      });
      assert.deepEqual(result.stalled, {
        top: 2500,
        max: 2500,
        following: true,
      });
      assert.deepEqual(result.final, { top: 2900, max: 2900, following: true });
      assert.deepEqual(result.pointerSamples, [true, true, true, true]);
      assert.ok(result.following.length > 0);
      assert.equal(result.following.includes(false), false);
      console.log(
        JSON.stringify({ engine: engine.name(), behavior, result: "passed" }),
      );
    }
  } finally {
    await browser.close();
  }
}
