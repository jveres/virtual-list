// Refresh must begin without another scroll, even when replacing a long
// response clamps the viewport onto the smooth-scroll command's destination.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { chromium, firefox, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1420, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://api.openai.com/**", (route) => route.abort());
  await page.goto(
    `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/?instant`,
  );
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  const arrowSizes = await page
    .locator("#scroll-top-btn svg, #scroll-bottom-btn svg")
    .evaluateAll((elements) =>
      elements.map((el) => ({
        width: getComputedStyle(el).width,
        height: getComputedStyle(el).height,
      })),
    );
  assert.deepEqual(arrowSizes, [
    { width: "14px", height: "14px" },
    { width: "14px", height: "14px" },
  ]);
  await page.locator("#prompt").fill("fast");
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const refresh = page.locator(
      ".message-actions[data-latest] .message-refresh-btn",
    );
    await refresh.scrollIntoViewIfNeeded();
    await refresh.hover();
    await refresh.click();
    // No wheel, touch, click, or manual scrollend after Refresh.
    try {
      await page.waitForFunction(
        () => document.getElementById("send-btn").textContent === "Send",
        undefined,
        { timeout: 4000 },
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          await page.evaluate(() => ({
            engine: navigator.userAgent,
            scrollTop: document.getElementById("viewport").scrollTop,
            text: document
              .querySelector(".message-actions[data-latest]")
              ?.closest(".message")
              ?.querySelector(".markdown")?.textContent,
            buttons: [...document.querySelectorAll("button")].filter(
              (el) => el.textContent === "Stop",
            ).length,
          })),
        ),
      );
      throw error;
    }
    console.log(
      JSON.stringify({
        engine,
        refresh: attempt + 1,
        completedWithoutInput: true,
      }),
    );
  }
  // Real incremental streaming, not just the instant completion path.
  await page.goto(
    `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/`,
  );
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  await page.locator("#prompt").fill("fast");
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
    undefined,
    { timeout: 60000 },
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const refresh = page.locator(
      ".message-actions[data-latest] .message-refresh-btn",
    );
    await refresh.scrollIntoViewIfNeeded();
    await refresh.hover();
    const oldKey = await refresh.evaluate(
      (el) => el.closest(".message").dataset.key,
    );
    await refresh.click();
    await page
      .waitForFunction(
        (oldKey) => {
          const row = document
            .querySelector(".message-actions[data-latest]")
            ?.closest(".message");
          const content = row?.querySelector(".message-content");
          const text = [...(content?.children ?? [])]
            .filter((el) => !el.matches(".tool-calls, .role-label"))
            .map((el) => el.textContent)
            .join("");
          return (
            row?.getAttribute("data-key") !== oldKey && text.trim().length > 0
          );
        },
        oldKey,
        { timeout: 4000 },
      )
      .catch(async (error) => {
        console.log(
          JSON.stringify(
            await page.evaluate(
              (oldKey) => ({
                oldKey,
                send: document.getElementById("send-btn").textContent,
                top: document.getElementById("viewport").scrollTop,
                latest: [
                  ...document.querySelectorAll(".message-actions[data-latest]"),
                ].map((el) => ({
                  key: el.closest(".message")?.getAttribute("data-key"),
                  text: el.closest(".message")?.textContent?.slice(0, 300),
                  html: el
                    .closest(".message")
                    ?.querySelector(".message-content")
                    ?.innerHTML?.slice(-1000),
                })),
              }),
              oldKey,
            ),
          ),
        );
        throw error;
      });
    await page.waitForFunction(
      () => document.getElementById("send-btn").textContent === "Send",
      undefined,
      { timeout: 60000 },
    );
    console.log(
      JSON.stringify({
        engine,
        streamedRefresh: attempt + 1,
        completedWithoutInput: true,
      }),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
