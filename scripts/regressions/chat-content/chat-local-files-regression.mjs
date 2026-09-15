import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const artwork = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAM0lEQVRYR+3QQREAAAQAQcrIqKVIxPDZS3CzWT0bj6UBAgQIECBAgAABAgQIECBA4FvgAK7MTaF9FEEPAAAAEGRlQkc0NkIzOENCQTYwMkY2MzUwJMtebQAAAABJRU5ErkJggg==",
  "base64",
);
const imageUrl = `data:image/png;base64,${artwork.toString("base64")}`;
const content =
  '<!doctype html><h1>Árvíz 😀</h1><img src="{{attachment:1}}"><script>globalThis.fileExecuted=true</script>';
const expectedContent = content.replace("{{attachment:1}}", imageUrl);
for (const engine of [firefox, webkit]) {
  if (
    process.env.BROWSER_ENGINE &&
    process.env.BROWSER_ENGINE !== engine.name()
  )
    continue;
  const browser = await engine.launch();
  let resumeReply = () => {};
  const replyGate = new Promise((resolve) => {
    resumeReply = resolve;
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem("virtual-list:ai-settings"))
        localStorage.setItem(
          "virtual-list:ai-settings",
          JSON.stringify({
            provider: "chatgpt",
            chatgptModel: "test-model",
            tools: {
              webSearch: false,
              imageGeneration: false,
              codeInterpreter: false,
              fileDownload: true,
            },
          }),
        );
    });
    await page.route("https://api.openai.com/**", (route) => {
      errors.push("Unexpected API-token request");
      return route.abort();
    });
    const requests = [];
    await page.route("**/__chatgpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/status"))
        return route.fulfill({ json: { authenticated: true } });
      if (path.endsWith("/models"))
        return route.fulfill({ json: { models: ["test-model"] } });
      assert.equal(path, "/__chatgpt/responses");
      const body = route.request().postDataJSON();
      requests.push(body);
      const first = requests.length === 1;
      if (!first) await replyGate;
      const output = first
        ? [
            {
              type: "reasoning",
              id: "rs_file",
              summary: [],
              encrypted_content: "opaque",
            },
            {
              type: "function_call",
              id: "fc_file",
              call_id: "call_file",
              name: "create_file",
              arguments: JSON.stringify({ filename: "page.html", content }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "[Download page](sandbox:/mnt/data/page.html)",
                  annotations: [],
                },
              ],
            },
          ];
      const events = [
        ...(first
          ? [{ type: "response.output_item.added", item: output[1] }]
          : [
              {
                type: "response.output_text.delta",
                delta: "[Download page](sandbox:/mnt/data/page.html)",
              },
            ]),
        ...output.map((item, output_index) => ({
          type: "response.output_item.done",
          item,
          output_index,
        })),
        {
          type: "response.completed",
          response: {
            id: first ? "resp_file" : "resp_final",
            model: "test-model",
            output: [],
          },
        },
      ];
      await route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    });
    await page.goto(`${base}/demos/streaming/`);
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await page.locator("#prompt").fill("Create an HTML file");
    await page.locator("#attachment-files").setInputFiles({
      name: "artwork.png",
      mimeType: "image/png",
      buffer: artwork,
    });
    await page.locator(".composer-attachments img").waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".composer-attachments img")?.naturalWidth ===
        32,
    );
    await page.locator("#send-btn").click();
    const button = page.getByRole("button", {
      name: "Download page.html",
      exact: true,
    });
    await button.waitFor();
    const streamingGap = await button.evaluate((button) => {
      const content = button.closest(".message-content");
      const cursor = content?.querySelector(".markdown > .cursor");
      const downloads = content?.querySelector(".message-generated-files");
      if (!cursor || !downloads)
        throw new Error("Missing cursor/download geometry");
      return (
        downloads.getBoundingClientRect().top -
        cursor.getBoundingClientRect().bottom
      );
    });
    assert.ok(
      streamingGap >= 15,
      `download footer needs a 16px gap below the cursor, got ${streamingGap}`,
    );
    resumeReply();
    await page.waitForFunction(
      () => document.querySelector("#send-btn").textContent === "Send",
    );
    const actionGap = await button.evaluate((button) => {
      const row = button.closest(".message");
      const downloads = row?.querySelector(".message-generated-files");
      const action = row?.querySelector(".message-actions > button");
      if (!downloads || !action)
        throw new Error("Missing action footer geometry");
      return (
        action.getBoundingClientRect().top -
        downloads.getBoundingClientRect().bottom
      );
    });
    assert.ok(
      actionGap >= 15,
      `action footer needs a 16px gap, got ${actionGap}`,
    );
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.some((tool) => tool.name === "create_file"));
    assert.ok(
      requests[0].input.some((item) =>
        item.content?.some?.(
          (part) =>
            part.type === "input_text" &&
            part.text.includes("{{attachment:1}}"),
        ),
      ),
    );
    assert.ok(
      requests[1].input.some(
        (item) =>
          item.type === "function_call_output" && item.call_id === "call_file",
      ),
    );
    for (const stage of ["initial", "reloaded"]) {
      if (stage === "reloaded") {
        await page.waitForFunction(async () => {
          const { loadOpenAIHistory } = await import(
            "/demos/streaming/openai.ts"
          );
          const turns = await loadOpenAIHistory();
          return turns.some((turn) =>
            turn.generatedFiles?.some((file) =>
              file.content?.includes("Árvíz"),
            ),
          );
        });
        await page.reload();
        await button.waitFor();
      }
      const downloadPromise = page.waitForEvent("download");
      await button.click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "page.html");
      assert.equal(
        await readFile(await download.path(), "utf8"),
        expectedContent,
      );
      assert.equal(
        await page.evaluate(() => globalThis.fileExecuted === true),
        false,
      );
      assert.equal(
        await page.locator(".message-generated-files script").count(),
        0,
      );
      assert.equal(
        await page.locator(".message-generated-files[data-files]").count(),
        0,
      );
    }
    await page.locator("#ai-settings-btn").click();
    const toggle = page.getByLabel("File download (custom)", { exact: true });
    await toggle.uncheck();
    await page.reload();
    assert.equal(await page.locator("#ai-tool-file").isChecked(), false);
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: local HTML download preserves bytes across reload, stays inert, uses tool continuation, and File download toggle persists`,
    );
  } finally {
    resumeReply();
    await browser.close();
  }
}
