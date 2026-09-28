import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const waitForBoot = (page) =>
  page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch();
  try {
    for (const follow of ["end", "keep-start", "keep-content"]) {
      const page = await browser.newPage();
      await page.addInitScript(
        (follow) =>
          localStorage.setItem(
            "virtual-list:chat-options",
            JSON.stringify({ follow, landing: "end" }),
          ),
        follow,
      );
      await page.goto(`${base}/demos/streaming/`);
      await waitForBoot(page);
      await page.locator("#prompt").fill("flash");
      await page.locator("#send-btn").click();
      await page.waitForFunction(
        () => document.querySelector("#scroll-bottom-btn").hidden,
      );
      await page.evaluate(() => {
        window.buttonChanges = [];
        const button = document.querySelector("#scroll-bottom-btn");
        window.buttonObserver = new MutationObserver(() => {
          window.buttonChanges.push(button.hidden);
        });
        window.buttonObserver.observe(button, {
          attributes: true,
          attributeFilter: ["hidden"],
        });
      });
      await page.waitForTimeout(8000);
      assert.deepEqual(
        await page.evaluate(() => window.buttonChanges),
        follow === "end" ? [] : [false],
        `${follow}: hide during catch-up, reveal once bounded follow stops`,
      );
      await page.evaluate(() => window.buttonObserver.disconnect());
      if (follow !== "end") {
        await page.locator("#scroll-bottom-btn").click();
        await page.waitForFunction(
          () => document.querySelector("#scroll-bottom-btn").hidden,
        );
      }
      await page.locator("#viewport").hover();
      await page.mouse.wheel(0, -450);
      await page.waitForFunction(
        () => !document.querySelector("#scroll-bottom-btn").hidden,
      );
      await page.close();
    }
    console.log(
      `${engine.name()}: following keeps the bottom button hidden; manual scrolling reveals it`,
    );
  } finally {
    await browser.close();
  }
}
