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
    page.on("dialog", (dialog) => dialog.accept());
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
    await page.getByRole("button", { name: "Reset tree zoom to 100%" }).click();

    async function checkRowLayout() {
      const geometry = await panel.evaluate((panel) => {
        const canvas = panel.querySelector(".conversation-tree-canvas");
        const origin = canvas.getBoundingClientRect();
        const nodes = [...panel.querySelectorAll(".conversation-tree-node")];
        const byId = new Map();
        const rows = new Map();
        for (const node of nodes) {
          const box = node.getBoundingClientRect();
          const glyph = node
            .querySelector(".conversation-tree-glyph")
            .getBoundingClientRect();
          const label = node
            .querySelector(".conversation-tree-label")
            .getBoundingClientRect();
          const item = {
            id: node.dataset.messageId,
            x: glyph.left + glyph.width / 2 - origin.left,
            y: glyph.top - origin.top,
            width: box.width,
            role: node.dataset.role,
            labelLeft: label.left - origin.left,
            labelRight: label.right - origin.left,
          };
          byId.set(item.id, item);
          const siblings = rows.get(node.dataset.row) ?? [];
          siblings.push(item);
          rows.set(node.dataset.row, siblings);
        }
        const edges = [
          ...panel.querySelectorAll(".conversation-tree-edge[data-child-id]"),
        ].map((edge) => {
          const start = edge.getPointAtLength(0);
          const end = edge.getPointAtLength(edge.getTotalLength());
          return {
            parentId: edge.dataset.parentId,
            childId: edge.dataset.childId,
            start: [start.x, start.y],
            end: [end.x, end.y],
          };
        });
        return {
          rows: [...rows.values()],
          nodes: Object.fromEntries(byId),
          edges,
          center: origin.width / 2,
        };
      });
      const parentById = new Map(
        geometry.edges.map((edge) => [edge.childId, edge.parentId]),
      );
      for (const siblings of geometry.rows) {
        const parent = geometry.nodes[parentById.get(siblings[0].id)];
        const center = parent?.x ?? geometry.center;
        assert.ok(
          Math.abs(
            siblings.reduce((sum, node) => sum + node.x, 0) / siblings.length -
              center,
          ) < 0.1,
          "the fork is centered under its actual parent",
        );
        const bandWidth = 2 * (siblings[0].width - 18);
        for (const [index, node] of siblings.entries()) {
          assert.ok(
            Math.abs(node.width - siblings[0].width) < 0.1,
            "equal-width version bands",
          );
          assert.ok(
            Math.abs(node.y - siblings[0].y) < 0.1,
            "versions share a depth row",
          );
          assert.ok(
            node.role === "user"
              ? node.labelRight < node.x
              : node.labelLeft > node.x,
            "user labels stay left; assistant labels stay right",
          );
          if (index > 0)
            assert.ok(
              Math.abs(node.x - siblings[index - 1].x - bandWidth) < 0.1,
              "neighboring bands have equal spacing",
            );
        }
        if (siblings.length === 1 && parent)
          assert.ok(
            Math.abs(siblings[0].x - parent.x) < 0.1,
            "descendants stay on their branch",
          );
      }
      for (const edge of geometry.edges) {
        const parent = geometry.nodes[edge.parentId];
        const child = geometry.nodes[edge.childId];
        assert.ok(
          Math.abs(edge.start[0] - parent.x) < 0.1,
          "edge starts at parent spine",
        );
        assert.ok(
          Math.abs(edge.start[1] - (parent.y + 28)) < 0.1,
          "edge starts below parent glyph",
        );
        assert.ok(
          Math.abs(edge.end[0] - child.x) < 0.1,
          "edge ends at child spine",
        );
        assert.ok(
          Math.abs(edge.end[1] - child.y) < 0.1,
          "edge ends above child glyph",
        );
      }
      return geometry;
    }

    async function checkPlacement(width) {
      await page.waitForFunction(() => {
        const panel = document.querySelector(".conversation-tree-panel");
        const chat = document
          .querySelector("#scroll-jump-layer")
          .getBoundingClientRect();
        const rect = panel.getBoundingClientRect();
        const expected = matchMedia("(max-width: 984px)").matches
          ? Math.min(460, innerWidth - 32)
          : Math.min(rect.width, chat.left + chat.width * 0.15 - 16);
        const toggle = document
          .querySelector(".conversation-tree-toggle")
          .getBoundingClientRect();
        const left = matchMedia("(max-width: 984px)").matches
          ? toggle.left
          : Math.max(16, toggle.right - expected);
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
          overlapLimit: chat.left + chat.width * 0.15,
          toggleLeft: toggle.left,
          toggleTop: toggle.top,
          toggleHeight: toggle.height,
          scrollTopTop: scrollTop.top,
          scrollTopHeight: scrollTop.height,
          scrollTopVisible: scrollTop.width > 0,
          arrowCenter: arrow.left + arrow.width / 2,
          arrowBottom: arrow.bottom,
          borderBottom:
            rect.top +
            Number.parseFloat(getComputedStyle(panel).borderTopWidth),
          toggleCenter: toggle.left + toggle.width / 2,
          arrowVisible: arrow.width > 0 && arrow.height > 0,
          overflow: scroller.scrollWidth - scroller.clientWidth,
          canvasWidth: Number.parseFloat(
            panel.querySelector(".conversation-tree-canvas").style.width,
          ),
          availableWidth: scroller.clientWidth - 24,
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
      if (bounds.scrollTopVisible) {
        assert.equal(
          bounds.toggleTop,
          bounds.scrollTopTop,
          "top controls align vertically",
        );
        assert.equal(bounds.toggleHeight, bounds.scrollTopHeight);
      }
      assert.ok(bounds.left >= 15 && bounds.right <= width - 15);
      if (width > 984) {
        assert.ok(
          bounds.right <= bounds.overlapLimit + 1,
          "at most 15% of the chat is covered",
        );
        assert.ok(
          bounds.left < bounds.toggleLeft,
          "use space left of the toggle",
        );
      }
      if (bounds.canvasWidth <= bounds.availableWidth)
        assert.ok(bounds.overflow <= 1, "show the full tree when it fits");
      if (bounds.width <= bounds.toggleLeft + 38 - 16)
        assert.ok(
          bounds.right <= bounds.chatLeft,
          "a large gutter needs no chat overlap",
        );
      return bounds.width;
    }

    for (const width of [1200, 1920, 2560, 1024, 720, 390, 2560]) {
      await page.setViewportSize({ width, height: 820 });
      await checkPlacement(width);
      const geometry = await checkRowLayout();
      assert.deepEqual(
        [...new Set(geometry.rows.map((row) => row.length))].sort(),
        [1, 2, 3],
      );
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
      const geometry = await checkRowLayout();
      if (id === 102) {
        assert.ok(
          Math.abs(geometry.nodes[102].x - geometry.nodes[103].x) < 0.1,
          "the selected version's follow-up stays on its branch",
        );
        await page.screenshot({
          path: `browser-artifacts/conversation-tree/${engine.name()}-row-layout-alternate.png`,
        });
      }
      if (id === 101) assert.equal(width, expandedWidth);
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

    async function importTree(nodes) {
      const markdown = await page.evaluate(async (nodes) => {
        const { branchingTranscriptMarkdown } = await import(
          "/demos/streaming/branching-transcript.ts"
        );
        return branchingTranscriptMarkdown(
          { selectedRootId: 1, nodes },
          { dayOf: () => 0, dayLabel: () => "Today" },
        );
      }, nodes);
      await page.keyboard.press("Escape");
      await page.locator("#import-file").setInputFiles({
        name: "tree-placement.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      });
      await page.locator('#viewport [data-key="2"]').waitFor();
      await toggle.click();
      await page
        .getByRole("button", { name: "Reset tree zoom to 100%" })
        .click();
      await panel
        .locator('.conversation-tree-node[data-message-id="2"]')
        .waitFor();
    }

    const response = (id, title, sections) => ({
      id,
      parentId: 1,
      selectedChildId: null,
      message: { role: "assistant", markdown: `# ${title}\n\n${sections}` },
    });
    const prompt = {
      id: 1,
      parentId: 0,
      selectedChildId: 2,
      message: { role: "user", markdown: "Explain this" },
    };
    await page.setViewportSize({ width: 2560, height: 820 });
    for (const count of [1, 2, 3, 4, 5]) {
      await importTree([
        prompt,
        ...Array.from({ length: count }, (_, index) =>
          response(index + 2, `Version ${index + 1}`, ""),
        ),
      ]);
      const geometry = await checkRowLayout();
      assert.equal(geometry.rows[1].length, count);
    }
    await importTree([prompt, response(2, "Short answer", "## Details")]);
    const shortWidth = await panel.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    assert.equal(shortWidth, 664);

    const title = "Mi az az LLM Wiki?";
    const longHeading =
      "A probléma, amelyet megold: a források rendszerezése és a megszerzett tudás folyamatos frissítése";
    const sections = `# ${longHeading}\n\n## ${longHeading}\n\n## A három réteg`;
    await importTree([prompt, response(2, title, sections)]);
    const headingButtons = panel.locator(
      '.conversation-tree-heading[data-message-id="2"]',
    );
    assert.deepEqual(await headingButtons.allTextContents(), [
      longHeading,
      longHeading,
      "A három réteg",
    ]);

    async function checkTextFits() {
      const clipped = await panel
        .locator(".conversation-tree-heading")
        .evaluateAll((headings) =>
          headings
            .filter((heading) => heading.scrollWidth > heading.clientWidth + 1)
            .map((heading) => heading.textContent),
        );
      assert.ok(
        clipped.length > 0,
        "long headings ellipsize within their band",
      );
      const clippedTitles = await panel
        .locator(".conversation-tree-label")
        .evaluateAll((labels) =>
          labels
            .filter((label) => label.scrollHeight > label.clientHeight + 1)
            .map((label) => label.textContent),
        );
      assert.deepEqual(
        clippedTitles,
        [],
        "message labels fit without line clamping",
      );
    }

    const longWidth = await panel.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    assert.equal(longWidth, shortWidth, "long labels don't resize the panel");
    await checkTextFits();
    const spacing = await panel.evaluate((panel) => {
      const node = panel.querySelector(
        '.conversation-tree-node[data-message-id="2"]',
      );
      const toc = panel.querySelector(".conversation-tree-toc");
      return toc.getBoundingClientRect().top - node.getBoundingClientRect().top;
    });
    assert.equal(
      spacing,
      36,
      "first ToC item immediately follows the node glyph",
    );
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-long-headings.png`,
    });

    for (const width of [1024, 390, 2560]) {
      await page.setViewportSize({ width, height: 820 });
      await checkPlacement(width);
      await checkRowLayout();
      if (width === 2560) await checkTextFits();
      else {
        assert.ok(
          await headingButtons
            .first()
            .evaluate((el) => el.scrollWidth > el.clientWidth),
          "ellipsis remains at the width limit",
        );
        if (width === 390)
          assert.ok(
            await panel
              .locator(".conversation-tree-scroll")
              .evaluate((el) => el.scrollWidth - el.clientWidth <= 1),
            "a single band fits when the panel exceeds its minimum width",
          );
      }
    }

    // Both versions get equal halves, including their ToCs.
    await importTree([
      prompt,
      response(
        2,
        title,
        "## A probléma, amelyet megold: a források rendszerezése",
      ),
      response(
        3,
        "Másik válasz",
        "## A tudás folyamatos frissítése és ellenőrzése",
      ),
    ]);
    const separation = await panel.evaluate((panel) => {
      const first = panel
        .querySelector('.conversation-tree-heading[data-message-id="2"]')
        .getBoundingClientRect();
      const next = panel
        .querySelector('.conversation-tree-node[data-message-id="3"]')
        .getBoundingClientRect();
      const firstNode = panel
        .querySelector('.conversation-tree-node[data-message-id="2"]')
        .getBoundingClientRect();
      return {
        gap: next.left - first.right,
        stride: next.left - firstNode.left,
        firstWidth: firstNode.width,
        nextWidth: next.width,
        canvasWidth: panel
          .querySelector(".conversation-tree-canvas")
          .getBoundingClientRect().width,
        firstTocWidth: first.width,
        nextTocWidth: panel
          .querySelector('.conversation-tree-heading[data-message-id="3"]')
          .getBoundingClientRect().width,
      };
    });
    assert.ok(separation.gap >= 8, "text stops before the adjacent branch");
    assert.ok(Math.abs(separation.stride - separation.canvasWidth / 2) < 0.1);
    assert.ok(
      Math.abs(separation.firstWidth - (separation.stride / 2 + 18)) < 0.1,
    );
    assert.equal(separation.nextWidth, separation.firstWidth);
    assert.ok(
      Math.abs(separation.firstTocWidth - (separation.firstWidth - 20)) < 0.1,
    );
    assert.equal(separation.nextTocWidth, separation.firstTocWidth);

    // Non-duplicated headings get the same compact spacing.
    await importTree([
      prompt,
      {
        ...response(2, title, ""),
        message: {
          role: "assistant",
          markdown: "Opening paragraph\n\n## First section",
        },
      },
    ]);
    assert.equal(
      await panel
        .locator(".conversation-tree-toc")
        .evaluate(
          (el) =>
            Number.parseFloat(el.style.top) -
            Number.parseFloat(
              el.parentElement.querySelector(
                '.conversation-tree-node[data-message-id="2"]',
              ).style.top,
            ),
        ),
      36,
    );
    await importTree([
      prompt,
      response(
        2,
        "A wrapped title explaining the sources, their organization, and how knowledge is continually updated",
        "## First section",
      ),
    ]);
    await page.setViewportSize({ width: 390, height: 820 });
    await page.waitForFunction(
      () =>
        document.querySelector(".conversation-tree-panel").style.width === "",
    );
    const wrappedClearance = await panel.evaluate((panel) => {
      const label = panel
        .querySelector(
          '.conversation-tree-node[data-message-id="2"] .conversation-tree-label',
        )
        .getBoundingClientRect();
      const toc = panel
        .querySelector(".conversation-tree-toc")
        .getBoundingClientRect();
      return { height: label.height, gap: toc.top - label.bottom };
    });
    assert.equal(wrappedClearance.height, 32);
    assert.ok(Math.abs(wrappedClearance.gap - 4) < 0.01);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: tree sizing, gutter placement, overlap cap, resize, branches, mobile passed`,
    );
  } finally {
    await browser.close();
  }
}
