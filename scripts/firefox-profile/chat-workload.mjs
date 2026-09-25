import { createHash } from "node:crypto";

// Local, deterministic Responses SSE input for the actual streaming demo.
export function chatWorkload({
  sections = 48,
  history = 160,
  durationMs = 30000,
} = {}) {
  for (const [name, value, min, max] of [
    ["sections", sections, 1, 200],
    ["history", history, 2, 1000],
    ["durationMs", durationMs, 1000, 120000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  }
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
  const text = Array.from({ length: sections }, (_, i) => section(i)).join("");
  const turns = Array.from({ length: history }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    markdown:
      i % 2
        ? section(i)
        : `Inspect stage ${i}. ${"Keep the reading position stable. ".repeat(8)}`,
    sentAt: Date.UTC(2026, 0, 1) + Math.floor(i / 20) * 86400000,
  }));
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
      sections,
      history,
      durationMs,
      characters: text.length,
      chunks,
      chunkSize,
      events: events.length,
    },
  };
}

export const profileImage = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360"><rect width="960" height="360" fill="#dce8ef"/><path d="M40 300L200 240 350 270 520 140 680 180 900 50" fill="none" stroke="#36586a" stroke-width="12"/></svg>`;
