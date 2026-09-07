import { describe, expect, it } from "vitest";
import type { ChatToolCall } from "../../demos/shared/chat-ui.js";
import {
  messageParts,
  type OrderedMessage,
  replaceMessageMarkdown,
} from "../../demos/shared/message-order.js";
import { validateStoredTurns } from "../../demos/streaming/openai.js";
import {
  parseTranscriptMarkdown,
  transcriptMarkdown,
} from "../../demos/streaming/transcript.js";

const call = (markdownOffset?: number): ChatToolCall => ({
  name: "image_generation",
  status: "done",
  durationMs: 10,
  input: "{}",
  output: "Generated",
  ...(markdownOffset === undefined ? {} : { markdownOffset }),
});
const days = { dayOf: () => 0, dayLabel: () => "Today" };

describe("message chronology", () => {
  it("should interleave text and tools without changing their contents", () => {
    const first = call(5);
    const second = { ...call(5), name: "thinking" };
    const third = call(10);
    const parts = messageParts({
      markdown: "FirstAfterLast",
      toolCalls: [first, second, third],
    });
    expect(parts).toEqual([
      { kind: "text", key: "text-0", text: "First" },
      { kind: "tool", key: "tool-0", call: first },
      { kind: "text", key: "text-1", text: "" },
      { kind: "tool", key: "tool-1", call: second },
      { kind: "text", key: "text-2", text: "After" },
      { kind: "tool", key: "tool-2", call: third },
      { kind: "text", key: "text-3", text: "Last" },
    ]);
  });
  it("should retain legacy tools at the beginning and clamp out-of-range positions", () => {
    const parts = messageParts({
      markdown: "Text",
      toolCalls: [call(), call(99), call(1)],
    });
    expect(
      parts.filter((part) => part.kind === "text").map((part) => part.text),
    ).toEqual(["", "Text", "", ""]);
  });
  it("should keep later calls after a replaced progressive image", () => {
    const message: OrderedMessage = {
      markdown: "Before[preview]After",
      toolCalls: [call(6), call(15), call(19)],
    };
    expect(replaceMessageMarkdown(message, "[preview]", "[final image]")).toBe(
      true,
    );
    expect(message.markdown).toBe("Before[final image]After");
    expect(message.toolCalls?.map((tool) => tool.markdownOffset)).toEqual([
      6, 19, 23,
    ]);
    expect(replaceMessageMarkdown(message, "missing", "new")).toBe(false);
    expect(message.markdown).toBe("Before[final image]After");
  });
  it.each([-1, 1.5, Infinity, NaN, "5"])(
    "should discard an invalid persisted tool offset %s",
    (markdownOffset) => {
      const [turn] = validateStoredTurns([
        {
          role: "assistant",
          markdown: "Answer",
          toolCalls: [{ ...call(), markdownOffset }],
        },
      ]);
      expect(turn?.toolCalls).toEqual([call()]);
    },
  );
  it("should preserve positions through storage and transcript export/import", () => {
    const turns = [
      {
        role: "assistant" as const,
        markdown: "Before\n\nAfter",
        toolCalls: [call(8)],
      },
    ];
    expect(validateStoredTurns(turns)).toEqual(turns);
    expect(parseTranscriptMarkdown(transcriptMarkdown(turns, days))).toEqual(
      turns,
    );
  });
  it("should adjust exported positions for trimmed leading whitespace", () => {
    const turns = [
      {
        role: "assistant" as const,
        markdown: " \nBefore\n\nAfter\n ",
        toolCalls: [call(10)],
      },
    ];
    const [turn] = parseTranscriptMarkdown(transcriptMarkdown(turns, days));
    expect(turn?.markdown).toBe("Before\n\nAfter");
    expect(turn?.toolCalls?.[0]?.markdownOffset).toBe(8);
  });
  it("should retain a tool-only turn through storage and export/import", () => {
    const turns = [
      { role: "assistant" as const, markdown: "", toolCalls: [call(0)] },
    ];
    expect(validateStoredTurns(turns)).toEqual(turns);
    expect(parseTranscriptMarkdown(transcriptMarkdown(turns, days))).toEqual(
      turns,
    );
  });
});
