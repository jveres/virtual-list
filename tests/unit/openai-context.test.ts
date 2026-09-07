import { describe, expect, it, vi } from "vitest";
import {
  buildResponseContext,
  type ResponseState,
  type StoredTurn,
  streamOpenAIChat,
  validateStoredTurns,
} from "../../demos/streaming/openai";

const model = "gpt-5-mini";
function state(overrides: Partial<ResponseState> = {}): ResponseState {
  return {
    id: "resp_first",
    model,
    contextStart: 0,
    contextTurns: 0,
    output: [
      {
        type: "image_generation_call",
        id: "ig_first",
        status: "completed",
        result: "aGVsbG8=",
      },
    ],
    ...overrides,
  };
}
function history(responseState = state()): StoredTurn[] {
  return [
    { role: "user", markdown: "Draw a cat" },
    {
      role: "assistant",
      markdown: "![Generated image](data:image/png;base64,aGVsbG8=)",
      responseState,
    },
    { role: "user", markdown: "Make it brighter" },
  ];
}
const settings = {
  apiKey: "test-only",
  model,
  tools: { webSearch: false, imageGeneration: true, codeInterpreter: false },
  reasoningSummary: true,
};
function streamResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}
function completed(id = "resp_next") {
  return {
    type: "response.completed",
    response: { id, status: "completed", output: state().output },
  };
}
async function collect(
  context = buildResponseContext(history(), 0, model),
  signal = new AbortController().signal,
) {
  const chunks = [];
  for await (const chunk of streamOpenAIChat(context, settings, signal))
    chunks.push(chunk);
  return chunks;
}

describe("OpenAI response context", () => {
  it("should replay image results without response-only metadata and retain web-search actions", () => {
    const image = {
      ...state().output[0],
      action: "edit",
      output_format: "png",
      revised_prompt: "A brighter cat",
      size: "1024x1024",
      quality: "medium",
    };
    const search = {
      type: "web_search_call",
      id: "ws_first",
      status: "completed",
      action: { type: "search", query: "cat" },
    };
    const turns = validateStoredTurns(
      JSON.parse(JSON.stringify(history(state({ output: [image, search] })))),
    );

    const chained = buildResponseContext(turns, 0, model);
    const rebuilt = buildResponseContext(turns, 12, model);

    expect(chained.fallbackInput).toEqual([
      { role: "user", content: "Draw a cat" },
      state().output[0],
      search,
      { role: "user", content: "Make it brighter" },
    ]);
    expect(rebuilt.input).toEqual(chained.fallbackInput);
    expect(turns[1]?.responseState?.output).toEqual([image, search]);
  });
  it("uses the selected branch's parent and starts fresh for a new conversation", () => {
    const branch = history(state({ id: "resp_alternative" }));
    expect(buildResponseContext(branch, 0, model).previousResponseId).toBe(
      "resp_alternative",
    );
    expect(
      buildResponseContext(
        [{ role: "user", markdown: "New conversation" }],
        0,
        model,
      ).input,
    ).toEqual([{ role: "user", content: "New conversation" }]);
    expect(
      buildResponseContext([], 0, model).previousResponseId,
    ).toBeUndefined();
  });

  it("chains only the new turn while retaining image output for recovery", () => {
    const context = buildResponseContext(
      [...history(), { role: "assistant", markdown: "" }],
      0,
      model,
    );
    expect(context.previousResponseId).toBe("resp_first");
    expect(context.input).toEqual([
      { role: "user", content: "Make it brighter" },
    ]);
    expect(context.fallbackInput).toEqual([
      { role: "user", content: "Draw a cat" },
      ...state().output,
      { role: "user", content: "Make it brighter" },
    ]);
  });

  it.each([1, 2, 12])(
    "rebuilds after changing the context setting to %i",
    (limit) => {
      const context = buildResponseContext(history(), limit, model);
      expect(context.previousResponseId).toBeUndefined();
      expect(context.input).toEqual(context.fallbackInput);
      expect(context.contextStart).toBe(Math.max(0, 3 - limit));
    },
  );

  it("chains a bounded history only until its starting turn moves", () => {
    expect(
      buildResponseContext(history(state({ contextTurns: 3 })), 3, model)
        .previousResponseId,
    ).toBe("resp_first");
    const turns = [
      ...history(state({ contextTurns: 3 })),
      {
        role: "assistant",
        markdown: "Brighter",
        responseState: state({ id: "resp_second", contextTurns: 3 }),
      } as StoredTurn,
      { role: "user", markdown: "Again" } as StoredTurn,
    ];
    const context = buildResponseContext(turns, 3, model);
    expect(context.previousResponseId).toBeUndefined();
    expect(context.contextStart).toBe(2);
    expect(context.input[0]).toEqual({
      role: "user",
      content: "Make it brighter",
    });
  });

  it("does not chain across model changes or partial assistant replies", () => {
    expect(
      buildResponseContext(history(), 0, "different-model").previousResponseId,
    ).toBeUndefined();
    const turns = history();
    delete turns[1]?.responseState;
    expect(
      buildResponseContext(turns, 0, model).previousResponseId,
    ).toBeUndefined();
  });

  it("replays legacy images as image inputs, not base64 text", () => {
    const turns = history();
    delete turns[1]?.responseState;
    const context = buildResponseContext(turns, 0, model);
    expect(context.input[1]).toEqual({
      role: "assistant",
      content: "*[generated image]*",
    });
    expect(context.input[2]).toEqual({
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Image from the preceding conversation turn:",
        },
        {
          type: "input_image",
          image_url: "data:image/png;base64,aGVsbG8=",
          detail: "auto",
        },
      ],
    });
  });

  it("restores structured state from storage and rejects invalid anchors", () => {
    expect(validateStoredTurns(JSON.parse(JSON.stringify(history())))).toEqual(
      history(),
    );
    for (const invalid of [
      null,
      { ...state(), contextStart: -1 },
      {
        ...state(),
        output: [{ type: "message", role: "system", content: [] }],
      },
    ]) {
      expect(
        validateStoredTurns([
          { role: "assistant", markdown: "text", responseState: invalid },
        ]),
      ).toEqual([{ role: "assistant", markdown: "text" }]);
    }
  });

  it("preserves tool-only completed turns across reloads", () => {
    const turns: StoredTurn[] = [
      { role: "assistant", markdown: "", responseState: state() },
    ];
    expect(validateStoredTurns(turns)).toEqual(turns);
    expect(
      validateStoredTurns([
        { role: "user", markdown: "", responseState: state() },
      ]),
    ).toEqual([]);
  });
});

describe("OpenAI chained requests", () => {
  it("propagates cancellation without retrying or committing a response ID", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        init?.signal?.throwIfAborted();
        return streamResponse([completed()]);
      });
    await expect(
      collect(buildResponseContext(history(), 0, model), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles SSE events split across network chunks", async () => {
    const payload = `data: ${JSON.stringify(completed())}\r\n\r\n`;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < payload.length; index += 7)
          controller.enqueue(encoder.encode(payload.slice(index, index + 7)));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    expect(await collect()).toEqual([
      { kind: "response-completed", state: state({ id: "resp_next" }) },
    ]);
  });

  it("sends a previous ID and emits a completed anchor with structured outputs", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return streamResponse([completed()]);
    });
    const chunks = await collect();
    expect(bodies).toEqual([
      expect.objectContaining({
        previous_response_id: "resp_first",
        input: [{ role: "user", content: "Make it brighter" }],
        store: true,
        instructions: expect.any(String),
      }),
    ]);
    expect(chunks).toEqual([
      { kind: "response-completed", state: state({ id: "resp_next" }) },
    ]);
  });

  it("retries a missing remote anchor once with local structured history", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response(
            JSON.stringify({ error: { code: "previous_response_not_found" } }),
            { status: 400 },
          )
        : streamResponse([completed()]);
    });
    await collect();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.previous_response_id).toBeUndefined();
    expect(bodies[1]?.input).toEqual(
      buildResponseContext(history(), 0, model).fallbackInput,
    );
  });

  it.each([401, 429, 500])(
    "does not retry unrelated HTTP %i failures",
    async (status) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("failure", { status }));
      await expect(collect()).rejects.toThrow(String(status));
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["response.failed", "response.incomplete"])(
    "does not save %s as an anchor",
    async (type) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        streamResponse([{ type, response: { error: { message: "Failed" } } }]),
      );
      await expect(collect()).rejects.toThrow();
    },
  );

  it("rejects disconnected streams without a completion anchor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamResponse([
        { type: "response.output_text.delta", delta: "partial" },
      ]),
    );
    await expect(collect()).rejects.toThrow("before completion");
  });
});
