// Offline Responses fixtures exercise real downloads, migration, and reloads.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import {
  fulfillOpenAI,
  OFFLINE_AI_SETTINGS,
  seedAISettings,
} from "../shared/openai-stream.mjs";
import { openStreamingDemo } from "../shared/transcript.mjs";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
const artifact = {
  type: "container_file_citation",
  container_id: "cntr_test",
  file_id: "cfile_report",
  filename: "report.csv",
  start_index: 0,
  end_index: 0,
};
const hostileName = "<img src=x onerror=alert(1)>.txt";
const part = {
  type: "output_text",
  text: "Your generated files are ready. [Get report](sandbox:/mnt/data/report.csv). [Encoded report](sandbox:/mnt/data/%72eport.csv). [Missing file](sandbox:/mnt/data/missing.docx). [Website](https://example.com).",
  annotations: [
    artifact,
    { ...artifact, file_id: "cfile_text", filename: hostileName },
  ],
};
const item = { type: "message", role: "assistant", content: [part] };
const complete = {
  type: "response.completed",
  response: { id: "resp_artifacts", output: [item] },
};
const browser = await { firefox, chromium, webkit }[engine].launch({
  headless: process.env.BROWSER_MATRIX_HEADED !== "1",
});
try {
  for (const mode of [
    "streaming",
    "completed-only",
    "interrupted",
    "old-history",
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 900 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    const requests = [];
    let expired = false;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", async (dialog) => {
      errors.push(`Unexpected dialog: ${dialog.message()}`);
      await dialog.dismiss();
    });
    await page.addInitScript(seedAISettings, OFFLINE_AI_SETTINGS);
    await page.addInitScript(
      ({ mode, part, item }) => {
        if (
          mode === "old-history" &&
          !localStorage.getItem("artifact-fixture-seeded")
        ) {
          localStorage.setItem("artifact-fixture-seeded", "1");
          localStorage.setItem(
            "virtual-list:openai-history",
            JSON.stringify([
              { role: "user", markdown: "Generate a report" },
              {
                role: "assistant",
                markdown: part.text,
                responseState: {
                  id: "resp_old",
                  model: "gpt-5-mini",
                  contextStart: 0,
                  contextTurns: 0,
                  output: [item],
                },
              },
            ]),
          );
        }
      },
      { mode, part, item },
    );
    await page.route("https://api.openai.com/**", async (route) => {
      const request = route.request();
      requests.push(request.url());
      assert.equal(request.headers().authorization, "Bearer offline-test");
      if (request.url().endsWith("/responses")) {
        const events = [
          { type: "response.output_text.delta", delta: part.text },
          ...(mode === "streaming" || mode === "interrupted"
            ? [
                ...part.annotations.map((annotation) => ({
                  type: "response.output_text.annotation.added",
                  annotation,
                })),
                { type: "response.content_part.done", part },
                { type: "response.output_item.done", item },
              ]
            : []),
          ...(mode === "interrupted" ? [] : [complete]),
        ];
        await fulfillOpenAI(route, events);
      } else if (
        request
          .url()
          .endsWith("/containers/cntr_test/files/cfile_report/content")
      ) {
        await route.fulfill({
          status: expired ? 404 : 200,
          contentType: "text/csv",
          body: expired ? "" : "a,b\n1,2\n",
        });
      } else {
        errors.push(`Unexpected API request: ${request.url()}`);
        await route.abort();
      }
    });
    await openStreamingDemo(page, base);
    if (mode !== "old-history") {
      assert.equal(await page.locator(".message").count(), 0);
      await page.locator("#prompt").fill("Generate a report");
      await page.locator("#send-btn").click();
      await page.waitForFunction(
        () => document.getElementById("send-btn").textContent === "Send",
      );
    }
    const report = page.getByRole("button", {
      name: "Download report.csv",
      exact: true,
    });
    await report.waitFor();
    assert.equal(
      await page.locator(".generated-file-download").count(),
      2,
      "duplicate event paths must not duplicate controls",
    );
    assert.equal(
      await page
        .getByRole("button", { name: `Download ${hostileName}`, exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page.locator(".message-generated-files img").count(),
      0,
      "filenames must be text, not HTML",
    );
    assert.equal(
      requests.filter((url) => url.endsWith("/content")).length,
      0,
      "files download only on user request",
    );
    for (const stage of ["initial", "reloaded"]) {
      if (stage === "reloaded") {
        // Wait for the history transaction, not a guessed storage delay.
        await page.waitForFunction(async () => {
          const { loadOpenAIHistory } = await import(
            "/demos/streaming/openai.ts"
          );
          const turns = await loadOpenAIHistory("openai");
          return turns.some(
            (turn) => turn.generatedFiles?.length || turn.responseState,
          );
        });
        await page.reload();
        await report.waitFor();
        assert.equal(await page.locator(".generated-file-download").count(), 2);
      }
      const downloadPromise = page.waitForEvent("download");
      await report.click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "report.csv");
      assert.equal(await download.failure(), null);
      assert.equal(await readFile(await download.path(), "utf8"), "a,b\n1,2\n");
      await page.waitForFunction(
        () => !document.querySelector(".generated-file-download").disabled,
      );
      for (const name of ["Get report", "Encoded report"]) {
        const inlineDownloadPromise = page.waitForEvent("download");
        const link = page.getByRole("link", { name, exact: true });
        if (name === "Encoded report") await link.press("Enter");
        else await link.click();
        const inlineDownload = await inlineDownloadPromise;
        assert.equal(inlineDownload.suggestedFilename(), "report.csv");
        assert.equal(
          await readFile(await inlineDownload.path(), "utf8"),
          "a,b\n1,2\n",
        );
        assert.equal(
          page.context().pages().length,
          1,
          "sandbox links must not open a tab",
        );
        await page.waitForFunction(
          () => !document.querySelector(".generated-file-download").disabled,
        );
      }
      const beforeMissing = requests.length;
      await page
        .getByRole("link", { name: "Missing file", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "No generated file matches" })
        .waitFor();
      assert.equal(
        requests.length,
        beforeMissing,
        "unmatched links must not request a file",
      );
      assert.equal(
        await page
          .getByRole("link", { name: "Website", exact: true })
          .getAttribute("href"),
        "https://example.com",
      );
    }
    expired = true;
    await report.click();
    await page
      .getByRole("status")
      .filter({ hasText: "no longer available" })
      .waitFor();
    assert.equal(await report.isEnabled(), true, "failure must allow retry");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, mode, generatedFiles: "passed" }));
    await page.close();
  }
} finally {
  await browser.close();
}
