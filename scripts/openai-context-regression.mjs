// Offline API fixture: no credentials or billable requests. Start Vite first.
// BROWSER_MATRIX_URL=http://127.0.0.1:5173 node scripts/openai-context-regression.mjs
import assert from "node:assert/strict";
import { firefox } from "playwright";

const baseUrl = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const browser = await firefox.launch();
try {
  const page = await browser.newPage();
  const requests = [];
  let missing = false;
  let responseNumber = 0;
  await page.addInitScript(() => {
    if (!localStorage.getItem("virtual-list:ai-settings")) {
      localStorage.setItem(
        "virtual-list:ai-settings",
        JSON.stringify({
          provider: "openai",
          apiKey: "offline-test-key",
          model: "gpt-5-mini",
          contextTurns: 0,
          tools: {
            imageGeneration: true,
            webSearch: false,
            codeInterpreter: false,
          },
        }),
      );
    }
  });
  await page.route("https://api.openai.com/**", async (route) => {
    assert.equal(route.request().url(), "https://api.openai.com/v1/responses");
    const request = route.request().postDataJSON();
    requests.push(request);
    if (missing && request.previous_response_id) {
      missing = false;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "previous_response_not_found" },
        }),
      });
      return;
    }
    responseNumber++;
    const output = [
      {
        type: "message",
        id: `msg_${responseNumber}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: `Reply ${responseNumber}`,
            annotations: [],
          },
        ],
      },
    ];
    if (responseNumber === 1)
      output.push({
        type: "image_generation_call",
        id: "ig_first",
        status: "completed",
        output_format: "png",
        result:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6w1sAAAAASUVORK5CYII=",
      });
    const events = [
      { type: "response.output_text.delta", delta: `Reply ${responseNumber}` },
      ...output.map((item) => ({ type: "response.output_item.done", item })),
      {
        type: "response.completed",
        response: { id: `resp_${responseNumber}`, status: "completed", output },
      },
    ];
    await route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });
  await page.goto(`${baseUrl}/demos/streaming/index.html`);
  async function send(text) {
    await page.fill("#prompt", text);
    await page.click("#send-btn");
    await page.waitForFunction(
      () => document.getElementById("send-btn")?.textContent === "Send",
    );
    assert.equal(
      await page.getByText("OpenAI request failed", { exact: false }).count(),
      0,
    );
  }
  await send("Draw a cat");
  assert.equal(requests[0].previous_response_id, undefined);
  await send("Make it brighter");
  assert.equal(requests[1].previous_response_id, "resp_1");
  assert.deepEqual(requests[1].input, [
    { role: "user", content: "Make it brighter" },
  ]);
  await page.reload();
  await send("Make it blue");
  assert.equal(requests[2].previous_response_id, "resp_2");
  missing = true;
  await send("Restore the original colors");
  assert.equal(requests[3].previous_response_id, "resp_3");
  assert.equal(requests[4].previous_response_id, undefined);
  assert.equal(
    requests[4].input.filter((item) => item.type === "image_generation_call")
      .length,
    1,
  );
  await page.evaluate(() => {
    const key = "virtual-list:ai-settings";
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key)),
        contextTurns: 2,
      }),
    );
  });
  await page.reload();
  await send("Only recent history");
  assert.equal(requests[5].previous_response_id, undefined);
  assert.equal(
    requests[5].input.some((item) => item.type === "image_generation_call"),
    false,
  );
  assert.equal(requests[5].input.length, 2);
  console.log(
    "PASS Firefox: image chaining, IndexedDB reload, expired-anchor recovery, bounded history (6 requests, no live API).",
  );
} finally {
  await browser.close();
}
