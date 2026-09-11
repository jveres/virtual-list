import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ colorScheme: "light" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = () =>
      page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
    const scheme = () => page.locator("html").getAttribute("data-theme");
    await page.goto(`${base}/demos/streaming/`);
    await ready();
    for (const choice of ["dark", "light", "system"]) {
      await page.emulateMedia({
        colorScheme: choice === "light" ? "dark" : "light",
      });
      await page.locator(`[data-theme-choice="${choice}"]`).click();
      await page.reload();
      await ready();
      assert.equal(await scheme(), choice === "system" ? "light" : choice);
      assert.equal(
        await page
          .locator(".theme-btn.active")
          .getAttribute("data-theme-choice"),
        choice,
      );
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await page.locator('[data-theme-choice="dark"]').click();
    // Verify the parser-time bootstrap independently of the application module.
    await page.route("**/*", (route) =>
      route.request().resourceType() === "script"
        ? route.abort()
        : route.continue(),
    );
    for (const demo of ["streaming", "chat-history", "newspaper"]) {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`${base}/demos/${demo}/`);
      assert.equal(await scheme(), "dark");
      assert.equal(
        await page
          .locator("html")
          .evaluate((element) => element.style.colorScheme),
        "dark",
      );
      assert.equal(
        await page
          .locator("html")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        demo === "newspaper" ? "rgb(20, 18, 12)" : "rgb(26, 29, 35)",
      );
    }
    await page.unroute("**/*");
    await page.evaluate(() =>
      localStorage.setItem("virtual-list-theme", "invalid"),
    );
    await page.goto(`${base}/demos/streaming/`);
    await ready();
    assert.equal(await scheme(), "light");
    assert.equal(
      await page.locator(".theme-btn.active").getAttribute("data-theme-choice"),
      "system",
    );
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Blocked", "SecurityError");
        },
      });
    });
    await page.reload();
    await ready();
    await page.locator('[data-theme-choice="dark"]').click();
    assert.equal(await scheme(), "dark");
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: theme persistence, startup, system updates, invalid and blocked storage passed`,
    );
  } finally {
    await browser.close();
  }
}
