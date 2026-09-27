// Completion/cancellation correctness in real engines, not presentation timing.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
    });
    await page.goto(base);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const result = await page.evaluate(async () => {
      const { createVirtualList } = await import("/src/virtual-list.ts");
      document.body.replaceChildren();
      const viewport = document.createElement("div");
      viewport.style.cssText = "height:600px;width:800px;overflow:auto";
      viewport.tabIndex = 0;
      document.body.append(viewport);
      let suppressEnd = false;
      viewport.addEventListener("scrollend", (event) => {
        if (suppressEnd) event.stopImmediatePropagation();
      });
      const list = createVirtualList(viewport, {
        items: Array.from({ length: 1000 }, (_, i) => i),
        key: String,
        height: () => 100,
        boot: "start",
        pinning: false,
        render: (item) => {
          const row = document.createElement("div");
          row.textContent = `Row ${item}`;
          row.style.height = "100px";
          return row;
        },
      });
      const smoothCalls = [];
      const scrollTo = viewport.scrollTo.bind(viewport);
      viewport.scrollTo = (options) => {
        smoothCalls.push(options.behavior);
        scrollTo(options);
      };
      const deadline = async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Native command did not complete")),
                6000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const outcomes = [];
      try {
        // A recent unmanaged scroll still has a live settle phase. Rebuilding
        // its scrolling layer used to strand the next WebKit smooth command.
        viewport.scrollTop = 60000;
        await new Promise((resolve) => setTimeout(resolve, 50));
        outcomes.push({
          target: "recent-native-takeover",
          completed: await deadline(
            list.scrollTo("start", { behavior: "smooth" }),
          ),
          position: viewport.scrollTop,
          expected: 0,
        });
        for (const [target, expected] of [
          ["end", 99400],
          ["start", 0],
          ["250", 25000],
        ]) {
          outcomes.push({
            target,
            completed: await deadline(
              list.scrollTo(target, { behavior: "smooth" }),
            ),
            position: viewport.scrollTop,
            expected,
          });
        }
        // A no-op does not necessarily generate scrollend.
        outcomes.push({
          target: "noop",
          completed: await deadline(
            list.scrollTo("250", { behavior: "smooth" }),
          ),
          position: viewport.scrollTop,
          expected: 25000,
        });
        // Suppress all ends to exercise target-confirmed quiet completion.
        suppressEnd = true;
        outcomes.push({
          target: "missing-end",
          completed: await deadline(
            list.scrollTo("start", { behavior: "smooth" }),
          ),
          position: viewport.scrollTop,
          expected: 0,
        });
        suppressEnd = false;
        const first = list.scrollTo("end", { behavior: "smooth" });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const second = list.scrollTo("start", { behavior: "smooth" });
        const superseded = await deadline(first);
        const replacement = await deadline(second);
        const keyed = list.scrollTo("end", { behavior: "smooth" });
        await new Promise((resolve) => setTimeout(resolve, 80));
        viewport.dispatchEvent(
          new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
        );
        const keyboardCancelled = await deadline(keyed);
        const disposed = list.scrollTo("end", { behavior: "smooth" });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        list.dispose();
        return {
          outcomes,
          superseded,
          replacement,
          keyboardCancelled,
          disposed: await deadline(disposed),
          smoothCalls,
        };
      } finally {
        list.dispose();
      }
    });
    for (const outcome of result.outcomes) {
      assert.equal(
        outcome.completed,
        true,
        `${engine.name()}: ${outcome.target}`,
      );
      assert.ok(
        Math.abs(outcome.position - outcome.expected) <= 1,
        JSON.stringify(outcome),
      );
    }
    assert.equal(result.superseded, false);
    assert.equal(result.replacement, true);
    assert.equal(result.keyboardCancelled, false);
    assert.equal(result.disposed, false);
    assert.ok(
      result.smoothCalls.filter((behavior) => behavior === "smooth").length >=
        7,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: native arrival, missing end, no-op, supersession, keyboard cancellation, and disposal passed`,
    );
  } finally {
    await browser.close();
  }
}
