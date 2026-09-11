// Offline, controlled stream: no credentials or billable requests.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    // Simulated/legacy calls omit offsets: the thinking-to-streaming transition
    // must use the same layout as calls that arrive with chronological offsets.
    const simulated = await browser.newPage({
      viewport: { width: 1200, height: 1000 },
    });
    await simulated.goto(`${base}/demos/streaming/index.html`);
    await simulated.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await simulated.locator("#prompt").fill("Check tool spacing");
    await simulated.locator("#send-btn").click();
    const simulatedRow = simulated.locator("article.message.assistant").last();
    await simulatedRow.locator('.role-label[data-status="thinking"]').waitFor();
    const readTools = (row) => {
      const origin = row.getBoundingClientRect();
      // Ignore floating-point noise from subtracting viewport coordinates.
      const round = (value) => Math.round(value * 1000) / 1000;
      return Array.from(row.querySelectorAll(".tool-call")).map((tool) => {
        const box = tool.getBoundingClientRect();
        return {
          x: round(box.x - origin.x),
          y: round(box.y - origin.y),
          width: round(box.width),
          height: round(box.height),
          padding: getComputedStyle(tool.querySelector("summary")).padding,
        };
      });
    };
    const thinkingTools = await simulatedRow.evaluate(readTools);
    assert.equal(thinkingTools.length, 2);
    await simulatedRow
      .locator('.role-label[data-status="streaming"]')
      .waitFor();
    assert.deepEqual(
      await simulatedRow.evaluate(readTools),
      thinkingTools,
      "simulated tools stay put when text streaming starts",
    );
    await simulated.locator("#send-btn").click();
    await simulatedRow
      .locator('.role-label[data-status="cancelled"]')
      .waitFor();
    assert.deepEqual(
      await simulatedRow.evaluate(readTools),
      thinkingTools,
      "stopping streaming preserves tool spacing",
    );
    await simulated.close();
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.addInitScript(() => {
      localStorage.setItem(
        "virtual-list:ai-settings",
        JSON.stringify({
          provider: "openai",
          apiKey: "offline-test",
          model: "gpt-5-mini",
        }),
      );
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (!String(input).startsWith("https://api.openai.com/"))
          return originalFetch(input, init);
        const encoder = new TextEncoder();
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                window.sendToolEvent = (event) =>
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                  );
                window.finishToolStream = () => controller.close();
                init.signal.addEventListener(
                  "abort",
                  () =>
                    controller.error(
                      new DOMException("Cancelled", "AbortError"),
                    ),
                  { once: true },
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      };
    });
    await page.goto(`${base}/demos/streaming/index.html`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await page.locator("#prompt").fill("Check tool chronology");
    await page.locator("#send-btn").click();
    await page.waitForFunction(
      () => typeof window.sendToolEvent === "function",
    );
    const send = (event) =>
      page.evaluate((event) => window.sendToolEvent(event), event);
    const item = (type, id, extra = {}) => ({ type, id, ...extra });
    const added = (item) => send({ type: "response.output_item.added", item });
    const done = (item) =>
      send({
        type: "response.output_item.done",
        item: { status: "completed", ...item },
      });
    const delta = (delta) =>
      send({ type: "response.output_text.delta", delta });
    const row = page.locator("article.message.assistant").last();
    const order = () =>
      row.evaluate((row) =>
        Array.from(row.querySelectorAll(".tool-call-title, .markdown p"))
          // Thinking summaries now render Markdown inside the tool disclosure.
          // They are tool content, not additional top-level response segments.
          .filter((element) => !element.closest(".tool-call-body"))
          .map((element) =>
            element.querySelector("img") ? "IMAGE" : element.textContent.trim(),
          )
          .filter(Boolean),
      );
    const toolLayout = () => row.evaluate(readTools);
    await added(item("reasoning", "think-1"));
    await done(
      item("reasoning", "think-1", {
        summary: [{ type: "summary_text", text: "Ready" }],
      }),
    );
    await row.getByText("thinking", { exact: true }).waitFor();
    await row.locator(".tool-call-meta.done").waitFor();
    assert.equal(
      await row.locator(".tool-call-body .markdown p").textContent(),
      "Ready",
      "the thinking summary remains rendered inside its tool",
    );
    const beforeText = await toolLayout();
    await delta("Before tool.\n\n");
    await row.getByText("Before tool.", { exact: true }).waitFor();
    assert.deepEqual(
      await toolLayout(),
      beforeText,
      "starting text preserves the preceding tool's spacing and position",
    );
    await row
      .locator(".markdown p")
      .filter({ hasText: "Before tool." })
      .evaluate((element) => {
        window.originalText = element;
      });
    await added(item("image_generation_call", "image-1"));
    await row.getByText("image_generation", { exact: true }).waitFor();
    assert.deepEqual(await order(), [
      "thinking",
      "Before tool.",
      "image_generation",
    ]);
    await row.locator(".tool-call-summary").last().click();
    const images = await page.evaluate(() =>
      [20, 40].map((size) => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#6389a1";
        ctx.fillRect(0, 0, size, size);
        return canvas.toDataURL().split(",")[1];
      }),
    );
    await send({
      type: "response.image_generation_call.partial_image",
      item_id: "image-1",
      partial_image_b64: images[0],
    });
    await row.locator(".markdown img").waitFor();
    await added(item("reasoning", "think-2"));
    await delta("After preview. ");
    await row.getByText("After preview.", { exact: true }).waitFor();
    await done(
      item("reasoning", "think-2", {
        summary: [{ type: "summary_text", text: "Done" }],
      }),
    );
    await done(
      item("image_generation_call", "image-1", {
        result: images[1],
        output_format: "png",
      }),
    );
    await delta("Final words.");
    await row
      .getByText("After preview. Final words.", { exact: true })
      .waitFor();
    const expected = [
      "thinking",
      "Before tool.",
      "image_generation",
      "IMAGE",
      "thinking",
      "After preview. Final words.",
    ];
    assert.deepEqual(await order(), expected);
    assert.equal(
      await row
        .locator(".tool-call")
        .nth(1)
        .evaluate((el) => el.open),
      true,
      "settling a tool keeps its expanded state",
    );
    assert.equal(
      await row
        .locator(".markdown p")
        .filter({ hasText: "Before tool." })
        .evaluate((el) => el === window.originalText),
      true,
      "earlier text stays mounted",
    );
    assert.equal(await row.locator("[data-cursor]").count(), 1);
    await send({
      type: "response.completed",
      response: { id: "resp_chronology", status: "completed", output: [] },
    });
    await page.waitForFunction(() =>
      document.querySelector("#send-btn")?.textContent.includes("Send"),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#viewport [data-cursor]").length === 0,
    );
    const exported = await page.evaluate(async () => {
      const { loadOpenAIHistory } = await import("/demos/streaming/openai.ts");
      const { transcriptMarkdown } = await import(
        "/demos/streaming/transcript.ts"
      );
      const turns = await loadOpenAIHistory();
      return transcriptMarkdown(turns, {
        dayOf: () => 0,
        dayLabel: () => "Today",
      });
    });
    await page.reload();
    await row
      .getByText("After preview. Final words.", { exact: true })
      .waitFor();
    assert.deepEqual(await order(), expected, "reload preserves chronology");
    await row.evaluate((element) => {
      element.dataset.beforeImport = "yes";
    });
    await page.locator("#import-file").setInputFiles({
      name: "chronology.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(exported),
    });
    await page.waitForFunction(
      () => !document.querySelector('[data-before-import="yes"]'),
    );
    await row
      .getByText("After preview. Final words.", { exact: true })
      .waitFor();
    assert.deepEqual(
      await order(),
      expected,
      "transcript import preserves chronology",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: streamed tool chronology, image replacement, reload and import passed`,
    );
  } finally {
    await browser.close();
  }
}
