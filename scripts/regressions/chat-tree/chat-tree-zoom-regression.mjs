import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
await mkdir("browser-artifacts/conversation-tree", { recursive: true });
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    const toggle = page.getByRole("button", {
      name: "Conversation tree",
      exact: true,
    });
    const fit = page.getByRole("button", {
      name: "Fit entire tree",
      exact: true,
    });
    const reset = page.getByRole("button", {
      name: "Reset tree zoom to 100%",
      exact: true,
    });
    const zoom = () =>
      page
        .locator(".conversation-tree-panel")
        .evaluate((panel) => Number(panel.dataset.zoom));
    async function fits() {
      await page.waitForFunction(() => {
        const view = document.querySelector(".conversation-tree-scroll");
        const rect = view.getBoundingClientRect();
        const tree = document
          .querySelector(".conversation-tree-canvas")
          .getBoundingClientRect();
        return (
          tree.left >= rect.left - 1 &&
          tree.top >= rect.top - 1 &&
          tree.right <= rect.left + view.clientWidth + 1 &&
          tree.bottom <= rect.top + view.clientHeight + 1 &&
          view.scrollWidth <= view.clientWidth + 1 &&
          view.scrollHeight <= view.clientHeight + 1
        );
      });
      assert.equal(await fit.getAttribute("aria-pressed"), "true");
    }
    await toggle.hover();
    assert.equal(await zoom(), 1, "first opening starts at 100%");
    await reset.click();
    await page.mouse.move(1400, 850);
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator(".conversation-tree-panel").isVisible(),
      true,
      "percentage keeps a hover-opened panel visible",
    );
    await fit.click();
    await fits();
    const iconSizes = () =>
      page
        .locator(".conversation-tree-header button:has(svg)")
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const box = button.getBoundingClientRect();
            const svg = button.querySelector("svg").getBoundingClientRect();
            return [
              box.width,
              box.height,
              svg.width,
              svg.height,
              getComputedStyle(button).borderRadius,
            ];
          }),
        );
    const selectedSizes = await iconSizes();
    assert.deepEqual(
      selectedSizes,
      Array.from({ length: 6 }, () => [28, 28, 16, 16, "6px"]),
    );
    await page
      .getByRole("button", { name: "Zoom in tree", exact: true })
      .hover();
    assert.deepEqual(
      await iconSizes(),
      selectedSizes,
      "hover and selected states keep rounded, square button dimensions",
    );
    assert.ok((await zoom()) < 1);
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-zoom-fit.png`,
    });
    await reset.click();
    const widthToggle = page.getByRole("button", {
      name: "Full width tree panel",
      exact: true,
    });
    const panel = page.locator(".conversation-tree-panel");
    const normalWidth = (await panel.boundingBox()).width;
    await widthToggle.click();
    assert.equal(await widthToggle.getAttribute("aria-pressed"), "true");
    const expanded = await panel.boundingBox();
    assert.ok(Math.abs(expanded.x - 16) <= 1);
    assert.ok(Math.abs(expanded.width - (1440 - 32)) <= 1);
    assert.equal(await zoom(), 1, "full width preserves manual zoom");
    const siblingGaps = await page
      .locator(".conversation-tree-node")
      .evaluateAll((nodes) => {
        const rows = new Map();
        for (const node of nodes) {
          const box = node.getBoundingClientRect();
          const toc = node.parentElement.querySelector(
            `.conversation-tree-toc:has([data-message-id="${node.dataset.messageId}"])`,
          );
          const row = rows.get(node.dataset.row) ?? [];
          row.push({
            left: box.left,
            right: Math.max(
              box.right,
              toc?.getBoundingClientRect().right ?? box.right,
            ),
          });
          rows.set(node.dataset.row, row);
        }
        return [...rows.values()]
          .filter((row) => row.length > 1)
          .flatMap((row) => {
            row.sort((a, b) => a.left - b.left);
            return row
              .slice(1)
              .map((node, index) => node.left - row[index].right);
          });
      });
    assert.ok(
      siblingGaps.length > 0 &&
        siblingGaps.every((gap) => Math.abs(gap - 12) <= 1),
      `full-width siblings pack their actual widths (${siblingGaps.join(", ")})`,
    );
    assert.equal(
      await page
        .locator(".conversation-tree-node")
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              Number.parseFloat(node.style.maxWidth) === 320 &&
              node.getBoundingClientRect().width <= 320.1,
          ),
        ),
      true,
      "full-width root and leaf cards share a maximum width",
    );
    assert.equal(
      await page
        .locator(".conversation-tree-toc")
        .evaluateAll((lists) =>
          lists.every(
            (list) =>
              Number.parseFloat(list.style.maxWidth) <= 300 &&
              list.getBoundingClientRect().width <= 300.1,
          ),
        ),
      true,
      "full-width headings keep the corresponding width cap",
    );
    await page.keyboard.press("Escape");
    await toggle.click();
    assert.equal(await widthToggle.getAttribute("aria-pressed"), "true");
    assert.equal((await panel.boundingBox()).width, expanded.width);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(
      (expected) =>
        Math.abs(
          document
            .querySelector(".conversation-tree-panel")
            .getBoundingClientRect().width - expected,
        ) <= 1,
      1200 - 32,
    );
    assert.ok(Math.abs((await panel.boundingBox()).width - (1200 - 32)) <= 1);
    await page.setViewportSize({ width: 390, height: 900 });
    await fit.click();
    await fits();
    assert.equal(
      await page.locator(".conversation-tree-canvas").evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return [
          ...canvas.querySelectorAll(
            ".conversation-tree-node, .conversation-tree-toc",
          ),
        ].every((node) => {
          const box = node.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      }),
      true,
      "full-width label extents remain inside the canvas on narrow screens",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await fit.click();
    await fits();
    await widthToggle.click();
    assert.equal(await widthToggle.getAttribute("aria-pressed"), "false");
    assert.equal((await panel.boundingBox()).width, normalWidth);
    assert.equal(await fit.getAttribute("aria-pressed"), "true");
    await fits();
    await reset.click();
    await page.mouse.move(1400, 850);
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator(".conversation-tree-panel").isVisible(),
      true,
      "percentage reset keeps a hover-opened panel open",
    );
    assert.equal(await zoom(), 1);
    assert.equal(await fit.getAttribute("aria-pressed"), "false");
    await page
      .getByRole("button", { name: "Zoom in tree", exact: true })
      .click();
    assert.equal(await zoom(), 1.25);
    await page
      .getByRole("button", { name: "Zoom out tree", exact: true })
      .click();
    assert.equal(await zoom(), 1);
    await page.locator('.conversation-tree-node[data-message-id="50"]').click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".conversation-tree-panel")
          .hasAttribute("aria-busy"),
    );
    await page
      .locator(".conversation-tree-scroll")
      .evaluate((view) => view.scrollTo(0, 0));
    const chatBefore = await page
      .locator("#viewport")
      .evaluate((view) => view.scrollTop);
    await page
      .getByRole("button", {
        name: "Locate current chat position",
        exact: true,
      })
      .click();
    await page.waitForFunction(() => {
      const view = document
        .querySelector(".conversation-tree-scroll")
        .getBoundingClientRect();
      const current = document
        .querySelector('.conversation-tree-node[aria-current="location"]')
        .getBoundingClientRect();
      return current.top >= view.top && current.bottom <= view.bottom;
    });
    assert.equal(await zoom(), 1);
    assert.equal(
      await page.locator("#viewport").evaluate((view) => view.scrollTop),
      chatBefore,
    );
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-zoom-locate.png`,
    });
    const scroller = page.locator(".conversation-tree-scroll");
    assert.equal(
      await scroller.evaluate((view) => getComputedStyle(view).cursor),
      "default",
    );
    const box = await scroller.boundingBox();
    const x = box.x + box.width - 50;
    const y = box.y + box.height / 2;
    const label = page.locator(
      '.conversation-tree-node[aria-current="location"] .conversation-tree-label',
    );
    const labelBox = await label.boundingBox();
    const textTop = await scroller.evaluate((view) => view.scrollTop);
    await page.mouse.move(labelBox.x + 2, labelBox.y + 6);
    await page.mouse.down();
    await page.mouse.move(
      labelBox.x + Math.min(90, labelBox.width - 2),
      labelBox.y + 66,
      { steps: 8 },
    );
    await page.mouse.up();
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      "",
      "drag starting on label text must not select text",
    );
    assert.ok(
      Math.abs(
        (await scroller.evaluate((view) => view.scrollTop)) - (textTop - 60),
      ) <= 2,
      "drag starting on label text pans the tree",
    );
    assert.equal(
      await page.locator("#viewport").evaluate((view) => view.scrollTop),
      chatBefore,
    );
    await page.evaluate(() => getSelection().removeAllRanges());
    const dragTop = await scroller.evaluate((view) => view.scrollTop);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 180, y + 60, { steps: 8 });
    assert.equal(
      await scroller.evaluate((view) => getComputedStyle(view).cursor),
      "grabbing",
    );
    await page.mouse.up();
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      "",
      "canvas drag across labels must not select text",
    );
    assert.equal(
      await scroller.evaluate((view) => getComputedStyle(view).cursor),
      "default",
    );
    assert.ok(
      Math.abs(
        (await scroller.evaluate((view) => view.scrollTop)) - (dragTop - 60),
      ) <= 2,
      "mouse drag pans the tree",
    );
    assert.equal(
      await page.locator("#viewport").evaluate((view) => view.scrollTop),
      chatBefore,
      "drag never navigates the chat",
    );
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      () =>
        Number(
          document.querySelector(".conversation-tree-panel").dataset.zoom,
        ) > 1.1,
    );
    await reset.click();
    assert.equal(
      await scroller.evaluate((view) => getComputedStyle(view).touchAction),
      "pan-x pan-y",
      "touch panning is browser-owned",
    );
    const pointer = (type, id, px) =>
      scroller.dispatchEvent(type, {
        pointerId: id,
        pointerType: "touch",
        button: 0,
        buttons: 1,
        clientX: px,
        clientY: y,
        bubbles: true,
      });
    const touch = (type, positions, cancelable = true) =>
      scroller.evaluate(
        (view, { type, positions, y, cancelable }) => {
          const event = new Event(type, { bubbles: true, cancelable });
          Object.defineProperty(event, "touches", {
            value: positions.map((clientX, index) => ({
              clientX,
              clientY: y,
              target: view.querySelectorAll("button")[index] ?? view,
            })),
          });
          view.dispatchEvent(event);
          return event.defaultPrevented;
        },
        { type, positions, y, cancelable },
      );
    const nativeTop = await scroller.evaluate((view) => view.scrollTop);
    const nativeLeft = await scroller.evaluate((view) => view.scrollLeft);
    assert.equal(await touch("touchstart", [x]), false);
    await pointer("pointerdown", 41, x);
    await pointer("pointermove", 41, x + 60);
    assert.equal(await touch("touchmove", [x + 60]), false);
    assert.equal(await scroller.evaluate((view) => view.scrollTop), nativeTop);
    assert.equal(
      await scroller.evaluate((view) => view.scrollLeft),
      nativeLeft,
    );
    assert.equal(await scroller.getAttribute("data-dragging"), null);
    await pointer("pointercancel", 41, x + 60);
    assert.equal(await touch("touchend", []), false);
    assert.equal(await touch("touchstart", [x - 40, x + 40]), true);
    await scroller.evaluate((view) => {
      for (const [type, scale] of [
        ["gesturestart", 1],
        ["gesturechange", 2],
      ]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "scale", { value: scale });
        view.dispatchEvent(event);
      }
    });
    assert.equal(
      await zoom(),
      1,
      "Safari gestures do not double-handle touch pinch",
    );
    assert.equal(await touch("touchmove", [x - 60, x + 60]), true);
    assert.ok(
      Math.abs((await zoom()) - 1.5) < 0.001,
      "two-finger pinch scales around its center",
    );
    assert.equal(await touch("touchend", [x - 60]), true);
    assert.equal(await touch("touchmove", [x - 80]), true);
    await touch("touchend", []);
    assert.equal(await touch("touchstart", [x]), false);
    assert.equal(await touch("touchmove", [x + 60]), false);
    await touch("touchcancel", []);
    assert.equal(await touch("touchstart", [x]), false);
    assert.equal(await touch("touchmove", [x - 40, x + 40], false), false);
    assert.equal(
      await zoom(),
      1.5,
      "an uncancelable native pan is not taken over",
    );
    await touch("touchcancel", []);
    assert.equal(await scroller.getAttribute("data-dragging"), null);
    await reset.click();
    await scroller.evaluate((view) => {
      for (const [type, scale] of [
        ["gesturestart", 1],
        ["gesturechange", 1.2],
        ["gestureend", 1.2],
      ]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "scale", { value: scale });
        view.dispatchEvent(event);
      }
    });
    assert.ok(
      Math.abs((await zoom()) - 1.2) < 0.001,
      "Safari gesture path changes zoom",
    );
    await reset.click();
    await page.setViewportSize({ width: 1200, height: 760 });
    assert.equal(await zoom(), 1, "manual zoom survives resize");
    await fit.click();
    await fits();
    for (const width of [390, 1024, 2560]) {
      await page.setViewportSize({ width, height: 820 });
      await fits();
      const toolbarFits = await page
        .locator(".conversation-tree-header")
        .evaluate((header) => {
          const view = header.getBoundingClientRect();
          return [...header.querySelectorAll("button")].every((button) => {
            const box = button.getBoundingClientRect();
            return (
              box.left >= view.left &&
              box.right <= view.right &&
              Math.abs(
                box.top + box.height / 2 - (view.top + view.height / 2 + 2),
              ) <= 4
            );
          });
        });
      assert.equal(
        toolbarFits,
        true,
        `all tree controls fit the close-button header at ${width}px`,
      );
    }
    await reset.click();
    await page.keyboard.press("Escape");
    await toggle.click();
    assert.equal(await zoom(), 1, "reopening preserves manual zoom");
    await page
      .getByRole("button", { name: "Zoom in tree", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await toggle.click();
    assert.equal(await zoom(), 1.25, "reopening does not reset changed zoom");
    await fit.click();
    await page.keyboard.press("Escape");
    await toggle.click();
    await fits();
    await reset.click();
    await page
      .getByRole("button", { name: "Zoom in tree", exact: true })
      .click();
    await page.locator(".conversation-tree-scroll").evaluate((view) => {
      view.scrollTop = view.scrollHeight;
      view.scrollLeft = view.scrollWidth;
    });
    await page.keyboard.press("Escape");
    await page.locator("#import-file").setInputFiles({
      name: "short-selection.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        `**User**\n\nEarlier prompt\n\n**Assistant**\n\n${"Earlier text. ".repeat(400)}\n\n**User**\n\nFinal prompt\n\n**Assistant**\n\nShort final reply\n`,
      ),
    });
    await page.locator('#viewport [data-key="4"]').waitFor();
    await toggle.click();
    async function checkReplacementView() {
      assert.equal(await zoom(), 1, "a replacement chat resets tree zoom");
      const viewState = await page
        .locator(".conversation-tree-scroll")
        .evaluate((view) => {
          const bounds = view.getBoundingClientRect();
          const nodes = [...view.querySelectorAll(".conversation-tree-node")];
          const first = (
            view.querySelector('[aria-current="location"]') ?? nodes[0]
          ).getBoundingClientRect();
          const offset =
            first.left + first.width / 2 - (bounds.left + view.clientWidth / 2);
          const centeredLeft = Math.max(
            0,
            Math.min(
              view.scrollWidth - view.clientWidth,
              view.scrollLeft + offset,
            ),
          );
          return {
            remainingCenterScroll: centeredLeft - view.scrollLeft,
            visible: nodes.some((node) => {
              const rect = node.getBoundingClientRect();
              return (
                rect.bottom > bounds.top &&
                rect.top < bounds.bottom &&
                rect.right > bounds.left &&
                rect.left < bounds.right
              );
            }),
            excessHeight: view.scrollHeight - view.clientHeight,
          };
        });
      assert.equal(viewState.visible, true, "replacement nodes are in view");
      assert.ok(
        Math.abs(viewState.remainingCenterScroll) < 1,
        "a straight path centers the card band as far as scroll bounds allow",
      );
      assert.ok(viewState.excessHeight <= 1, "old canvas height is discarded");
    }
    await checkReplacementView();
    await page.locator('.conversation-tree-node[data-message-id="4"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.conversation-tree-node[data-message-id="4"]')
          ?.getAttribute("aria-current") === "location",
    );
    await page
      .locator("#viewport")
      .evaluate((view) => view.dispatchEvent(new Event("scrollend")));
    assert.equal(
      await page
        .locator('.conversation-tree-node[data-message-id="4"]')
        .getAttribute("aria-current"),
      "location",
      "short final response remains selected even with its prompt visible",
    );
    await page.locator("#viewport").evaluate((view) => {
      view.scrollTop = 0;
      view.dispatchEvent(new Event("scrollend"));
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('.conversation-tree-node[data-message-id="1"]')
          ?.getAttribute("aria-current") === "location",
    );
    await page
      .getByRole("button", { name: "Zoom in tree", exact: true })
      .click();
    await page.locator("#import-file").setInputFiles({
      name: "visible-replacement.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "**User**\n\nReplacement prompt\n\n**Assistant**\n\nReplacement reply\n",
      ),
    });
    await page.waitForFunction(
      () =>
        document.querySelector(".conversation-tree-label")?.textContent ===
        "Replacement prompt",
    );
    await checkReplacementView();
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: fit, zoom, locate, resize, and reopen passed`,
    );
  } finally {
    await browser.close();
  }
}
