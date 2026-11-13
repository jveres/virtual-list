import { appendFileSync, mkdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { chatGPTPlugin } from "./demos/streaming/server/chatgpt-plugin.js";
import { scrollIsolationPlugin } from "./scripts/firefox-profile/scroll-isolation.js";

/**
 * Dev-only report sink for the dynamic-height lab: a device (a phone, a
 * tablet) POSTs its trace tail to /__lab/report and it lands in
 * browser-artifacts/device-*.log,
 * one file per user agent, so a run on real Safari for iPadOS can be read
 * back on the desk.
 */
function labReportSink(): Plugin {
  const maxReportBytes = 1_000_000;
  return {
    name: "lab-report-sink",
    configureServer(server) {
      server.middlewares.use("/__lab/report", (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end();
          return;
        }
        let body = "";
        let bytes = 0;
        let rejected = false;
        request.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxReportBytes) {
            rejected = true;
            response.statusCode = 413;
            response.end();
            request.destroy();
            return;
          }
          body += String(chunk);
        });
        request.on("end", () => {
          if (rejected) return;
          try {
            const report = JSON.parse(body) as {
              why: string;
              userAgent: string;
              strategy: string;
              violations: number;
              viewport: { width: number; height: number };
              trace: string[];
            };
            const slug = report.userAgent
              .replace(/[^a-z0-9]+/gi, "-")
              .slice(0, 60)
              .toLowerCase();
            mkdirSync("browser-artifacts", { recursive: true });
            appendFileSync(
              `browser-artifacts/device-${slug}.log`,
              `\n===== ${new Date().toISOString()} ${report.why} · ${report.userAgent} · ${report.strategy} · ${report.viewport.width}×${report.viewport.height} · violations=${report.violations}\n${report.trace.join("\n")}\n`,
            );
            response.statusCode = 204;
          } catch {
            response.statusCode = 400;
          }
          response.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [labReportSink(), chatGPTPlugin(), scrollIsolationPlugin()],
  cacheDir:
    process.env.COMRAK_WASM_LOCAL === "1"
      ? "browser-artifacts/parser-preview-cache"
      : process.env.MARKDOWN_VIEWER_LOCAL === "1"
        ? "browser-artifacts/renderer-preview-cache"
        : undefined,
  // Opt-in owner previews; normal builds retain their GitHub tag pins.
  resolve: {
    alias: [
      ...(process.env.MARKDOWN_VIEWER_LOCAL === "1"
        ? [
            {
              find: /^markdown-viewer$/,
              replacement: new URL(
                "../markdown-viewer/dist/index.js",
                import.meta.url,
              ).pathname,
            },
            {
              find: /^markdown-viewer\/styles\.css$/,
              replacement: new URL(
                "../markdown-viewer/dist/styles/index.css",
                import.meta.url,
              ).pathname,
            },
          ]
        : []),
      ...(process.env.COMRAK_WASM_LOCAL === "1"
        ? [
            {
              find: /^comrak-wasm$/,
              replacement: new URL("../comrak-wasm/index.js", import.meta.url)
                .pathname,
            },
            {
              find: /^comrak-wasm\/comrak\.wasm$/,
              replacement: new URL(
                "../comrak-wasm/pkg/comrak.wasm",
                import.meta.url,
              ).pathname,
            },
          ]
        : []),
    ],
  },
  build: {
    rollupOptions: {
      input: {
        ...(process.env.PAGES_BUILD === "1"
          ? {}
          : {
              "streaming-markdown": new URL(
                "examples/streaming-markdown/index.html",
                import.meta.url,
              ).pathname,
              "streaming-paged": new URL(
                "examples/streaming-paged/index.html",
                import.meta.url,
              ).pathname,
              "streaming-basic": new URL(
                "examples/streaming-basic/index.html",
                import.meta.url,
              ).pathname,
            }),
        main: new URL("index.html", import.meta.url).pathname,
        "scroll-settle": new URL(
          "demos/scroll-settle/index.html",
          import.meta.url,
        ).pathname,
        "dynamic-height": new URL(
          "demos/dynamic-height/index.html",
          import.meta.url,
        ).pathname,
        streaming: new URL("demos/streaming/index.html", import.meta.url)
          .pathname,
        gallery: new URL("demos/gallery/index.html", import.meta.url).pathname,
        feed: new URL("demos/feed/index.html", import.meta.url).pathname,
        newspaper: new URL("demos/newspaper/index.html", import.meta.url)
          .pathname,
        "chat-history": new URL(
          "demos/chat-history/index.html",
          import.meta.url,
        ).pathname,
      },
    },
  },
  server: {
    fs: {
      // The opt-in local renderer checkouts (MARKDOWN_VIEWER_LOCAL=1) live
      // beside this project: ../markdown-viewer and ../comrak-wasm (Wasm).
      allow: [".", "../markdown-viewer", "../comrak-wasm"],
    },
  },
});
