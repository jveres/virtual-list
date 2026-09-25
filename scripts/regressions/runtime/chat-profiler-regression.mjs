// Correctness of the common recorder and local stream, not native performance.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { webkit } from "playwright";
import { discardRaw } from "../../firefox-profile/artifacts.mjs";
import { analyzeChat } from "../../firefox-profile/chat-analysis.mjs";
import { capturePlaywright } from "../../firefox-profile/chat-browsers.mjs";
import { createChatProfileServer } from "../../firefox-profile/chat-server.mjs";

await mkdir("browser-artifacts/chat-profile", { recursive: true });
for (const browser of ["engine-firefox", "engine-chromium", "engine-webkit"]) {
  const options = {
    browser,
    diagnostic: true,
    scheduler: true,
    scenario: "follow",
    trail: "long",
    sections: 6,
    history: 20,
    durationMs: 2000,
    seconds: 6,
  };
  const directory = await mkdtemp("browser-artifacts/chat-profile/regression-");
  const server = await createChatProfileServer(options);
  try {
    const result = await capturePlaywright(
      server,
      directory,
      options,
      new AbortController().signal,
    );
    const summary = analyzeChat(result.recording, result);
    await writeFile(
      `${directory}/summary.json`,
      JSON.stringify(summary, null, 2),
    );
    assert.deepEqual(summary.invalidReasons, [], browser);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].finished, true);
    assert.deepEqual(
      result.recording.phases.map((phase) => phase.name),
      ["send-glide", "send-landed"],
    );
    assert.ok(
      summary.work.expensive.some(
        (item) =>
          item.name.endsWith("message-content.ts:update") && item.count > 1,
      ),
    );
    assert.ok(summary.work.geometryAccess.length > 0);
    assert.ok(summary.scheduling.timerLatenessMs.count > 30);
    assert.ok(summary.scheduling.postRafTaskMs.count > 30);
    assert.ok(summary.scheduling.rafCallbacks.length > 0);
    assert.ok(summary.frames.callbackGapMs.count > 30);
    assert.ok(
      summary.scheduling.trailChanges.some(
        (change) => change.layersRemoved > 0,
      ),
    );
    assert.ok(
      result.recording.spans.every(
        (span) => span[2] >= 0 && span[2] <= span[1],
      ),
    );
    console.log(
      `${browser}: complete local stream, bounded attribution, and movement verified`,
    );
  } finally {
    try {
      await server.close();
    } finally {
      await discardRaw(directory);
    }
  }
}

// Exercise the Inspector-closed keyboard/export path used by manual Safari.
// Synthetic keyboard input proves the control flow, not native gesture timing.
const manualServer = await createChatProfileServer({
  diagnostic: true,
  scenario: "follow",
  sections: 2,
  history: 10,
  durationMs: 1000,
});
let manualBrowser;
try {
  manualBrowser = await webkit.launch();
  const page = await manualBrowser.newPage();
  await page.goto(manualServer.url);
  await page.waitForFunction(() => globalThis.__chatProfile?.ready());
  await page.keyboard.press("Alt+Shift+KeyP");
  await page.waitForTimeout(3000);
  const download = page.waitForEvent("download");
  await page.keyboard.press("Alt+Shift+KeyS");
  const exported = await download;
  const data = JSON.parse(await readFile(await exported.path(), "utf8"));
  assert.equal(data.stream.done, true);
  assert.equal(data.stream.characters, manualServer.workload.characters);
  assert.ok(data.frames.length > 30);
  assert.ok(data.operations.length > 0);
  await page.reload();
  await page.waitForFunction(() => globalThis.__chatProfile?.ready());
  const historyCount = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("virtual-list-demo", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction("openai-history")
            .objectStore("openai-history")
            .get("history");
          read.onsuccess = () => {
            db.close();
            resolve(read.result.length);
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
  );
  assert.equal(historyCount, 10, "Reload restores the same input history");
  console.log(
    "WebKit: keyboard capture, JSON download, and repeatable reload verified",
  );
} finally {
  try {
    await manualBrowser?.close();
  } finally {
    await manualServer.close();
  }
}
