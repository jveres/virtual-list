// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  attachmentChip,
  type ChatAttachment,
  MAX_ATTACHMENT_BYTES,
  readAttachments,
  storedAttachments,
} from "../../demos/streaming/attachments";
import {
  buildResponseContext,
  type StoredTurn,
  validateStoredTurns,
} from "../../demos/streaming/openai";
import {
  parseTranscriptMarkdown,
  transcriptMarkdown,
} from "../../demos/streaming/transcript";

function attachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    dataUrl: "data:text/plain;base64,aGVsbG8=",
    ...overrides,
  };
}

describe("local attachments", () => {
  it("should encode files with a canonical MIME type and preserve selection order", async () => {
    const files = [
      new File(["hello"], "notes.txt"),
      new File(["abc"], "photo.PNG"),
    ];

    const result = await readAttachments(files);

    expect(result).toEqual([
      attachment(),
      attachment({
        name: "photo.PNG",
        mimeType: "image/png",
        size: 3,
        dataUrl: "data:image/png;base64,YWJj",
      }),
    ]);
    expect(storedAttachments(result)).toEqual(result);
  });

  it("should reject unsupported and empty files before adding any selection", async () => {
    await expect(
      readAttachments([
        new File(["hello"], "notes.txt"),
        new File(["binary"], "app.exe"),
      ]),
    ).rejects.toThrow("unsupported file type");
    await expect(readAttachments([new File([], "empty.txt")])).rejects.toThrow(
      "empty or invalid",
    );
  });

  it("should enforce per-file, total-size, and count limits including pending files", async () => {
    const oversized = new File(["x"], "large.pdf");
    Object.defineProperty(oversized, "size", {
      value: MAX_ATTACHMENT_BYTES + 1,
    });
    await expect(readAttachments([oversized])).rejects.toThrow("10 MB");
    const existing = [
      attachment({ size: MAX_ATTACHMENT_BYTES }),
      attachment({ size: MAX_ATTACHMENT_BYTES }),
    ];
    await expect(
      readAttachments([new File(["x"], "extra.txt")], existing),
    ).rejects.toThrow("20 MB");
    await expect(
      readAttachments(
        [new File(["x"], "extra.txt")],
        Array.from({ length: 10 }, () => attachment()),
      ),
    ).rejects.toThrow("10 files");
  });

  it.each([
    null,
    [{}],
    [attachment({ dataUrl: "javascript:alert(1)" })],
    [
      attachment({
        mimeType: "image/svg+xml",
        dataUrl: "data:image/svg+xml;base64,aGVsbG8=",
      }),
    ],
    [attachment({ size: 4 })],
    [attachment({ dataUrl: "data:text/plain;base64,@@@@@@@=" })],
    [attachment({ name: "app.exe" })],
    [attachment({ size: -1 })],
  ])("should reject invalid stored metadata %#", (value) => {
    expect(storedAttachments(value)).toEqual([]);
  });

  it("should render hostile filenames only as text", () => {
    const name = '<img src=x onerror="alert(1)">.txt';

    const chip = attachmentChip(attachment({ name }));

    expect(chip.querySelector(".attachment-name")?.textContent).toBe(name);
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.querySelector(".attachment-size")?.textContent).toBe("1 KB");
  });

  it("should preserve attachment-only user turns but discard assistant attachments", () => {
    const turn = { role: "user", markdown: "", attachments: [attachment()] };

    expect(validateStoredTurns([turn])).toEqual([turn]);
    expect(validateStoredTurns([{ ...turn, role: "assistant" }])).toEqual([]);
  });

  it("should send images and files as typed content instead of base64 text", () => {
    const photo = attachment({
      name: "photo.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,aGVsbG8=",
    });
    const turn: StoredTurn = {
      role: "user",
      markdown: "Review these",
      attachments: [attachment(), photo],
    };

    const context = buildResponseContext(
      [turn, { role: "assistant", markdown: "" }],
      0,
      "gpt-5-mini",
    );

    expect(context.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Review these" },
          {
            type: "input_file",
            filename: "notes.txt",
            file_data: attachment().dataUrl,
          },
          { type: "input_image", image_url: photo.dataUrl, detail: "auto" },
        ],
      },
    ]);
  });

  it("should carry new attachment-only turns on chains and old attachments in fallback", () => {
    const turns: StoredTurn[] = [
      { role: "user", markdown: "", attachments: [attachment()] },
      {
        role: "assistant",
        markdown: "Read it",
        responseState: {
          id: "resp_first",
          model: "gpt-5-mini",
          contextStart: 0,
          contextTurns: 0,
          output: [],
        },
      },
      {
        role: "user",
        markdown: "",
        attachments: [attachment({ name: "next.txt" })],
      },
    ];

    const context = buildResponseContext(turns, 0, "gpt-5-mini");

    expect(context.previousResponseId).toBe("resp_first");
    expect(context.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "next.txt",
            file_data: attachment().dataUrl,
          },
        ],
      },
    ]);
    expect(context.fallbackInput).toHaveLength(3);
    expect(context.fallbackInput[0]).toEqual({
      role: "user",
      content: [
        {
          type: "input_file",
          filename: "notes.txt",
          file_data: attachment().dataUrl,
        },
      ],
    });
    expect(buildResponseContext(turns, 1, "gpt-5-mini").input).toEqual(
      context.input,
    );
  });

  it("should round-trip attachments through transcript export and import", () => {
    const turns: StoredTurn[] = [
      {
        role: "user",
        markdown: "",
        sentAt: 123,
        attachments: [attachment({ name: "a-->b\n文.txt" })],
      },
    ];

    const markdown = transcriptMarkdown(turns, {
      dayOf: () => 0,
      dayLabel: () => "Today",
    });
    const result = parseTranscriptMarkdown(markdown);

    expect(result).toEqual(turns);
    expect(
      parseTranscriptMarkdown(
        transcriptMarkdown(result, { dayOf: () => 0, dayLabel: () => "Today" }),
      ),
    ).toEqual(turns);
  });
});
