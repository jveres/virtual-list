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
    await page.goto(`${base}/examples/streaming-paged/`);
    await page.locator("#stream").click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-key="119"]')
        ?.textContent.includes("Token 3:"),
    );
    await page.mouse.move(350, 400);
    const before = await page.locator('[data-key="119"]').innerText();
    for (let index = 0; index < 8; index++) {
      await page.mouse.wheel(0, -8);
      await page.waitForTimeout(45);
    }
    const after = await page.locator('[data-key="119"]').innerText();
    assert.ok(
      after.length > before.length,
      "live row stopped updating during scrolling",
    );
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Done",
    );

    // Programmatic movement here tests data retention, not gesture performance.
    for (let index = 0; index < 6; index++) {
      await page.locator("#viewport").evaluate((v) => {
        v.scrollTop = 0;
        v.dispatchEvent(new Event("scrollend"));
      });
      await page.waitForTimeout(700);
      await page.locator("#older").click();
      await page.waitForTimeout(300);
    }
    const count = Number.parseInt(
      await page.locator("#retained").textContent(),
      10,
    );
    assert.ok(
      count <= 60,
      `expected a settled soft budget of 60, got ${count}`,
    );
    assert.equal(await page.locator('[data-key="119"]').count(), 0);
    assert.ok(
      Number(await page.locator("#retained").getAttribute("data-last")) < 118,
      "the offscreen pinned page was not evicted",
    );
    // The source continues receiving tokens while neither prompt nor reply is
    // retained. Missing-row updates must not resurrect the evicted tail.
    await page.locator("#stream").click();
    await page.waitForFunction(
      () => document.querySelector("#status").value === "Done",
    );
    assert.equal(await page.locator('[data-key="119"]').count(), 0);
    assert.equal(
      Number.parseInt(await page.locator("#retained").textContent(), 10),
      count,
    );
    for (let index = 0; index < 6; index++) {
      await page.locator("#viewport").evaluate((v) => {
        v.scrollTop = v.scrollHeight;
        v.dispatchEvent(new Event("scrollend"));
      });
      await page.waitForTimeout(700);
      await page.locator("#newer").click();
      await page.waitForTimeout(300);
    }
    await page.locator("#viewport").evaluate((v) => {
      v.scrollTop = v.scrollHeight;
    });
    await page.waitForFunction(() =>
      document
        .querySelector('[data-key="119"]')
        ?.textContent.includes("Token 100:"),
    );
    assert.equal(
      (await page.locator('[data-key="119"]').innerText()).match(/Token 100:/g)
        ?.length,
      2,
      "restored reply lost text streamed while evicted",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: paged live streaming and restoration passed`,
    );
  } finally {
    await browser.close();
  }
}
