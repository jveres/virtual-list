// Verify tracked profiling inputs through Vite, without collecting performance data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { firefox } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const browser = await firefox.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${base}/scripts/firefox-profile/fixtures/declared-rows.html`,
  );
  await page.waitForFunction(
    () => document.querySelector("#viewport").scrollTop === 320000,
  );
  const control = await page.evaluate(() => ({
    height: document.querySelector("#viewport").scrollHeight,
    status: document.querySelector("#status").textContent,
  }));
  assert.equal(control.height, 640000);
  assert.match(control.status, /^10000 items;/);

  await page.goto(`${base}/demos/streaming/`);
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  page.on("dialog", (dialog) => dialog.accept());
  const rich = await readFile(
    new URL("../../firefox-profile/fixtures/rich-chat.js", import.meta.url),
    "utf8",
  );
  const setup = await page.evaluate(rich);
  assert.match(setup.workload, /160 synthetic turns/);
  await page.waitForFunction(() =>
    document.querySelector("#window-status").textContent.includes("/160"),
  );
  await page.waitForFunction(
    () => document.querySelector("#viewport img")?.complete === true,
  );
  assert.ok((await page.locator("#viewport table").count()) > 0);

  // Fresh context: no dependence on the imported transcript or persistent history.
  const streamPage = await browser.newPage();
  streamPage.on("pageerror", (error) => errors.push(error.message));
  await streamPage.goto(`${base}/demos/streaming/?fast-long`);
  await streamPage.waitForFunction(
    () => !document.documentElement.classList.contains("booting"),
  );
  const streaming = await readFile(
    new URL(
      "../../firefox-profile/fixtures/streaming-chat.js",
      import.meta.url,
    ),
    "utf8",
  );
  await streamPage.evaluate(streaming);
  await streamPage.waitForFunction(() =>
    document.querySelector("#send-btn").textContent.includes("Stop"),
  );
  await streamPage.close();
  await page.goto(
    `${base}/scripts/firefox-profile/fixtures/complex-stream.html?trail=long`,
  );
  await page.waitForFunction(() => !!window.complexStream);
  const complex = await page.evaluate(() => window.complexStream.start());
  assert.equal(complex.sections, 70);
  assert.ok(complex.characters > 65000);
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[data-trail-blend] [data-trail-group] > div")
        .length > 0,
  );
  await page.waitForFunction(() => window.complexStream.snapshot().done, null, {
    timeout: 30000,
  });
  await page.waitForFunction(
    () => !document.querySelector("[data-streaming-trail]"),
  );
  const completed = await page.evaluate(() => ({
    ...window.complexStream.snapshot(),
    tables: document.querySelectorAll("#viewport table").length,
    code: document.querySelectorAll("#viewport pre").length,
    headings: document.querySelectorAll("#viewport h2").length,
  }));
  assert.equal(completed.delivered, complex.characters);
  assert.equal(completed.following, true);
  assert.equal(completed.tables, 70);
  assert.equal(completed.code, 70);
  assert.equal(completed.headings, 70);
  assert.deepEqual(errors, []);
  console.log("Tracked Firefox profiling fixtures passed");
} finally {
  await browser.close();
}
