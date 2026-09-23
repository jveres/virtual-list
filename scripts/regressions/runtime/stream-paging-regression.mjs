// Scrollback paging keeps working while a reply streams.
// Every token replaces the streaming message through updateItem; an older
// page staged meanwhile must still land, carrying the latest reply. Before
// the fix, each token cancelled the staged page until the stream ended.
//
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import {
  OFFLINE_AI_SETTINGS,
  openAIStreamMock,
} from "../shared/openai-stream.mjs";
import { openTranscript } from "../shared/transcript.mjs";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";

for (const [name, engine] of Object.entries({ firefox, chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 820 },
    });
    await page.addInitScript(openAIStreamMock, {
      settings: OFFLINE_AI_SETTINGS,
      emitText: "sendToken",
      finish: "finishStream",
      responseId: "resp_paging",
    });
    const errors = await openTranscript(page, base, 200, /loaded \d+-200\/200/);
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
