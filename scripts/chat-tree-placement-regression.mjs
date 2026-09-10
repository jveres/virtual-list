import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
await mkdir("browser-artifacts/conversation-tree", { recursive: true });

for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const toggle = page.getByRole("button", {
      name: "Conversation tree",
      exact: true,
    });
    const panel = page.locator(".conversation-tree-panel");
    await toggle.click();

    async function checkPlacement(width) {
      await page.waitForFunction(() => {
        const panel = document.querySelector(".conversation-tree-panel");
        const chat = document
          .querySelector("#scroll-jump-layer")
          .getBoundingClientRect();
        const canvas = document.querySelector(".conversation-tree-canvas");
        const preferred = Math.max(
          320,
          Number.parseFloat(canvas.style.width) + 40,
        );
        const expected = matchMedia("(max-width: 984px)").matches
          ? Math.min(460, innerWidth - 32)
          : Math.min(preferred, chat.left + chat.width / 2 - 16);
        const toggle = document
          .querySelector(".conversation-tree-toggle")
          .getBoundingClientRect();
        const left = matchMedia("(max-width: 984px)").matches
          ? toggle.left
          : Math.max(16, toggle.right - expected);
        const rect = panel.getBoundingClientRect();
        return (
          Math.abs(rect.width - expected) < 1 && Math.abs(rect.left - left) < 1
        );
      });
      const bounds = await panel.evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        const chat = document
          .querySelector("#scroll-jump-layer")
          .getBoundingClientRect();
        const toggle = document
          .querySelector(".conversation-tree-toggle")
          .getBoundingClientRect();
        const scroller = panel.querySelector(".conversation-tree-scroll");
        const scrollTop = document
          .querySelector("#scroll-top-btn")
          .getBoundingClientRect();
        const root = panel.parentElement;
        const arrow = root
          .querySelector(".conversation-tree-notch")
          .getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          chatLeft: chat.left,
          midpoint: chat.left + chat.width / 2,
          toggleLeft: toggle.left,
          toggleTop: toggle.top,
          toggleHeight: toggle.height,
          scrollTopTop: scrollTop.top,
          scrollTopHeight: scrollTop.height,
          arrowCenter: arrow.left + arrow.width / 2,
          arrowBottom: arrow.bottom,
          borderBottom:
            rect.top +
            Number.parseFloat(getComputedStyle(panel).borderTopWidth),
          toggleCenter: toggle.left + toggle.width / 2,
          arrowVisible: arrow.width > 0 && arrow.height > 0,
          overflow: scroller.scrollWidth - scroller.clientWidth,
        };
      });
      assert.equal(await panel.isVisible(), true);
      assert.equal(bounds.arrowVisible, true);
      assert.ok(
        Math.abs(bounds.arrowBottom - bounds.borderBottom) < 0.01,
        "notch legs stop at the panel border's bottom edge",
      );
      assert.ok(
        Math.abs(bounds.arrowCenter - bounds.toggleCenter) < 1,
        "panel notch points to the toggle",
      );
      assert.equal(
        bounds.toggleTop,
        bounds.scrollTopTop,
        "top controls align vertically",
      );
      assert.equal(bounds.toggleHeight, bounds.scrollTopHeight);
      assert.ok(bounds.left >= 15 && bounds.right <= width - 15);
      if (width > 984) {
        assert.ok(
          bounds.right <= bounds.midpoint + 1,
          "at most half the chat is covered",
        );
        assert.ok(
          bounds.left < bounds.toggleLeft,
          "use space left of the toggle",
        );
      }
      if (width >= 1920)
        assert.ok(bounds.overflow <= 1, "show the full tree when it fits");
      if (width === 2560)
        assert.ok(
          bounds.right <= bounds.chatLeft,
          "a large gutter needs no chat overlap",
        );
      if (width === 1200)
        assert.ok(
          bounds.overflow > 0,
          "retain scrolling when the tree exceeds the cap",
        );
      return bounds.width;
    }

    for (const width of [1200, 1920, 2560, 1024, 720, 390, 2560]) {
      await page.setViewportSize({ width, height: 820 });
      await checkPlacement(width);
      if (width === 1200 || width === 2560)
        await page.screenshot({
          path: `browser-artifacts/conversation-tree/${engine.name()}-placement-${width}.png`,
        });
    }

    // Branch selection changes the number of columns while the panel is open.
    const expandedWidth = await checkPlacement(2560);
    for (const id of [102, 101]) {
      await panel
        .locator(`.conversation-tree-node[data-message-id="${id}"]`)
        .click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".conversation-tree-panel")
            .hasAttribute("aria-busy"),
      );
      const width = await checkPlacement(2560);
      if (id === 102) assert.ok(width < expandedWidth);
      else assert.equal(width, expandedWidth);
    }

    await page.keyboard.press("Escape");
    assert.equal(await panel.isVisible(), false);
    assert.equal(
      await page.locator(".conversation-tree-notch").isVisible(),
      false,
    );
    await page.setViewportSize({ width: 1200, height: 820 });
    await toggle.click();
    await checkPlacement(1200);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: tree sizing, gutter placement, overlap cap, resize, branches, mobile passed`,
    );
  } finally {
    await browser.close();
  }
}
