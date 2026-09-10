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
              : index === 1
                ? answer("A structured answer")
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
    await page.locator("#import-file").setInputFiles({
      name: "tree-headings.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(markdown),
    });
    await page.locator('#viewport [data-key="120"]').waitFor();
    await page
      .getByRole("button", { name: "Conversation tree", exact: true })
      .click();
    const panel = page.locator(".conversation-tree-panel");
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
    assert.deepEqual(indent, ["33px", "45px", "45px", "45px"]);

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
