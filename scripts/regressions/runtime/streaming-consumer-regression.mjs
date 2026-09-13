// Exercise the standalone consumer, not a second chat implementation in a test.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 700, height: 650 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/examples/streaming-basic/`);
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Done",
    );
    await page.waitForFunction(() => {
      const v = document.querySelector("#viewport");
      return Math.abs(v.scrollHeight - v.clientHeight - v.scrollTop) <= 1;
    });
    assert.match(
      await page.locator('[data-role="assistant"]').innerText(),
      /Line 100:/,
    );

    await page.locator("#reset").click();
    await page.locator("#follow").selectOption("keep-start");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Keep the reply start");
    await page.locator("#send").click();
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-role="assistant"]');
      return row?.textContent.includes("Line 35:");
    });
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-role="assistant"]');
      const v = document.querySelector("#viewport");
      return (
        Math.abs(
          row.getBoundingClientRect().top - v.getBoundingClientRect().top,
        ) <= 1
      );
    });
    await page.locator("#bottom").click();
    await page.mouse.move(250, 200);
    await page.mouse.move(350, 250);
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Done",
    );
    await page.waitForFunction(() => {
      const v = document.querySelector("#viewport");
      return Math.abs(v.scrollHeight - v.clientHeight - v.scrollTop) <= 1;
    });

    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Stop and replace");
    await page.locator("#send").click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-streaming="true"]')
        ?.textContent.includes("Line 5:"),
    );
    await page.locator("#stop").click();
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Stopped",
    );
    assert.equal(await page.locator('[data-streaming="true"]').count(), 0);

    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Dispose midstream");
    await page.locator("#send").click();
    await page.locator("#reset").click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator(".message").count(), 0);
    assert.equal(await page.locator("#status").textContent(), "Ready");

    // Fail both a token render and its final render: cleanup must still run.
    await page.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(
        Node.prototype,
        "textContent",
      );
      let failures = 0;
      Object.defineProperty(Node.prototype, "textContent", {
        ...original,
        set(value) {
          if (
            this instanceof HTMLElement &&
            this.matches("article.message") &&
            value?.includes("Line 5:")
          ) {
            if (++failures === 2)
              Object.defineProperty(Node.prototype, "textContent", original);
            throw new Error("injected row render failure");
          }
          original.set.call(this, value);
        },
      });
    });
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Recover from render failure");
    await page.locator("#send").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        .value.includes("injected row render failure"),
    );
    assert.equal(await page.locator("#send").isEnabled(), true);
    assert.equal(await page.locator("#stop").isEnabled(), false);
    await page.locator("#reset").click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Retry after failure");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Done",
    );
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: standalone streaming consumer passed`);
  } finally {
    await browser.close();
  }
}
