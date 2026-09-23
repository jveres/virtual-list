import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const engine of [firefox, chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/demos/chat-history/`);
    await page.waitForFunction(() => window.chatHistory);
    const result = await page.evaluate(async () => {
      const { buildToolCall } = await import("/demos/shared/chat-ui.ts");
      const { appendStaticMessageContent, createMessageContent } = await import(
        "/demos/streaming/message-content.ts"
      );
      const output = [
        "**Considering names**",
        "",
        "Another paragraph with `inline code`.",
        "",
        "- First option",
        "- Second option",
        "",
        "```typescript",
        "const name = 'Nova';",
        "```",
      ].join("\n");
      const call = {
        name: "thinking",
        status: "done",
        durationMs: 123,
        input: "(internal reasoning; summary below)",
        output,
        open: true,
      };
      const probe = document.createElement("div");
      document.body.append(probe);
      const inspect = (host) => {
        const markdown = host.querySelector(
          ".tool-call-body > .markdown-viewer > .markdown",
        );
        const paragraphs = markdown?.querySelectorAll(":scope > p");
        return {
          bold: markdown?.querySelector("strong")?.textContent,
          fontSize: markdown ? getComputedStyle(markdown).fontSize : null,
          color: markdown ? getComputedStyle(markdown).color : null,
          bottomPadding: markdown
            ? getComputedStyle(markdown).paddingBottom
            : null,
          inline: markdown?.querySelector("p code")?.textContent,
          items: markdown?.querySelectorAll("li").length,
          code: markdown?.querySelector("pre code")?.textContent.trim(),
          paragraphGap: paragraphs?.[1]
            ? Number.parseFloat(getComputedStyle(paragraphs[1]).marginTop) +
              Number.parseFloat(getComputedStyle(paragraphs[0]).marginBottom)
            : 0,
          input: host.querySelector(".tool-call-code")?.textContent,
        };
      };
      const message = { role: "assistant", markdown: "", toolCalls: [call] };
      const ordered = document.createElement("div");
      appendStaticMessageContent(ordered, message);
      const live = document.createElement("div");
      probe.append(ordered, live);
      const handle = createMessageContent(live, "none");
      try {
        handle.update(
          { ...message, toolCalls: [{ ...call, status: "running" }] },
          "",
          true,
        );
        const running = inspect(live);
        live.querySelector("details").open = false;
        handle.update(message, "", false);
        const closedAfterUpdate = !live.querySelector("details").open;
        const observer = new MutationObserver(() => {});
        for (const slot of live.children)
          observer.observe(slot, { attributes: true });
        handle.update(message, "", false);
        const unchangedSlotMutations = observer.takeRecords().length;
        observer.disconnect();
        const plain = buildToolCall({ ...call, name: "search" });
        const unsafe = buildToolCall({
          ...call,
          output:
            '<script>window.thinkingXss = true</script><img src="x" onerror="window.thinkingXss = true"><a href="javascript:alert(1)">bad</a>',
        });
        probe.append(plain, unsafe);
        return {
          rendered: [inspect(ordered), running, inspect(live)],
          closedAfterUpdate,
          unchangedSlotMutations,
          plain: plain.querySelector(".tool-call-body > p")?.textContent,
          plainColor: getComputedStyle(
            plain.querySelector(".tool-call-body > p"),
          ).color,
          plainFontSize: getComputedStyle(
            plain.querySelector(".tool-call-body > p"),
          ).fontSize,
          plainHasMarkdown: !!plain.querySelector(".markdown-viewer"),
          unsafeElements: unsafe.querySelectorAll(
            'script, [onerror], [href^="javascript:"]',
          ).length,
          bare: buildToolCall({
            ...call,
            input: "",
            output: "",
          }).classList.contains("bare"),
          output,
        };
      } finally {
        handle.destroy();
        probe.remove();
      }
    });
    for (const rendered of result.rendered) {
      assert.equal(rendered.bold, "Considering names");
      assert.equal(rendered.fontSize, "12px");
      assert.equal(rendered.fontSize, result.plainFontSize);
      assert.equal(rendered.color, result.plainColor);
      assert.equal(rendered.bottomPadding, "0px");
      assert.equal(rendered.inline, "inline code");
      assert.equal(rendered.items, 2);
      assert.equal(rendered.code, "const name = 'Nova';");
      assert.ok(
        rendered.paragraphGap > 0,
        "Markdown paragraph spacing retained",
      );
      assert.equal(rendered.input, "(internal reasoning; summary below)");
    }
    assert.equal(result.closedAfterUpdate, true);
    assert.equal(result.unchangedSlotMutations, 0);
    assert.equal(result.plain, result.output);
    assert.equal(result.plainHasMarkdown, false);
    assert.equal(result.unsafeElements, 0);
    assert.equal(result.bare, true);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: thinking Markdown passes static/live, disclosure, plain-tool, and sanitization checks`,
    );
  } finally {
    await browser.close();
  }
}
