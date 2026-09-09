// Offline geometry check: cursor and actions occupy one shared footer space.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit, chromium }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  for (const hasTouch of [false, true]) {
    const page = await browser.newPage({
      hasTouch,
      viewport: hasTouch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      deviceScaleFactor: hasTouch ? 3 : 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 80;
      return canvas.toDataURL();
    });
    for (const markdown of [
      "\n\n",
      "A short reply.",
      "A short reply with trailing newlines.\n\n",
      "| A | B |\n| --- | --- |\n| One | Two |",
      "```text\nA code block\n```",
      "> Outer quote\n>\n> > Nested quote\n\n",
      `![Generated image](${image})\n\n`,
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
      await row
        .locator("img")
        .evaluateAll((images) =>
          Promise.all(images.map((image) => image.decode())),
        );
      await page.waitForTimeout(150);
      const streaming = await row.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const cursor = el.querySelector(".cursor");
        const body = el
          .querySelector(".message-content")
          .getBoundingClientRect();
        const cursorBounds = cursor.getBoundingClientRect();
        return {
          height: bounds.height,
          bareCursor: cursor.parentElement.classList.contains("markdown"),
          cursorTop: cursorBounds.top - body.bottom,
          cursorBottom: cursorBounds.bottom - bounds.bottom,
        };
      });
      const streamingHeight = streaming.height;
      if (streaming.bareCursor) {
        assert.ok(streaming.cursorTop >= -1, JSON.stringify(streaming));
        assert.ok(streaming.cursorBottom <= 0, JSON.stringify(streaming));
      }
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
          footerPadding: Number.parseFloat(getComputedStyle(el).paddingBottom),
          footerHeight: actions.height,
          footerBottom: actions.bottom - el.getBoundingClientRect().bottom,
          buttonHeight: firstButton.height,
          coarse: matchMedia("(any-pointer: coarse)").matches,
          position: getComputedStyle(el.querySelector(".message-actions"))
            .position,
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
      assert.equal(settled.position, "absolute");
      assert.equal(settled.footerHeight, settled.footerPadding);
      assert.ok(Math.abs(settled.footerBottom) < 0.01, JSON.stringify(settled));
      assert.equal(settled.buttonHeight, settled.coarse ? 44 : 24);
      assert.equal(settled.footerPadding, settled.coarse ? 48 : 40);
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
    assert.deepEqual(errors, []);
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
