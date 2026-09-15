import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGPTAuth } from "../../demos/streaming/server/chatgpt-auth";
import { createChatGPTRelay } from "../../demos/streaming/server/chatgpt-relay";

describe("ChatGPT HTTP relay", () => {
  let server: Server;
  let relay: ReturnType<typeof createChatGPTRelay>;
  let base: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let openLogin: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  const headers = {
    "x-virtual-list-client": "streaming-demo",
    "content-type": "application/json",
  };

  beforeEach(async () => {
    fetcher = vi.fn<typeof fetch>();
    openLogin = vi
      .fn<(url: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const auth = new ChatGPTAuth(
      {
        load: async () => ({
          access: "private-access",
          refresh: "private-refresh",
          accountId: "private-account",
          expires: Date.now() + 3600000,
        }),
        save: async () => {},
      },
      fetcher,
    );
    relay = createChatGPTRelay({ auth, fetcher, openLogin });
    server = createServer((request, response) => {
      void relay.handle(request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    relay.dispose();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });

  it.each<Record<string, string>>([
    {},
    { "x-virtual-list-client": "wrong-client" },
    { ...headers, origin: "https://other.example" },
    { ...headers, origin: "null" },
    { ...headers, "sec-fetch-site": "cross-site" },
    { ...headers, host: "attacker.example", origin: "http://attacker.example" },
  ])(
    "should reject cross-origin, simple, or DNS-rebinding requests: %j",
    async (requestHeaders) => {
      const response = await fetch(`${base}/__chatgpt/status`, {
        headers: requestHeaders,
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("should expose status without exposing tokens or invoking inference", async () => {
    const response = await fetch(`${base}/__chatgpt/status`, {
      headers: { ...headers, origin: base },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ authenticated: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should open the fixed ChatGPT login URL through the server's browser launcher", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({
        device_auth_id: "private-device-id",
        user_code: "TEST-CODE",
        interval: "5",
      }),
    );
    const response = await fetch(`${base}/__chatgpt/login`, {
      method: "POST",
      headers,
    });
    const value = await response.json();
    expect(value.browserOpened).toBe(true);
    expect(value.login.userCode).toBe("TEST-CODE");
    expect(openLogin).toHaveBeenCalledExactlyOnceWith(
      "https://auth.openai.com/codex/device",
    );
    expect(JSON.stringify(value)).not.toContain("private-device-id");
  });

  it("should keep the manual login link usable if opening the default browser fails", async () => {
    openLogin.mockRejectedValueOnce(new Error("OS launch failed"));
    fetcher.mockResolvedValueOnce(
      Response.json({
        device_auth_id: "private-device-id",
        user_code: "TEST-CODE",
        interval: 5,
      }),
    );
    const response = await fetch(`${base}/__chatgpt/login`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.browserOpened).toBe(false);
    expect(value.login.url).toBe("https://auth.openai.com/codex/device");
    expect(value.login.userCode).toBe("TEST-CODE");
  });

  it("should stream only to the fixed subscription backend and force stateless context", async () => {
    fetcher.mockResolvedValueOnce(
      new Response('data: {"type":"response.completed"}\n\n'),
    );
    const input = [{ role: "user", content: "Hello" }];
    const response = await fetch(`${base}/__chatgpt/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "test-model",
        instructions: "test",
        input,
        store: true,
        previous_response_id: "resp_old",
        conversation: "conv_old",
        baseURL: "https://evil.example",
        tools: [
          { type: "web_search" },
          { type: "code_interpreter", container: { type: "auto" } },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      'data: {"type":"response.completed"}\n\n',
    );
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer private-access",
    );
    expect(new Headers(request?.headers).get("ChatGPT-Account-Id")).toBe(
      "private-account",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "test-model",
      instructions: "test",
      input,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [
        { type: "web_search" },
        { type: "code_interpreter", container: { type: "auto" } },
      ],
    });
    expect(request?.redirect).toBe("error");
  });

  it("should resolve a blank model from the authenticated account catalog", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({
        models: [
          { slug: "hidden", visibility: "hide" },
          { slug: "available-model" },
        ],
      }),
    );
    fetcher.mockResolvedValueOnce(new Response("data: done\n\n"));
    const response = await fetch(`${base}/__chatgpt/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "", instructions: "test", input: [] }),
    });
    expect(await response.text()).toBe("data: done\n\n");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).model).toBe(
      "available-model",
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0",
    );
  });

  it("should request a compatible catalog version instead of the hidden-only legacy catalog", async () => {
    fetcher.mockImplementation(async (url) =>
      Response.json({
        models:
          new URL(String(url)).searchParams.get("client_version") === "0.154.0"
            ? [
                { slug: "current-model", visibility: "list" },
                { slug: "internal-model", visibility: "hide" },
              ]
            : [{ slug: "internal-model", visibility: "hide" }],
      }),
    );
    const response = await fetch(`${base}/__chatgpt/models`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: ["current-model"] });
  });

  it.each([
    { models: [] },
    { models: [{ slug: "internal-model", visibility: "hide" }] },
  ])(
    "should not suggest signing in again when the catalog has no selectable models: %j",
    async (catalog) => {
      fetcher.mockResolvedValueOnce(Response.json(catalog));
      const response = await fetch(`${base}/__chatgpt/models`, { headers });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          message:
            "OpenAI returned no selectable models for this client version. Enter a model explicitly.",
        },
      });
    },
  );

  it.each([null, { data: [] }])(
    "should distinguish a malformed model catalog from an empty list: %j",
    async (catalog) => {
      fetcher.mockResolvedValueOnce(Response.json(catalog));
      const response = await fetch(`${base}/__chatgpt/models`, { headers });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          message:
            "OpenAI returned an invalid model catalog. Enter a model explicitly.",
        },
      });
    },
  );

  it.each([
    null,
    {},
    { model: "model", instructions: "test", input: "not-an-array" },
  ])(
    "should reject malformed requests before any upstream call: %j",
    async (body) => {
      const response = await fetch(`${base}/__chatgpt/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("should reject oversized bodies and non-JSON content types", async () => {
    const unsupported = await fetch(`${base}/__chatgpt/responses`, {
      method: "POST",
      headers: { "x-virtual-list-client": "streaming-demo" },
      body: "text",
    });
    expect(unsupported.status).toBe(415);
    const oversized = await fetch(`${base}/__chatgpt/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "x".repeat(24 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("should redact credentials from upstream errors without API fallback", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json(
        { detail: "private-access private-refresh private-account rejected" },
        { status: 401 },
      ),
    );
    const response = await fetch(`${base}/__chatgpt/models`, { headers });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain("private-");
    expect(body).toContain("Sign out and sign in again");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("should cancel the upstream stream when the browser disconnects", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    fetcher.mockImplementationOnce(async (_url, request) => {
      upstreamSignal = request?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
          },
        }),
      );
    });
    const controller = new AbortController();
    const response = await fetch(`${base}/__chatgpt/responses`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: "test", instructions: "test", input: [] }),
    });
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    controller.abort();
    await reader?.cancel().catch(() => {});
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });

  it("should allow sign-out at the concurrency limit and cancel every active stream", async () => {
    const signals: AbortSignal[] = [];
    fetcher.mockImplementation(async (_url, request) => {
      if (request?.signal) signals.push(request.signal);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
          },
        }),
      );
    });
    const streams = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${base}/__chatgpt/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "test",
            instructions: "test",
            input: [],
          }),
        }),
      ),
    );
    try {
      const limited = await fetch(`${base}/__chatgpt/models`, { headers });
      expect(limited.status).toBe(429);
      const logout = await fetch(`${base}/__chatgpt/logout`, {
        method: "POST",
        headers,
      });
      expect(logout.status).toBe(200);
      expect(await logout.json()).toEqual({ authenticated: false });
      await vi.waitFor(() =>
        expect(signals.map((signal) => signal.aborted)).toEqual([
          true,
          true,
          true,
          true,
        ]),
      );
      const status = await fetch(`${base}/__chatgpt/status`, { headers });
      expect(await status.json()).toEqual({ authenticated: false });
    } finally {
      await Promise.all(
        streams.map((response) => response.body?.cancel().catch(() => {})),
      );
    }
  });

  it("should release an unfinished upload immediately when the relay is disposed", async () => {
    const upload = httpRequest(`${base}/__chatgpt/responses`, {
      method: "POST",
      headers,
    });
    const result = new Promise<number | undefined>((resolve, reject) => {
      upload.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      upload.on("error", reject);
    });
    try {
      const received = once(server, "request");
      upload.write("{");
      await received;
      relay.dispose();
      await expect(result).resolves.toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      upload.destroy();
    }
  });
});
