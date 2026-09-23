import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";
import { waitForBoot } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4193";
for (const engine of [firefox, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://fonts.googleapis.com/**", (route) =>
      route.abort(),
    );
    await page.route("https://picsum.photos/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#9aabba"/></svg>',
      }),
    );
    await page.goto(`${base}/demos/newspaper/`);
    await waitForBoot(page);
    for (const width of [1100, 375]) {
      await page.setViewportSize({ width, height: 800 });
      for (const variant of ["radar", "broadsheet", "modular", "reader"]) {
        await page.selectOption("#variant-select", variant);
        await page.waitForFunction(
          (value) => document.body.dataset.variant === value,
          variant,
        );
        await page.waitForTimeout(250);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        for (const position of [0, 0.3, 0.7, 1]) {
          await page.locator("#viewport").evaluate((element, fraction) => {
            element.scrollTop =
              fraction * (element.scrollHeight - element.clientHeight);
          }, position);
          await page.waitForTimeout(250);
          const geometry = await page
            .locator("#viewport")
            .evaluate((viewport) => {
              const blocks = [...viewport.querySelectorAll(".np-block")];
              return {
                mounted: blocks.length,
                overflow: viewport.scrollWidth - viewport.clientWidth,
                mismatches: blocks.flatMap((block) => {
                  const actual = block.getBoundingClientRect().height;
                  const slot =
                    block.parentElement.getBoundingClientRect().height;
                  return Math.abs(actual - slot) > 1
                    ? [{ kind: block.className, actual, slot }]
                    : [];
                }),
              };
            });
          assert.ok(
            geometry.mounted > 0 && geometry.mounted < 30,
            JSON.stringify(geometry),
          );
          assert.ok(
            geometry.overflow <= 1,
            `${engine.name()} ${width} ${variant}: ${JSON.stringify(geometry)}`,
          );
          assert.deepEqual(
            geometry.mismatches,
            [],
            `${engine.name()} ${width} ${variant}`,
          );
        }
        await page.click("#top-btn");
        await page.waitForFunction(
          () => document.querySelector("#viewport").scrollTop < 1,
        );
        await page.click("#bottom-btn");
        await page.waitForFunction(() => {
          const v = document.querySelector("#viewport");
          return v.scrollHeight - v.clientHeight - v.scrollTop < 2;
        });
      }
    }
    for (const theme of ["dark", "light"]) {
      await page.click(`[data-theme-choice="${theme}"]`);
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        theme,
      );
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(300);
    await page.locator("#viewport").evaluate((v) => {
      v.scrollTop = 20000;
    });
    await page.waitForTimeout(300);
    const before = await page.locator("#viewport").evaluate((v) => {
      const top = v.getBoundingClientRect().top;
      const block = [...v.querySelectorAll(".np-block")].find(
        (b) => b.getBoundingClientRect().bottom > top,
      );
      v.scrollTop += block.getBoundingClientRect().top - top + 20;
      return block.textContent;
    });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(500);
    const after = await page.locator("#viewport").evaluate((v) => {
      const top = v.getBoundingClientRect().top;
      const block = [...v.querySelectorAll(".np-block")].find(
        (b) => b.getBoundingClientRect().bottom > top,
      );
      return {
        text: block.textContent,
        offset: block.getBoundingClientRect().top - top,
      };
    });
    assert.equal(after.text, before, "resize preserves reading block");
    assert.ok(
      Math.abs(after.offset + 20) <= 1,
      `resize offset ${after.offset}`,
    );
    await page.evaluate(() => {
      const select = document.querySelector("#variant-select");
      for (const value of ["radar", "modular", "broadsheet", "reader"]) {
        select.value = value;
        select.dispatchEvent(new Event("change"));
      }
    });
    await page.waitForFunction(
      () => document.body.dataset.variant === "reader",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: four layouts, desktop/mobile geometry, jumps, themes, rapid switching passed`,
    );
  } finally {
    await browser.close();
  }
}
