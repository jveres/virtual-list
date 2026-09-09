import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const viewport of [
      { width: 1900, height: 965 },
      { width: 1200, height: 450 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
      const errors = [];
      const failedRequests = [];
      page.on("requestfailed", (request) =>
        failedRequests.push({ url: request.url(), error: request.failure() }),
      );
      page.on("pageerror", (error) =>
        errors.push(error.stack ?? error.message),
      );
      const ready = async () => {
        await page.goto(`${base}/demos/chat-history/`);
        await page.waitForFunction(
          () =>
            window.chatHistory &&
            !document.documentElement.classList.contains("booting"),
        );
      };
      const idle = () =>
        page.waitForFunction(
          () =>
            !window.chatHistory.stats.busy &&
            !window.chatHistory.virtualList.state.held,
        );
      const bottom = async (index) => {
        await page.click("#bottom-btn");
        await page.waitForFunction(
          (index) => window.chatHistory.items.at(-1).index === index,
          index,
        );
        await idle();
      };
      const go = async (index = 853) => {
        await page.fill("#index-input", String(index));
        await page.click("#goto-btn");
        await page.waitForFunction(
          (index) => window.chatHistory.items.some((m) => m.index === index),
          index,
        );
        await idle();
      };
      const tailGeometry = () =>
        page.evaluate(() => {
          const h = window.chatHistory;
          const v = document.querySelector("#viewport");
          const tail = h.items.at(-1);
          const t = h.virtualList.positionOf(tail.key);
          // Use the last message's measured bottom, not the scroll range:
          // atEnd alone can pass while a stale pin retains blank space.
          const expectedTop = Math.ceil(
            Math.max(0, t.top + t.height - v.clientHeight),
          );
          const row = h.virtualList.elementOf(tail.key);
          return {
            tail: tail.index,
            expectedTop,
            actualTop: v.scrollTop,
            bottomGap: row
              ? v.getBoundingClientRect().top +
                v.clientHeight -
                row.getBoundingClientRect().bottom
              : null,
            reserve: v.scrollHeight - t.top - t.height,
            atEnd: h.virtualList.state.atEnd,
            retained: h.stats.retained,
          };
        });
      const assertTail = async (label) => {
        const geometry = await tailGeometry();
        const detail = `${engine.name()} ${viewport.width} ${label}: ${JSON.stringify(geometry)}`;
        assert.ok(
          Math.abs(geometry.actualTop - geometry.expectedTop) <= 1,
          detail,
        );
        assert.ok(
          Math.abs(geometry.reserve) <= 1,
          `no stale pin reserve: ${detail}`,
        );
        assert.notEqual(geometry.bottomGap, null, detail);
        assert.ok(
          Math.abs(geometry.bottomGap) <= 1,
          `last message sits at the bottom: ${detail}`,
        );
        assert.equal(geometry.atEnd, true, detail);
        assert.ok(geometry.retained <= 192, detail);
        return geometry;
      };

      await ready();
      await idle();
      await assertTail("boot");
      // The reported sequence, using the unchanged default smooth controls.
      await go();
      const beforeAppend = await page.evaluate(() => ({
        top: document.querySelector("#viewport").scrollTop,
        pages: window.chatHistory.stats.pageLoads,
      }));
      await page.click("#add-btn");
      await idle();
      assert.deepEqual(
        await page.evaluate(() => ({
          top: document.querySelector("#viewport").scrollTop,
          pages: window.chatHistory.stats.pageLoads,
        })),
        beforeAppend,
        "remote append preserves the #853 reading window",
      );
      await bottom(10099);
      const landed = await assertTail("Go → append → bottom");
      assert.equal(landed.tail, 10099);

      // Retarget an existing last-row pin without retaining its larger gap.
      await go(10099);
      await bottom(10099);
      await assertTail("bottom clears a last-reply pin");
      await page.click("#sticky-toggle");
      await bottom(10099);
      await assertTail("bottom with sticky headers off");
      await page.click("#sticky-toggle");
      await bottom(10099);
      await assertTail("bottom with sticky headers on");

      // No demo resize compensation: the runtime owns end anchoring on reflow.
      await page.setViewportSize({ width: 1500, height: 1100 });
      await page.waitForTimeout(200);
      await idle();
      await assertTail("resized end");
      await page.setViewportSize(viewport);
      await page.waitForTimeout(200);
      await idle();
      await bottom(10099);
      await assertTail("bottom after resize");

      // Appending at the current end uses the same runtime command as bottom.
      await page.click("#add-btn");
      await page.waitForFunction(
        () => window.chatHistory.items.at(-1).index === 10199,
      );
      await idle();
      await assertTail("append while at end");

      assert.deepEqual(errors, [], JSON.stringify(failedRequests));
      assert.equal(
        await page.evaluate(() => window.chatHistory.stats.error),
        "",
      );
      console.log(
        `${engine.name()} ${viewport.width}×${viewport.height}: history ends at the last message without a pin`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
