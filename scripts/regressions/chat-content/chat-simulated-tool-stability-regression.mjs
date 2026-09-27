import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = await openStreamingDemo(page, base);
    await page.locator("#prompt").fill("Explain virtual scrolling");
    await page.locator("#send-btn").click();
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
    assert.deepEqual(
      await page.evaluate(() => {
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
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: simulated tools retain their row and DOM nodes when streaming starts`,
    );
  } finally {
    await browser.close();
  }
}
