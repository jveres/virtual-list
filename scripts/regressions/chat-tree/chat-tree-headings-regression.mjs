import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import { importTranscript, openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
await mkdir("browser-artifacts/conversation-tree", { recursive: true });
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    const errors = await openStreamingDemo(page, base, { acceptDialogs: true });
    const markdown = await page.evaluate(async () => {
      const { branchingTranscriptMarkdown } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      const paragraph = "A paragraph explaining the section in detail. ".repeat(
        100,
      );
      const answer = (title) =>
        `# ${title}\n\n# Overview\n\n${paragraph}\n\n## Details\n\n${paragraph}\n\n\`\`\`md\n# Not a section\n\`\`\`\n\n### Deeper section\n\n## Details\n\n${paragraph}\n\n## &lt;img src=x&gt;\n\n${paragraph}`;
      const nodes = Array.from({ length: 120 }, (_, index) => ({
        id: index + 1,
        parentId: index,
        selectedChildId: index === 119 ? null : index + 2,
        message: {
          role: index % 2 ? "assistant" : "user",
          markdown:
            index === 0
              ? "# User heading"
              : index === 1 || index === 119
                ? answer(index === 1 ? "A structured answer" : "Final answer")
                : `Message ${index + 1}\n\n${paragraph}`,
        },
      }));
      nodes.push({
        id: 201,
        parentId: 1,
        selectedChildId: 202,
        message: { role: "assistant", markdown: answer("An alternate answer") },
      });
      nodes.push({
        id: 202,
        parentId: 201,
        selectedChildId: null,
        message: { role: "user", markdown: `Follow-up\n\n${paragraph}` },
      });
      return branchingTranscriptMarkdown(
        { selectedRootId: 1, nodes },
        { dayOf: () => 0, dayLabel: () => "Today" },
      );
    });
    await importTranscript(page, markdown, { name: "tree-headings.md" });
    await page.locator('#viewport [data-key="120"]').waitFor();
    await page
      .getByRole("button", { name: "Conversation tree", exact: true })
      .click();
    const panel = page.locator(".conversation-tree-panel");
    await page.getByRole("button", { name: "Reset tree zoom to 100%" }).click();
    const node = (id) =>
      panel.locator(`.conversation-tree-node[data-message-id="${id}"]`);
    const headings = (id) =>
      panel.locator(`.conversation-tree-heading[data-message-id="${id}"]`);
    assert.equal(
      await headings(1).count(),
      0,
      "user messages have no response ToC",
    );
    assert.deepEqual(await headings(2).allTextContents(), [
      "Overview",
      "Details",
      "Details",
      "<img src=x>",
    ]);
    assert.equal(
      await headings(2).first().getAttribute("data-loaded"),
      "false",
    );
    assert.equal(await panel.locator("button button, img").count(), 0);
    const indent = await headings(2).evaluateAll((buttons) =>
      buttons.map((button) => getComputedStyle(button).paddingLeft),
    );
    assert.deepEqual(indent, ["29px", "41px", "41px", "41px"]);
    const outline = await headings(2)
      .first()
      .evaluate((heading) => {
        const glyph = document.querySelector(
          '.conversation-tree-node[data-message-id="2"] .conversation-tree-glyph',
        );
        const rect = heading.getBoundingClientRect();
        const glyphRect = glyph.getBoundingClientRect();
        const style = getComputedStyle(heading);
        return {
          alignment: style.textAlign,
          textLeft: rect.left + Number.parseFloat(style.paddingLeft),
          spineX: glyphRect.left + glyphRect.width / 2,
        };
      });
    assert.equal(outline.alignment, "left");
    assert.ok(outline.textLeft > outline.spineX);

    async function jump(id, index, keyboard = false) {
      const target = headings(id).nth(index);
      const ordinal = Number(await target.getAttribute("data-heading-index"));
      if (keyboard) {
        await target.focus();
        await target.press("Enter");
      } else await target.click({ position: { x: 6, y: 12 } });
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".conversation-tree-panel")
            .hasAttribute("aria-busy"),
      );
      const alignment = await page.evaluate(
        ({ id, index }) => {
          const row = document.querySelector(`#viewport [data-key="${id}"]`);
          const viewport = document.querySelector("#viewport");
          const heading = row?.querySelectorAll(
            ".message-content .markdown :is(h1, h2)",
          )[index];
          return heading
            ? heading.getBoundingClientRect().top -
                viewport.getBoundingClientRect().top
            : null;
        },
        { id, index: ordinal },
      );
      assert.ok(
        alignment !== null && Math.abs(alignment - 40) < 2,
        `heading ${id}:${index} offset ${alignment}`,
      );
      assert.equal(await panel.isVisible(), true);
      assert.equal(await target.getAttribute("data-loaded"), "true");
      assert.equal(await target.getAttribute("aria-current"), "location");
      assert.equal(await node(id).getAttribute("aria-current"), null);
      assert.equal(await panel.locator('[aria-current="location"]').count(), 1);
      assert.equal(
        await target.evaluate((heading) => {
          const parent = document.querySelector(
            `.conversation-tree-node[data-message-id="${heading.dataset.messageId}"]`,
          );
          return (
            getComputedStyle(heading).color !== getComputedStyle(parent).color
          );
        }),
        true,
        "selected heading, not its parent message, receives the accent color",
      );
      if (keyboard)
        assert.equal(
          await target.evaluate((button) => button === document.activeElement),
          true,
        );
    }

    // The repeated label must select its own ordinal in unloaded history.
    await jump(2, 2);
    const positions = await page.evaluate(() => {
      const title = document
        .querySelector(
          '.conversation-tree-node[data-message-id="2"] .conversation-tree-label',
        )
        .getBoundingClientRect();
      const toc = document
        .querySelector('.conversation-tree-heading[data-message-id="2"]')
        .parentElement.parentElement.getBoundingClientRect();
      const next = document
        .querySelector('.conversation-tree-node[data-message-id="3"]')
        .getBoundingClientRect();
      return {
        titleBottom: title.bottom,
        tocTop: toc.top,
        tocBottom: toc.bottom,
        nextTop: next.top,
      };
    });
    assert.ok(positions.tocTop >= positions.titleBottom + 4);
    assert.ok(
      positions.nextTop >= positions.tocBottom + 8 &&
        positions.nextTop <= positions.tocBottom + 12,
      "a straight path should leave only a compact gap after the ToC",
    );
    // Scrolling within one reply must not leave Locate on the last clicked ToC.
    for (const index of [0, 1, 2]) {
      const target = headings(2).nth(index);
      const ordinal = Number(await target.getAttribute("data-heading-index"));
      const chatTop = await page.evaluate((ordinal) => {
        const viewport = document.querySelector("#viewport");
        const heading = document
          .querySelector('[data-key="2"]')
          .querySelectorAll(".message-content .markdown :is(h1, h2)")[ordinal];
        viewport.scrollTop +=
          heading.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          40 +
          120;
        return viewport.scrollTop;
      }, ordinal);
      await page
        .getByRole("button", { name: "Locate current chat position" })
        .click();
      assert.equal(
        await target.getAttribute("aria-current"),
        "location",
        `Locate resolves section ${ordinal} after scrolling within message 2`,
      );
      assert.equal(await panel.locator('[aria-current="location"]').count(), 1);
      assert.ok(
        Math.abs(
          (await page.locator("#viewport").evaluate((view) => view.scrollTop)) -
            chatTop,
        ) < 1,
        "Locate does not move the chat",
      );
    }
    await jump(201, 1, true);
    assert.equal(await node(201).getAttribute("data-active"), "true");
    await jump(2, 0);
    assert.equal(await node(2).getAttribute("data-active"), "true");
    const appearance = (target) =>
      target.evaluate((button) => {
        const style = getComputedStyle(button);
        return { color: style.color, background: style.backgroundColor };
      });
    await node(2).hover();
    const nodeHover = await appearance(node(2));
    assert.equal(nodeHover.background, "rgba(0, 0, 0, 0)");
    for (const index of [0, 1]) {
      const heading = headings(2).nth(index);
      const ring = await heading.evaluate((button) => {
        const style = getComputedStyle(button, "::before");
        const spine = document.querySelector(".conversation-tree-edge.active");
        return {
          border: style.borderTopWidth,
          borderStyle: style.borderTopStyle,
          ink: style.borderTopColor,
          spine: getComputedStyle(spine).stroke,
          fill: style.backgroundColor,
          background: getComputedStyle(document.body).backgroundColor,
          width: style.width,
          height: style.height,
          radius: style.borderRadius,
        };
      });
      // 1.5px; engines snap borders to device pixels, so 1x reports 1px.
      assert.ok(["1px", "1.5px"].includes(ring.border), ring.border);
      assert.equal(ring.borderStyle, "solid");
      assert.equal(ring.ink, ring.spine);
      assert.equal(ring.fill, ring.background, "ring center masks the spine");
      assert.notEqual(ring.fill, ring.ink, "ToC markers are hollow");
      // Sized against the 12px message dots on the same rail.
      assert.equal(ring.width, index === 0 ? "8px" : "6px");
      assert.equal(ring.height, ring.width);
      assert.equal(ring.radius, "50%");
      assert.equal(
        (await appearance(heading)).background,
        "rgba(0, 0, 0, 0)",
        "active-branch headings have no selection background",
      );
      await heading.hover();
      assert.deepEqual(
        await appearance(heading),
        nodeHover,
        "H1 and H2 hover styles match message nodes",
      );
    }
    // A final response title is a message target, not a bottom command.
    await jump(120, 1);
    await node(120).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".conversation-tree-panel")
          .hasAttribute("aria-busy"),
    );
    const parentLanding = await page
      .locator('#viewport [data-key="120"]')
      .evaluate((row) => {
        const viewport = document.querySelector("#viewport");
        return {
          top:
            row.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
          endGap:
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        };
      });
    assert.ok(Math.abs(parentLanding.top - 40) <= 2);
    assert.ok(parentLanding.endGap > 100);
    assert.equal(await node(120).getAttribute("aria-current"), "location");
    assert.equal(await headings(120).nth(1).getAttribute("aria-current"), null);
    await jump(2, 0);
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-headings-desktop.png`,
    });
    await page.setViewportSize({ width: 720, height: 820 });
    await jump(2, 1, true);
    await page.screenshot({
      path: `browser-artifacts/conversation-tree/${engine.name()}-headings-narrow.png`,
    });
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: tree headings, safe labels, history, branches, keyboard, alignment passed`,
    );
  } finally {
    await browser.close();
  }
}
