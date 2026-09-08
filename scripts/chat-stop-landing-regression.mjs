import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  for (const partial of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1420, height: 1000 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/`,
    );
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await page.locator("#prompt").fill("one pixel landing");
    await page.locator("#send-btn").click();
    await page.waitForTimeout(800);
    const landing = await page.evaluate(() => {
      const viewport = document.getElementById("viewport");
      const rows = [...viewport.querySelectorAll(".message")];
      const prompt = rows
        .filter((row) => row.classList.contains("user"))
        .at(-1);
      const previous = rows[rows.indexOf(prompt) - 1];
      const top = viewport.getBoundingClientRect().top;
      const pill = document
        .querySelector(".vl-sticky-header .section-header-pill")
        .getBoundingClientRect();
      return {
        prompt: prompt.getBoundingClientRect().top - top,
        previousBottom: previous.getBoundingClientRect().bottom - top,
        gapAbove: pill.top - top,
        gapBelow:
          prompt.querySelector(".message-content").getBoundingClientRect().top -
          pill.bottom,
      };
    });
    assert.ok(landing.prompt <= 44, JSON.stringify(landing));
    assert.ok(landing.prompt >= 43, JSON.stringify(landing));
    assert.ok(landing.previousBottom <= 0, JSON.stringify(landing));
    assert.ok(
      Math.abs(landing.gapAbove - landing.gapBelow) <= 1,
      JSON.stringify(landing),
    );
    const reply = page.locator("#viewport .message.assistant").last();
    if (partial) {
      await page.waitForFunction(() => {
        const row = [
          ...document.querySelectorAll("#viewport .message.assistant"),
        ].at(-1);
        return [...row.querySelectorAll(".markdown")].some(
          (markdown) => markdown.textContent.length > 40,
        );
      });
    }
    await page.locator("#send-btn").click();
    const marker = reply.locator(".message-stopped");
    await marker.waitFor();
    assert.equal(await marker.count(), 1);
    assert.equal(await marker.textContent(), "...stopped");
    assert.equal(
      await marker.evaluate((element) => getComputedStyle(element).color),
      "rgb(239, 68, 68)",
    );
    if (partial) {
      assert.ok(
        await marker.evaluate((element) => {
          const block = element.parentElement;
          return (
            block.closest(".markdown") !== null &&
            block.textContent.endsWith("...stopped") &&
            block.textContent.length > 10
          );
        }),
      );
    }
    if (!partial) {
      await page.locator("#viewport").evaluate((viewport) => {
        viewport.scrollTop -= 150;
      });
      await page.locator("#scroll-bottom-btn").click();
      await page.waitForTimeout(800);
      const bottomLanding = await page.evaluate(() => {
        const viewport = document.getElementById("viewport");
        const rows = [...viewport.querySelectorAll(".message")];
        const prompt = rows
          .filter((row) => row.classList.contains("user"))
          .at(-1);
        return (
          rows[rows.indexOf(prompt) - 1].getBoundingClientRect().bottom -
          viewport.getBoundingClientRect().top
        );
      });
      assert.ok(
        bottomLanding <= 0,
        `bottom button left ${bottomLanding}px visible`,
      );
    }
    // Force a fresh static render of the stopped response via version changes.
    const key = await reply.getAttribute("data-key");
    await reply.getByRole("button", { name: "Regenerate response" }).click();
    await page.locator("#send-btn").click();
    await page
      .locator("#viewport .message.assistant")
      .last()
      .getByRole("button", { name: "Previous version" })
      .click();
    await page
      .locator(`.message[data-key="${key}"] .message-stopped`)
      .waitFor();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ engine, partial, landing, stopped: "passed" }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
