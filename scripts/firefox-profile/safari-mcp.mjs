import assert from "node:assert/strict";
import { createInterface } from "node:readline";

// Safari 27's supported stdio transport launches its own --automation instance.
// Keep results small; the page posts the large recording to our local server.
export class SafariMcp {
  #child;
  #pending = new Map();
  #next = 0;
  #failure;

  constructor(child) {
    this.#child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        const pending = this.#pending.get(message.id);
        if (!pending) return; // Notifications or a late, cancelled reply.
        if (message.error)
          pending.reject(new Error(`Safari MCP: ${message.error.message}`));
        else pending.resolve(message.result);
      } catch (error) {
        this.#fail(new Error("Invalid Safari MCP response", { cause: error }));
      }
    });
    child.once("error", (error) => this.#fail(error));
    child.stdin.on("error", (error) => this.#fail(error));
    child.once("close", () => {
      lines.close();
      this.#fail(new Error("Safari MCP exited"));
    });
  }

  #fail(error) {
    this.#failure ??= error;
    for (const request of this.#pending.values()) request.reject(error);
  }

  request(method, params, { signal, timeoutMs = 45000 } = {}) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      const timer = setTimeout(
        () => finish(reject, new Error(`Safari MCP ${method} timed out`)),
        timeoutMs,
      );
      this.#pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async initialize(options) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "virtual-list-chat-profiler", version: "1" },
      },
      options,
    );
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return result.serverInfo;
  }

  async tool(name, args, options) {
    const result = await this.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      options,
    );
    const text = result?.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (result?.isError) throw new Error(`Safari ${name}: ${text}`);
    assert.equal(typeof text, "string", `Missing Safari ${name} result`);
    return text;
  }
}
