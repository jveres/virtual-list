// virtual-list-next: scrollback paging keeps working while a reply streams.
// Every token replaces the streaming message through updateItem; an older
// page staged meanwhile must still land, carrying the latest reply. Before
// the fix, each token cancelled the staged page until the stream ended.
// Run against a next server (vite.next.config.ts) with BROWSER_MATRIX_URL.
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://127.0.0.1:4273";

function datedTranscript(turns) {
  const start = new Date(2026, 8, 2, 9, 0, 0).getTime();
  const lines = [
    "# streaming-chat transcript",
    "",
    "<!-- day -->",
    "## Day",
    "",
  ];
  for (let i = 1; i <= turns; i++) {
    lines.push(
      `**${i % 2 ? "User" : "Assistant"}**`,
      `<!-- turn {"sentAt":${start + i * 120_000}} -->`,
      "",
      `Message ${i} ${"lorem ipsum dolor sit amet ".repeat(8 + (i % 5) * 6)}`,
      "",
    );
  }
  return lines.join("\n");
}

for (const [name, engine] of Object.entries({ firefox, chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
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
      const original = window.fetch;
      window.fetch = (input, init) => {
        if (!String(input).startsWith("https://api.openai.com/"))
          return original(input, init);
        const encode = (event) =>
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                window.sendToken = (delta) =>
                  controller.enqueue(
                    encode({ type: "response.output_text.delta", delta }),
                  );
                window.finishStream = () => {
                  controller.enqueue(
                    encode({
                      type: "response.completed",
                      response: {
                        id: "resp_paging",
                        status: "completed",
                        output: [],
                      },
                    }),
                  );
                  controller.close();
                };
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
    await page.evaluate((markdown) => {
      const wrap = document.querySelector(".viewport-wrap");
      const data = new DataTransfer();
      data.items.add(
        new File([markdown], "chat.md", { type: "text/markdown" }),
      );
      for (const type of ["dragenter", "dragover", "drop"])
        wrap.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: data,
          }),
        );
    }, datedTranscript(200));
    await page.waitForFunction(() =>
      /loaded \d+-200\/200/.test(
        document.getElementById("window-status")?.textContent ?? "",
      ),
    );
    await page.locator("#prompt").fill("Stream while I read history");
    await page.locator("#send-btn").click();
    await page.waitForFunction(() => typeof window.sendToken === "function");
    // A token every 50 ms until the test finishes the stream.
    await page.evaluate(() => {
      let token = 0;
      window.lastToken = 0;
      window.tokenTimer = setInterval(() => {
        token += 1;
        window.lastToken = token;
        window.sendToken(` t${token}`);
      }, 50);
    });
    await page.waitForTimeout(600);
    const first = (status) => Number(/loaded (\d+)-/.exec(status)?.[1]);
    const before = await page.evaluate(
      () => document.getElementById("window-status").textContent,
    );
    // The reader scrolls near the top of the loaded history mid-stream:
    // inside the reach zone, away from the edge (an edge gesture settles
    // only on a real release in Firefox, which synthetic input lacks).
    await page.evaluate(() => {
      const viewport = document.getElementById("viewport");
      viewport.scrollTop = 400;
      viewport.dispatchEvent(new Event("scroll"));
    });
    const landed = await page
      .waitForFunction(
        (start) => {
          const status = document.getElementById("window-status").textContent;
          return Number(/loaded (\d+)-/.exec(status)?.[1]) < start;
        },
        first(before),
        { timeout: 5_000 },
      )
      .then(
        () => true,
        () => false,
      );
    const during = await page.evaluate(() => ({
      status: document.getElementById("window-status").textContent,
      streaming: document.getElementById("send-btn").textContent !== "Send",
      lastToken: window.lastToken,
    }));
    await page.evaluate(() => {
      clearInterval(window.tokenTimer);
      window.finishStream();
    });
    await page.waitForFunction(
      () => document.getElementById("send-btn").textContent === "Send",
    );
    const lastToken = await page.evaluate(() => window.lastToken);
    // The finished reply ends with its last token, loaded or not in view.
    await page.locator("#scroll-bottom-btn").click();
    await page.waitForFunction(
      (token) =>
        [...document.querySelectorAll("#viewport > div > div")].some((row) =>
          row.textContent.includes(`t${token}`),
        ),
      lastToken,
      { timeout: 5_000 },
    );
    assert.ok(
      landed && during.streaming,
      `${name}: an older page lands while the reply streams (${before} → ${JSON.stringify(during)})`,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${name}: an older page landed mid-stream (${/loaded [^ ]+/.exec(before)?.[0]} → ${/loaded [^ ]+/.exec(during.status)?.[0]} at token ${during.lastToken})`,
    );
  } finally {
    await browser.close();
  }
}
