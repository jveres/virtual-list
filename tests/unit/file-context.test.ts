import { describe, expect, it, vi } from "vitest";
import { fileImageContext } from "../../demos/streaming/create-file";
import {
  generatedFileInputs,
  subscriptionImageInputs,
} from "../../demos/streaming/file-context";
import {
  buildResponseContext,
  type StoredTurn,
  streamOpenAIChat,
} from "../../demos/streaming/openai";
import {
  parseTranscriptMarkdown,
  transcriptMarkdown,
} from "../../demos/streaming/transcript";

const image = "data:image/png;base64,YWJj";
const file = {
  fileId: "local_postcard",
  filename: "postcard.html",
  content: `<h1>Postcard secret: lavender</h1><img src="${image}"><img src="${image}">`,
};
const days = { dayOf: () => 0, dayLabel: () => "Today" };

describe("generated file request context", () => {
  it.each([
    { format: "png", result: "iVBORw0KGgo=", fileDownload: true },
    { format: "jpeg", result: "/9j/2w==", fileDownload: true },
    { format: "webp", result: "UklGRg==", fileDownload: false },
  ])(
    "should send an earlier generated $format image as vision input with fileDownload=$fileDownload",
    async ({ format, result, fileDownload }) => {
      const output = [
        {
          type: "image_generation_call",
          id: "ig_saved",
          status: "completed",
          result,
          output_format: format,
        },
      ];
      const history: StoredTurn[] = [
        { role: "user", markdown: "Generate variants" },
        {
          role: "assistant",
          markdown: `![Generated image](data:image/${format};base64,${result})`,
          responseState: {
            provider: "chatgpt",
            id: "resp_image",
            model: "test",
            contextStart: 0,
            contextTurns: 0,
            output,
          },
        },
        { role: "user", markdown: "Choose variant 06" },
        { role: "assistant", markdown: "Chosen." },
        { role: "user", markdown: "Use that image" },
      ];
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            'data: {"type":"response.completed","response":{"id":"resp_next","model":"test","output":[]}}\n\n',
          ),
        );
      for await (const _chunk of streamOpenAIChat(
        buildResponseContext(JSON.parse(JSON.stringify(history)), 12, "test"),
        {
          provider: "chatgpt",
          apiKey: "",
          model: "test",
          tools: {
            webSearch: false,
            imageGeneration: false,
            codeInterpreter: false,
            fileDownload,
          },
          reasoningSummary: false,
        },
        new AbortController().signal,
      )) {
        /* drain */
      }
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(
        body.input.some(
          (item: Record<string, unknown>) =>
            item.type === "image_generation_call",
        ),
      ).toBe(false);
      const parts = body.input.flatMap((item: Record<string, unknown>) =>
        Array.isArray(item.content) ? item.content : [],
      );
      expect(
        parts.filter(
          (part: Record<string, unknown>) => part.type === "input_image",
        ),
      ).toEqual([
        {
          type: "input_image",
          image_url: `data:image/${format};base64,${result}`,
          detail: "auto",
        },
      ]);
      if (fileDownload)
        expect(parts).toContainEqual({
          type: "input_text",
          text: "Image reference for create_file: {{attachment:1}} (the following image).",
        });
      expect(history[1]?.responseState?.output).toEqual(output);
    },
  );

  it("should omit unsuccessful generated images while preserving other structured items", () => {
    const reasoning = {
      type: "reasoning",
      encrypted_content: "opaque",
      summary: [],
    };
    const input = [
      { type: "image_generation_call", result: null },
      {
        type: "image_generation_call",
        result: "iVBORw0KGgo=",
        status: "failed",
      },
      reasoning,
    ];
    expect(subscriptionImageInputs(input)).toEqual([reasoning]);
  });

  it.each(["chatgpt", "openai"] as const)(
    "should replay saved files for %s after storage and transcript round trips",
    async (provider) => {
      const history: StoredTurn[] = [
        { role: "assistant", markdown: "File ready.", generatedFiles: [file] },
        { role: "user", markdown: "Change the heading" },
      ];
      const imported = parseTranscriptMarkdown(
        transcriptMarkdown(JSON.parse(JSON.stringify(history)), days),
      );
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            'data: {"type":"response.completed","response":{"id":"resp_done","model":"test-model","output":[]}}\n\n',
          ),
        );
      for await (const _chunk of streamOpenAIChat(
        buildResponseContext(imported, 0, "test-model"),
        {
          provider,
          apiKey: "test-key",
          model: "test-model",
          tools: {
            webSearch: false,
            imageGeneration: false,
            codeInterpreter: false,
            fileDownload: false,
          },
          reasoningSummary: false,
        },
        new AbortController().signal,
      )) {
        /* drain */
      }
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      const parts = body.input.flatMap((item: Record<string, unknown>) =>
        Array.isArray(item.content) ? item.content : [],
      );
      const text = parts
        .filter((part: Record<string, unknown>) => part.type === "input_text")
        .map((part: Record<string, unknown>) => part.text)
        .join("\n");
      expect(text).toContain("postcard.html");
      expect(text).toContain("Postcard secret: lavender");
      expect(text).not.toContain("YWJj");
      expect(
        parts.filter(
          (part: Record<string, unknown>) => part.type === "input_image",
        ),
      ).toEqual([{ type: "input_image", image_url: image, detail: "auto" }]);
      expect(body.previous_response_id).toBeUndefined();
    },
  );

  it("should retain file-only replies but not leak files outside the selected window", () => {
    const history: StoredTurn[] = [
      { role: "assistant", markdown: "", generatedFiles: [file] },
      { role: "user", markdown: "Read it" },
    ];
    expect(
      JSON.stringify(buildResponseContext(history, 0, "test").fallbackInput),
    ).toContain("lavender");
    expect(buildResponseContext(history, 1, "test").fallbackInput).toEqual([
      { role: "user", content: "Read it" },
    ]);
  });

  it("should replay files alongside structured state instead of relying on API chains", () => {
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "File ready." }],
      },
    ];
    const history: StoredTurn[] = [
      { role: "user", markdown: "Create it" },
      {
        role: "assistant",
        markdown: "File ready.",
        generatedFiles: [file],
        responseState: {
          id: "resp_old",
          model: "test",
          contextStart: 0,
          contextTurns: 0,
          output,
        },
      },
      { role: "user", markdown: "Edit it" },
    ];
    const result = buildResponseContext(history, 0, "test");
    expect(result.previousResponseId).toBeUndefined();
    expect(result.input).toEqual(result.fallbackInput);
    expect(result.input).toContainEqual(output[0]);
    expect(JSON.stringify(result.input)).toContain("lavender");
    expect([...fileImageContext(result.input).images.values()]).toEqual([
      image,
    ]);
  });

  it("should keep empty files readable and leave remote-only references unfetched", () => {
    expect(
      generatedFileInputs([{ fileId: "file_remote", filename: "remote.csv" }]),
    ).toEqual([]);
    expect(
      generatedFileInputs([
        { fileId: "local_empty", filename: "empty.txt", content: "" },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: expect.stringContaining('"content":""') },
        ],
      },
    ]);
  });

  it("should omit embedded binary payloads without changing saved file bytes", () => {
    const original = {
      fileId: "local_data",
      filename: "page.html",
      content: '<a href="data:application/pdf;base64,YWJj">PDF</a>',
    };
    const input = generatedFileInputs([original]);
    expect(JSON.stringify(input)).not.toContain("YWJj");
    expect(JSON.stringify(input)).toContain("embedded binary data omitted");
    expect(original.content).toContain("data:application/pdf;base64,YWJj");
  });
});
