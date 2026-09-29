import assert from "node:assert/strict";
import { parseSync } from "vite";

// Parse function boundaries; never edit production files or silently skip a target.
export const chatTargets = {
  "src/virtual-list.ts": [
    "commit",
    "liveCommit",
    "viewportState",
    "repositionMounted",
    "followIfBehindEnd",
    "reconcileWindow",
    "mountWindow",
    "publish",
    "onScrolled",
    "readHeights",
    "measureRows",
    "renderInto",
    "mountRow",
    "unmountRow",
    "destroyRow",
    "flowInsert",
    "layoutFlow",
    "observeRow",
    "syncCanvasHeight",
    "commitHeight",
    "updateItem",
    "stageFrame",
    "writeScrollTop",
  ],
  "src/scroll-settle.ts": [
    "handleScroll",
    "handleScrollEnd",
    "handleWheel",
    "finishScrollPhase",
  ],
  "src/geometry.ts": ["capture", "resolve", "setKeys", "measure", "window"],
  "src/paging.ts": ["replaced", "reconcile"],
  "src/companions/sticky-headers.ts": ["refresh", "updatePosition", "fillSlot"],
  "demos/streaming/streaming.ts": [
    "updateMessage",
    "buildRow",
    "updateRow",
    "syncMetrics",
    "syncScrollButtons",
    "rowsForRuntime",
    "syncMessageActionState",
    "handleRowDestroy",
    "persistOpenAIConversation",
    "persistSimulatedConversation",
  ],
  "demos/streaming/message-content.ts": [
    "update",
    "appendStaticMessageContent",
    "setMounted",
  ],
  "demos/streaming/image-lifecycle.ts": ["suspendRowImages", "resumeRowImages"],
  "demos/streaming/display-copies.ts": ["adoptDisplayCopies"],
  "integrations/measured-text.ts": [
    "mountMeasuredText",
    "unmountMeasuredText",
    "prepareMeasuredText",
    "run",
  ],
  "demos/streaming/image-preview.ts": ["bind", "collect"],
  "demos/shared/markdown.ts": ["renderMarkdown"],
  "demos/shared/chat-ui.ts": ["buildToolCall"],
  "demos/streaming/openai.ts": ["chunksFromEvent", "saveOpenAIHistory"],
};

export function instrumentChat(source, path, diagnostic) {
  if (!(path in chatTargets)) return source;
  const targets = diagnostic ? (chatTargets[path] ?? []) : [];
  const parsed = parseSync(path, source);
  assert.equal(
    parsed.errors.length,
    0,
    `Cannot parse profiling target: ${path}`,
  );
  const edits = [];
  const counts = new Map(targets.map((name) => [name, 0]));
  let liveViewportReads = 0;
  const insert = (at, text) => edits.push({ at, text });
  const visit = (node, parent, owner = "") => {
    if (!node || typeof node !== "object") return;
    const callable = [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type);
    const name = node.id?.name ?? parent?.key?.name ?? parent?.id?.name ?? "";
    if (callable && name) owner = name;
    if (
      diagnostic &&
      path === "src/virtual-list.ts" &&
      owner === "liveCommit" &&
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "viewportState"
    ) {
      // Separate the flush after host rendering from the read after the
      // runtime writes slot geometry. Function totals hide that distinction.
      const label = `${path}:liveCommit.viewportRead[${liveViewportReads++}]`;
      insert(
        node.start,
        `(() => { const __chatRead = globalThis.__chatProfile?.enter(${JSON.stringify(label)}); try { return `,
      );
      insert(
        node.end,
        "; } finally { globalThis.__chatProfile?.leave(__chatRead); } })()",
      );
    }
    if (
      callable &&
      node.body &&
      node.body.type === "BlockStatement" &&
      targets.includes(name)
    ) {
      assert.ok(
        !node.async && !node.generator,
        `Async target needs separate timing: ${path}:${name}`,
      );
      counts.set(name, counts.get(name) + 1);
      const label = `${path}:${name}`;
      const params = node.params.map((p) => p.name ?? p.left?.name);
      const entity = params.includes("row")
        ? "row"
        : params.includes("message")
          ? "message"
          : "null";
      // Exact text equality is only a candidate: tool, cursor, or mount state may differ.
      const input =
        path.endsWith("message-content.ts") && name === "update"
          ? "text"
          : "undefined";
      const identity = input === "text" ? "host" : entity;
      insert(
        node.body.start + 1,
        `\nconst __chatSpan = globalThis.__chatProfile?.enter(${JSON.stringify(label)}, ${identity}, ${input});\ntry {\n`,
      );
      if (path === "src/virtual-list.ts" && name === "publish")
        insert(
          node.body.start + 1,
          "\nglobalThis.__chatProfile?.coverage(vp, geometry.contentSize, Array.from(mountedRows, row => [geometry.offsetOf(row.key), row.height, row.slot.isConnected]));\n",
        );
      insert(
        node.body.end - 1,
        "\n} finally { globalThis.__chatProfile?.leave(__chatSpan); }\n",
      );
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, node, owner);
      } else if (value?.type) visit(value, node, owner);
    }
  };
  visit(parsed.program);
  for (const [name, count] of counts)
    assert.equal(count, 1, `Profiling target changed: ${path}:${name}`);
  if (diagnostic && path === "src/virtual-list.ts")
    assert.equal(liveViewportReads, 2, "Profiling live-commit reads changed");
  for (const edit of edits.sort((a, b) => b.at - a.at))
    source = source.slice(0, edit.at) + edit.text + source.slice(edit.at);
  const replace = (needle, replacement) => {
    assert.equal(
      source.split(needle).length,
      2,
      `Profiling hook changed: ${path}: ${needle}`,
    );
    source = source.replace(needle, replacement);
  };
  if (path === "demos/streaming/openai.ts") {
    replace(
      'const RESPONSES_URL = "https://api.openai.com/v1/responses";',
      'const RESPONSES_URL = "/__chat-profile/responses";',
    );
    replace(
      'if (!isRecord(parsed) || typeof parsed.type !== "string") return [];',
      'if (!isRecord(parsed) || typeof parsed.type !== "string") return [];\n  globalThis.__chatProfile?.delivery(parsed.type, typeof parsed.delta === "string" ? parsed.delta.length : 0);',
    );
  }
  if (path === "demos/streaming/streaming.ts") {
    source = `await globalThis.__chatProfile.seedHistory;\n${source}`;
    replace(
      "const pinCommand = regenerating",
      'globalThis.__chatProfile?.phase("send-glide");\n    const pinCommand = regenerating',
    );
    replace(
      "pinCommand.then(() => {",
      'pinCommand.then((completed) => {\n        globalThis.__chatProfile?.phase(completed ? "send-landed" : "send-cancelled");',
    );
    replace(
      "syncScrollButtons(state);",
      "globalThis.__chatProfile?.state(state, snapshot, { latestLoaded: loadedEnd >= transcript.length, pending: windowNavigation !== null, loadedStart, loadedEnd, loading: loadingTop || loadingBottom });\n      syncScrollButtons(state);",
    );
  }
  return source;
}
