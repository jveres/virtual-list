import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { instrumentChat } from "./chat-instrument.mjs";
import { installChatProbe } from "./chat-probe.mjs";
import { chatWorkload, profileImage } from "./chat-workload.mjs";
import { steadyScrollPlan } from "./steady-scroll.mjs";

export async function createChatProfileServer(options = {}) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const workload = chatWorkload({
    ...options,
    history:
      options.history ??
      (options.scenario === "steady" ? steadyScrollPlan.history : undefined),
  });
  if (
    options.scenario === "steady" &&
    workload.metadata.history !== steadyScrollPlan.history
  )
    throw new Error("The steady scenario requires the whole 20-turn history");
  const config = {
    turns: workload.turns,
    workload: { ...workload.metadata, trail: options.trail ?? "long" },
    diagnostic: options.diagnostic ?? false,
    scheduler: options.scheduler ?? false,
    scenario: options.scenario ?? "follow",
    trail: options.trail ?? "long",
    landing: options.landing ?? "end",
    provider: options.provider ?? "openai",
    limit: options.limit ?? 100000,
  };
  const sources = {};
  const requests = [];
  let recording = null;
  let captureReleased = false;
  const pendingStarts = new Set();
  const streams = new Set();
  // Match the demo's opt-in preview when measuring an owning-repository fix.
  const rendererRoot = resolve(root, "../markdown-viewer");
  const previewRenderer = options.rendererPreview === true;
  const parserRoot = resolve(root, "../comrak-wasm");
  const previewParser = options.parserPreview === true;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    cacheDir:
      options.cacheDir ??
      (previewParser
        ? "browser-artifacts/chat-profile/parser-preview-cache"
        : previewRenderer
          ? "browser-artifacts/chat-profile/renderer-preview-cache"
          : "browser-artifacts/chat-profile/vite-cache"),
    resolve: {
      alias: [
        ...(previewRenderer
          ? [
              {
                find: /^markdown-viewer$/,
                replacement: resolve(rendererRoot, "dist/index.js"),
              },
              {
                find: /^markdown-viewer\/styles\.css$/,
                replacement: resolve(rendererRoot, "dist/styles/index.css"),
              },
            ]
          : []),
        ...(previewParser
          ? [
              {
                find: /^comrak-wasm$/,
                replacement: resolve(parserRoot, "index.js"),
              },
              {
                find: /^comrak-wasm\/comrak\.wasm$/,
                replacement: resolve(parserRoot, "pkg/comrak.wasm"),
              },
            ]
          : []),
      ],
    },
    server: {
      host: "127.0.0.1",
      port: options.port ?? 0,
      strictPort: true,
      hmr: false,
      open: false,
      // Worktrees can share a dependency directory. WASM is served from
      // that real path, not from the node_modules symlink Vite sees here.
      fs: {
        allow: [
          root,
          await realpath(resolve(root, "node_modules")),
          ...(previewRenderer
            ? [
                rendererRoot,
                await realpath(resolve(rendererRoot, "node_modules")),
              ]
            : []),
          ...(previewParser ? [parserRoot] : []),
        ],
      },
    },
    plugins: [
      {
        name: "streaming-chat-profile",
        enforce: "pre",
        transform(source, id) {
          if (id.includes("?") || !id.endsWith(".ts")) return null;
          const path = relative(root, id).split("\\").join("/");
          const code = instrumentChat(source, path, config.diagnostic);
          if (code === source) return null;
          sources[path] = createHash("sha256").update(source).digest("hex");
          return { code, map: null };
        },
        transformIndexHtml() {
          return [
            {
              tag: "script",
              children: `(${installChatProbe.toString()})(${JSON.stringify(config).replaceAll("<", "\\u003c")});`,
              injectTo: "head-prepend",
            },
          ];
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            // The diagnostic server cannot use account relays or remote providers.
            res.setHeader(
              "Content-Security-Policy",
              "connect-src 'self' data: blob:",
            );
            if (req.url === "/__chat-profile/start") {
              res.setHeader("Cache-Control", "no-store");
              if (req.method !== "GET") {
                res.writeHead(405).end();
              } else if (captureReleased) {
                res.writeHead(204).end();
              } else {
                pendingStarts.add(res);
                res.once("close", () => pendingStarts.delete(res));
              }
            } else if (req.url === "/__chat-profile/recording") {
              if (req.method !== "POST") {
                res.statusCode = 405;
                res.end();
                return;
              }
              let body = "";
              req.on("data", (chunk) => {
                body += chunk;
                if (body.length > 40_000_000) req.destroy();
              });
              req.on("end", () => {
                try {
                  recording = JSON.parse(body);
                  res.statusCode = 204;
                } catch {
                  res.statusCode = 400;
                }
                res.end();
              });
            } else if (req.url === "/__chat-profile/image.svg") {
              res.setHeader("Content-Type", "image/svg+xml");
              res.end(profileImage);
            } else if (req.url === "/__chat-profile/responses") {
              if (req.method !== "POST") {
                res.statusCode = 405;
                res.end();
                return;
              }
              const record = {
                start: Date.now(),
                sent: 0,
                backpressure: 0,
                cancelled: false,
                finished: false,
                lateMs: [],
              };
              requests.push(record);
              req.resume(); // Deliberately do not retain prompt, headers, or credentials.
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
              });
              res.flushHeaders();
              let timer;
              let cursor = 0;
              const began = performance.now();
              const cleanup = () => {
                clearTimeout(timer);
                streams.delete(res);
              };
              streams.add(res);
              res.once("close", () => {
                record.cancelled = !record.finished;
                cleanup();
              });
              const pump = () => {
                if (res.destroyed) return;
                const now = performance.now() - began;
                while (
                  cursor < workload.events.length &&
                  workload.events[cursor].at <= now
                ) {
                  const { at, event } = workload.events[cursor++];
                  record.sent++;
                  record.lateMs.push(Math.max(0, now - at));
                  if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) {
                    record.backpressure++;
                    res.once("drain", pump);
                    return;
                  }
                }
                if (cursor === workload.events.length) {
                  record.finished = true;
                  res.end();
                  cleanup();
                } else
                  timer = setTimeout(
                    pump,
                    Math.max(
                      0,
                      workload.events[cursor].at - (performance.now() - began),
                    ),
                  );
              };
              pump();
            } else next();
          });
        },
      },
    ],
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    url: `${server.resolvedUrls.local[0]}demos/streaming/`,
    workload: config.workload,
    sources,
    requests,
    get recording() {
      return recording;
    },
    get captureArmed() {
      return pendingStarts.size > 0;
    },
    releaseCapture() {
      captureReleased = true;
      for (const res of pendingStarts) res.writeHead(204).end();
      pendingStarts.clear();
    },
    async close() {
      for (const res of pendingStarts) res.writeHead(503).end();
      pendingStarts.clear();
      for (const stream of streams) stream.destroy();
      await server.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      diagnostic: { type: "boolean", default: false },
      port: { type: "string", default: "4197" },
      "stream-ms": { type: "string", default: "30000" },
    },
  });
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid port");
  const server = await createChatProfileServer({
    diagnostic: values.diagnostic,
    scenario: "manual",
    durationMs: Number(values["stream-ms"]),
    port,
  });
  console.log(
    `Diagnostic chat: ${server.url}\nOpen in a fresh test profile/private session. Alt+Shift+P starts streaming and capture; Alt+Shift+S stops and downloads JSON. Keep Inspector closed for timing trials.`,
  );
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
