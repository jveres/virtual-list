// Offline geometry check: cursor and actions occupy one shared footer space.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  for (const hasTouch of [false, true]) {
    const page = await browser.newPage({ hasTouch });
    await page.addInitScript(() => {
      localStorage.setItem(
        "virtual-list:ai-settings",
        JSON.stringify({
          provider: "openai",
          apiKey: "offline-test",
          model: "gpt-5-mini",
        }),
      );
      const original = window.fetch;
      window.fetch = (input, init) => {
        if (!String(input).startsWith("https://api.openai.com/"))
          return original(input, init);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                window.sendFooterText = (delta) =>
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
                    ),
                  );
                window.finishFooterStream = () => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_footer", status: "completed", output: [] } })}\n\n`,
                    ),
                  );
                  controller.close();
                };
                init.signal.addEventListener(
                  "abort",
                  () =>
                    controller.error(
                      new DOMException("Cancelled", "AbortError"),
                    ),
                  { once: true },
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      };
    });
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    for (const markdown of [
      "A short reply.",
      "| A | B |\n| --- | --- |\n| One | Two |",
      "```text\nA code block\n```",
    ]) {
      await page.evaluate(() => {
        window.sendFooterText = null;
      });
      await page.locator("#prompt").fill("Check shared footer");
      await page.locator("#send-btn").click();
      await page.waitForFunction(
        () => typeof window.sendFooterText === "function",
      );
      await page.evaluate((text) => window.sendFooterText(text), markdown);
      const row = page
        .locator(".message.assistant")
        .filter({ has: page.locator(".message-actions[data-latest]") });
      await row.locator(".cursor").waitFor({ state: "attached" });
      await page.waitForTimeout(150);
      const streamingHeight = await row.evaluate(
        (el) => el.getBoundingClientRect().height,
      );
      assert.equal(await row.locator(".message-actions").isVisible(), false);
      await page.evaluate(() => window.finishFooterStream());
      await page.waitForFunction(
        () => document.getElementById("send-btn").textContent === "Send",
      );
      await page.waitForTimeout(150);
      const settled = await row.evaluate((el) => {
        const actions = el
          .querySelector(".message-actions")
          .getBoundingClientRect();
        const body = el
          .querySelector(".message-content")
          .getBoundingClientRect();
        const markdown = el.querySelector(".markdown");
        const reserved = Number.parseFloat(
          getComputedStyle(markdown).paddingBottom,
        );
        const firstButton = el
          .querySelector(".message-actions button")
          .getBoundingClientRect();
        return {
          height: el.getBoundingClientRect().height,
          overlap: body.bottom - actions.top,
          buttonGap: firstButton.top - body.bottom,
          reserved,
        };
      });
      assert.ok(
        Math.abs(settled.height - streamingHeight) < 1,
        `stream end must preserve footer height: ${JSON.stringify({ markdown, hasTouch, streamingHeight, settled })}`,
      );
      assert.equal(
        settled.reserved,
        0,
        "the actions replace the unused cursor padding",
      );
      assert.ok(
        Math.abs(settled.overlap) < 1 && Math.abs(settled.buttonGap - 4) < 1,
        "actions have a compact, hoverable gap and do not overlap markdown",
      );
      const hitTargets = await row
        .locator(".message-actions button")
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => !button.disabled)
            .every((button) => {
              const rect = button.getBoundingClientRect();
              return [0.25, 0.5, 0.75].every((part) =>
                button.contains(
                  document.elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height * part,
                  ),
                ),
              );
            }),
        );
      assert.equal(
        hitTargets,
        true,
        "the visible controls must own their hit targets",
      );
      assert.equal(await row.locator(".message-actions").isVisible(), true);
    }
    await page.close();
  }
  console.log(
    JSON.stringify({
      engine,
      sharedFooter: "passed",
      streamEnd: "passed",
      touch: "passed",
    }),
  );
} finally {
  await browser.close();
}
