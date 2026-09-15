import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTurn } from "../../demos/streaming/openai";

beforeEach(() => {
  vi.resetModules();
});

const settings = {
  provider: "chatgpt" as const,
  apiKey: "must-not-be-used",
  model: "test-model",
  tools: { webSearch: true, imageGeneration: false, codeInterpreter: false },
  reasoningSummary: true,
};

function fixtureResponse() {
  const output = [
    {
      type: "reasoning",
      id: "rs_test",
      summary: [],
      encrypted_content: "opaque-reasoning",
    },
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Reply", annotations: [] }],
    },
  ];
  const events = [
    { type: "response.output_text.delta", delta: "Reply" },
    {
      type: "response.completed",
      response: { id: "resp_test", model: "test-model", output },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
}

describe("ChatGPT stateless Responses adapter", () => {
  it("should include code interpreter in subscription requests when enabled", async () => {
    const { streamOpenAIChat } = await import("../../demos/streaming/openai");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fixtureResponse());
    const options = {
      ...settings,
      tools: { webSearch: true, imageGeneration: true, codeInterpreter: true },
    };
    for await (const _chunk of streamOpenAIChat(
      {
        input: [],
        fallbackInput: [{ role: "user", content: "hi" }],
        contextStart: 0,
        contextTurns: 0,
      },
      options,
      new AbortController().signal,
    )) {
      /* drain */
    }
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([
      { type: "web_search" },
      { type: "image_generation", output_format: "jpeg", partial_images: 2 },
      { type: "code_interpreter", container: { type: "auto" } },
      expect.objectContaining({ type: "function", name: "create_file" }),
    ]);
    expect(options.tools.codeInterpreter).toBe(true);
  });

  it("should retain code interpreter for API-token requests", async () => {
    const { streamOpenAIChat } = await import("../../demos/streaming/openai");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fixtureResponse());
    for await (const _chunk of streamOpenAIChat(
      {
        input: [{ role: "user", content: "hi" }],
        fallbackInput: [],
        contextStart: 0,
        contextTurns: 0,
      },
      {
        ...settings,
        provider: "openai",
        tools: {
          webSearch: false,
          imageGeneration: false,
          codeInterpreter: true,
        },
      },
      new AbortController().signal,
    )) {
      /* drain */
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).tools).toEqual([
      { type: "code_interpreter", container: { type: "auto" } },
    ]);
  });
  it("should ignore a chain anchor and retain complete local history and opaque reasoning", async () => {
    const { buildResponseContext, streamOpenAIChat } = await import(
      "../../demos/streaming/openai"
    );
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fixtureResponse());
    const history: StoredTurn[] = [
      { role: "user", markdown: "First" },
      {
        role: "assistant",
        markdown: "Earlier reply",
        responseState: {
          id: "resp_old",
          model: "test-model",
          contextStart: 0,
          contextTurns: 0,
          output: [
            {
              type: "message",
              id: "msg_old",
              role: "assistant",
              phase: "final_answer",
              content: [
                { type: "output_text", text: "Earlier reply", annotations: [] },
              ],
            },
          ],
        },
      },
      { role: "user", markdown: "Follow-up" },
    ];
    const context = buildResponseContext(history, 0, "test-model");
    expect(context.previousResponseId).toBe("resp_old");
    const chunks = [];
    for await (const chunk of streamOpenAIChat(
      context,
      settings,
      new AbortController().signal,
    ))
      chunks.push(chunk);
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/__chatgpt/responses");
    expect(new Headers(request?.headers).get("authorization")).toBeNull();
    expect(new Headers(request?.headers).get("x-virtual-list-client")).toBe(
      "streaming-demo",
    );
    const body = JSON.parse(String(request?.body));
    expect(body.store).toBe(false);
    expect(body.previous_response_id).toBeUndefined();
    expect(body.input).toEqual(context.fallbackInput);
    expect(chunks[0]).toEqual({ kind: "text", text: "Reply" });
    const completed = chunks.at(-1);
    if (completed?.kind !== "response-completed")
      throw new Error("Missing response state");
    expect(completed.state.provider).toBe("chatgpt");
    expect(completed.state.output[0]?.encrypted_content).toBe(
      "opaque-reasoning",
    );
    const next = buildResponseContext(
      [
        ...history,
        {
          role: "assistant",
          markdown: "Reply",
          responseState: completed.state,
        },
        { role: "user", markdown: "Next" },
      ],
      0,
      "test-model",
    );
    expect(next.previousResponseId).toBeUndefined();
    expect(next.input).toContainEqual(completed.state.output[0]);
    expect(next.input).toContainEqual(completed.state.output[1]);
  });

  it("should apply context limits and not send a deleted continuation", async () => {
    const { buildResponseContext, streamOpenAIChat } = await import(
      "../../demos/streaming/openai"
    );
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fixtureResponse());
    const history: StoredTurn[] = [
      { role: "user", markdown: "Old prompt" },
      { role: "assistant", markdown: "Old answer" },
      { role: "user", markdown: "Edited prompt" },
    ];
    for await (const _chunk of streamOpenAIChat(
      buildResponseContext(history, 1, "test-model"),
      settings,
      new AbortController().signal,
    )) {
      /* drain */
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).input).toEqual([
      { role: "user", content: "Edited prompt" },
    ]);
  });

  it("should use the relay without any browser-held credential", async () => {
    const { streamOpenAIChat } = await import("../../demos/streaming/openai");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fixtureResponse());
    const stream = streamOpenAIChat(
      { input: [], fallbackInput: [], contextStart: 0, contextTurns: 0 },
      { ...settings, apiKey: "" },
      new AbortController().signal,
    );
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { kind: "text", text: "Reply" },
    });
    await stream.return();
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBeNull();
  });
});
