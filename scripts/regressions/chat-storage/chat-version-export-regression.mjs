// Offline file round-trip through the actual download/import controls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { firefox, webkit } from "playwright";

const engine = process.env.BROWSER_ENGINE ?? "firefox";
const browser = await { firefox, webkit }[engine].launch();
const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  const errors = [];
  const alerts = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "alert") alerts.push(dialog.message());
    await dialog.accept();
  });
  await page.goto(`${base}/demos/streaming/`);
  await page.waitForSelector(".message");
  const fixture = await page.evaluate(async () => {
    const { branchingTranscriptMarkdown } = await import(
      "/demos/streaming/branching-transcript.ts"
    );
    return branchingTranscriptMarkdown(
      {
        selectedRootId: 1,
        nodes: [
          {
            id: 1,
            parentId: 0,
            selectedChildId: 3,
            message: { role: "user", markdown: "Original question" },
          },
          {
            id: 2,
            parentId: 1,
            selectedChildId: 6,
            message: { role: "assistant", markdown: "Original answer" },
          },
          {
            id: 3,
            parentId: 1,
            selectedChildId: 4,
            message: { role: "assistant", markdown: "Regenerated answer" },
          },
          {
            id: 4,
            parentId: 3,
            selectedChildId: 5,
            message: { role: "user", markdown: "Selected follow up" },
          },
          {
            id: 5,
            parentId: 4,
            selectedChildId: null,
            message: { role: "assistant", markdown: "Selected final answer" },
          },
          {
            id: 6,
            parentId: 2,
            selectedChildId: null,
            message: { role: "user", markdown: "Inactive follow up" },
          },
          {
            id: 10,
            parentId: 0,
            selectedChildId: 11,
            message: { role: "user", markdown: "Edited question" },
          },
          {
            id: 11,
            parentId: 10,
            selectedChildId: null,
            message: { role: "assistant", markdown: "Edited answer" },
          },
        ],
      },
      { dayOf: () => 0, dayLabel: () => "Today" },
    );
  });
  const importFile = (text) =>
    page.locator("#import-file").setInputFiles({
      name: "versions.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(text),
    });
  const row = (text) =>
    page
      .locator(".message")
      .filter({ has: page.getByText(text, { exact: true }) });
  const parse = (text) =>
    page.evaluate(async (file) => {
      const { parseBranchingTranscript } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      return parseBranchingTranscript(file);
    }, text);
  const downloadFile = async () => {
    const ready = page.waitForEvent("download");
    await page.locator("#download-btn").click();
    const download = await ready;
    const path = await download.path();
    assert.ok(path);
    return readFile(path, "utf8");
  };

  await importFile(fixture);
  await page.getByText("Selected final answer", { exact: true }).waitFor();
  assert.equal(
    await row("Regenerated answer").locator(".version-nav-count").textContent(),
    "2 / 2",
  );
  await row("Regenerated answer").locator(".message-content").hover();
  await row("Regenerated answer")
    .getByRole("button", { name: "Previous version" })
    .click();
  await page.getByText("Inactive follow up", { exact: true }).waitFor();
  await row("Original answer").locator(".message-content").hover();
  await row("Original answer")
    .getByRole("button", { name: "Next version" })
    .click();
  await page.getByText("Selected final answer", { exact: true }).waitFor();
  await row("Original question").locator(".message-content").hover();
  await row("Original question")
    .getByRole("button", { name: "Next version" })
    .click();
  await page.getByText("Edited answer", { exact: true }).waitFor();

  const file = await downloadFile();
  const saved = await parse(file);
  assert.equal(saved.tree.nodes.length, 8);
  assert.equal(saved.tree.selectedRootId, 10);
  assert.equal(
    saved.tree.nodes.find((node) => node.id === 1).selectedChildId,
    3,
  );
  assert.deepEqual(
    saved.turns.map((turn) => turn.markdown),
    ["Edited question", "Edited answer"],
  );
  await importFile("**User**\n\nTemporary linear chat");
  await page.getByText("Temporary linear chat", { exact: true }).waitFor();
  await importFile(file);
  await page.getByText("Edited answer", { exact: true }).waitFor();
  assert.deepEqual((await parse(await downloadFile())).tree, saved.tree);
  await row("Edited question").locator(".message-content").hover();
  await row("Edited question")
    .getByRole("button", { name: "Previous version" })
    .click();
  await page.getByText("Selected final answer", { exact: true }).waitFor();
  assert.equal(
    await row("Original question").locator(".version-nav-count").textContent(),
    "1 / 2",
  );

  const beforeFailure = await parse(await downloadFile());
  const corrupt = file.replace('"version":1', '"version":999');
  await importFile(corrupt);
  await page.waitForFunction(
    () => document.getElementById("import-file").value === "",
  );
  assert.match(alerts.at(-1), /unsupported format version/);
  assert.deepEqual(
    (await parse(await downloadFile())).tree,
    beforeFailure.tree,
  );
  const sparse = await page.evaluate(async (text) => {
    const { parseBranchingTranscript, branchingTranscriptMarkdown } =
      await import("/demos/streaming/branching-transcript.ts");
    const tree = parseBranchingTranscript(text).tree;
    tree.nodes.push({
      id: Number.MAX_SAFE_INTEGER,
      parentId: 0,
      selectedChildId: Number.MAX_SAFE_INTEGER - 1,
      message: { role: "user", markdown: "Large imported ID" },
    });
    // Editing an answered prompt creates a new branch. Unanswered prompts
    // intentionally edit in place, which doesn't exercise version allocation.
    tree.nodes.push({
      id: Number.MAX_SAFE_INTEGER - 1,
      parentId: Number.MAX_SAFE_INTEGER,
      selectedChildId: null,
      message: { role: "assistant", markdown: "Answer for large imported ID" },
    });
    tree.selectedRootId = Number.MAX_SAFE_INTEGER;
    return branchingTranscriptMarkdown(tree, {
      dayOf: () => 0,
      dayLabel: () => "Today",
    });
  }, file);
  await importFile(sparse);
  await row("Large imported ID").locator(".message-content").hover();
  await row("Large imported ID").locator(".message-edit-btn").click();
  const editor = page.getByRole("textbox", {
    name: "Edit user message",
    exact: true,
  });
  await editor.fill("New version after import");
  await editor.press("Enter");
  await row("New version after import").waitFor();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Stop",
  );
  await page.locator("#send-btn").click();
  await page.waitForFunction(
    () => document.getElementById("send-btn").textContent === "Send",
  );
  const extended = (await parse(await downloadFile())).tree;
  assert.equal(extended.nodes.length, 12);
  assert.equal(new Set(extended.nodes.map((node) => node.id)).size, 12);
  assert.equal(
    extended.nodes.every((node) => Number.isSafeInteger(node.id)),
    true,
  );
  assert.equal(
    extended.nodes.find((node) => node.id === Number.MAX_SAFE_INTEGER).message
      .markdown,
    "Large imported ID",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      versionExport: "passed",
      versionImport: "passed",
      invalidImport: "passed",
    }),
  );
} finally {
  await browser.close();
}
