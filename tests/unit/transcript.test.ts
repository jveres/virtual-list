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
  it.each(["", "Download the file below."])(
    "should preserve generated downloads through export and import: %s",
    (markdown) => {
      const turns: StoredTurn[] = [
        {
          role: "assistant",
          markdown,
          generatedFiles: [
            {
              fileId: "local_html",
              filename: "postcard.html",
              content:
                '<!-- artwork -->\r\n<img src="data:image/png;base64,YWJj">\n**User**\nÁrvíz 😀',
            },
            { fileId: "local_empty", filename: "empty.txt", content: "" },
            {
              fileId: "file_remote",
              containerId: "cntr_remote",
              filename: "report.csv",
            },
          ],
        },
      ];
      expect(parseTranscriptMarkdown(transcriptMarkdown(turns, days))).toEqual(
        turns,
      );
    },
  );

  it.each(["", "Partial answer", "## Partial section\n\nA response."])(
    "should preserve a stopped response through export and import: %s",
    (markdown) => {
      const turns: StoredTurn[] = [
        { role: "user", markdown: "Question" },
        { role: "assistant", markdown, stopped: true },
      ];

      const restored = parseTranscriptMarkdown(transcriptMarkdown(turns, days));

      expect(restored).toEqual(turns);
    },
  );

  it.each([
    "Literal roles:\n\n**User**\n\n**Assistant**\n\nNot new turns.",
    "<!-- day -->\n## Not a day heading\n\nStill the answer.",
    "_(cancelled)_",
    "> Tool call `example` (done, 3ms)\n\nQuoted syntax.",
    '<!-- turn {"sentAt":42} -->\n\nLiteral metadata.',
    "````md\n```js\n**User**\n```\n````",
  ])("should preserve transcript-like body syntax: %s", (markdown) => {
    const turns: StoredTurn[] = [
      { role: "assistant", markdown },
      { role: "user", markdown: "Next real turn" },
    ];
    expect(parseTranscriptMarkdown(transcriptMarkdown(turns, days))).toEqual(
      turns,
    );
  });
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

  it("closes a body cut inside a code block so the next turn stays a turn", () => {
    const turns: StoredTurn[] = [
      { role: "assistant", markdown: "Partial:\n\n```ts\nconst a = 1;" },
      { role: "user", markdown: "Go on" },
      { role: "assistant", markdown: "```ts\nconst b = 2;\n```" },
    ];
    const text = transcriptMarkdown(turns, days);
    expect(parseTranscriptMarkdown(text)).toEqual([
      { role: "assistant", markdown: "Partial:\n\n```ts\nconst a = 1;\n```" },
      turns[1],
      turns[2],
    ]);
  });

  it("keeps a body that is only a heading, and a reply ending in one, in a tagged file", () => {
    const turns: StoredTurn[] = [
      { role: "user", markdown: "## Just a heading", sentAt: DAY },
      { role: "assistant", markdown: "Body\n\n## Closing", sentAt: DAY + 1 },
      { role: "user", markdown: "Next", sentAt: DAY + 2 },
    ];
    expect(parseTranscriptMarkdown(transcriptMarkdown(turns, days))).toEqual(
      turns,
    );
  });

  it("settles a tool call still running at export time, as persistence does", () => {
    const turns: StoredTurn[] = [
      {
        role: "assistant",
        markdown: "Working",
        toolCalls: [
          {
            name: "code",
            status: "running",
            durationMs: 9,
            input: "",
            output: "",
          },
        ],
      },
    ];
    const text = transcriptMarkdown(turns, days);
    expect(text).toContain("> Tool call `code` (error, 9ms)");
    expect(parseTranscriptMarkdown(text)[0]?.toolCalls).toEqual([
      { name: "code", status: "error", durationMs: 9, input: "", output: "" },
    ]);
  });

  it("falls back to the summaries when the turn comment's calls are unusable", () => {
    const text = [
      "**Assistant**",
      '<!-- turn {"toolCalls":[{"name":"x","status":"running"}]} -->',
      "",
      "> Tool call `x` (done, 3ms)",
      "",
      "Body",
    ].join("\n");
    expect(parseTranscriptMarkdown(text)[0]?.toolCalls).toEqual([
      { name: "x", status: "done", durationMs: 3, input: "", output: "" },
    ]);
  });

  it("returns nothing for a file without turns", () => {
    expect(parseTranscriptMarkdown("# notes\n\nplain text\n")).toEqual([]);
  });

  it("should reject changed body framing rather than import partial history", () => {
    const text = transcriptMarkdown(
      [{ role: "user", markdown: "Saved body" }],
      days,
    );
    expect(() =>
      parseTranscriptMarkdown(text.replace("body 1", "body 5")),
    ).toThrow("truncated");
    expect(() =>
      parseTranscriptMarkdown(text.replace("<!-- /body -->", "")),
    ).toThrow("truncated");
  });
});
