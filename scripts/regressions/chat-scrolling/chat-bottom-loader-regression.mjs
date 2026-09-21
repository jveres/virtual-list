// Synthetic input checks loader lifecycle, not native momentum presentation.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const engines = { firefox, webkit, chromium };
const selected = process.env.BROWSER_ENGINE;
if (selected && !engines[selected]) throw new Error("Unknown BROWSER_ENGINE");
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of selected ? [engines[selected]] : Object.values(engines)) {
  const browser = await engine.launch();
  try {
    for (const mode of ["slot", "pill"]) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 850 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${base}/demos/streaming/`);
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      await page.locator("#edge-loader-mode").evaluate((select, mode) => {
        select.value = mode;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, mode);
      const transcript = Array.from(
        { length: 124 },
        (_, i) =>
          `**${i % 2 ? "Assistant" : "User"}**\n\nHistory turn ${i + 1}. ${"Synthetic paging content. ".repeat(i < 96 ? 100 : 20)}\n`,
      ).join("\n");
      await page.locator("#import-file").setInputFiles({
        name: "bottom-loader.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(transcript),
      });
      await page.locator('#viewport [data-key="124"]').waitFor();
      const range = () =>
        page.locator("#window-status").evaluate((node) => {
          const match = /loaded ([\d,]+)-([\d,]+)\/([\d,]+)/.exec(
            node.textContent,
          );
          return match
            ?.slice(1)
            .map((value) => Number(value.replaceAll(",", "")));
        });
      for (const first of [73, 49]) {
        await page.locator("#scroll-top-btn").click();
        await page.waitForFunction(
          (first) =>
            document
              .querySelector("#window-status")
              .textContent.includes(`loaded ${first}-`),
          first,
        );
      }
      assert.equal((await range())[1], 96, "tail was evicted");
      const selector =
        mode === "slot"
          ? '.boundary-slot[data-edge="end"]'
          : ".edge-overlay-end";
      for (let attempts = 0; (await range())[1] < 124; attempts++) {
        assert.ok(attempts < 4, "bottom loading must advance");
        const before = (await range())[1];
        await page.locator("#viewport").evaluate((node) => {
          node.dispatchEvent(
            new PointerEvent("pointerdown", {
              pointerType: "pen",
              pointerId: 700,
              bubbles: true,
            }),
          );
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event("scroll"));
        });
        await page
          .locator(`${selector}[data-state="loading"]`)
          .waitFor({ state: "visible" });
        // Fetch delay is 180 ms. The indicator must survive fetched work held
        // behind the active gesture, until the page actually commits.
        await page.waitForTimeout(350);
        assert.equal(
          (await range())[1],
          before,
          "page stays held during input",
        );
        const visible = await page.locator(selector).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const vp = document
            .getElementById("viewport")
            .getBoundingClientRect();
          const spinner = element.querySelector(".boundary-spinner");
          return {
            state: element.dataset.state,
            label: element.textContent,
            intersects: rect.bottom > vp.top && rect.top < vp.bottom,
            opacity: getComputedStyle(element).opacity,
            animation: getComputedStyle(spinner).animationName,
            spinner: getComputedStyle(spinner).display,
          };
        });
        assert.equal(visible.state, "loading");
        assert.match(visible.label, /Loading newer messages/);
        assert.equal(visible.intersects, true);
        assert.equal(visible.opacity, "1");
        assert.equal(visible.animation, "boundary-spin");
        assert.notEqual(visible.spinner, "none");
        await page.evaluate(() =>
          window.dispatchEvent(
            new PointerEvent("pointerup", {
              pointerType: "pen",
              pointerId: 700,
            }),
          ),
        );
        await page.waitForFunction((before) => {
          const match = /loaded [\d,]+-([\d,]+)\//.exec(
            document.querySelector("#window-status").textContent,
          );
          return Number(match?.[1].replaceAll(",", "")) > before;
        }, before);
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#window-status")
              .textContent.includes("loading bottom"),
        );
      }
      assert.equal(
        await page.locator('.boundary-slot[data-edge="end"]').count(),
        0,
        "no trailing slot after all history is restored",
      );
      assert.equal(
        await page.locator('.edge-overlay-end[data-state="loading"]').count(),
        0,
      );
      // Replacing the conversation cancels a held load without carrying its
      // loader or trailing slot into a fully loaded, short conversation.
      for (let attempt = 0; (await range())[1] === 124; attempt++) {
        assert.ok(attempt < 4, "tail must be evictable again");
        const first = (await range())[0];
        await page.locator("#scroll-top-btn").click();
        await page.waitForFunction((first) => {
          const match = /loaded ([\d,]+)-/.exec(
            document.querySelector("#window-status").textContent,
          );
          return Number(match?.[1].replaceAll(",", "")) < first;
        }, first);
      }
      await page.locator("#viewport").evaluate((node) => {
        node.dispatchEvent(
          new PointerEvent("pointerdown", {
            pointerType: "pen",
            pointerId: 701,
            bubbles: true,
          }),
        );
        node.scrollTop = node.scrollHeight;
        node.dispatchEvent(new Event("scroll"));
      });
      await page
        .locator(`${selector}[data-state="loading"]`)
        .waitFor({ state: "visible" });
      await page.locator("#import-file").setInputFiles({
        name: "replacement.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          "**User**\n\nReplacement prompt.\n\n**Assistant**\n\nReplacement reply.\n",
        ),
      });
      await page
        .locator("#viewport .message")
        .filter({ hasText: "Replacement reply." })
        .waitFor();
      await page.evaluate(() =>
        window.dispatchEvent(
          new PointerEvent("pointerup", { pointerType: "pen", pointerId: 701 }),
        ),
      );
      await page.waitForTimeout(500);
      assert.deepEqual(await range(), [1, 2, 2]);
      assert.equal(
        await page.locator('.boundary-slot[data-edge="end"]').count(),
        0,
      );
      assert.equal(
        await page.locator('.edge-overlay-end[data-state="loading"]').count(),
        0,
      );
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()} ${mode}: visible bottom loader survives fetch/held commit and clears at the true end`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
