import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.BROWSER_MATRIX_URL ?? "http://localhost:5173";
for (const engine of [firefox, webkit, chromium]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${base}/demos/streaming/`);
    const ready = () =>
      page.waitForFunction(
        () => !document.documentElement.classList.contains("booting"),
      );
    await ready();
    const fixture = await page.evaluate(async () => {
      const { branchingTranscriptMarkdown } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      const text = "A portable attachment.\n".repeat(2048);
      const attachment = {
        name: "notes.txt",
        mimeType: "text/plain",
        size: text.length,
        dataUrl: `data:text/plain;base64,${btoa(text)}`,
      };
      const tree = {
        selectedRootId: 1,
        nodes: [
          {
            id: 1,
            parentId: 0,
            selectedChildId: 2,
            message: {
              role: "user",
              markdown: "Choose a version",
              attachments: [attachment],
            },
          },
          {
            id: 2,
            parentId: 1,
            selectedChildId: 4,
            message: { role: "assistant", markdown: "Original version" },
          },
          {
            id: 3,
            parentId: 1,
            selectedChildId: null,
            message: {
              role: "assistant",
              markdown: "Compact version",
              stopped: true,
            },
          },
          {
            id: 4,
            parentId: 2,
            selectedChildId: 5,
            message: { role: "user", markdown: "Original follow-up" },
          },
          {
            id: 5,
            parentId: 4,
            selectedChildId: null,
            message: { role: "assistant", markdown: "Original final reply" },
          },
        ],
      };
      return {
        tree,
        markdown: branchingTranscriptMarkdown(tree, {
          dayOf: () => 0,
          dayLabel: () => "Today",
        }),
      };
    });
    const importFile = async (markdown) => {
      await page.locator("#import-file").setInputFiles({
        name: "selection-fixture.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      });
      await page.waitForFunction(
        () => document.querySelector("#import-file").value === "",
      );
    };
    const openTree = async () => {
      if (!(await page.locator(".conversation-tree-panel").isVisible())) {
        await page
          .getByRole("button", { name: "Conversation tree", exact: true })
          .click();
      }
    };
    const select = async (id) => {
      await openTree();
      await page
        .locator(`.conversation-tree-node[data-message-id="${id}"]`)
        .click();
      await page.waitForFunction((id) => {
        const node = document.querySelector(
          `.conversation-tree-node[data-message-id="${id}"]`,
        );
        return (
          node?.dataset.active === "true" &&
          !document
            .querySelector(".conversation-tree-panel")
            .hasAttribute("aria-busy")
        );
      }, id);
    };
    const records = () =>
      page.evaluate(async () => {
        const { loadSimulatedHistory } = await import(
          "/demos/streaming/openai.ts"
        );
        await loadSimulatedHistory();
        return await new Promise((resolve, reject) => {
          const request = indexedDB.open("virtual-list-demo");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("openai-history", "readonly");
            const store = tx.objectStore("openai-history");
            const history = store.get("simulated-history");
            const selection = store.get("simulated-selection");
            tx.oncomplete = () => {
              db.close();
              resolve({
                history: history.result,
                selection: selection.result ?? null,
              });
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        });
      });
    await importFile(fixture.markdown);
    await openTree();
    await page
      .locator(".conversation-tree-node")
      .filter({ hasText: "Compact version" })
      .waitFor();
    const original = await records();
    await select(3);
    const switched = await records();
    assert.equal(
      switched.history.markdown,
      original.history.markdown,
      "branch selection leaves transcript bytes unchanged",
    );
    assert.equal(switched.history.revision, original.history.revision);
    assert.equal(switched.selection.revision, original.history.revision);
    assert.ok(
      JSON.stringify(switched.selection).length < 1000,
      "selection record excludes attachment bytes",
    );
    assert.equal(
      switched.selection.selection.nodes.find((node) => node.id === 1)
        .selectedChildId,
      3,
    );

    await page.reload();
    await ready();
    await openTree();
    assert.equal(
      await page
        .locator('.conversation-tree-node[data-message-id="3"]')
        .getAttribute("data-active"),
      "true",
      "reload restores selected version",
    );
    assert.equal(
      await page
        .locator('.conversation-tree-node[data-message-id="2"]')
        .getAttribute("data-active"),
      "false",
    );
    await select(2);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-btn").click();
    const download = await downloadPromise;
    const exported = await readFile(await download.path(), "utf8");
    const restored = await page.evaluate(async (markdown) => {
      const { parseBranchingTranscript } = await import(
        "/demos/streaming/branching-transcript.ts"
      );
      return parseBranchingTranscript(markdown);
    }, exported);
    assert.deepEqual(
      restored.tree,
      fixture.tree,
      "export retains every version, attachment, stopped status, and folded choice",
    );

    await select(3);
    const oldSelection = (await records()).selection;
    await page.keyboard.press("Escape");
    await importFile(fixture.markdown);
    await openTree();
    await page.waitForFunction(
      () =>
        document.querySelector('.conversation-tree-node[data-message-id="2"]')
          ?.dataset.active === "true",
    );
    const replacement = await records();
    assert.notEqual(replacement.history.revision, oldSelection.revision);
    assert.equal(
      replacement.selection,
      null,
      "replacement atomically clears the previous selection",
    );
    // A late write from another tab must not apply choices from an old snapshot.
    await page.evaluate(async (selection) => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("virtual-list-demo");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("openai-history", "readwrite");
          tx.objectStore("openai-history").put(
            selection,
            "simulated-selection",
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    }, oldSelection);
    await page.reload();
    await ready();
    await openTree();
    assert.equal(
      await page
        .locator('.conversation-tree-node[data-message-id="2"]')
        .getAttribute("data-active"),
      "true",
      "stale selection cannot override a replacement transcript",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: compact selection persistence, reload, export, and stale-record isolation passed`,
    );
  } finally {
    await browser.close();
  }
}
