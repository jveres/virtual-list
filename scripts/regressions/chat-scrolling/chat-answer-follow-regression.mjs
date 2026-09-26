// Offline streams with leading tools, delayed text, and interleaved tools.
// These are correctness checks, not physical scroll-presentation measurements.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  openAIStreamMock,
} from "../shared/openai-stream.mjs";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    await page.addInitScript(openAIStreamMock, {
      settings: OFFLINE_AI_SETTINGS,
      emitEvent: "answerFollowEvent",
      emitText: "answerFollowText",
      finish: "finishAnswerFollow",
      responseId: "resp_answer_follow",
    });
    await page.addInitScript(() => {
      if (!localStorage.getItem("virtual-list:chat-options"))
        localStorage.setItem(
          "virtual-list:chat-options",
          JSON.stringify({
            follow: "keep-start",
            sticky: true,
            landing: "end",
          }),
        );
    });
    const errors = await openStreamingDemo(page, base);
    const row = page.locator("article.message.assistant").last();
    const text = Array.from(
      { length: 24 },
      (_, index) =>
        `Answer paragraph ${index + 1}. ${"Readable answer content. ".repeat(12)}\n\n`,
    ).join("");
    const sendText = (text) =>
      page.evaluate((text) => window.answerFollowText(text), text);
    const tools = (count, prefix) =>
      page.evaluate(
        ({ count, prefix }) => {
          for (let index = 0; index < count; index++) {
            const item = {
              id: `${prefix}-${index}`,
              type: "reasoning",
              status: "completed",
              summary: [
                { type: "summary_text", text: "Tool summary, not the answer." },
              ],
            };
            window.answerFollowEvent({
              type: "response.output_item.added",
              item,
            });
            window.answerFollowEvent({
              type: "response.output_item.done",
              item,
            });
          }
        },
        { count, prefix },
      );
    const start = async (prompt) => {
      await page.evaluate(() => {
        delete window.answerFollowEvent;
      });
      await page.locator("#prompt").fill(prompt);
      await page.locator("#send-btn").click();
      await page.waitForFunction(
        () => typeof window.answerFollowEvent === "function",
      );
    };
    const top = () => page.locator("#viewport").evaluate((el) => el.scrollTop);
    const atEnd = () =>
      page.waitForFunction(() => {
        const el = document.querySelector("#viewport");
        return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
      });
    const atStart = (answer = false) =>
      page
        .waitForFunction(
          ({ answer, inset }) => {
            const viewport = document.querySelector("#viewport");
            const row = [
              ...viewport.querySelectorAll("article.message.assistant"),
            ].at(-1);
            const element = answer
              ? [...row.querySelectorAll("p")].find((el) =>
                  el.textContent.startsWith("Answer paragraph 1."),
                )
              : row;
            return (
              element &&
              Math.abs(
                element.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top -
                  inset,
              ) <= 2
            );
          },
          { answer, inset: 40 },
        )
        .catch(async (error) => {
          console.error(
            await row.evaluate((row) => {
              const viewport = document.querySelector("#viewport");
              const origin = viewport.getBoundingClientRect().top;
              return {
                scrollTop: viewport.scrollTop,
                max: viewport.scrollHeight - viewport.clientHeight,
                row: row.getBoundingClientRect().top - origin,
                text: [...row.querySelectorAll(".markdown, p")]
                  .slice(0, 4)
                  .map((el) => ({
                    tag: el.className || el.tagName,
                    top: el.getBoundingClientRect().top - origin,
                  })),
              };
            }),
          );
          throw error;
        });
    const pause = () => page.waitForTimeout(900);

    await start("Show the answer after many tools");
    await tools(32, "leading");
    await atStart();
    await pause();
    const oldLimit = await top();
    await page.locator("#ai-settings-btn").click();
    await page.locator("#autoscroll-mode").selectOption("keep-content");
    await page.mouse.click(10, 10); // Close the settings backdrop, without stopping the stream.
    await atEnd();
    await pause();
    assert.ok(
      (await top()) > oldLimit + 200,
      "tool-only replies can scroll past their row start",
    );

    await sendText(" \n\n");
    await tools(1, "after-whitespace");
    await atEnd();
    await sendText(text);
    await atStart(true);
    await pause();
    const limited = await top();
    const leadingBottom = await row
      .locator(".tool-calls")
      .last()
      .evaluate(
        (el) =>
          el.getBoundingClientRect().bottom -
          document.querySelector("#viewport").getBoundingClientRect().top,
      );
    assert.ok(
      leadingBottom <= 40,
      "leading tool cards scrolled above the answer",
    );
    await tools(1, "interleaved");
    await sendText(text);
    await pause();
    assert.ok(
      Math.abs((await top()) - limited) <= 2,
      "later tools and text keep the first answer visible",
    );

    await page.locator("#viewport").hover();
    await page.mouse.wheel(0, -300);
    await pause();
    const reading = await top();
    assert.ok(reading < limited - 100, "the manual scroll actually moved");
    await sendText(text);
    await pause();
    assert.ok(
      Math.abs((await top()) - reading) <= 2,
      "manual reading disables follow",
    );
    await page.locator("#scroll-bottom-btn").click();
    await atEnd();
    await pause();
    await sendText(text);
    await atEnd();
    await page.evaluate(() => window.finishAnswerFollow());
    await page.waitForFunction(() =>
      document.querySelector("#send-btn").textContent.includes("Send"),
    );
    await page.reload();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    assert.equal(
      await page.locator("#autoscroll-mode").inputValue(),
      "keep-content",
    );

    await start("Reply without any tools");
    await sendText(text);
    await atStart(true);
    await pause();
    const plainLimit = await top();
    await sendText(text);
    await pause();
    assert.ok(
      Math.abs((await top()) - plainLimit) <= 2,
      "tool-free replies stop at their text too",
    );
    await page.evaluate(() => window.finishAnswerFollow());
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine: engine.name(),
        result: "passed",
        limited,
        plainLimit,
      }),
    );
  } finally {
    await browser.close();
  }
}
