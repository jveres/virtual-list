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
      hasTouch: true,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    // The default chat starts with the last prompt pinned. Selecting its
    // alternate short reply must not add another reserve for the reply.
    const initialHeight = await page
      .locator("#viewport")
      .evaluate((viewport) => viewport.scrollHeight);
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.scrollTop -= 600;
    });
    await page
      .getByRole("button", { name: "Conversation tree", exact: true })
      .click();
    await page
      .locator(".conversation-tree-node")
      .filter({ hasText: "Here's the trade-off as a table:" })
      .click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".conversation-tree-panel")
          .hasAttribute("aria-busy"),
    );
    const alternateFinal = await page
      .locator('#viewport [data-key="105"]')
      .evaluate((row) => {
        const viewport = document.querySelector("#viewport");
        return {
          height: viewport.scrollHeight,
          top: viewport.scrollTop,
          client: viewport.clientHeight,
          offset:
            row.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
        };
      });
    assert.ok(
      alternateFinal.offset > 40,
      `alternate short final response must clamp, not align at ${alternateFinal.offset}`,
    );
    assert.ok(
      Math.abs(alternateFinal.height - initialHeight) <= 2,
      "switching short replies must retain the prompt reserve without adding a reply reserve",
    );
    assert.ok(
      Math.abs(
        alternateFinal.top + alternateFinal.client - alternateFinal.height,
      ) <= 2,
      "alternate short final response must land at the bottom limit",
    );
    await page.locator("#prompt").click();
    const markdown = await page.evaluate(async () => {
      const { branchingTranscriptMarkdown } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      const imageUri = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><!--${"padding".repeat(600)}--><rect width="80" height="80" fill="#789"/></svg>`)}`;
      const nodes = Array.from({ length: 120 }, (_, index) => ({
        id: index + 1,
        parentId: index,
        selectedChildId: index === 119 ? null : index + 2,
        message: {
          role: index % 2 ? "assistant" : "user",
          markdown: `${index === 4 ? "A detailed summary that should use the free space to the right instead of being cut off early." : `Message ${index + 1}`}\n\n${"A paragraph with enough content to exercise unloaded history. ".repeat(12)}`,
        },
      }));
      const file = (name, mimeType) => ({
        name,
        mimeType,
        size: 3,
        dataUrl: `data:${mimeType};base64,YWJj`,
      });
      nodes[0].message.attachments = [
        file("notes.txt", "text/plain"),
        file("data.csv", "text/csv"),
      ];
      nodes[2].message.markdown = "";
      nodes[2].message.attachments = [file("report.pdf", "application/pdf")];
      nodes[4].message.attachments = [file("notes.txt", "text/plain")];
      nodes[4].message.markdown += `\n\n![Attached picture](${imageUri})`;
      nodes.push(
        {
          id: 201,
          parentId: 1,
          selectedChildId: 202,
          message: {
            role: "assistant",
            markdown: `Alternate answer\n\n![Supporting picture](${imageUri})\n\n![Second picture](${imageUri})`,
          },
        },
        {
          id: 202,
          parentId: 201,
          selectedChildId: 203,
          message: {
            role: "user",
            markdown: `Alternate follow-up\n\n![One picture](${imageUri})`,
          },
        },
        {
          id: 203,
          parentId: 202,
          selectedChildId: null,
          message: {
            role: "assistant",
            markdown: `![Tree image summary](${imageUri})\n\n![Second picture](${imageUri})`,
          },
        },
        {
          id: 204,
          parentId: 0,
          selectedChildId: 205,
          message: { role: "user", markdown: "Edited root question" },
        },
        {
          id: 205,
          parentId: 204,
          selectedChildId: null,
          message: {
            role: "assistant",
            markdown: '<img src=x onerror="alert(1)">',
          },
        },
      );
      return branchingTranscriptMarkdown(
        { selectedRootId: 1, nodes },
        { dayOf: () => 0, dayLabel: () => "Today" },
      );
    });
    await page.locator("#import-file").setInputFiles({
      name: "tree.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(markdown),
    });
    await page.waitForFunction(() =>
      document.querySelector('#viewport [data-key="119"]'),
    );
    const toggle = page.getByRole("button", {
      name: "Conversation tree",
      exact: true,
    });
    const panel = page.locator(".conversation-tree-panel");
    const node = (id) =>
      panel.locator(`.conversation-tree-node[data-message-id="${id}"]`);
    assert.equal(await panel.isVisible(), false);
    await toggle.hover();
    await panel.waitFor({ state: "visible" });
    // These geometry/fade checks exercise the unscaled reading view.
    await page
      .getByRole("button", { name: "Reset tree zoom to 100%" })
      .evaluate((button) => button.click());
    assert.equal(await node(1).getAttribute("data-loaded"), "false");
    assert.equal(await node(119).getAttribute("data-loaded"), "true");
    assert.equal(await node(201).getAttribute("data-loaded"), "false");
    for (const [id, description] of [
      [1, "Includes 2 files"],
      [3, "Includes 1 file"],
      [5, "Includes 1 image and 1 file"],
    ]) {
      assert.equal(
        await node(id).getAttribute("aria-description"),
        description,
      );
      assert.equal(
        await node(id)
          .locator(".conversation-tree-attachment-indicator")
          .count(),
        1,
        "user attachments use one paperclip badge regardless of file type",
      );
      assert.equal(
        await node(id).locator(".conversation-tree-image-indicator").count(),
        0,
      );
      assert.equal(
        await node(id)
          .locator(".conversation-tree-glyph > svg path")
          .getAttribute("d"),
        await node(119)
          .locator(".conversation-tree-glyph > svg path")
          .getAttribute("d"),
        "attachments preserve the user-message bubble",
      );
    }
    const unloadedInk = await node(1).evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--fg-muted)";
      element.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return {
        expected,
        text: getComputedStyle(
          element.querySelector(".conversation-tree-label"),
        ).color,
        icon: getComputedStyle(
          element.querySelector(".conversation-tree-glyph"),
        ).color,
      };
    });
    assert.equal(unloadedInk.text, unloadedInk.expected);
    assert.equal(unloadedInk.icon, unloadedInk.expected);
    assert.equal(
      await panel.locator(".conversation-tree-node[title]").count(),
      0,
    );
    assert.equal(await toggle.locator("svg rect[rx='1']").count(), 3);
    const controlStrokes = await page
      .locator(
        ".icon-btn svg > *, .scroll-jump svg > *, .message-actions button svg > *, .message-user-actions button svg > *, .version-nav-btn svg > *, .user-message-toggle svg > *, .attach-btn svg > *, .conversation-tree button svg > *",
      )
      .evaluateAll((shapes) =>
        shapes.map((shape) => {
          const style = getComputedStyle(shape);
          return { width: style.strokeWidth, effect: style.vectorEffect };
        }),
      );
    assert.ok(controlStrokes.length > 20);
    for (const stroke of controlStrokes)
      assert.deepEqual(stroke, { width: "1px", effect: "non-scaling-stroke" });
    assert.equal(
      await panel
        .locator(".conversation-tree-edges > g:last-child > path:not(.active)")
        .count(),
      0,
    );
    assert.equal(await panel.locator(".conversation-tree-node").count(), 122);
    assert.equal(await panel.locator('[aria-current="location"]').count(), 1);
    const marker = await panel
      .locator('[aria-current="location"]')
      .evaluate((element) => ({
        border: getComputedStyle(
          element.querySelector(".conversation-tree-glyph"),
        ).borderColor,
        ink: getComputedStyle(element).color,
        dot: getComputedStyle(element, "::before").content,
      }));
    assert.equal(marker.border, marker.ink);
    assert.equal(marker.dot, "none");
    const currentGlyph = panel.locator(
      '[aria-current="location"] .conversation-tree-glyph',
    );
    assert.equal(
      await currentGlyph.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
      "conversation-tree-current-pulse",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await currentGlyph.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
      "none",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Labels use their side of the branch band. Long text keeps its full
    // accessible label while the visible summary is clamped to two lines.
    const wideLabel = await node(5)
      .locator(".conversation-tree-label")
      .evaluate((element) => ({
        width: element.clientWidth,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        text: element.textContent,
        available: element.closest(".conversation-tree-node").clientWidth - 49,
      }));
    assert.ok(
      Math.abs(wideLabel.width - wideLabel.available) < 1,
      `message labels use the available side of their band: ${JSON.stringify(wideLabel)}`,
    );
    assert.equal(
      wideLabel.text,
      "A detailed summary that should use the free space to the right instead of being cut off early.",
    );
    assert.equal(wideLabel.height, 32);
    assert.ok(wideLabel.scrollHeight > wideLabel.height);
    const cappedWidths = await panel
      .locator(".conversation-tree-node")
      .evaluateAll((nodes) => {
        return nodes.every((node) => {
          const width = node.getBoundingClientRect().width;
          const cap = Number.parseFloat(node.style.maxWidth);
          return width > 0 && width <= cap && cap <= 320;
        });
      });
    assert.equal(
      cappedWidths,
      true,
      "content-sized versions respect the width cap",
    );
    const closeGeometry = await page
      .getByRole("button", { name: "Close conversation tree", exact: true })
      .evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        radius: getComputedStyle(element).borderRadius,
      }));
    assert.equal(closeGeometry.width, closeGeometry.height);
    assert.equal(closeGeometry.radius, "6px");
    const closeButton = page.getByRole("button", {
      name: "Close conversation tree",
      exact: true,
    });
    await closeButton.hover();
    const closeCenter = await closeButton.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const cross = element.querySelector("svg").getBoundingClientRect();
      return {
        width: cross.width,
        height: cross.height,
        x: cross.x + cross.width / 2 - (button.x + button.width / 2),
        y: cross.y + cross.height / 2 - (button.y + button.height / 2),
      };
    });
    assert.deepEqual(closeCenter, { width: 16, height: 16, x: 0, y: 0 });
    await closeButton.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-close.png`,
    });
    const badgeSpacing = await panel.evaluate((element) => {
      const canvasTop = element
        .querySelector(".conversation-tree-canvas")
        .getBoundingClientRect().top;
      return [...element.querySelectorAll(".conversation-tree-count")].flatMap(
        (badge) => {
          const row = Number(badge.closest("[data-row]").dataset.row);
          const next = element.querySelector(`[data-row="${row + 1}"]`);
          return next
            ? [
                Number.parseFloat(next.style.top) +
                  8 -
                  (badge.getBoundingClientRect().bottom - canvasTop),
              ]
            : [];
        },
      );
    });
    assert.ok(badgeSpacing.length > 0);
    for (const gap of badgeSpacing)
      assert.ok(gap >= 8, `badge-to-connector gap: ${gap}`);
    const scrollbar = await panel
      .locator(".conversation-tree-scroll")
      .evaluate((element) => {
        // Firefox's headless theme resolves even auto/thin to none on macOS.
        // Compare with a native thin control and verify our authored rule too.
        const probe = document.createElement("div");
        probe.style.scrollbarWidth = "thin";
        document.body.append(probe);
        const nativeThin = getComputedStyle(probe).scrollbarWidth;
        probe.remove();
        const authoredThin = [...document.styleSheets].some((sheet) =>
          [...sheet.cssRules].some(
            (rule) =>
              rule.selectorText === ".conversation-tree-scroll" &&
              rule.style.scrollbarWidth === "thin",
          ),
        );
        return {
          actual: getComputedStyle(element).scrollbarWidth,
          nativeThin,
          authoredThin,
        };
      });
    assert.equal(scrollbar.authoredThin, true);
    assert.equal(scrollbar.actual, scrollbar.nativeThin);
    const gutters = await panel
      .locator(".conversation-tree-scroll")
      .evaluate((element) => ({
        x: Number.parseFloat(
          element.style.getPropertyValue("--scroll-fade-gutter-x"),
        ),
        y: Number.parseFloat(
          element.style.getPropertyValue("--scroll-fade-gutter-y"),
        ),
        actualX: element.offsetHeight - element.clientHeight,
        actualY: element.offsetWidth - element.clientWidth,
      }));
    assert.equal(gutters.x, gutters.actualX);
    assert.equal(gutters.y, gutters.actualY);
    await panel.locator(".conversation-tree-scroll").evaluate((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
    await page.waitForFunction(() => {
      const style = document.querySelector(".conversation-tree-scroll").style;
      return (
        style.getPropertyValue("--scroll-fade-top") === "0px" &&
        style.getPropertyValue("--scroll-fade-bottom") === "14px"
      );
    });
    await panel.locator(".conversation-tree-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForFunction(() => {
      const style = document.querySelector(".conversation-tree-scroll").style;
      return (
        style.getPropertyValue("--scroll-fade-top") === "14px" &&
        style.getPropertyValue("--scroll-fade-bottom") === "0px"
      );
    });
    const checkTreeBottomClick = async () => {
      await page
        .getByRole("button", { name: "Reset tree zoom to 100%" })
        .click();
      const treePosition = () =>
        panel.locator(".conversation-tree-scroll").evaluate((element) => ({
          top: element.scrollTop,
          height: element.clientHeight,
          contentHeight: element.scrollHeight,
          nodeTop: element
            .querySelector('[data-message-id="119"]')
            .getBoundingClientRect().top,
        }));
      for (const width of [1200, 390]) {
        await page.setViewportSize({ width, height: 820 });
        await page.waitForFunction(
          (mobile) =>
            (document.querySelector(".conversation-tree-panel").style.left ===
              "") ===
            mobile,
          width === 390,
        );
        await panel.locator(".conversation-tree-scroll").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const beforeTreeClick = await treePosition();
        await node(119).click();
        await page.waitForFunction(
          () =>
            !document
              .querySelector(".conversation-tree-panel")
              .hasAttribute("aria-busy"),
        );
        assert.deepEqual(
          await treePosition(),
          beforeTreeClick,
          `clicking a node at the tree's bottom must preserve its scroll position (${width}px)`,
        );
      }
      await page.setViewportSize({ width: 1200, height: 820 });
    };
    assert.equal(
      await node(201).locator(".conversation-tree-count").textContent(),
      "2 more messages",
    );
    const geometry = await page.evaluate(() => {
      const box = (selector) =>
        document.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        tree: box(".conversation-tree-toggle"),
        top: box("#scroll-top-btn"),
        panel: box(".conversation-tree-panel"),
        message: box("#viewport .message"),
      };
    });
    assert.equal(geometry.tree.y, geometry.top.y);
    assert.equal(geometry.tree.width, geometry.top.width);
    assert.ok(geometry.tree.x < geometry.top.x);
    assert.ok(geometry.panel.x + geometry.panel.width > geometry.message.x);
    await page.mouse.move(1190, 810);
    await panel.waitFor({ state: "hidden" });
    await toggle.focus();
    await panel.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    assert.equal(await panel.isVisible(), false);
    await toggle.click();
    await checkTreeBottomClick();
    await node(1).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.conversation-tree-node[data-message-id="1"]')
          ?.getAttribute("aria-current") === "location",
    );
    const firstPosition = await page
      .locator('#viewport [data-key="1"]')
      .evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document.querySelector("#viewport").getBoundingClientRect().top,
      );
    assert.equal(await node(1).getAttribute("data-loaded"), "true");
    // Loaded data need not have a mounted DOM row while it is offscreen.
    assert.equal(await node(119).getAttribute("data-loaded"), "true");
    assert.equal(await page.locator('#viewport [data-key="119"]').count(), 0);
    assert.ok(
      Math.abs(firstPosition - 40) <= 2,
      `history target offset: ${firstPosition}`,
    );
    await page.locator("#prompt").click();
    await page.locator("#viewport").hover();
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(
      () => document.querySelector("#viewport").scrollTop === 0,
    );
    assert.equal(await page.locator("#viewport .boundary-slot").count(), 0);
    const firstAtTop = await page
      .locator('#viewport [data-key="1"]')
      .evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document.querySelector("#viewport").getBoundingClientRect().top,
      );
    assert.ok(
      Math.abs(firstAtTop - 40) <= 2,
      `unexpected blank area above first message: ${firstAtTop}`,
    );
    await toggle.click();
    await node(120).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".conversation-tree-panel")
          ?.getAttribute("aria-busy") === null,
    );
    const treeEnd = await page
      .locator("#viewport")
      .evaluate((viewport) => viewport.scrollTop);
    await page.locator("#prompt").click();
    await page.locator("#viewport").evaluate((viewport) => {
      viewport.scrollTop -= 300;
    });
    await page
      .getByRole("button", { name: "Scroll to bottom", exact: true })
      .click();
    await page.waitForFunction(
      (expected) =>
        Math.abs(document.querySelector("#viewport").scrollTop - expected) < 1,
      treeEnd,
    );
    await toggle.click();
    await node(201).scrollIntoViewIfNeeded();
    const versionPosition = await node(201).evaluate((element) => ({
      left: element.style.left,
      top: element.style.top,
    }));
    await node(201).click();
    await page.waitForFunction(
      () =>
        document.querySelector('.conversation-tree-node[data-message-id="201"]')
          ?.dataset.active === "true",
    );
    assert.equal(await panel.locator('[data-active="true"]').count(), 4);
    assert.equal(
      await node(201).locator(".conversation-tree-image-indicator").count(),
      1,
    );
    assert.equal(
      await node(201).getAttribute("aria-description"),
      "Includes 2 images",
    );
    assert.equal(
      await node(202).getAttribute("aria-description"),
      "Includes 1 image",
    );
    assert.equal(
      await node(203).getAttribute("aria-description"),
      "Includes 2 images",
    );
    const imagePath = (id, selector) =>
      node(id).locator(selector).getAttribute("d");
    const multipleImagePath = await imagePath(
      201,
      ".conversation-tree-image-indicator path",
    );
    assert.notEqual(
      multipleImagePath,
      await imagePath(202, ".conversation-tree-attachment-indicator path"),
    );
    assert.equal(
      multipleImagePath,
      await imagePath(203, ".conversation-tree-glyph > svg path"),
    );
    assert.equal(
      await node(201).locator(".conversation-tree-label").textContent(),
      "Alternate answer",
    );
    assert.equal(
      await node(203).locator(".conversation-tree-label").textContent(),
      "Tree image summary",
    );
    assert.equal(await node(203).locator("img").count(), 0);
    assert.equal(
      await node(203).locator(".conversation-tree-image-indicator").count(),
      0,
    );
    assert.deepEqual(
      await node(201).evaluate((element) => ({
        left: element.style.left,
        top: element.style.top,
      })),
      versionPosition,
    );
    assert.equal(
      await node(2).locator(".conversation-tree-count").textContent(),
      "118 more messages",
    );
    assert.equal(
      await page
        .locator('#viewport [data-key="201"] .version-nav-count')
        .textContent(),
      "2 / 2",
    );
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-desktop.png`,
    });
    await node(204).click();
    await page.waitForFunction(
      () =>
        document.querySelector('.conversation-tree-node[data-message-id="204"]')
          ?.dataset.active === "true",
    );
    assert.equal(await node(205).locator("img").count(), 0);
    assert.equal(
      await node(205).locator(".conversation-tree-label").textContent(),
      '<img src=x onerror="alert(1)">',
    );
    assert.equal(await panel.locator('[data-active="true"]').count(), 2);
    await node(1).click();
    await page.waitForFunction(
      () =>
        document.querySelector('.conversation-tree-node[data-message-id="1"]')
          ?.dataset.active === "true",
    );
    await node(2).click();
    await page.waitForFunction(
      () =>
        document.querySelector('.conversation-tree-node[data-message-id="2"]')
          ?.dataset.active === "true",
    );
    assert.equal(await panel.locator('[data-active="true"]').count(), 120);
    await page.locator("#prompt").click();
    assert.equal(await panel.isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle.tap();
    await panel.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Reset tree zoom to 100%" }).tap();
    await panel.locator(".conversation-tree-scroll").evaluate((element) => {
      element.scrollLeft = 0;
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".conversation-tree-scroll")
          .style.getPropertyValue("--scroll-fade-right") === "14px",
    );
    await panel.locator(".conversation-tree-scroll").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await page.waitForFunction(() => {
      const style = document.querySelector(".conversation-tree-scroll").style;
      return (
        style.getPropertyValue("--scroll-fade-left") === "14px" &&
        style.getPropertyValue("--scroll-fade-right") === "0px"
      );
    });
    const mobile = await panel.boundingBox();
    assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 390);
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-mobile.png`,
    });
    await page
      .getByRole("button", { name: "Close conversation tree", exact: true })
      .tap();
    assert.equal(await panel.isVisible(), false);
    await page.setViewportSize({ width: 1200, height: 820 });
    for (const long of [false, true]) {
      const label = `Final ${long ? "long" : "short"} response`;
      const ending = long
        ? `${label}\n\n${"A long response paragraph. ".repeat(800)}`
        : label;
      await page.locator("#import-file").setInputFiles({
        name: "last-message.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          `**User**\n\nEarlier prompt\n\n**Assistant**\n\n${"Earlier reply. ".repeat(200)}\n\n**User**\n\nFinal prompt\n\n**Assistant**\n\n${ending}\n`,
        ),
      });
      await page
        .locator("#viewport")
        .getByText(label, { exact: true })
        .waitFor();
      const before = await page
        .locator('#viewport [data-key="4"]')
        .evaluate((row) => {
          const viewport = document.querySelector("#viewport");
          return {
            height: viewport.scrollHeight,
            client: viewport.clientHeight,
            absoluteTop:
              row.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top +
              viewport.scrollTop,
          };
        });
      await toggle.click();
      await node(4).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".conversation-tree-panel")
            ?.getAttribute("aria-busy") === null,
      );
      const after = await page
        .locator('#viewport [data-key="4"]')
        .evaluate((row) => {
          const viewport = document.querySelector("#viewport");
          return {
            height: viewport.scrollHeight,
            top: viewport.scrollTop,
            offset:
              row.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top,
          };
        });
      assert.equal(
        after.height,
        before.height,
        "tree navigation must preserve the page-load scroll range",
      );
      const expectedTop = Math.max(
        0,
        Math.min(before.absoluteTop - 40, before.height - before.client),
      );
      assert.ok(Math.abs(after.top - expectedTop) <= 2);
      if (long)
        assert.ok(
          Math.abs(after.offset - 40) <= 2,
          `long response should reveal its start: ${after.offset}`,
        );
      else
        assert.ok(
          after.offset > 40,
          "short response should stop at the existing bottom limit",
        );
      await page.locator("#prompt").click();
    }
    // Keyboard-opened (not pinned) panels must retain focus across the
    // node replacement performed after a successful selection.
    await toggle.focus();
    await node(4).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".conversation-tree-panel")
          .hasAttribute("aria-busy"),
    );
    assert.equal(
      await panel.isVisible(),
      true,
      "keyboard selection must keep the tree open",
    );
    assert.equal(
      await node(4).evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press("Escape");

    const datedBranch = await page.evaluate(async () => {
      const { branchingTranscriptMarkdown } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      const nodes = Array.from({ length: 4 }, (_, index) => ({
        id: index + 1,
        parentId: index,
        selectedChildId: index === 3 ? null : index + 2,
        message: {
          role: index % 2 ? "assistant" : "user",
          markdown: `Message ${index + 1}`,
        },
      }));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const dataUrl = canvas.toDataURL("image/png");
      nodes[2].message.markdown = "";
      nodes[2].message.attachments = [
        {
          name: "review_image.png",
          mimeType: "image/png",
          size: atob(dataUrl.split(",")[1]).length,
          dataUrl,
        },
      ];
      nodes.push({
        id: 5,
        parentId: 3,
        selectedChildId: null,
        message: {
          role: "assistant",
          markdown: "Dated answer",
          sentAt: Date.now(),
        },
      });
      return branchingTranscriptMarkdown(
        { selectedRootId: 1, nodes },
        { dayOf: () => 0, dayLabel: () => "Today" },
      );
    });
    await page.locator("#import-file").setInputFiles({
      name: "dated-branch.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(datedBranch),
    });
    await page.locator('#viewport [data-key="4"]').waitFor();
    await toggle.click();
    assert.equal(
      await node(3).getAttribute("aria-description"),
      "Includes 1 image",
    );
    assert.equal(
      await node(3).locator(".conversation-tree-label").textContent(),
      "review_image.png",
    );
    assert.equal(
      await node(3).locator(".conversation-tree-attachment-indicator").count(),
      1,
      "an image-only user message also has a paperclip badge",
    );
    for (const [id, headers] of [
      [5, ["Earlier", "Today"]],
      [4, ["Today"]],
    ]) {
      await node(id).click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".conversation-tree-panel")
            .hasAttribute("aria-busy"),
      );
      await page.locator("#viewport").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.locator('#viewport [data-key="1"]').waitFor();
      assert.deepEqual(
        await page.locator("#viewport .section-header-pill").allTextContents(),
        headers,
        "day headers must come from the selected snapshot",
      );
      assert.equal(
        await page
          .locator(`#viewport [data-key="${id}"] .message-actions`)
          .getAttribute("data-latest"),
        "",
        "the selected branch's last response must keep its toolbar visible",
      );
    }
    await page.locator("#prompt").click();
    await page.locator("#prompt").fill("Explain virtual scrolling briefly.");
    const pendingLabel = await page.evaluate(async () => {
      document.querySelector("#send-btn").click();
      // The structural refresh is queued after the new response is appended.
      await Promise.resolve();
      document.querySelector(".conversation-tree-toggle").click();
      return document.querySelector(
        '.conversation-tree-node[data-message-id="7"] .conversation-tree-label',
      )?.textContent;
    });
    assert.equal(pendingLabel, "Response in progress…");
    assert.equal(
      await page.locator(".conversation-tree-panel").isVisible(),
      true,
    );
    await page.waitForFunction(
      () => document.querySelector("#send-btn").textContent === "Send",
    );
    const finishedLabel = await node(7)
      .locator(".conversation-tree-label")
      .textContent();
    assert.notEqual(finishedLabel, "Untitled message");
    assert.notEqual(finishedLabel, "Response in progress…");
    assert.ok(finishedLabel.length > 0);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: tree hover, keyboard, touch, history, branches, safe labels, alignment passed`,
    );
  } finally {
    await browser.close();
  }
}
