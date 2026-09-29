import { createHash } from "node:crypto";
import { imageFixture, imageFixtureSize } from "./image-fixture.mjs";

function thinkingSummary(turn, pass) {
  return Array.from({ length: 5 }, (_, step) => {
    const stage = `${turn}.${pass}.${step}`;
    return (
      `### Review stage ${stage}\n\n` +
      `The request for stage ${turn} needs a stable reading position while older results are loaded. ` +
      "I will compare the supplied measurements with the visible message sequence, separate rendering work from scroll input, and check whether the proposed change preserves the selected branch. " +
      "The available evidence describes a local synthetic conversation; it does not establish physical presentation timing or the behavior of an unrelated browser.\n\n" +
      "The next check should keep the window size and text unchanged so that differences in row wrapping do not obscure the result. " +
      "A completed request must retain the same content and tool order when its row is removed and later rebuilt.\n\n" +
      "- Confirm that the earlier answer remains reachable.\n" +
      "- Keep the disclosure state independent of reply completion.\n" +
      "- Record the result before considering another change.\n\n" +
      `\`\`\`typescript\nconst review = { turn: ${turn}, pass: ${pass}, step: ${step} };\nconst ready = review.step >= 0;\n\`\`\`\n`
    );
  }).join("\n");
}

function historyTools(turn, markdown) {
  const table = markdown.indexOf("\n\n| Stage");
  const code = markdown.indexOf("\n\n```typescript");
  return [
    {
      name: "thinking",
      status: "done",
      durationMs: 832,
      input: "(reasoning summary)",
      output: thinkingSummary(turn, 1),
      markdownOffset: 0,
      open: false,
    },
    {
      name: "local_search",
      status: "done",
      durationMs: 246,
      input: JSON.stringify({
        query: `stage ${turn} rendering and paging`,
        limit: 6,
      }),
      output: JSON.stringify(
        {
          results: Array.from({ length: 6 }, (_, index) => ({
            id: `stage-${turn}-result-${index}`,
            title: `Rendering observation ${turn}.${index}`,
            excerpt:
              "Keep the current message visible when a page commits. Inspect whether its measured height changes, whether an earlier row is rebuilt, and whether a finished tool preserves its disclosure state.",
          })),
        },
        null,
        2,
      ),
      markdownOffset: table,
      open: false,
    },
    {
      name: "thinking",
      status: "done",
      durationMs: 1134,
      input: "(reasoning summary after local search)",
      output: thinkingSummary(turn, 2),
      markdownOffset: code,
      open: false,
    },
  ];
}

// Local, deterministic Responses SSE input for the actual streaming demo.
export function chatWorkload({
  sections = 48,
  history = 160,
  historyContent = "rich",
  durationMs = 30000,
  content = "rich",
} = {}) {
  if (!["rich", "prose"].includes(content)) throw new Error("Invalid content");
  if (!["rich", "tools", "images"].includes(historyContent))
    throw new Error("Invalid historyContent");
  for (const [name, value, min, max] of [
    ["sections", sections, 1, 200],
    ["history", history, 2, 1000],
    ["durationMs", durationMs, 1000, 120000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  }
  // The probe also seeds the legacy localStorage record. Keep tool-heavy
  // history comfortably within that store's quota, including UTF-16 encoding.
  if (historyContent === "tools" && history > 320)
    throw new Error("Tool history supports at most 320 turns");
  if (historyContent === "images" && history !== 20)
    throw new Error("Image history requires exactly 20 turns");
  const section = (i) =>
    `\n\n## Streaming section ${i}\n\n` +
    "Inspect **stable geometry**, _incremental rendering_, and `scrollTop`. ".repeat(
      8,
    ) +
    "\n\n| Stage | Value | State |\n| --- | ---: | --- |\n| Decode | 12 | Ready |\n| Render | 24 | Active |\n" +
    `\n\n\`\`\`typescript\ninterface Row { id: string; height: number; }\nconst stage = ${i};\n\`\`\`\n` +
    "\n$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$\n" +
    "\n- Keep the reading anchor stable.\n- Measure the actual work.\n\n> Synthetic input, served locally.\n" +
    (i % 8 === 0 ? "\n![Synthetic chart](/__chat-profile/image.svg)\n" : "");
  const text =
    content === "prose"
      ? "Describe the measurements in plain language and keep the reading position stable as the response grows. ".repeat(
          sections * 9,
        )
      : Array.from({ length: sections }, (_, i) => section(i)).join("");
  const turns = Array.from({ length: history }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    markdown:
      i % 2
        ? section(i)
        : `Inspect stage ${i}. ${"Keep the reading position stable. ".repeat(8)}`,
    sentAt: Date.UTC(2026, 0, 1) + Math.floor(i / 20) * 86400000,
  }));
  if (historyContent === "tools") {
    for (const [index, turn] of turns.entries())
      if (turn.role === "assistant")
        turn.toolCalls = historyTools(index, turn.markdown);
  }
  let imageMetadata;
  if (historyContent === "images") {
    let assetBytes = 0;
    let sourceBytes = 0;
    let count = 0;
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const png = imageFixture(++count);
      const source = `data:image/png;base64,${png.toString("base64")}`;
      assetBytes += png.length;
      sourceBytes += source.length;
      turn.markdown += `\n\n<img src="${source}" width="${imageFixtureSize.width}" height="${imageFixtureSize.height}" alt="Synthetic raster ${count}">\n`;
    }
    const serialized = JSON.stringify(turns);
    imageMetadata = {
      historyImages: count,
      historyImageGenerator: {
        node: process.version,
        zlib: process.versions.zlib,
      },
      historyImageSize: imageFixtureSize,
      historyImageAssetBytes: assetBytes,
      historyImageSourceBytes: sourceBytes,
      historyJsonBytes: Buffer.byteLength(serialized),
      historyStorageBytes: serialized.length * 2,
    };
    if (
      imageMetadata.historyJsonBytes > 2 * 1024 ** 2 ||
      imageMetadata.historyStorageBytes >= 5 * 1024 ** 2
    )
      throw new Error("Image history exceeded its fixture storage budget");
  }
  const calls = turns.flatMap((turn) => turn.toolCalls ?? []);
  const events = [];
  const push = (at, event) => events.push({ at, event });
  const chunkSize = 96;
  const chunks = Math.ceil(text.length / chunkSize);
  push(0, {
    type: "response.output_item.added",
    item: { id: "reasoning-1", type: "reasoning" },
  });
  push(100, {
    type: "response.output_item.done",
    item: {
      id: "reasoning-1",
      type: "reasoning",
      summary: [{ text: "Checking the synthetic stages and their geometry." }],
    },
  });
  for (let i = 0; i < chunks; i++) {
    // Fixed deadlines, with short groups of overdue chunks after periodic stalls.
    const nominal = 200 + (i / chunks) * (durationMs - 400);
    const at =
      Math.floor(nominal / 4000) * 4000 + Math.max(150, nominal % 4000);
    push(at, {
      type: "response.output_text.delta",
      delta: text.slice(i * chunkSize, (i + 1) * chunkSize),
    });
    if (i === Math.floor(chunks / 3)) {
      push(at, {
        type: "response.output_item.added",
        item: { id: "search-1", type: "web_search_call" },
      });
      push(at + 250, {
        type: "response.output_item.done",
        item: {
          id: "search-1",
          type: "web_search_call",
          action: { type: "search", query: "synthetic geometry" },
          status: "completed",
        },
      });
    }
  }
  push(durationMs, {
    type: "response.completed",
    response: { id: "profile-response", status: "completed", output: [] },
  });
  events.sort((a, b) => a.at - b.at);
  const hash = createHash("sha256")
    .update(JSON.stringify({ turns, events }))
    .digest("hex");
  return {
    turns,
    events,
    metadata: {
      hash,
      content,
      sections,
      history,
      historyContent,
      ...imageMetadata,
      historyToolCalls: calls.length,
      historyPayloadCharacters: calls.reduce(
        (total, call) => total + call.input.length + call.output.length,
        0,
      ),
      durationMs,
      characters: text.length,
      chunks,
      chunkSize,
      events: events.length,
    },
  };
}

export const profileImage = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360"><rect width="960" height="360" fill="#dce8ef"/><path d="M40 300L200 240 350 270 520 140 680 180 900 50" fill="none" stroke="#36586a" stroke-width="12"/></svg>`;
