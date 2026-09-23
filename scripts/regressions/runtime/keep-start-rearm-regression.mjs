// Let scroll-to-bottom settle before streaming resumes: an in-flight command
// tracks the live end itself and would hide a lost automatic-follow override.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    await openStreamingDemo(page, base);
    const result = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      const viewport = document.createElement("div");
      viewport.style.cssText =
        "position:fixed;inset:0 auto auto 0;width:400px;height:600px;overflow:auto";
      document.body.append(viewport);
      const following = [];
      const list = createVirtualList(viewport, {
        items: [
          { id: "history", height: 1400 },
          { id: "reply", height: 100 },
        ],
        key: (item) => item.id,
        render(item, existing) {
          const row = existing ?? document.createElement("div");
          row.style.height = `${item.height}px`;
          row.textContent = item.id;
          return row;
        },
        followBehavior: "smooth",
        followMode: "keep-start",
        followInset: 40,
        onState: (state) => following.push(state.following),
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));
      const snapshot = () => ({
        top: viewport.scrollTop,
        max: viewport.scrollHeight - viewport.clientHeight,
        following: list.state.following,
      });
      try {
        await settle();
        list.updateItem("reply", { id: "reply", height: 1200 });
        await settle();
        const limited = snapshot();
        const landed = await list.scrollTo("end", { behavior: "smooth" });
        await settle();
        const rearmed = snapshot();
        following.length = 0;
        const resumed = [];
        for (const height of [1400, 1600]) {
          list.updateItem("reply", { id: "reply", height });
          await settle();
          resumed.push(snapshot());
        }
        const resumedFollowing = following.slice();
        list.setItems([
          { id: "history", height: 1400 },
          { id: "reply", height: 1600 },
          { id: "next-reply", height: 100 },
        ]);
        await settle();
        list.updateItem("next-reply", { id: "next-reply", height: 1000 });
        await settle();
        return {
          limited,
          landed,
          rearmed,
          resumed,
          resumedFollowing,
          next: snapshot(),
        };
      } finally {
        list.dispose();
        viewport.remove();
      }
    });
    assert.deepEqual(result.limited, { top: 1360, max: 2000, following: true });
    assert.equal(result.landed, true);
    assert.deepEqual(result.rearmed, { top: 2000, max: 2000, following: true });
    assert.deepEqual(result.resumed, [
      { top: 2200, max: 2200, following: true },
      { top: 2400, max: 2400, following: true },
    ]);
    assert.ok(result.resumedFollowing.length > 0);
    assert.equal(result.resumedFollowing.includes(false), false);
    assert.deepEqual(result.next, { top: 2960, max: 3400, following: true });
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
