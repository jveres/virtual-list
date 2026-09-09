import { describe, expect, it, vi } from "vitest";
import {
  fetchGeneratedFile,
  filesFromAnnotations,
  filesFromOutput,
  storedGeneratedFiles,
} from "../../demos/streaming/generated-files";
import {
  buildResponseContext,
  streamOpenAIChat,
  validateStoredTurns,
} from "../../demos/streaming/openai";

const file = {
  containerId: "cntr_test",
  fileId: "cfile_test",
  filename: "report.csv",
};
const annotation = {
  type: "container_file_citation",
  container_id: file.containerId,
  file_id: file.fileId,
  filename: file.filename,
  start_index: 0,
  end_index: 0,
};
const part = {
  type: "output_text",
  text: "Your report.",
  annotations: [annotation],
};
const item = { type: "message", role: "assistant", content: [part] };
const settings = {
  apiKey: "test-only",
  model: "gpt-5-mini",
  tools: { webSearch: false, imageGeneration: false, codeInterpreter: true },
  reasoningSummary: false,
};

describe("generated files", () => {
  it("should find artifacts without a markdown link and deduplicate repeated citations", () => {
    expect(filesFromOutput([item, item])).toEqual([file]);
    expect(filesFromAnnotations([annotation, annotation])).toEqual([file]);
  });

  it("should distinguish generated files from source citations", () => {
    expect(
      filesFromAnnotations([
        {
          type: "file_citation",
          file_id: "file_source",
          filename: "source.pdf",
        },
        { type: "url_citation", url: "https://example.com" },
        { type: "file_path", file_id: "file_result" },
      ]),
    ).toEqual([{ fileId: "file_result", filename: "file_result" }]);
  });

  it.each([undefined, null, {}, "not an array", [null, {}, 42]])(
    "should ignore malformed annotation and stored-file data (%j)",
    (input) => {
      expect(filesFromAnnotations(input)).toEqual([]);
      expect(filesFromOutput(input)).toEqual([]);
      expect(storedGeneratedFiles(input)).toEqual([]);
    },
  );

  it.each(["../escape", "https://evil.example", "id?query", "", "id%2fpath"])(
    "should reject unsafe identifiers (%s)",
    (id) => {
      expect(storedGeneratedFiles([{ ...file, fileId: id }])).toEqual([]);
      expect(storedGeneratedFiles([{ ...file, containerId: id }])).toEqual([]);
      expect(
        filesFromAnnotations([{ ...annotation, container_id: id }]),
      ).toEqual([]);
    },
  );

  it.each([
    ["/mnt/data/report.csv", "report.csv"],
    ["..\\report.csv", "report.csv"],
    ["re\u0000port\u202e.csv", "report.csv"],
    ["..", "cfile_test"],
    ["", "cfile_test"],
  ])("should normalize download names (%s)", (filename, expected) => {
    const result = storedGeneratedFiles([{ ...file, filename }]);
    expect(result).toEqual([{ ...file, filename: expected }]);
    expect(storedGeneratedFiles(result)).toEqual(result);
  });

  it("should recover old saved artifact metadata without mutating the response", () => {
    const responseState = {
      id: "resp_saved",
      model: settings.model,
      contextStart: 0,
      contextTurns: 0,
      output: [item],
    };
    const input = [
      { role: "assistant", markdown: "Your report.", responseState },
    ];
    const restored = validateStoredTurns(input);
    expect(restored).toEqual([{ ...input[0], generatedFiles: [file] }]);
    expect(responseState.output).toEqual([item]);
    expect(validateStoredTurns(restored)).toEqual(restored);
  });

  it("should retain artifact-only interrupted turns but not assign artifacts to users", () => {
    expect(
      validateStoredTurns([
        {
          role: "assistant",
          markdown: "",
          generatedFiles: [file],
          stopped: true,
        },
        { role: "user", markdown: "Hello", generatedFiles: [file] },
      ]),
    ).toEqual([
      {
        role: "assistant",
        markdown: "",
        generatedFiles: [file],
        stopped: true,
      },
      { role: "user", markdown: "Hello" },
    ]);
  });

  it.each([
    { type: "response.output_text.annotation.added", annotation },
    { type: "response.content_part.done", part },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: { id: "resp_files", output: [item] },
    },
  ])("should surface artifacts from $type", async (event) => {
    const events =
      event.type === "response.completed"
        ? [event]
        : [
            event,
            {
              type: "response.completed",
              response: { id: "resp_files", output: [] },
            },
          ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
      ),
    );
    const chunks = [];
    for await (const chunk of streamOpenAIChat(
      buildResponseContext(
        [{ role: "user", markdown: "Make a report" }],
        0,
        settings.model,
      ),
      settings,
      new AbortController().signal,
    ))
      chunks.push(chunk);

    expect(chunks.filter((chunk) => chunk.kind === "files")).toEqual([
      { kind: "files", files: [file] },
    ]);
    expect(chunks.at(-1)?.kind).toBe("response-completed");
  });

  it.each([
    [file, "containers/cntr_test/files/cfile_test"],
    [{ fileId: "file_result", filename: "report.csv" }, "files/file_result"],
  ] as const)(
    "should download bytes using the authenticated content endpoint (%j)",
    async (artifact, path) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("a,b\n1,2", {
          headers: { "Content-Type": "text/html" },
        }),
      );
      const signal = new AbortController().signal;

      const blob = await fetchGeneratedFile(artifact, "test-only", signal);

      expect(await blob.text()).toBe("a,b\n1,2");
      expect(blob.type).toBe("application/octet-stream");
      expect(fetch).toHaveBeenCalledWith(
        `https://api.openai.com/v1/${path}/content`,
        {
          headers: { Authorization: "Bearer test-only" },
          signal,
          redirect: "error",
        },
      );
    },
  );

  it.each([
    [404, "no longer available"],
    [410, "no longer available"],
    [401, "key cannot access"],
    [403, "key cannot access"],
    [500, "failed (500)"],
  ])("should explain download failure %s", async (status, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status }),
    );
    await expect(fetchGeneratedFile(file, "test-only")).rejects.toThrow(
      message,
    );
  });

  it("should reject missing keys and invalid references before making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(fetchGeneratedFile(file, "")).rejects.toThrow("API key");
    await expect(
      fetchGeneratedFile({ ...file, fileId: "../escape" }, "test-only"),
    ).rejects.toThrow("Invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should report unreadable network responses without exposing credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("test-only"));
    await expect(fetchGeneratedFile(file, "test-only")).rejects.toThrow(
      "Check your API key",
    );
  });
});
