// Correctness of edge-trigger ownership during native navigation handoffs.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const delay of process.env.TAKEOVER_CASE === "handoff"
      ? ["handoff"]
      : [0, 100, 350, "handoff"]) {
      const page = await browser.newPage();
      const errors = await openStreamingDemo(page, base);
      const range = () =>
        page.locator("#window-status").evaluate((e) =>
          /loaded ([\d,]+)-([\d,]+)\/([\d,]+)/
            .exec(e.textContent)
            .slice(1)
            .map((s) => Number(s.replaceAll(",", ""))),
        );
      for (let i = 0; i < 4; i++) {
        const before = await range();
        if (before[1] < before[2]) break;
        await page.locator("#scroll-top-btn").click();
        await page.waitForFunction((first) => {
          const s = document.querySelector("#window-status").textContent;
          return (
            Number(/loaded ([\d,]+)-/.exec(s)[1].replaceAll(",", "")) < first &&
            !s.includes("loading")
          );
        }, before[0]);
      }
      const before = await range();
      assert.ok(before[1] < before[2]);
      await page.evaluate(async (delay) => {
        if (delay === "handoff") {
          const viewport = document.querySelector("#viewport");
          const native = viewport.scrollTo;
          viewport.scrollTo = function (...args) {
            const status = document.querySelector("#window-status").textContent;
            const [, , last, total] = /loaded ([\d,]+)-([\d,]+)\/([\d,]+)/.exec(
              status,
            );
            const atHandoff =
              args[0]?.behavior === "smooth" &&
              last === total &&
              viewport.scrollTop < 800;
            const result = native.apply(this, args);
            if (atHandoff) {
              delete viewport.scrollTo;
              setTimeout(() => {
                window.takeoverRange = status;
                document.querySelector("#scroll-top-btn").click();
              }, 0);
            }
            return result;
          };
          document.querySelector("#scroll-bottom-btn").click();
          return;
        }
        document.querySelector("#scroll-bottom-btn").click();
        await new Promise((resolve) => setTimeout(resolve, delay));
        window.takeoverRange =
          document.querySelector("#window-status").textContent;
        document.querySelector("#scroll-top-btn").click();
      }, delay);
      await page.waitForFunction(() => {
        if (!window.takeoverRange) return false;
        const before = Number(
          /loaded ([\d,]+)-/.exec(window.takeoverRange)[1].replaceAll(",", ""),
        );
        const status = document.querySelector("#window-status").textContent;
        const current = Number(
          /loaded ([\d,]+)-/.exec(status)[1].replaceAll(",", ""),
        );
        return (
          !status.includes("loading") && (current < before || current === 1)
        );
      });
      const result = await page.evaluate(() => ({
        beforeTop: window.takeoverRange,
        status: document.querySelector("#window-status").textContent,
        top: document.querySelector("#viewport").scrollTop,
        slot: document.querySelector(".boundary-slot:not([data-edge])")?.dataset
          .state,
      }));
      console.log(JSON.stringify({ engine: engine.name(), delay, ...result }));
      assert.ok(
        result.top > 2 || result.status.startsWith("loaded 1-"),
        `No older-page dead end after takeover: ${JSON.stringify(result)}`,
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
