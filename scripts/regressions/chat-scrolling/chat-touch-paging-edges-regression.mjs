// Deliberate event-order and preparation failures; not native iOS momentum.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const failures = [];
const firstLoaded = (page) =>
  page.evaluate(() =>
    Number(
      /loaded ([\d,]+)-/
        .exec(document.querySelector("#window-status").textContent)[1]
        .replaceAll(",", ""),
    ),
  );
const touch = (page, type) =>
  page.evaluate((type) => {
    const event = new Event(type);
    Object.defineProperty(event, "touches", { value: [] });
    document.querySelector("#viewport").dispatchEvent(event);
  }, type);
const scroll = (page, top) =>
  page.evaluate((top) => {
    document.querySelector("#viewport").scrollTop = top;
  }, top);

for (const engine of [webkit, firefox, chromium]) {
  const browser = await engine.launch();
  const scenarios =
    engine === webkit
      ? [
          "regrab",
          "reverse",
          "resize-preparation",
          "rotate-page-size",
          "missing-scrollend",
          "bottom-command",
        ]
      : ["rotate-page-size"];
  try {
    for (const scenario of scenarios) {
      const page = await browser.newPage({
        viewport:
          scenario === "rotate-page-size"
            ? { width: 1024, height: 1366 }
            : { width: 1180, height: 734 },
        isMobile: engine !== firefox,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      try {
        await page.addInitScript(() => {
          window.addEventListener(
            "scrollend",
            (event) => {
              if (window.dropScrollEnd) event.stopImmediatePropagation();
            },
            true,
          );
        });
        const errors = await openStreamingDemo(page, base);
        const before = await firstLoaded(page);
        const previousEnd = await page.evaluate(() =>
          Number(
            /loaded [\d,]+-([\d,]+)/
              .exec(document.querySelector("#window-status").textContent)[1]
              .replaceAll(",", ""),
          ),
        );
        if (scenario === "rotate-page-size") {
          await page.setViewportSize({ width: 1180, height: 734 });
          await page.waitForTimeout(200);
        }
        if (scenario === "missing-scrollend")
          await page.evaluate(() => {
            window.dropScrollEnd = true;
          });
        if (scenario === "resize-preparation") {
          await page.evaluate((before) => {
            const vp = document.querySelector("#viewport");
            const width = vp.clientWidth;
            window.preparationResize = false;
            const observer = new MutationObserver((records) => {
              const added = records.flatMap((record) => [...record.addedNodes]);
              if (
                !added.some(
                  (node) =>
                    node instanceof Element &&
                    [...node.querySelectorAll(".message[data-key]")].some(
                      (row) => Number(row.dataset.key) < before,
                    ),
                )
              )
                return;
              observer.disconnect();
              window.preparationResize = true;
              vp.style.width = `${width - 80}px`;
            });
            observer.observe(vp.firstElementChild, { childList: true });
          }, before);
        }
        await touch(page, "touchstart");
        await scroll(page, 30);
        await page.waitForTimeout(250);
        if (scenario === "regrab") {
          await touch(page, "touchend");
          await scroll(page, 40);
          await touch(page, "touchstart");
          await page.waitForTimeout(700);
          assert.equal(
            await firstLoaded(page),
            before,
            "regrab keeps the prepend pending",
          );
        }
        if (scenario === "reverse") {
          await scroll(page, 600);
          await page.waitForTimeout(400);
        }
        await touch(page, "touchend");
        if (scenario === "bottom-command") {
          await page.evaluate(() =>
            document.querySelector("#scroll-bottom-btn").click(),
          );
          await page.waitForFunction(() => {
            const vp = document.querySelector("#viewport");
            return vp.scrollHeight - vp.clientHeight - vp.scrollTop < 2;
          });
          await page.waitForTimeout(600);
          await touch(page, "touchstart");
          await scroll(page, 30);
          await page.waitForTimeout(250);
          await touch(page, "touchend");
        }
        if (scenario !== "missing-scrollend") await touch(page, "scrollend");
        await page.waitForFunction(
          (before) =>
            Number(
              /loaded ([\d,]+)-/
                .exec(document.querySelector("#window-status").textContent)[1]
                .replaceAll(",", ""),
            ) < before,
          before,
          { timeout: 5000 },
        );
        if (scenario === "resize-preparation")
          assert.equal(
            await page.evaluate(() => window.preparationResize),
            true,
            "resized during preparation",
          );
        const top = await page.evaluate(
          () => document.querySelector("#viewport").scrollTop,
        );
        if (scenario === "rotate-page-size") {
          const end = await page.evaluate(() =>
            Number(
              /loaded [\d,]+-([\d,]+)/
                .exec(document.querySelector("#window-status").textContent)[1]
                .replaceAll(",", ""),
            ),
          );
          assert.equal(
            end,
            previousEnd,
            "a smaller page must still connect to the retained history",
          );
        }
        assert.ok(top > 1200, `reading position survived: ${top}`);
        assert.deepEqual(errors, []);
        console.log(`${engine.name()} ${scenario}: passed`);
      } catch (error) {
        const state = await page.evaluate(() => ({
          status: document.querySelector("#window-status")?.textContent,
          top: document.querySelector("#viewport")?.scrollTop,
          resized: window.preparationResize,
        }));
        console.error(`${engine.name()} ${scenario}:`, error.message, state);
        failures.push(`${engine.name()} ${scenario}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
assert.deepEqual(failures, []);
