// Offline API fixture: no credentials or billable requests. Start Vite first.
// BROWSER_MATRIX_URL=http://localhost:5173 node scripts/chat-attachments-regression.mjs
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 820 },
  });
  const errors = [];
  const requests = [];
  let missingParent = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      "virtual-list:ai-settings",
      JSON.stringify({
        provider: "openai",
        apiKey: "offline-test-key",
        model: "gpt-5-mini",
        contextTurns: 0,
        tools: {
          imageGeneration: false,
          webSearch: false,
          codeInterpreter: false,
        },
      }),
    );
  });
  await page.route("https://api.openai.com/**", async (route) => {
    assert.equal(route.request().url(), "https://api.openai.com/v1/responses");
    const request = route.request().postDataJSON();
    requests.push(request);
    if (missingParent && request.previous_response_id) {
      missingParent = false;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "previous_response_not_found" },
        }),
      });
      return;
    }
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Attachment received.",
            annotations: [],
          },
        ],
      },
    ];
    const events = [
      { type: "response.output_text.delta", delta: "Attachment received." },
      {
        type: "response.completed",
        response: {
          id: `resp_${requests.length}`,
          status: "completed",
          output,
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
  await page.goto(
    `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/index.html`,
  );
  await page.waitForFunction(() =>
    document.getElementById("attachment-files")?.accept.includes(".pdf"),
  );
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  assert.equal(
    await page
      .locator("#prompt")
      .evaluate((input) => input === document.activeElement),
    false,
  );
  await page.locator("#prompt").focus();
  assert.equal(
    await page
      .locator("#prompt")
      .evaluate((input) => getComputedStyle(input).outlineStyle),
    "none",
  );
  const textFile = {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment fixture"),
  };
  const imageFile = {
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6w1sAAAAASUVORK5CYII=",
      "base64",
    ),
  };
  async function select(files) {
    await page.locator("#attachment-files").setInputFiles(files);
    await page.waitForFunction(
      () => !document.getElementById("attach-btn").disabled,
    );
  }
  async function send(text = "") {
    const count = requests.length;
    await page.fill("#prompt", text);
    await page.locator("#send-btn").focus();
    await page.click("#send-btn");
    await page.waitForFunction(
      () => document.getElementById("send-btn")?.textContent === "Send",
    );
    assert.ok(requests.length > count);
    assert.equal(
      await page
        .locator("#prompt")
        .evaluate((input) => input === document.activeElement),
      false,
    );
    assert.equal(
      await page.getByText("OpenAI request failed", { exact: false }).count(),
      0,
    );
  }

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files", exact: true }).click();
  assert.equal((await chooser).isMultiple(), true);
  await select([textFile, imageFile]);
  assert.equal(requests.length, 0, "selecting files must not upload them");
  assert.equal(
    await page.locator("#pending-attachments .attachment-chip").count(),
    2,
  );
  for (const width of [1200, 390, 320]) {
    await page.setViewportSize({ width, height: 820 });
    const layout = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll(".attachment-remove")].map(
        (button) => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        },
      ),
      overflow: document.body.scrollWidth > innerWidth,
      composer: ["attach-btn", "prompt", "send-btn"].map((id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }),
    }));
    assert.deepEqual(layout.buttons, [
      { width: 28, height: 28 },
      { width: 28, height: 28 },
    ]);
    assert.equal(layout.overflow, false);
    assert.deepEqual(layout.composer[0], layout.composer[1]);
    assert.deepEqual(layout.composer[2], layout.composer[1]);
  }
  await page
    .getByRole("button", { name: "Remove notes.txt", exact: true })
    .click();
  assert.notEqual(await page.locator("#attachment-status").textContent(), "");
  await page
    .getByRole("button", { name: "Remove pixel.png", exact: true })
    .click();
  assert.equal(await page.locator("#pending-attachments").isVisible(), false);
  assert.equal(await page.locator("#attachment-status").textContent(), "");

  await page.fill("#prompt", "Keep my draft");
  await select([
    {
      name: "bad.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("x"),
    },
  ]);
  assert.match(
    await page.locator("#attachment-status").textContent(),
    /unsupported file type/,
  );
  assert.equal(await page.locator("#prompt").inputValue(), "Keep my draft");
  await select([textFile, imageFile]);
  await send();
  assert.deepEqual(requests[0].input, [
    {
      role: "user",
      content: [
        {
          type: "input_file",
          filename: textFile.name,
          file_data: `data:text/plain;base64,${textFile.buffer.toString("base64")}`,
        },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${imageFile.buffer.toString("base64")}`,
          detail: "auto",
        },
      ],
    },
  ]);
  assert.equal(await page.locator(".message.user .attachment-chip").count(), 2);
  assert.equal(await page.locator("#attachment-status").textContent(), "");
  assert.equal(await page.locator("#pending-attachments").isVisible(), false);
  await page.reload();
  await page.waitForSelector(".message.user .attachment-chip");
  assert.equal(
    await page
      .locator(".message.user .attachment-name")
      .allTextContents()
      .then((names) => names.join(",")),
    "notes.txt,pixel.png",
  );
  await select([
    {
      name: "followup.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 test"),
    },
  ]);
  await send("Use this too");
  assert.equal(requests[1].previous_response_id, "resp_1");
  assert.equal(requests[1].input.length, 1);
  assert.equal(requests[1].input[0].content[1].type, "input_file");
  missingParent = true;
  await send("Review all files again");
  const fallback = requests.at(-1);
  assert.equal(fallback.previous_response_id, undefined);
  assert.equal(
    fallback.input
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((part) => ["input_file", "input_image"].includes(part.type))
      .length,
    3,
  );
  // A short pinned reply must not bounce when its composer grows/shrinks.
  await page.setViewportSize({ width: 1200, height: 820 });
  page.on("dialog", (dialog) => dialog.accept());
  const transcript = Array.from(
    { length: 4 },
    (_, i) =>
      `${i % 2 ? "**Assistant**" : "**User**"}\n<!-- turn {"sentAt":1788508800000} -->\n\nTurn ${i}. ${"Short content. ".repeat(5)}\n`,
  ).join("\n");
  await page.locator("#import-file").setInputFiles({
    name: "short.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(transcript),
  });
  await page.waitForFunction(() =>
    document.getElementById("window-status")?.textContent.includes("/4"),
  );
  await page.waitForTimeout(500);
  for (let cycle = 0; cycle < 2; cycle++) {
    const top = await page.evaluate(() => {
      const viewport = document.getElementById("viewport");
      window.attachmentScrollSamples = [];
      window.sampleAttachmentScroll = true;
      const sample = () => {
        window.attachmentScrollSamples.push(viewport.scrollTop);
        if (window.sampleAttachmentScroll) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return viewport.scrollTop;
    });
    assert.ok(top > 0);
    await select([textFile, imageFile]);
    await page.waitForTimeout(500);
    if (cycle === 0)
      await page.screenshot({
        path: `browser-artifacts/attachments-${engine}.png`,
      });
    await page
      .getByRole("button", { name: "Remove notes.txt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove pixel.png", exact: true })
      .click();
    await page.waitForTimeout(500);
    const samples = await page.evaluate(() => {
      window.sampleAttachmentScroll = false;
      return window.attachmentScrollSamples;
    });
    assert.ok(samples.length > 5);
    assert.ok(
      samples.every((value) => Math.abs(value - top) <= 1),
      `attachment resize moved pinned chat: ${JSON.stringify([...new Set(samples)])}`,
    );
  }
  // Long replies follow composer resizing in the resize delivery, not via
  // the animation reserved for streamed message content.
  const longTranscript = Array.from(
    { length: 4 },
    (_, i) =>
      `${i % 2 ? "**Assistant**" : "**User**"}\n<!-- turn {"sentAt":1788508800000} -->\n\nLong turn ${i}. ${"Content fills the row with readable words. ".repeat(i % 2 ? 80 : 5)}\n`,
  ).join("\n");
  await page.locator("#import-file").setInputFiles({
    name: "long.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(longTranscript),
  });
  await page.waitForFunction(() =>
    document.getElementById("viewport")?.textContent.includes("Long turn 3"),
  );
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    const contentHeight = viewport.scrollHeight;
    window.attachmentResizeGaps = [];
    window.attachmentResizeObserver = new ResizeObserver(([entry]) => {
      window.attachmentResizeGaps.push(
        contentHeight - entry.contentRect.height - viewport.scrollTop,
      );
    });
    window.attachmentResizeObserver.observe(viewport);
  });
  await select([textFile]);
  await page.waitForTimeout(300);
  await page
    .getByRole("button", { name: "Remove notes.txt", exact: true })
    .click();
  await page.waitForTimeout(300);
  const resizeGaps = await page.evaluate(() => {
    window.attachmentResizeObserver.disconnect();
    return window.attachmentResizeGaps;
  });
  assert.ok(resizeGaps.length >= 2);
  assert.ok(
    resizeGaps.every((gap) => Math.abs(gap) <= 1),
    `composer resize must land instantly: ${JSON.stringify(resizeGaps)}`,
  );
  // Clipboard images use the same local attachment pipeline as selected files.
  await page.fill("#prompt", "Keep this draft");
  const beforePaste = requests.length;
  const pasteImage = () =>
    page.locator("#prompt").evaluate((input) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const bytes = Uint8Array.from(
        atob(canvas.toDataURL().split(",")[1]),
        (c) => c.charCodeAt(0),
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], "", { type: "image/png" }));
      clipboardData.setData("text/plain", "image fallback text");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
      });
      // Firefox discards files passed to the ClipboardEvent constructor.
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
      return !input.dispatchEvent(event);
    });
  assert.equal(await pasteImage(), true);
  await page.waitForFunction(
    () => !document.getElementById("attach-btn").disabled,
  );
  assert.equal(requests.length, beforePaste, "pasting must not upload images");
  assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft");
  assert.equal(
    await page.locator("#pending-attachments .attachment-chip img").count(),
    1,
  );
  await page
    .getByRole("button", { name: "Remove pasted-image.png", exact: true })
    .click();
  assert.equal(await page.locator("#pending-attachments").isVisible(), false);
  assert.equal(await pasteImage(), true);
  await page.waitForFunction(
    () => !document.getElementById("attach-btn").disabled,
  );
  await send("Describe the pasted image");
  assert.equal(requests.length, beforePaste + 1);
  const pastedContent = requests.at(-1).input.at(-1).content;
  assert.equal(pastedContent[0].text, "Describe the pasted image");
  assert.equal(pastedContent[1].type, "input_image");
  assert.match(pastedContent[1].image_url, /^data:image\/png;base64,/);
  assert.equal(
    await page.locator("#prompt").evaluate((input) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "ordinary text");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
      return input.dispatchEvent(event);
    }),
    true,
    "ordinary text paste must retain its native behavior",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ engine, result: "passed", requests: requests.length }),
  );
} finally {
  await browser.close();
}
