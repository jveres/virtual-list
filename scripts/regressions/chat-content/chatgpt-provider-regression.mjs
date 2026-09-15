// Offline subscription-provider regression. No OpenAI credentials or live requests.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
const engines = { chromium, firefox, webkit };
for (const [name, engine] of Object.entries(engines)) {
  if (process.env.BROWSER_ENGINE && process.env.BROWSER_ENGINE !== name)
    continue;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let signedIn = false;
    let pending = false;
    const requests = [];
    const forbidden = [];
    await page.addInitScript(() => {
      if (localStorage.getItem("virtual-list:ai-settings")) return;
      localStorage.setItem(
        "virtual-list:ai-settings",
        JSON.stringify({
          provider: "chatgpt",
          apiKey: "do-not-use",
          model: "api-model",
          chatgptModel: "fixture-model",
          contextTurns: 0,
          tools: {
            webSearch: false,
            imageGeneration: false,
            codeInterpreter: false,
          },
          reasoningSummary: true,
        }),
      );
    });
    await page.route("https://api.openai.com/**", async (route) => {
      forbidden.push(route.request().url());
      await route.abort();
    });
    await page.route("**/__chatgpt/**", async (route) => {
      assert.equal(route.request().headers().authorization, undefined);
      assert.equal(
        route.request().headers()["x-virtual-list-client"],
        "streaming-demo",
      );
      const path = new URL(route.request().url()).pathname;
      let value;
      if (path.endsWith("/login")) {
        pending = true;
        value = {
          authenticated: false,
          login: { userCode: "TEST-CODE", intervalMs: 1000 },
        };
      } else if (path.endsWith("/status")) {
        if (pending) {
          signedIn = true;
          pending = false;
        }
        value = { authenticated: signedIn };
      } else if (path.endsWith("/logout")) {
        signedIn = false;
        value = { authenticated: false };
      } else if (path.endsWith("/models")) {
        value = { models: ["fixture-model"] };
      } else if (path.endsWith("/responses")) {
        assert.equal(signedIn, true);
        const body = route.request().postDataJSON();
        assert.equal(body.store, false);
        assert.equal(body.previous_response_id, undefined);
        assert.equal(body.model, "fixture-model");
        requests.push(body);
        const index = requests.length;
        const output = [
          {
            type: "reasoning",
            id: `rs_${index}`,
            summary: [],
            encrypted_content: `encrypted-${index}`,
          },
          {
            type: "message",
            id: `msg_${index}`,
            role: "assistant",
            phase: "final_answer",
            content: [
              { type: "output_text", text: `Reply ${index}`, annotations: [] },
            ],
          },
        ];
        const events = [
          { type: "response.output_text.delta", delta: `Reply ${index}` },
          {
            type: "response.completed",
            response: { id: `resp_${index}`, model: "fixture-model", output },
          },
        ];
        await route.fulfill({
          contentType: "text/event-stream",
          body: events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        });
        return;
      } else throw new Error(`Unexpected route ${path}`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    });

    await page.goto(`${base}/demos/streaming/index.html`);
    await page.click("#ai-settings-btn");
    assert.equal(
      await page.locator('#ai-provider option[value="openai"]').textContent(),
      "OpenAI API token",
    );
    assert.equal(
      await page.locator('#ai-provider option[value="chatgpt"]').textContent(),
      "OpenAI Subscription",
    );
    await page.waitForFunction(() =>
      document
        .getElementById("ai-chatgpt-status")
        ?.textContent?.includes("Not signed in"),
    );
    await page.click("#ai-chatgpt-login");
    await page.waitForFunction(
      () =>
        document.getElementById("ai-chatgpt-code")?.textContent ===
        "Code: TEST-CODE",
    );
    await page.waitForFunction(() =>
      document
        .getElementById("ai-chatgpt-status")
        ?.textContent?.includes("Connected to OpenAI"),
    );
    await page.keyboard.press("Escape");

    async function settled(count) {
      await page.waitForFunction(
        () => document.getElementById("send-btn")?.textContent === "Send",
      );
      assert.equal(requests.length, count);
      assert.equal(
        await page
          .getByText("ChatGPT request failed", { exact: false })
          .count(),
        0,
      );
      await page
        .locator(".message.assistant")
        .last()
        .getByText(`Reply ${count}`, { exact: true })
        .waitFor();
    }
    async function send(text, count) {
      await page.fill("#prompt", text);
      await page.click("#send-btn");
      await settled(count);
    }
    await send("First prompt", 1);
    assert.deepEqual(requests[0].input, [
      { role: "user", content: "First prompt" },
    ]);
    await page.locator(".message.assistant").last().hover();
    await page.locator(".message-refresh-btn").last().click();
    await settled(2);
    assert.deepEqual(requests[1].input, requests[0].input);

    await page.locator(".message.user > .message-content").first().hover();
    await page.locator(".message-edit-btn").first().click();
    await page
      .getByRole("textbox", { name: "Edit user message" })
      .fill("Edited prompt");
    await page
      .getByRole("textbox", { name: "Edit user message" })
      .press("Enter");
    await settled(3);
    assert.deepEqual(requests[2].input, [
      { role: "user", content: "Edited prompt" },
    ]);
    await send("Follow-up", 4);
    assert.deepEqual(
      requests[3].input.map((item) => item.content ?? item.encrypted_content),
      [
        "Edited prompt",
        "encrypted-3",
        [{ type: "output_text", text: "Reply 3", annotations: [] }],
        "Follow-up",
      ],
    );

    // Delete the unbranched follow-up, then reload. It must not reappear in context.
    await page.locator(".message.user > .message-content").last().hover();
    await page.locator(".message.user .message-delete-btn").last().click();
    await page.click("#delete-message-dialog .delete-message-confirm");
    await page.waitForFunction(
      () => document.querySelectorAll(".message.user").length === 1,
    );
    await page.reload();
    await send("After deletion", 5);
    assert.equal(
      JSON.stringify(requests[4].input).includes("Follow-up"),
      false,
    );
    assert.equal(JSON.stringify(requests[4].input).includes("Reply 4"), false);
    assert.equal(
      JSON.stringify(requests[4].input).includes("encrypted-3"),
      true,
    );

    // API-key history must remain empty, then switching back restores OAuth history.
    await page.click("#ai-settings-btn");
    await page.selectOption("#ai-provider", "openai");
    await page.waitForFunction(
      () => document.querySelectorAll(".message").length === 0,
    );
    await page.selectOption("#ai-provider", "chatgpt");
    await page.waitForFunction(
      () => document.querySelectorAll(".message.user").length === 2,
    );
    await page.click("#ai-clear-history");
    await page.waitForFunction(
      () => document.querySelectorAll(".message").length === 0,
    );
    await page.keyboard.press("Escape");
    await send("Fresh chat", 6);
    assert.deepEqual(requests[5].input, [
      { role: "user", content: "Fresh chat" },
    ]);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${name}: OAuth UI, regenerate, edit, delete, reload, full context, reasoning replay, provider isolation, clear history; no live API.`,
    );
  } finally {
    await browser.close();
  }
}
