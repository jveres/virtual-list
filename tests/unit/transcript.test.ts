import { describe, expect, it } from "vitest";
import type { StoredTurn } from "../../demos/streaming/openai";
import {
  parseTranscriptMarkdown,
  transcriptMarkdown,
} from "../../demos/streaming/transcript";

const DAY = 86_400_000;
const days = {
  dayOf: (m: StoredTurn) =>
    m.sentAt === undefined ? -1 : Math.floor(m.sentAt / DAY) * DAY,
  dayLabel: (day: number) => (day < 0 ? "Earlier" : `Day ${day / DAY}`),
};

describe("chat transcript round trip", () => {
  it("restores roles, bodies, send times, and tool payloads exactly", () => {
    const turns: StoredTurn[] = [
      { role: "user", markdown: "Hi -- how are you?", sentAt: 3 * DAY + 100 },
      {
        role: "assistant",
        markdown: "## A heading\n\n```md\n**User**\n## not a day\n```\n\nDone.",
        sentAt: 3 * DAY + 200,
        toolCalls: [
          {
            name: "web_search",
            status: "done",
            durationMs: 1234,
            input: '{"q":"a --> b"}',
            output: "<!-- looks like a comment --> --",
          },
          {
            name: "code",
            status: "error",
            durationMs: 5,
            input: "",
            output: "",
          },
        ],
      },
      { role: "user", markdown: "Next day", sentAt: 4 * DAY + 100 },
      { role: "assistant", markdown: "Reply", sentAt: 4 * DAY + 150 },
    ];
    const text = transcriptMarkdown(turns, days);
    expect(text).toContain("## Day 3");
    expect(text).toContain("## Day 4");
    expect(text).toContain("> Tool call `web_search` (done, 1234ms)");
    expect(text).not.toMatch(/--(?!>)[^>]*-->.*-->/); // Comments stay well-formed.
    expect(parseTranscriptMarkdown(text)).toEqual(turns);
  });

  it("reads a file written before the tags: summaries only, undated", () => {
    const legacy = [
      "# streaming-chat transcript",
      "",
      "## Yesterday",
      "",
      "**User**",
      "",
      "Question",
      "",
      "**Assistant**",
      "",
      "> Tool call `web_search` (done, 42ms)",
      "",
      "Answer with a trailing heading",
      "",
      "## Today",
      "",
      "**User**",
      "",
      "_(cancelled)_",
      "",
      "**Assistant**",
      "",
      "Last",
      "",
    ].join("\n");
    expect(parseTranscriptMarkdown(legacy)).toEqual([
      { role: "user", markdown: "Question" },
      {
        role: "assistant",
        markdown: "Answer with a trailing heading",
        toolCalls: [
          {
            name: "web_search",
            status: "done",
            durationMs: 42,
            input: "",
            output: "",
          },
        ],
      },
      { role: "assistant", markdown: "Last" },
    ]);
  });

  it("keeps a heading that ends a reply when it is not followed by a marker", () => {
    const turns: StoredTurn[] = [
      { role: "assistant", markdown: "Body\n\n## Closing heading" },
    ];
    const text = transcriptMarkdown(turns, days);
    expect(parseTranscriptMarkdown(text)).toEqual(turns);
  });

  it("returns nothing for a file without turns", () => {
    expect(parseTranscriptMarkdown("# notes\n\nplain text\n")).toEqual([]);
  });
});
