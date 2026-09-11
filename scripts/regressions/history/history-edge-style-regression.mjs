import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/demos/chat-history/`);
    await page.waitForFunction(() => window.chatHistory);
    // Isolate the edge control from automatic paging so its loading and
    // enabled styles can both be inspected under a real pointer hover.
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "edge-style-probe";
      button.className = "history-edge";
      button.style.cssText =
        "position:fixed;top:100px;left:100px;width:300px;z-index:10000";
      document.body.append(button);
    });
    const probe = page.locator("#edge-style-probe");
    for (const theme of ["light", "dark"]) {
      for (const direction of ["earlier", "later"]) {
        for (const loading of [false, true]) {
          await probe.evaluate(
            (button, { theme, direction, loading }) => {
              document.documentElement.dataset.theme = theme;
              button.disabled = loading;
              button.textContent = `${loading ? "Loading" : "Load"} ${direction} messages`;
            },
            { theme, direction, loading },
          );
          await page.mouse.move(0, 0);
          const before = await probe.evaluate(
            (button) => getComputedStyle(button).backgroundColor,
          );
          // Disabled buttons still match :hover; use the actual mouse.
          await probe.hover({ force: true });
          const after = await probe.evaluate((button) => ({
            hovered: button.matches(":hover"),
            background: getComputedStyle(button).backgroundColor,
          }));
          assert.equal(after.hovered, true);
          assert.equal(before, "rgba(0, 0, 0, 0)");
          assert.equal(
            after.background,
            before,
            `${engine.name()} ${theme} ${direction} loading=${loading}: hover must stay transparent`,
          );
        }
      }
    }
    console.log(
      `${engine.name()}: earlier/later edge hover stays transparent in both themes and loading states`,
    );
  } finally {
    await browser.close();
  }
}
