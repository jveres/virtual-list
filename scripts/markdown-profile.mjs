// Profile generated chat history using the demo's static markdown renderer.
// Start Vite on port 4175, then: node scripts/markdown-profile.mjs
// Chromium heap snapshots and all results go to ignored browser-artifacts/.
import "./firefox-app-data.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium, firefox, webkit } from "playwright";

const baseUrl = "http://127.0.0.1:4175";
const outputDir = "browser-artifacts";
await mkdir(outputDir, { recursive: true });
const results = [];
const heaps = [];

async function heapSnapshot(session, name) {
  await session.send("HeapProfiler.collectGarbage");
  const usage = await session.send("Runtime.getHeapUsage");
  const dom = await session.send("Memory.getDOMCounters");
  const chunks = [];
  const receive = ({ chunk }) => chunks.push(chunk);
  session.on("HeapProfiler.addHeapSnapshotChunk", receive);
  try {
    await session.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
    });
  } finally {
    session.off("HeapProfiler.addHeapSnapshotChunk", receive);
  }
  const path = `${outputDir}/markdown-${name}.heapsnapshot`;
  await writeFile(path, chunks.join(""));
  const result = { name, ...usage, ...dom, path };
  heaps.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/__markdown_profile__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Markdown profile</title></head><body></body></html>",
      }),
    );
    await page.goto(`${baseUrl}/__markdown_profile__`);
    await page.evaluate(async () => {
      const { initMarkdown, renderMarkdown } = await import(
        "/demos/shared/markdown.ts"
      );
      const { buildChatItem } = await import("/demos/shared/chat-ui.ts");
      const { createVirtualList } = await import("/src/virtual-list.ts");
      await import("/demos/shared/styles.css");
      await initMarkdown();
      renderMarkdown("Warm **markdown** parser.");
      await document.fonts.ready;
      window.profileHistory = (count) => {
        const viewport = document.createElement("div");
        viewport.style.cssText =
          "width:600px;height:600px;overflow:auto;overflow-anchor:none";
        document.body.appendChild(viewport);
        let renderHtmlMs = 0;
        let createDomMs = 0;
        let built = 0;
        let destroyed = 0;
        const items = Array.from({ length: count }, (_, id) => ({
          id,
          role: "assistant",
          markdown: `## Response ${id}\n\nA **virtual list** preserves the reading position while new content arrives. This generated history exercises paragraphs, links, lists, tables, and highlighted code.\n\n- Keep stable keys.\n- Batch reads before writes.\n- Preserve content state.\n\n\`\`\`typescript\nconst message = { id: ${id}, text: "ready" };\nlist.updateItem(String(message.id), message);\n\`\`\`\n\n| Stage | Result |\n| --- | --- |\n| Prepare | Exact heights |\n| Commit | Stable anchor |\n\nSee [the example](https://example.com/) for context.`,
        }));
        const started = performance.now();
        const list = createVirtualList(viewport, {
          items,
          key: (item) => String(item.id),
          boot: "start",
          render: (item) => {
            let start = performance.now();
            const html = renderMarkdown(item.markdown);
            renderHtmlMs += performance.now() - start;
            start = performance.now();
            const element = buildChatItem(item, html);
            element.dataset.profileRow = "";
            createDomMs += performance.now() - start;
            built++;
            return element;
          },
          onDestroy: () => {
            destroyed++;
          },
        });
        const bootMs = performance.now() - started;
        window.disposeProfileHistory = () => {
          list.dispose();
          viewport.remove();
          if (built !== destroyed) throw new Error("Row destruction imbalance");
        };
        return {
          count,
          bootMs,
          renderHtmlMs,
          createDomMs,
          otherBootMs: bootMs - renderHtmlMs - createDomMs,
          retainedRows: built - destroyed,
          mountedRows: viewport.querySelectorAll("[data-profile-row]").length,
        };
      };
    });
    const session =
      engine === "chromium" ? await page.context().newCDPSession(page) : null;
    if (session) await heapSnapshot(session, "baseline");
    for (const count of [100, 1_000]) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const sample = await page.evaluate(
          (size) => window.profileHistory(size),
          count,
        );
        const result = {
          engine,
          browserVersion: browser.version(),
          repeat,
          ...sample,
        };
        results.push(result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (session && count === 1_000 && repeat === 2)
          await heapSnapshot(session, "retained-1000");
        await page.evaluate(() => {
          window.disposeProfileHistory();
          delete window.disposeProfileHistory;
        });
        if (session && count === 1_000 && repeat === 2)
          await heapSnapshot(session, "disposed");
      }
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${outputDir}/markdown-profile.json`,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), results, heaps },
    null,
    2,
  ),
);
