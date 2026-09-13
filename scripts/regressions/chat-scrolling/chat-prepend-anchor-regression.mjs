// Geometry correctness only; native gesture/compositor evidence is recorded separately.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
// Optional local, linear exported transcript. Never copy user data into this test.
const imported = process.env.PREPEND_TRANSCRIPT
  ? await readFile(process.env.PREPEND_TRANSCRIPT, "utf8")
  : null;
const turns = imported
  ? [...imported.matchAll(/^<!-- body \d+ -->$/gm)].length
  : 240;
assert.ok(turns > 0, "transcript contains serialized turns");
const failures = [];
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const demo of ["chat-history", "streaming"]) {
      const page = await browser.newPage({
        viewport: { width: 1900, height: 965 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${base}/demos/${demo}/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      if (demo === "streaming") {
        const transcript =
          imported ??
          Array.from(
            { length: 240 },
            (_, i) =>
              `**${i % 2 ? "Assistant" : "User"}**\n\nTurn ${i + 1}. ${"Paging anchor content. ".repeat(30)}\n`,
          ).join("\n");
        await page.locator("#import-file").setInputFiles({
          name: "prepend-anchor.md",
          mimeType: "text/markdown",
          buffer: Buffer.from(transcript),
        });
        await page.locator(`#viewport [data-key="${turns}"]`).waitFor();
      }
      const shifts = [];
      for (let step = 0; step < 5; step++) {
        const before = await page.evaluate((demo) => {
          const viewport = document.querySelector("#viewport");
          const first =
            demo === "chat-history"
              ? window.chatHistory.items[0].index
              : Number(
                  /loaded ([\d,]+)-/
                    .exec(
                      document.querySelector("#window-status").textContent,
                    )[1]
                    .replaceAll(",", ""),
                );
          if (demo === "streaming" && first === 1) return null;
          window.prependAnchor = null;
          const capture = () => {
            if (viewport.scrollTop !== 0) return;
            const bounds = viewport.getBoundingClientRect();
            const row = [...viewport.querySelectorAll(".message")].find(
              (el) => {
                const rect = el.getBoundingClientRect();
                return (
                  rect.bottom > bounds.top + 44 && rect.top < bounds.bottom
                );
              },
            );
            if (!row) throw new Error("No visible reading row");
            window.prependAnchor = row;
            window.prependAnchorY = row.getBoundingClientRect().top;
            viewport.removeEventListener("scroll", capture);
          };
          if (demo === "streaming")
            viewport.addEventListener("scroll", capture);
          else {
            viewport.scrollTop = 0;
            viewport.dispatchEvent(new Event("scroll"));
            viewport.dispatchEvent(new Event("scrollend"));
            capture();
          }
          return { first };
        }, demo);
        if (before === null) break;
        if (demo === "streaming") await page.locator("#scroll-top-btn").click();
        await page.waitForFunction(
          ({ demo, first }) =>
            demo === "chat-history"
              ? window.chatHistory.items[0].index < first &&
                !window.chatHistory.stats.busy
              : Number(
                  /loaded ([\d,]+)-/
                    .exec(
                      document.querySelector("#window-status").textContent,
                    )[1]
                    .replaceAll(",", ""),
                ) < first,
          { demo, first: before.first },
        );
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => ({
          connected: window.prependAnchor.isConnected,
          y: window.prependAnchor.getBoundingClientRect().top,
          beforeY: window.prependAnchorY,
        }));
        assert.equal(after.connected, true, "reading row survives the prepend");
        shifts.push(after.y - after.beforeY);
      }
      console.log(
        `${engine.name()}/${demo}: prepend shifts ${shifts.join(", ")}`,
      );
      if (shifts.some((shift) => Math.abs(shift) >= 0.01))
        failures.push(`${engine.name()}/${demo}: ${JSON.stringify(shifts)}`);
      assert.ok(shifts.length >= 3, "exercise at least three page commits");
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
assert.deepEqual(failures, [], "all prepend anchors remain stationary");
