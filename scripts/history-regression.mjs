import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/demos/chat-history/`);
    await page.waitForFunction(
      () =>
        window.chatHistory &&
        !document.documentElement.classList.contains("booting"),
    );

    const stats = () => page.evaluate(() => window.chatHistory.stats);
    const idle = () =>
      page.waitForFunction(
        () =>
          !window.chatHistory.stats.busy &&
          !window.chatHistory.virtualList.state.held,
      );
    const jump = async (index, align = "top", behavior = "instant") => {
      assert.equal(
        await page.evaluate(
          ({ index, align, behavior }) =>
            window.chatHistory.jump(index, { align, behavior }),
          { index, align, behavior },
        ),
        true,
        `jump ${index}/${align}`,
      );
      await idle();
    };
    async function aligned(index, align = "top", sticky = true) {
      const result = await page.evaluate(
        ({ index, align, sticky }) => {
          const v = document.querySelector("#viewport");
          const row = v.querySelector(`[data-message-index="${index}"]`);
          if (!row) return null;
          const rect = row.getBoundingClientRect();
          const expected =
            align === "center"
              ? (v.clientHeight - rect.height) / 2
              : align === "bottom"
                ? v.clientHeight - rect.height
                : sticky || index % 8 === 0
                  ? 44
                  : 0;
          return { actual: rect.top - v.getBoundingClientRect().top, expected };
        },
        { index, align, sticky },
      );
      assert.notEqual(result, null, `message ${index} is mounted`);
      assert.ok(
        Math.abs(result.actual - result.expected) <= 1,
        `alignment ${index}/${align}: ${JSON.stringify(result)}`,
      );
    }
    const boot = await stats();
    assert.equal(boot.retained, 64);
    assert.ok(
      boot.createdElements <= 73,
      `boot rendered only one page: ${JSON.stringify(boot)}`,
    );
    assert.equal(
      await page.evaluate(() => window.chatHistory.items.at(-1).index),
      9999,
    );

    // Exercise the actual user control, including Enter submission.
    await page.fill("#index-input", "853");
    await page.selectOption("#behavior-select", "instant");
    await page.press("#index-input", "Enter");
    await page.waitForFunction(() =>
      window.chatHistory.items.some((item) => item.index === 853),
    );
    await idle();
    await aligned(853);
    const afterJump = await stats();
    assert.equal(
      afterJump.pageLoads - boot.pageLoads,
      1,
      "distant jump fetches one around-page, not intervening pages",
    );
    assert.equal(afterJump.retained, 64);
    assert.ok(afterJump.createdElements - boot.createdElements <= 73);

    // Smooth must produce actual intermediate positions even when a distant
    // target needs a fresh page, and for center/bottom alignment of tall rows.
    for (const [index, align] of [
      [6000, "top"],
      [853, "top"],
      [853, "center"],
      [853, "bottom"],
    ]) {
      const animation = await page.evaluate(
        async ({ index, align }) => {
          const h = window.chatHistory;
          const v = document.querySelector("#viewport");
          const positions = [];
          let done = false;
          const before = h.stats.pageLoads;
          const started = performance.now();
          const moving = h
            .jump(index, { align, behavior: "smooth" })
            .finally(() => {
              done = true;
            });
          while (!done) {
            await new Promise(requestAnimationFrame);
            if (h.virtualList.positionOf(`message:${index}`))
              positions.push(v.scrollTop);
          }
          return {
            landed: await moving,
            positions: [...new Set(positions)],
            elapsed: performance.now() - started,
            fetched: h.stats.pageLoads - before,
          };
        },
        { index, align },
      );
      assert.equal(animation.landed, true);
      assert.ok(
        animation.positions.length >= 5,
        `smooth ${index}/${align} needs intermediate frames: ${JSON.stringify(animation)}`,
      );
      assert.ok(
        animation.elapsed >= 200,
        `smooth ${index}/${align} completed instantly`,
      );
      assert.ok(animation.fetched <= 1);
      await aligned(index, align);
    }
    const pagesAfterSmooth = (await stats()).pageLoads;

    for (const align of ["center", "bottom", "top"]) {
      await jump(854, align, "smooth");
      await aligned(854, align);
    }
    assert.equal(
      (await stats()).pageLoads,
      pagesAfterSmooth,
      "in-window jumps do not fetch",
    );

    await jump(853);
    const pillTiming = await page.evaluate(async () => {
      const h = window.chatHistory;
      const v = document.querySelector("#viewport");
      const descriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      const errors = [];
      let handoffFrames = 0;
      Object.defineProperty(v, "scrollTop", {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(top) {
          descriptor.set.call(this, top);
          // The entire glide write/reconcile finishes before this sample.
          // Query committed geometry and inline styles, never frame layout.
          queueMicrotask(() => {
            const next = h.rows
              .filter((row) => row.kind === "header")
              .map((row) => h.virtualList.positionOf(row.key))
              .find((position) => position && position.top > top);
            const expected = next ? Math.min(0, next.top - top - 44) : 0;
            const slot = document.querySelector(
              ".vl-sticky-header .sticky-group",
            );
            const actual = Number(
              slot.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0,
            );
            if (expected < 0) handoffFrames++;
            if (Math.abs(actual - expected) > 1)
              errors.push({ top, expected, actual });
          });
        },
      });
      try {
        await h.jump(856, { behavior: "smooth" });
        await h.jump(853, { behavior: "smooth" });
      } finally {
        delete v.scrollTop;
      }
      return { errors, handoffFrames };
    });
    assert.ok(pillTiming.handoffFrames >= 3, "sampled the pill handoff");
    assert.deepEqual(pillTiming.errors, [], "pill tracks each glide write");

    for (const behavior of ["instant", "smooth"]) {
      await jump(9999, "top", behavior);
      for (const align of ["center", "bottom"]) {
        await jump(9999, align, behavior);
        await aligned(9999, align);
        const remaining = await page
          .locator("#viewport")
          .evaluate((v) => v.scrollHeight - v.clientHeight - v.scrollTop);
        assert.ok(
          remaining <= 1,
          `last-item ${behavior}/${align} retains ${remaining}px of old pin reserve`,
        );
      }
    }
    await page.click("#sticky-toggle");

    // Actual scroll-boundary callbacks, without calling the paging helper.
    await jump(5000);
    const firstBeforeScroll = await page.evaluate(
      () => window.chatHistory.items[0].index,
    );
    const viewportBox = await page.locator("#viewport").boundingBox();
    await page.mouse.move(
      viewportBox.x + viewportBox.width / 2,
      viewportBox.y + viewportBox.height / 2,
    );
    // Firefox caps the distance of one wheel event; drive actual movement
    // to the edge instead of assuming one oversized delta reaches it.
    for (let step = 0; step < 80; step++) {
      await page.mouse.wheel(0, -3000);
      await page.waitForTimeout(30);
      if (
        await page.evaluate(
          (first) =>
            document.querySelector("#viewport").scrollTop < 1 ||
            window.chatHistory.items[0].index < first,
          firstBeforeScroll,
        )
      )
        break;
    }
    // Playwright wheel input does not model Firefox's native overscroll
    // release. Deliver that separate signal explicitly; the runtime must
    // keep the fetched page held until the gesture has ended.
    await page
      .locator("#viewport")
      .evaluate((viewport) => viewport.dispatchEvent(new Event("scrollend")));
    await page
      .waitForFunction(
        (first) => window.chatHistory.items[0].index < first,
        firstBeforeScroll,
      )
      .catch(async (reason) => {
        throw new Error(
          `${reason.message}: ${JSON.stringify(await page.evaluate(() => ({ stats: window.chatHistory.stats, state: window.chatHistory.virtualList.state, scrollTop: document.querySelector("#viewport").scrollTop, first: window.chatHistory.items[0].index })))}`,
        );
      });
    await idle();
    await jump(853);
    await aligned(853, "top", false);
    await page.click("#sticky-toggle");

    // Newest navigation wins; no stale edge load may reconnect old history.
    const race = await page.evaluate(async () => {
      const h = window.chatHistory;
      const results = await Promise.all([
        h.load("end"),
        h.jump(6000),
        h.jump(21),
        h.jump(853),
      ]);
      return { results, first: h.items[0].index, last: h.items.at(-1).index };
    });
    assert.equal(race.results.at(-1), true);
    assert.ok(race.first <= 853 && race.last >= 853);
    await aligned(853);

    for (const edge of ["end", "start"]) {
      for (let i = 0; i < 5; i++) {
        const index = await page.evaluate((edge) => {
          const items = window.chatHistory.items;
          return edge === "end" ? items.at(-5).index : items[4].index;
        }, edge);
        await jump(index);
        const before = await page.evaluate(
          (index) => ({
            top: document
              .querySelector(`[data-message-index="${index}"]`)
              .getBoundingClientRect().top,
            first: window.chatHistory.items[0].index,
            last: window.chatHistory.items.at(-1).index,
          }),
          index,
        );
        await page.evaluate((edge) => window.chatHistory.load(edge), edge);
        await idle();
        const after = await page.evaluate(
          (index) => ({
            top: document
              .querySelector(`[data-message-index="${index}"]`)
              .getBoundingClientRect().top,
            first: window.chatHistory.items[0].index,
            last: window.chatHistory.items.at(-1).index,
            stats: window.chatHistory.stats,
            indices: window.chatHistory.items.map((item) => item.index),
          }),
          index,
        );
        assert.ok(
          Math.abs(after.top - before.top) <= 1,
          `${edge} load moved reading point: ${JSON.stringify({ before, after })}`,
        );
        assert.ok(
          edge === "end"
            ? after.last > before.last
            : after.first < before.first,
          `${edge} paging progressed`,
        );
        assert.ok(
          after.stats.retained <= 192,
          `source retained ${after.stats.retained}`,
        );
        assert.ok(
          after.stats.liveElements <= 217,
          `DOM retained ${after.stats.liveElements}`,
        );
        assert.deepEqual(
          after.indices,
          Array.from(
            { length: after.indices.length },
            (_, i) => after.first + i,
          ),
        );
      }
    }

    await jump(853);
    await aligned(853);
    await page.setViewportSize({ width: 390, height: 844 });
    await idle();
    await page.waitForTimeout(150);
    await aligned(853);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.waitForTimeout(150);

    // Unretained endpoints still travel across several screens of the one
    // fetched page. Exercise the actual buttons and sample writes, not layout
    // reads in animation frames. Mounted endpoints keep their natural travel.
    for (const edge of ["start", "end"]) {
      await jump(853);
      const motion = await page.evaluate(async (edge) => {
        const h = window.chatHistory;
        const v = document.querySelector("#viewport");
        const key = `message:${edge === "start" ? 0 : h.total() - 1}`;
        const missing = h.virtualList.positionOf(key) === null;
        const pagesBefore = h.stats.pageLoads;
        const height = v.clientHeight;
        const samples = [];
        const descriptor = Object.getOwnPropertyDescriptor(
          Element.prototype,
          "scrollTop",
        );
        Object.defineProperty(v, "scrollTop", {
          configurable: true,
          get() {
            return descriptor.get.call(this);
          },
          set(top) {
            descriptor.set.call(this, top);
            queueMicrotask(() => {
              if (h.virtualList.positionOf(key))
                samples.push({ top, time: performance.now() });
            });
          },
        });
        try {
          document
            .querySelector(edge === "start" ? "#top-btn" : "#bottom-btn")
            .click();
          while (h.stats.busy) await new Promise(requestAnimationFrame);
          return {
            missing,
            samples,
            height,
            pages: h.stats.pageLoads - pagesBefore,
            retained: h.stats.retained,
            reached:
              edge === "start"
                ? h.virtualList.state.atStart
                : h.virtualList.state.atEnd,
          };
        } finally {
          delete v.scrollTop;
        }
      }, edge);
      assert.equal(motion.missing, true);
      assert.equal(motion.reached, true);
      assert.equal(motion.pages, 1);
      assert.equal(motion.retained, 64);
      const first = motion.samples[0];
      const last = motion.samples.at(-1);
      const distance = Math.abs(last.top - first.top);
      assert.ok(
        distance >= motion.height * 3,
        `${edge} needs a travel leg: ${distance}px`,
      );
      assert.ok(
        distance <= motion.height * 6,
        `${edge} approach is bounded: ${distance}px`,
      );
      assert.ok(
        last.time - first.time >= 550,
        `${edge} includes travel before landing`,
      );
      assert.ok(
        motion.samples.length >= 25,
        `${edge} has intermediate positions`,
      );
      for (let i = 1; i < motion.samples.length; i++) {
        const step = motion.samples[i].top - motion.samples[i - 1].top;
        assert.ok(
          edge === "start" ? step <= 1 : step >= -1,
          `${edge} does not reverse`,
        );
      }
    }
    await jump(0);
    await aligned(0);
    await page.click("#bottom-btn");
    await page.waitForFunction(
      () =>
        window.chatHistory.items.at(-1).index === 9999 &&
        !window.chatHistory.stats.busy,
    );
    await page.evaluate(() => window.chatHistory.append());
    assert.equal(await page.evaluate(() => window.chatHistory.total()), 10100);
    assert.equal(
      await page.evaluate(() => window.chatHistory.items.at(-1).index),
      10099,
    );
    assert.equal(
      await page.evaluate(() => window.chatHistory.virtualList.state.atEnd),
      true,
    );
    await jump(853);
    const countBeforeAppend = (await stats()).pageLoads;
    await page.evaluate(() => window.chatHistory.append());
    await aligned(853);
    assert.equal(
      (await stats()).pageLoads,
      countBeforeAppend,
      "appending at the remote end does not reload earlier history",
    );
    await jump(10199);
    await aligned(10199);
    // Appending while a local glide is active must refresh an exhausted
    // continuation, not leave the new remote tail permanently unreachable.
    await page.evaluate(async () => {
      const h = window.chatHistory;
      const moving = h.jump(10180, { behavior: "smooth" });
      await h.append();
      await moving;
    });
    await idle();
    await page.evaluate(() => window.chatHistory.load("end"));
    await idle();
    assert.ok(
      await page.evaluate(() => window.chatHistory.items.at(-1).index > 10199),
    );
    assert.deepEqual(errors, []);
    assert.equal((await stats()).error, "");
    console.log(
      `${engine.name()}: bounded boot, #853 jump, alignment, latest-wins races, bidirectional eviction, resize, endpoints and append passed`,
    );
  } finally {
    await browser.close();
  }
}
