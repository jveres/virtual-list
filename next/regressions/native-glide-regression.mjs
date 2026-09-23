// virtual-list-next F5: a glide keeps the settle rule under native
// anchoring. One press of the streaming demo's "scroll to top" glides to the
// committed start; the older page the reach loads commits once the glide
// lands, and the reader stays on the old first row. Before the fix, the page
// committed mid-glide, the engine anchored it, and the glide went on to the
// new start, loading every page down to the first. Run against a next server
// (vite.next.config.ts) with BROWSER_MATRIX_URL.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4273";

function datedTranscript(turns) {
  const start = new Date(2026, 8, 2, 9, 0, 0).getTime();
  const lines = [
    "# streaming-chat transcript",
    "",
    "<!-- day -->",
    "## Day",
    "",
  ];
  for (let i = 1; i <= turns; i++) {
    lines.push(
      `**${i % 2 ? "User" : "Assistant"}**`,
      `<!-- turn {"sentAt":${start + i * 120_000}} -->`,
      "",
      `Message ${i} ${"lorem ipsum dolor sit amet ".repeat(8 + (i % 5) * 6)}`,
      "",
    );
  }
  return lines.join("\n");
}

for (const [name, engine] of Object.entries({ firefox, chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await page.evaluate((markdown) => {
      const wrap = document.querySelector(".viewport-wrap");
      const data = new DataTransfer();
      data.items.add(
        new File([markdown], "chat.md", { type: "text/markdown" }),
      );
      for (const type of ["dragenter", "dragover", "drop"])
        wrap.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: data,
          }),
        );
    }, datedTranscript(200));
    await page.waitForFunction(() =>
      /loaded 181-200\/200/.test(
        document.getElementById("window-status")?.textContent ?? "",
      ),
    );
    await page.waitForTimeout(500);
    await page.click("#scroll-top-btn");
    const result = await page.evaluate(async () => {
      const viewport = document.getElementById("viewport");
      const status = () =>
        document
          .getElementById("window-status")
          .textContent.match(/loaded \d+-\d+\/\d+/)?.[0];
      const windows = [status()];
      const deadline = performance.now() + 6_000;
      while (performance.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50));
        if (status() !== windows.at(-1)) windows.push(status());
      }
      return {
        anchoring: viewport.firstElementChild.dataset.anchoring,
        windows,
        scrollTop: viewport.scrollTop,
      };
    });
    assert.equal(result.anchoring, "native", `${name}: native anchoring`);
    assert.deepEqual(
      result.windows,
      ["loaded 181-200/200", "loaded 157-200/200"],
      `${name}: one press commits one older page (${JSON.stringify(result)})`,
    );
    assert.ok(
      result.scrollTop > 1000,
      `${name}: the reader stays on the old first row (${JSON.stringify(result)})`,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${name}: one press landed one older page (scrollTop ${Math.round(result.scrollTop)})`,
    );
  } finally {
    await browser.close();
  }
}
