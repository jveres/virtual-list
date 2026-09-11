// Composer persistence and storage failures; all responses are local simulations.
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const key = "virtual-list:chat-draft";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = () =>
      page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
    await page.goto(`${base}/demos/streaming/index.html`);
    await ready();
    const prompt = page.locator("#prompt");
    const stored = () => page.evaluate((key) => localStorage.getItem(key), key);
    const emptyHeight = await prompt.evaluate((input) => input.clientHeight);
    const draft =
      "  Keep this draft 🌻\nSecond line\nThird line\nFourth line  ";
    await prompt.fill(draft);
    assert.equal(await stored(), draft);
    await page.reload();
    await ready();
    assert.equal(await prompt.inputValue(), draft);
    assert.ok(
      (await prompt.evaluate((input) => input.clientHeight)) > emptyHeight,
      "restored multiline draft is autosized",
    );
    await prompt.fill("");
    assert.equal(await stored(), null);
    await page.reload();
    await ready();
    assert.equal(await prompt.inputValue(), "");
    await prompt.fill("Send this draft");
    await page.locator("#send-btn").click();
    assert.equal(await prompt.inputValue(), "");
    assert.equal(await stored(), null);
    await page.reload();
    await ready();
    assert.equal(await prompt.inputValue(), "");
    // Fail reads, writes and removal without breaking the composer.
    await page.addInitScript(() => {
      for (const method of ["getItem", "setItem", "removeItem"]) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (key === "virtual-list:chat-draft")
            throw new DOMException("Storage unavailable", "SecurityError");
          return original.call(this, key, ...args);
        };
      }
    });
    await page.reload();
    await ready();
    await prompt.fill("Works without storage");
    assert.equal(await prompt.inputValue(), "Works without storage");
    await page.locator("#send-btn").click();
    assert.equal(await prompt.inputValue(), "");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine: engine.name(), result: "passed" }));
  } finally {
    await browser.close();
  }
}
