import assert from "node:assert/strict";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
try {
  for (const partial of [false, true]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem(
        "virtual-list:ai-settings",
        JSON.stringify({
          provider: "openai",
          apiKey: "offline-test",
          model: "gpt-5-mini",
        }),
      );
      const original = window.fetch;
      window.fetch = (input, init) => {
        if (!String(input).startsWith("https://api.openai.com/"))
          return original(input, init);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                window.emitText = (delta) =>
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
                    ),
                  );
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
    await page.goto(
      `${process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173"}/demos/streaming/`,
    );
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("booting"),
    );
    await page.locator("#prompt").fill("Persist stopped response");
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => typeof window.emitText === "function");
    if (partial) {
      await page.evaluate(() => window.emitText("Some received text"));
      await page.getByText("Some received text", { exact: true }).waitFor();
    }
    await page.locator("#send-btn").click();
    await page.locator(".message-stopped").waitFor();
    // Wait for durable storage, rather than relying on a sleep before reload.
    await page.waitForFunction(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("virtual-list-demo");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const turns = await new Promise((resolve, reject) => {
          const request = database
            .transaction("openai-history")
            .objectStore("openai-history")
            .get("history");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return turns?.at(-1)?.stopped === true;
      } finally {
        database.close();
      }
    });
    for (let reload = 0; reload < 2; reload++) {
      await page.reload();
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
      const reply = page.locator("#viewport .message.assistant").last();
      await reply.locator(".message-stopped").waitFor();
      assert.equal(
        await reply.locator(".message-stopped").textContent(),
        "...stopped",
      );
      assert.equal(
        await reply.locator(".role-label .dot.cancelled").count(),
        1,
      );
      assert.equal(
        await reply
          .locator(".markdown")
          .innerText()
          .catch(() => ""),
        partial ? "Some received text...stopped" : "...stopped",
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ engine, partial, reloadMarkerAndDot: "passed" }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
