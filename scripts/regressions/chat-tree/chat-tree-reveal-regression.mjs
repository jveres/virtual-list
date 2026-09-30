import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 820 },
    });
    const errors = await openStreamingDemo(page, base, { acceptDialogs: true });
    const markdown = await page.evaluate(async () => {
      const { branchingTranscriptMarkdown } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      const nodes = Array.from({ length: 40 }, (_, index) => ({
        id: index + 1,
        parentId: index,
        selectedChildId: index < 39 ? index + 2 : null,
        message: {
          role: index % 2 ? "assistant" : "user",
          markdown:
            index % 2
              ? `# Reply ${index + 1}\n\n## First section\n\nText\n\n## Second section\n\nText`
              : `Prompt ${index + 1}`,
        },
      }));
      // Enough content-sized versions to clip a middle node at either edge.
      for (let id = 41; id <= 50; id++)
        nodes.push({
          id,
          parentId: 39,
          selectedChildId: null,
          message: { role: "assistant", markdown: `Version ${id}` },
        });
      return branchingTranscriptMarkdown(
        { selectedRootId: 1, nodes },
        { dayOf: () => 0, dayLabel: () => "Today" },
      );
    });
    await importTranscript(page, markdown, { name: "reveal.md" });
    await page.locator('#viewport [data-key="40"]').waitFor();
    await page
      .getByRole("button", { name: "Conversation tree", exact: true })
      .click();
    async function currentIsVisible() {
      await page.waitForFunction(() => {
        const view = document.querySelector(".conversation-tree-scroll");
        const bounds = view.getBoundingClientRect();
        const current = view.querySelector('[aria-current="location"]');
        if (!current) return false;
        const rect = current.getBoundingClientRect();
        return (
          rect.left >= bounds.left &&
          rect.right <= bounds.left + view.clientWidth &&
          rect.top >= bounds.top &&
          rect.bottom <= bounds.top + view.clientHeight
        );
      });
    }
    await currentIsVisible();
    const chatBeforeReopen = await page
      .locator("#viewport")
      .evaluate((view) => view.scrollTop);
    await page.locator(".conversation-tree-scroll").evaluate((view) => {
      view.scrollTop = 0;
      view.scrollLeft = view.scrollWidth;
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Conversation tree", exact: true })
      .click();
    await currentIsVisible();
    assert.equal(
      await page.locator("#viewport").evaluate((view) => view.scrollTop),
      chatBeforeReopen,
    );
    const reopenOffset = await page
      .locator(".conversation-tree-scroll")
      .evaluate((view) => {
        const bounds = view.getBoundingClientRect();
        const item = view
          .querySelector('[aria-current="location"]')
          .getBoundingClientRect();
        return (
          item.left + item.width / 2 - (bounds.left + view.clientWidth / 2)
        );
      });
    assert.ok(
      Math.abs(reopenOffset) < 1,
      "reopening centers the current band after a far-right pan",
    );
    assert.equal(
      await page.locator(".conversation-tree-panel").getAttribute("data-zoom"),
      "1",
    );
    await page.evaluate(() => {
      const scroller = document.querySelector(".conversation-tree-scroll");
      document.querySelector('[aria-label="Reset tree zoom to 100%"]')?.click();
      const scrollBy = scroller.scrollBy.bind(scroller);
      window.revealCalls = [];
      scroller.scrollBy = (options) => {
        window.revealCalls.push(options);
        scrollBy(options);
      };
    });
    for (const [edge, heading, reduced] of [
      ["bottom", false, false],
      ["top", false, false],
      ["right", false, false],
      ["left", false, false],
      ["bottom", true, false],
      ["bottom", false, true],
      ["visible", false, false],
    ]) {
      await page.emulateMedia({
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      const selector = heading
        ? '.conversation-tree-heading[data-message-id="20"][data-heading-index="1"]'
        : '.conversation-tree-node[data-message-id="20"]';
      const before = await page.evaluate(
        async ({ selector, edge }) => {
          const scroller = document.querySelector(".conversation-tree-scroll");
          const node = document.querySelector(selector);
          const view = scroller.getBoundingClientRect();
          const item = node.getBoundingClientRect();
          const x = item.left - view.left + scroller.scrollLeft;
          const y = item.top - view.top + scroller.scrollTop;
          scroller.scrollTo({
            top:
              edge === "bottom"
                ? y - scroller.clientHeight + item.height - 4
                : edge === "top"
                  ? y + item.height / 2
                  : y - 80,
            left:
              edge === "right"
                ? x - scroller.clientWidth + item.width / 2
                : edge === "left"
                  ? x + item.width / 2
                  : x - 80,
            behavior: "instant",
          });
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const clipped = node.getBoundingClientRect();
          window.revealCalls.length = 0;
          return {
            clipping: {
              left: clipped.left - view.left,
              right: clipped.right - view.left - scroller.clientWidth,
            },
            top: scroller.scrollTop,
            left: scroller.scrollLeft,
            clickX:
              (Math.max(clipped.left, view.left + 2) +
                Math.min(clipped.right, view.left + scroller.clientWidth - 2)) /
              2,
            // Stay clear of the overlaid horizontal scrollbar and the ToC
            // hit area that starts below the glyph, inside the node's box.
            clickY: Math.max(clipped.top, view.top + 2) + 2,
          };
        },
        { selector, edge },
      );
      // Click the visible portion without locator auto-scrolling it first.
      if (edge === "right")
        assert.ok(before.clipping.right > 0, "fixture clips the right edge");
      if (edge === "left")
        assert.ok(before.clipping.left < 0, "fixture clips the left edge");
      await page.mouse.click(before.clickX, before.clickY);
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".conversation-tree-panel")
            .hasAttribute("aria-busy"),
      );
      assert.equal(
        await page
          .locator(selector)
          .evaluate((node) => getComputedStyle(node).outlineStyle),
        "none",
        "pointer selection has no keyboard focus frame",
      );
      if (edge === "visible") {
        const after = await page.evaluate(() => {
          const scroller = document.querySelector(".conversation-tree-scroll");
          return {
            top: scroller.scrollTop,
            left: scroller.scrollLeft,
            calls: window.revealCalls,
          };
        });
        assert.deepEqual(after.calls, [], "fully visible items do not scroll");
        assert.equal(after.top, before.top);
        assert.equal(after.left, before.left);
      } else {
        const calls = await page.evaluate(() => window.revealCalls);
        assert.equal(
          calls.length,
          1,
          `${engine.name()} ${edge} heading=${heading} reduced=${reduced}: one reveal request`,
        );
        assert.equal(calls[0].behavior, reduced ? "auto" : "smooth");
        await page
          .waitForFunction(
            (selector) => {
              const scroller = document.querySelector(
                ".conversation-tree-scroll",
              );
              const view = scroller.getBoundingClientRect();
              const item = document
                .querySelector(selector)
                .getBoundingClientRect();
              return (
                item.top >= view.top + 13 &&
                item.bottom <= view.top + scroller.clientHeight - 13 &&
                item.left >= view.left + 13 &&
                item.right <= view.left + scroller.clientWidth - 13
              );
            },
            selector,
            { timeout: 5000 },
          )
          .catch(async (error) => {
            const bounds = await page.evaluate((selector) => {
              const scroller = document.querySelector(
                ".conversation-tree-scroll",
              );
              return {
                item: document
                  .querySelector(selector)
                  .getBoundingClientRect()
                  .toJSON(),
                view: scroller.getBoundingClientRect().toJSON(),
                scrollTop: scroller.scrollTop,
                scrollLeft: scroller.scrollLeft,
                clientWidth: scroller.clientWidth,
                clientHeight: scroller.clientHeight,
                calls: window.revealCalls,
              };
            }, selector);
            throw new Error(
              `${engine.name()} ${edge} heading=${heading}: ${JSON.stringify(bounds)}`,
              { cause: error },
            );
          });
      }
    }
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(
        () => getComputedStyle(document.activeElement).outlineStyle,
      ),
      "solid",
      "keyboard navigation keeps its focus indicator",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: clipped nodes, headings, reduced motion, and visible-item stability passed`,
    );
  } finally {
    await browser.close();
  }
}
