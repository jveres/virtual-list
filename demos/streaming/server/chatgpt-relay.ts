import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { ChatGPTAuth } from "./chatgpt-auth.js";

const BACKEND = "https://chatgpt.com/backend-api/codex";
// Older compatibility versions can return only hidden catalog entries.
const CODEX_CATALOG_CLIENT_VERSION = "0.154.0";
const MAX_BODY_BYTES = 24 * 1024 * 1024;

class HTTPError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorized(request: IncomingMessage): boolean {
  if (request.headers["x-virtual-list-client"] !== "streaming-demo")
    return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  // Do not trust arbitrary Host headers: an attacker-controlled DNS name can
  // resolve to the LAN server while still appearing same-origin to a browser.
  try {
    const host = new URL(`http://${request.headers.host ?? ""}`);
    const address = host.hostname.replace(/^\[|\]$/g, "");
    const localAddress = request.socket.localAddress?.replace(/^::ffff:/, "");
    const localName = hostname().toLowerCase();
    if (
      host.username ||
      host.password ||
      host.pathname !== "/" ||
      host.search ||
      host.hash ||
      ![
        "localhost",
        "127.0.0.1",
        "::1",
        localAddress,
        localName,
        `${localName}.local`,
      ].includes(address)
    )
      return false;
  } catch {
    return false;
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.host !== request.headers.host
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw new HTTPError(415, "Send application/json.");
  }
  const body = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        finish(
          new HTTPError(413, "ChatGPT request exceeds the 24 MiB demo limit."),
        );
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () =>
      finish(new HTTPError(400, "Request body could not be read."));
    const aborted = () => finish(new HTTPError(400, "Request cancelled."));
    const timer = setTimeout(
      () => finish(new HTTPError(408, "Request body timed out.")),
      30_000,
    );
    request
      .on("data", data)
      .once("end", end)
      .once("error", failed)
      .once("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new HTTPError(400, "Invalid JSON request.");
  }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/** Same-origin, trusted-LAN relay. It owns no conversation or agent state. */
export function createChatGPTRelay({
  auth,
  openLogin,
  fetcher = fetch,
}: {
  auth: ChatGPTAuth;
  openLogin?: (url: string) => Promise<void>;
  fetcher?: typeof fetch;
}): {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  dispose(): void;
} {
  const active = new Set<AbortController>();
  let disposed = false;

  async function upstream(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    const credentials = await auth.getCredentials();
    signal.throwIfAborted();
    const result = await fetcher(`${BACKEND}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credentials.access}`,
        "ChatGPT-Account-Id": credentials.accountId,
        "content-type": "application/json",
        originator: "virtual-list-demo",
        "OpenAI-Beta": "responses=experimental",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "error",
    });
    if (!result.ok) {
      const value: unknown = await result.json().catch(() => null);
      const error = record(value) && record(value.error) ? value.error : value;
      let detail =
        record(error) && typeof error.message === "string"
          ? error.message
          : record(value) && typeof value.detail === "string"
            ? value.detail
            : "Request rejected";
      for (const secret of [
        credentials.access,
        credentials.refresh,
        credentials.accountId,
      ])
        detail = detail.replaceAll(secret, "[redacted]");
      throw new HTTPError(
        result.status,
        `ChatGPT: ${detail.slice(0, 1500)} (${result.status}).${result.status === 401 ? " Sign out and sign in again." : ""}`,
      );
    }
    return result;
  }

  async function models(signal: AbortSignal): Promise<string[]> {
    const response = await upstream(
      `/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
      signal,
    );
    const value: unknown = await response.json().catch(() => null);
    if (!record(value) || !Array.isArray(value.models))
      throw new HTTPError(
        502,
        "OpenAI returned an invalid model catalog. Enter a model explicitly.",
      );
    const entries = value.models;
    const models = entries
      .filter(record)
      .filter((item) => item.visibility !== "hide")
      .map((item) => item.slug)
      .filter(
        (slug): slug is string => typeof slug === "string" && slug.length > 0,
      );
    if (!models.length)
      throw new HTTPError(
        502,
        "OpenAI returned no selectable models for this client version. Enter a model explicitly.",
      );
    return [...new Set(models)];
  }

  return {
    dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      auth.dispose();
    },
    async handle(request, response) {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      const controller = new AbortController();
      const close = () => controller.abort();
      response.once("close", close);
      try {
        if (!authorized(request))
          throw new HTTPError(
            403,
            "Open the streaming demo directly on this dev server. Cross-origin relay requests are not allowed.",
          );
        if (disposed)
          throw new HTTPError(503, "ChatGPT relay is shutting down.");
        const path = request.url?.split("?")[0];
        const signingOut =
          path === "/__chatgpt/logout" && request.method === "POST";
        if (active.size >= 4 && !signingOut)
          throw new HTTPError(
            429,
            "Too many ChatGPT relay requests. Try again shortly.",
          );
        active.add(controller);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(
            path === "/__chatgpt/responses" ? 15 * 60_000 : 60_000,
          ),
        ]);
        if (path === "/__chatgpt/status" && request.method === "GET") {
          json(response, await auth.status());
        } else if (path === "/__chatgpt/login" && request.method === "POST") {
          const status = await auth.startLogin();
          let browserOpened = false;
          if (status.login && openLogin) {
            try {
              await openLogin("https://auth.openai.com/codex/device");
              browserOpened = true;
            } catch {
              /* Keep the code and manual link usable if macOS cannot open a browser. */
            }
          }
          json(response, { ...status, browserOpened });
        } else if (path === "/__chatgpt/logout" && request.method === "POST") {
          // Stop requests using this account before forgetting its credentials.
          for (const other of active) if (other !== controller) other.abort();
          await auth.logout();
          json(response, { authenticated: false });
        } else if (path === "/__chatgpt/models" && request.method === "GET") {
          json(response, { models: await models(signal) });
        } else if (
          path === "/__chatgpt/responses" &&
          request.method === "POST"
        ) {
          const value = await readBody(request, signal);
          if (
            !record(value) ||
            !Array.isArray(value.input) ||
            value.input.length > 20_000 ||
            typeof value.model !== "string" ||
            value.model.length > 200 ||
            typeof value.instructions !== "string"
          )
            throw new HTTPError(400, "Invalid ChatGPT response request.");
          const model = value.model.trim() || (await models(signal))[0];
          // Deliberately omit conversation/previous_response_id and all unknown options.
          const body = {
            model,
            instructions: value.instructions,
            input: value.input,
            stream: true,
            store: false,
            include: ["reasoning.encrypted_content"],
            ...(Array.isArray(value.tools) ? { tools: value.tools } : {}),
            ...(record(value.reasoning) ? { reasoning: value.reasoning } : {}),
          };
          const result = await upstream("/responses", signal, body);
          if (!result.body)
            throw new HTTPError(502, "ChatGPT returned no stream.");
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          });
          await pipeline(
            Readable.fromWeb(result.body as ReadableStream<Uint8Array>),
            response,
            { signal },
          );
        } else {
          throw new HTTPError(404, "Unknown ChatGPT relay route or method.");
        }
      } catch (error) {
        if (!response.destroyed && !response.headersSent) {
          json(
            response,
            {
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : "ChatGPT relay failed.",
              },
            },
            error instanceof HTTPError ? error.status : 502,
          );
        } else if (!response.destroyed) response.destroy();
      } finally {
        request.resume();
        active.delete(controller);
        response.off("close", close);
      }
    },
  };
}
