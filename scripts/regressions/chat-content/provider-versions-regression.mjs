// One version/reload contract for every provider. All remote responses are fixtures.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  fulfillOpenAI,
  seedMissingAISettings,
} from "../shared/openai-stream.mjs";
import { openStreamingDemo } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:5173";
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  if (process.env.BROWSER_ENGINE && process.env.BROWSER_ENGINE !== name)
    continue;
  const browser = await engine.launch();
  try {
    for (const provider of ["simulated", "openai", "chatgpt"]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.addInitScript(seedMissingAISettings, {
          provider,
          apiKey: "fixture-key",
          model: "fixture-model",
          chatgptModel: "fixture-model",
          tools: {
            webSearch: false,
            imageGeneration: false,
            codeInterpreter: false,
          },
        });
        let requests = 0;
        async function fixture(route) {
          const path = new URL(route.request().url()).pathname;
          if (!path.endsWith("/responses")) {
            if (path.endsWith("/status"))
              return route.fulfill({ json: { authenticated: true } });
            if (path.endsWith("/models"))
              return route.fulfill({ json: { models: ["fixture-model"] } });
            throw new Error(`Unexpected remote request: ${path}`);
          }
          requests++;
          if (requests === 1)
            return route.fulfill({
              status: 400,
              json: { error: { message: "Fixture first-answer error" } },
            });
          const text = "Fixture successful second answer";
          const events = [
            { type: "response.output_text.delta", delta: text },
            {
              type: "response.completed",
              response: {
                id: "resp_fixture",
                model: "fixture-model",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text, annotations: [] }],
                  },
                ],
              },
            },
          ];
          return fulfillOpenAI(route, events);
        }
        await page.route("https://api.openai.com/**", fixture);
        await page.route("**/__chatgpt/**", fixture);
        const errors = await openStreamingDemo(page, base, {
          path: "/demos/streaming/index.html",
        });
        const answer = () => page.locator(".message.assistant").last();
        async function settled() {
          await page.waitForFunction(
            () => document.getElementById("send-btn")?.textContent === "Send",
            undefined,
            { timeout: 60_000 },
          );
        }
        async function flush() {
          await page.evaluate(async (provider) => {
            const storage = await import("/demos/streaming/openai.ts");
            if (provider === "simulated") await storage.loadSimulatedHistory();
            else await storage.loadOpenAIConversation(provider);
          }, provider);
        }
        await page.fill("#prompt", "fast version persistence check");
        await page.click("#send-btn");
        await settled();
        const first = await answer().locator(".message-content").innerText();
        if (provider !== "simulated")
          assert.match(first, /Fixture first-answer error/);
        await answer().hover();
        await answer().locator(".message-refresh-btn").click();
        await settled();
        assert.equal(
          await answer().locator(".version-nav-count").textContent(),
          "2 / 2",
        );
        const second = await answer().locator(".message-content").innerText();
        await flush();
        await page.reload();
        await answer().locator(".version-nav-count").waitFor();
        assert.equal(
          await answer().locator(".version-nav-count").textContent(),
          "2 / 2",
        );
        assert.equal(
          await answer().locator(".message-content").innerText(),
          second,
        );
        await answer().hover();
        await answer()
          .getByRole("button", { name: "Previous version" })
          .click();
        await page.waitForFunction(
          () =>
            [
              ...document.querySelectorAll(
                ".message.assistant .version-nav-count",
              ),
            ].at(-1)?.textContent === "1 / 2",
        );
        assert.equal(
          await answer().locator(".message-content").innerText(),
          first,
        );
        await flush();
        await page.reload();
        await answer().locator(".version-nav-count").waitFor();
        assert.equal(
          await answer().locator(".version-nav-count").textContent(),
          "1 / 2",
        );
        assert.equal(
          await answer().locator(".message-content").innerText(),
          first,
        );
        assert.equal(requests, provider === "simulated" ? 0 : 2);
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}/${provider}: regenerate, reload both versions, select previous, reload selection`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
