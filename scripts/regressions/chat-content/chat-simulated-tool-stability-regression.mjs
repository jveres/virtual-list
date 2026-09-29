import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = await openStreamingDemo(page, base);
    for (const action of ["send", "regenerate"]) {
      if (action === "send") {
        await page.locator("#prompt").fill("Explain virtual scrolling");
        await page.locator("#send-btn").click();
      } else {
        await page
          .locator(".message.assistant")
          .last()
          .locator(".message-refresh-btn")
          .click();
      }
      await page.waitForFunction(() => {
        const row = [
          ...document.querySelectorAll("article.message.assistant"),
        ].at(-1);
        if (
          row?.querySelector('.role-label[data-status="thinking"]') &&
          row.querySelector(".tool-call")
        ) {
          window.toolStability = {
            row,
            tools: [...row.querySelectorAll(".tool-call")],
          };
          // Correctness sampler: observe visibility through the thinking-to-text
          // transition. This is deliberately not a performance measurement.
          const previous = new Map();
          const state = window.toolStability;
          state.frames = 0;
          state.regressions = 0;
          state.visibleTools = new Set();
          state.sampling = true;
          const sample = () => {
            if (!state.sampling) return;
            state.frames++;
            for (const tool of state.tools) {
              let opacity = tool.isConnected ? 1 : 0;
              for (let node = tool; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                opacity *= Number(style.opacity);
                if (style.visibility === "hidden" || style.display === "none")
                  opacity = 0;
                if (node === state.row) break;
              }
              if (opacity + 0.02 < (previous.get(tool) ?? 0))
                state.regressions++;
              previous.set(tool, opacity);
              if (opacity >= 0.95) state.visibleTools.add(tool);
            }
            requestAnimationFrame(sample);
          };
          sample();
          return true;
        }
        return false;
      });
      await page.waitForFunction(() => {
        const row = [
          ...document.querySelectorAll("article.message.assistant"),
        ].at(-1);
        return (
          row?.querySelector('.role-label[data-status="streaming"]') &&
          [...row.querySelectorAll(".markdown")].some(
            (el) => !el.closest(".tool-calls") && el.textContent.trim(),
          )
        );
      });
      await page.waitForTimeout(250);
      assert.deepEqual(
        await page.evaluate(() => {
          window.toolStability.sampling = false;
          if (window.toolStability.frames < 2)
            throw new Error("No sampled transition");
          if (window.toolStability.regressions)
            throw new Error("Tool visibility regressed");
          if (
            window.toolStability.visibleTools.size !==
            window.toolStability.tools.length
          )
            throw new Error("Not all tools became visible");
          const row = [
            ...document.querySelectorAll("article.message.assistant"),
          ].at(-1);
          const tools = [...row.querySelectorAll(".tool-call")];
          return {
            sameRow: row === window.toolStability.row,
            answerHasFocus: row.contains(document.activeElement),
            sameTools:
              tools.length > 0 &&
              tools.length === window.toolStability.tools.length &&
              tools.every((tool, i) => tool === window.toolStability.tools[i]),
          };
        }),
        { sameRow: true, sameTools: true, answerHasFocus: false },
      );
      await page.locator("#send-btn").click();
      await page.waitForFunction(
        () => document.querySelector("#send-btn").textContent === "Send",
      );
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()}/${action}: tools retain their row, nodes, and visibility when streaming starts`,
      );
    }
    await page.reload();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    assert.ok((await page.locator(".tool-call").count()) > 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
