import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
await mkdir("browser-artifacts/date-pill", { recursive: true });
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    for (const width of [390, 1200]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${base}/demos/streaming/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      const today = Date.now();
      const transcript = [
        "# streaming-chat transcript",
        "",
        ...[
          "Yesterday prompt",
          "Earlier reply. ".repeat(200),
          "Today prompt",
          "Today reply.",
        ].flatMap((text, index) => [
          index % 2 ? "**Assistant**" : "**User**",
          `<!-- turn ${JSON.stringify({ sentAt: today - (index < 2 ? 86400000 : 0) })} -->`,
          "",
          text,
          "",
        ]),
      ].join("\n");
      await page.locator("#import-file").setInputFiles({
        name: "date-pill.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(transcript),
      });
      await page.getByText("Today reply.", { exact: true }).waitFor();
      await page.waitForTimeout(200);
      const offset = await page.evaluate(() => {
        const viewport = document.getElementById("viewport");
        const header = [...viewport.querySelectorAll(".section-header")].find(
          (element) => element.textContent === "Today",
        );
        return (
          header.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        );
      });
      // In-flow, both sides of the handoff threshold, mid-handoff, and pinned;
      // reverse the sequence as well so recycled incoming slots are covered.
      for (const relative of [
        100, 60, 41, 40, 39, 20, 1, 0, 1, 20, 39, 40, 41, 60,
      ]) {
        await page.locator("#viewport").evaluate((element, top) => {
          element.scrollTop = top;
        }, offset - relative);
        await page.waitForTimeout(40);
        const pills = await page.evaluate(() =>
          [...document.querySelectorAll(".section-header-pill")]
            .filter(
              (element) =>
                element.textContent === "Today" &&
                getComputedStyle(element).visibility === "visible" &&
                getComputedStyle(element).color !== "rgba(0, 0, 0, 0)",
            )
            .map((element) => {
              const bounds = element.getBoundingClientRect();
              const clips = [];
              for (
                let parent = element.parentElement;
                parent;
                parent = parent.parentElement
              ) {
                if (
                  ["clip", "hidden", "auto", "scroll"].includes(
                    getComputedStyle(parent).overflowY,
                  )
                ) {
                  const clip = parent.getBoundingClientRect();
                  clips.push({
                    top: clip.top,
                    bottom: clip.bottom,
                    cls: parent.className,
                  });
                }
              }
              return { top: bounds.top, bottom: bounds.bottom, clips };
            }),
        );
        assert.equal(
          pills.length,
          1,
          `Today must be drawn exactly once: ${JSON.stringify({ relative, pills })}`,
        );
        for (const clip of pills[0].clips) {
          assert.ok(
            pills[0].top >= clip.top - 0.01 &&
              pills[0].bottom <= clip.bottom + 0.01,
            `pill border clipped: ${JSON.stringify({ engine: engine.name(), width, relative, pill: pills[0], clip })}`,
          );
        }
        if (relative === 60) {
          const inlinePill = page
            .locator("#viewport .section-header-pill")
            .filter({ hasText: /^Today$/ });
          const bounds = await inlinePill.boundingBox();
          const clip = {
            x: Math.floor(bounds.x) - 8,
            y: Math.floor(bounds.y) - 8,
            width: Math.ceil(bounds.width) + 16,
            height: Math.ceil(bounds.height) + 16,
          };
          const painted = await page.screenshot({ clip });
          const previousStyle = await inlinePill.evaluate((element) => {
            const slot = element.parentElement.parentElement;
            const previous = slot.getAttribute("style");
            slot.style.setProperty("overflow", "visible", "important");
            return previous;
          });
          try {
            const unclipped = await page.screenshot({ clip });
            assert.ok(
              painted.equals(unclipped),
              "the entire in-flow pill and its shadow must match an unclipped reference",
            );
          } finally {
            await inlinePill.evaluate(
              (element, style) =>
                element.parentElement.parentElement.setAttribute(
                  "style",
                  style,
                ),
              previousStyle,
            );
          }
          assert.equal(
            await page
              .locator("#viewport .message")
              .first()
              .evaluate(
                (element) => getComputedStyle(element.parentElement).overflow,
              ),
            "clip",
            "message rows must retain their committed-height clip",
          );
        }
        if ([60, 20, 0].includes(relative)) {
          const viewport = await page.locator("#viewport").boundingBox();
          await page.screenshot({
            path: `browser-artifacts/date-pill/${engine.name()}-${width}-${relative}.png`,
            clip: { x: 0, y: viewport.y, width, height: 180 },
          });
        }
      }
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          engine: engine.name(),
          width,
          pillBorder: "passed",
          handoff: "passed",
        }),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
