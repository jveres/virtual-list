import { describe, expect, it, vi } from "vitest";
import {
  createTextFile,
  fileImageContext,
} from "../../demos/streaming/create-file";
import {
  fetchGeneratedFile,
  type GeneratedFile,
  storedGeneratedFiles,
} from "../../demos/streaming/generated-files";
import {
  buildResponseContext,
  streamOpenAIChat,
  validateStoredTurns,
} from "../../demos/streaming/openai";

const settings = {
  provider: "chatgpt" as const,
  apiKey: "never-send",
  model: "test-model",
  tools: { webSearch: false, imageGeneration: false, codeInterpreter: false },
  reasoningSummary: true,
};
const context = {
  input: [],
  fallbackInput: [{ role: "user", content: "Create an HTML file" }],
  contextStart: 0,
  contextTurns: 0,
};
const content =
  "<!doctype html><h1>Árvíz 😀</h1><script>globalThis.pwned=true</script>";
function call(
  args = JSON.stringify({ filename: "page.html", content }),
  id = "call_file",
) {
  return {
    type: "function_call",
    id: `fc_${id}`,
    call_id: id,
    name: "create_file",
    arguments: args,
  };
}
function response(
  output: Record<string, unknown>[],
  id = "resp_file",
  streamedOutput = false,
) {
  return new Response(
    (streamedOutput
      ? output
          .map(
            (item, output_index) =>
              `data: ${JSON.stringify({ type: "response.output_item.done", item, output_index })}\n\n`,
          )
          .join("")
      : "") +
      `data: ${JSON.stringify({ type: "response.completed", response: { id, model: settings.model, output: streamedOutput ? [] : output } })}\n\n`,
  );
}
const finalMessage = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "File ready.", annotations: [] }],
};

describe("local downloadable text files", () => {
  it("should embed selected images without sending their bytes as text or tool output", async () => {
    const dataUrl = "data:image/png;base64,YWJj";
    const transcript = [
      {
        role: "user" as const,
        markdown: "Use my artwork",
        attachments: [
          { name: "art.png", mimeType: "image/png", size: 3, dataUrl },
        ],
      },
      { role: "assistant" as const, markdown: "OK" },
      { role: "user" as const, markdown: "Create a postcard" },
    ];
    const selected = buildResponseContext(transcript, 0, settings.model);
    const template =
      '<img src="{{attachment:1}}"><style>body{background-image:url("{{attachment:1}}")}</style>';
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response(
          [
            call(
              JSON.stringify({ filename: "postcard.html", content: template }),
            ),
          ],
          "resp_file",
          true,
        ),
      )
      .mockResolvedValueOnce(response([finalMessage], "resp_final", true));
    const chunks = [];
    for await (const chunk of streamOpenAIChat(
      selected,
      settings,
      new AbortController().signal,
    ))
      chunks.push(chunk);
    const created = chunks.find((chunk) => chunk.kind === "files");
    if (created?.kind !== "files") throw new Error("Missing file");
    expect(created.files[0]?.content).toBe(
      template.replaceAll("{{attachment:1}}", dataUrl),
    );
    const restored = storedGeneratedFiles(
      JSON.parse(JSON.stringify(created.files)),
    );
    const restoredFile = restored[0];
    if (!restoredFile) throw new Error("Missing restored file");
    expect(await (await fetchGeneratedFile(restoredFile, "")).text()).toBe(
      created.files[0]?.content,
    );
    for (const [, request] of fetcher.mock.calls) {
      const body = JSON.parse(String(request?.body));
      expect(body.input[0].content).toContainEqual({
        type: "input_image",
        image_url: dataUrl,
        detail: "auto",
      });
      expect(body.input[0].content).toContainEqual({
        type: "input_text",
        text: "Image reference for create_file: {{attachment:1}} (the following image).",
      });
      expect(
        JSON.stringify(
          body.input.filter(
            (item: Record<string, unknown>) =>
              item.type === "function_call_output",
          ),
        ),
      ).not.toContain(dataUrl);
      expect(
        JSON.stringify(
          body.input[0].content.filter(
            (item: Record<string, unknown>) => item.type === "input_text",
          ),
        ),
      ).not.toContain(dataUrl);
    }
    expect(selected).toEqual(
      buildResponseContext(transcript, 0, settings.model),
    );
    expect(
      fileImageContext(
        buildResponseContext(transcript, 1, settings.model).fallbackInput,
      ).images.size,
    ).toBe(0);
  });

  it.each([
    "https://example.com/image.png",
    "file:///private/image.png",
    "data:image/svg+xml;base64,YWJj",
    'data:image/png;base64,YWJj" onload="bad',
    "data:image/png;base64,YQ=",
  ])(
    "should not expose invalid or remote image references: %s",
    (image_url) => {
      const input = [
        { role: "user", content: [{ type: "input_image", image_url }] },
      ];
      expect(fileImageContext(input)).toEqual({ input, images: new Map() });
    },
  );

  it("should reject unknown references and expansion beyond the file limit", () => {
    const args = (content: string) =>
      JSON.stringify({ filename: "a.html", content });
    expect(() =>
      createTextFile(args("{{attachment:missing}}"), "local_test"),
    ).toThrow("Unknown image reference");
    const image = `data:image/png;base64,${"YWJj".repeat(300000)}`;
    const images = fileImageContext([
      { role: "user", content: [{ type: "input_image", image_url: image }] },
    ]).images;
    const file = createTextFile(
      args('<img src="{{attachment:1}}">'),
      "local_test",
      images,
    );
    expect(file.content).toBe(`<img src="${image}">`);
    expect(storedGeneratedFiles([file])).toEqual([file]);
    expect(() =>
      createTextFile(args("{{attachment:1}}".repeat(15)), "local_test", images),
    ).toThrow("16 MiB");
  });

  it("should label multiple images independently in conversation order", () => {
    const first = "data:image/png;base64,YWJj";
    const second = "data:image/jpeg;base64,ZGVm";
    const result = fileImageContext([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: first },
          { type: "input_image", image_url: second },
        ],
      },
    ]);
    expect([...result.images]).toEqual([
      ["1", first],
      ["2", second],
    ]);
    expect(
      createTextFile(
        JSON.stringify({
          filename: "a.html",
          content: "{{attachment:2}} {{attachment:1}}",
        }),
        "local_test",
        result.images,
      ).content,
    ).toBe(`${second} ${first}`);
  });

  it("should omit the tool and file instructions when File download is disabled", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([finalMessage]));
    for await (const _chunk of streamOpenAIChat(
      context,
      { ...settings, tools: { ...settings.tools, fileDownload: false } },
      new AbortController().signal,
    )) {
      /* drain */
    }
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.tools).toBeUndefined();
    expect(body.instructions).not.toContain("create_file");
  });
  it.each(["", content, "a,b\r\n1,2\r\n", "日本語\n\tindent"])(
    "should roundtrip inert content through storage and download (%s)",
    async (text) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      const file = createTextFile(
        JSON.stringify({ filename: "/mnt/data/page.html", content: text }),
        "local_test",
      );
      const saved = JSON.parse(
        JSON.stringify([
          {
            role: "assistant",
            markdown: "",
            stopped: true,
            generatedFiles: [file],
          },
        ]),
      );
      const restored = validateStoredTurns(saved);
      expect(restored).toEqual(saved);
      expect(file.filename).toBe("page.html");
      const blob = await fetchGeneratedFile(file, "");
      expect(await blob.text()).toBe(text);
      expect(blob.type).toBe("application/octet-stream");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    "not json",
    "null",
    "{}",
    JSON.stringify({ filename: "a.pdf", content: "fake PDF" }),
    JSON.stringify({ filename: "a.html", content: 7 }),
    JSON.stringify({ filename: "a.html", content: "😀".repeat(250001) }),
  ])("should reject invalid or oversized tool arguments", (args) => {
    expect(() => createTextFile(args, "local_test")).toThrow();
  });

  it("should reject corrupt stored local artifacts instead of fetching them remotely", () => {
    expect(
      storedGeneratedFiles([
        { fileId: "local_missing", filename: "a.txt" },
        { fileId: "file_remote", filename: "a.txt", content: "text" },
        {
          fileId: "local_bad",
          containerId: "cntr_1",
          filename: "a.txt",
          content: "text",
        },
      ]),
    ).toEqual([]);
  });

  it.each([false, true])(
    "should retain reasoning/call/output pairs and continue with streamed output=%s",
    async (streamedOutput) => {
      const reasoning = {
        type: "reasoning",
        id: "rs_test",
        summary: [],
        encrypted_content: "opaque",
      };
      const tool = call();
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          response([reasoning, tool], "resp_file", streamedOutput),
        )
        .mockResolvedValueOnce(
          response([finalMessage], "resp_final", streamedOutput),
        );
      const chunks = [];
      for await (const chunk of streamOpenAIChat(
        context,
        settings,
        new AbortController().signal,
      ))
        chunks.push(chunk);
      const created = chunks.find((chunk) => chunk.kind === "files");
      expect(created).toEqual({
        kind: "files",
        files: [
          {
            fileId: "local_resp_file_call_file",
            filename: "page.html",
            content,
          },
        ],
      });
      const completed = chunks.at(-1);
      if (completed?.kind !== "response-completed")
        throw new Error("Missing completion");
      expect(completed.state.output).toEqual([
        reasoning,
        tool,
        {
          type: "function_call_output",
          call_id: "call_file",
          output: JSON.stringify({
            filename: "page.html",
            download_url: "sandbox:/mnt/data/page.html",
          }),
        },
        finalMessage,
      ]);
      const nextRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
      expect(nextRequest.input).toEqual([
        ...context.fallbackInput,
        ...completed.state.output.slice(0, -1),
      ]);
      for (const [url, request] of fetcher.mock.calls) {
        expect(url).toBe("/__chatgpt/responses");
        expect(new Headers(request?.headers).has("authorization")).toBe(false);
      }
      const saved = validateStoredTurns([
        {
          role: "assistant",
          markdown: "File ready.",
          responseState: completed.state,
          generatedFiles: created?.kind === "files" ? created.files : [],
        },
      ]);
      expect(saved[0]?.responseState).toEqual(completed.state);
      expect(
        buildResponseContext(
          [...saved, { role: "user", markdown: "Continue" }],
          0,
          settings.model,
        ).fallbackInput,
      ).toEqual([
        ...completed.state.output,
        { role: "user", content: "Continue" },
      ]);
    },
  );

  it("should return malformed arguments as tool feedback without creating a download", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([call("{")]))
      .mockResolvedValueOnce(response([finalMessage]));
    const chunks = [];
    for await (const chunk of streamOpenAIChat(
      context,
      settings,
      new AbortController().signal,
    ))
      chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.kind === "files")).toEqual([]);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        kind: "tool-end",
        ok: false,
        name: "create_file",
      }),
    );
    expect(
      JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).input.at(-1),
    ).toEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_file",
      }),
    );
  });

  it("should stop at the continuation limit while retaining completed files", async () => {
    let round = 0;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        response([call(undefined, `call_${++round}`)]),
      );
    const files: GeneratedFile[] = [];
    await expect(
      (async () => {
        for await (const chunk of streamOpenAIChat(
          context,
          settings,
          new AbortController().signal,
        ))
          if (chunk.kind === "files") files.push(...chunk.files);
      })(),
    ).rejects.toThrow("continuation limit");
    expect(files).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("should cancel before the follow-up request without losing completed artifact data", async () => {
    const abort = new AbortController();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([call()]));
    const kinds: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of streamOpenAIChat(
          context,
          settings,
          abort.signal,
        )) {
          kinds.push(chunk.kind);
          if (chunk.kind === "files") abort.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(kinds).toContain("response-completed");
    expect(kinds).toContain("files");
  });
});
