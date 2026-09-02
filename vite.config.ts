import { appendFileSync, mkdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-only report sink for the labs: devices (a phone, a tablet) POST their
 * trace tail to /__lab/report and it lands in browser-artifacts/device-*.log,
 * one file per user agent, so a run on real Safari for iPadOS can be read
 * back on the desk.
 */
function labReportSink(): Plugin {
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
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          try {
            const report = JSON.parse(body) as {
              why: string;
              userAgent: string;
              strategy: string;
              mode: string;
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
              `\n===== ${new Date().toISOString()} ${report.why} · ${report.userAgent} · ${report.strategy} · ${report.mode} · ${report.viewport.width}×${report.viewport.height} · violations=${report.violations}\n${report.trace.join("\n")}\n`,
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
  plugins: [labReportSink()],
  build: {
    rollupOptions: {
      input: {
        main: new URL("index.html", import.meta.url).pathname,
        "scroll-settle": new URL(
          "demos/scroll-settle/index.html",
          import.meta.url,
        ).pathname,
        "dynamic-height": new URL(
          "demos/dynamic-height/index.html",
          import.meta.url,
        ).pathname,
        // The streaming chat demo is the acceptance target; it returns to
        // the build once the v2 runtime can host it.
      },
    },
  },
  server: {
    fs: {
      // Both rendering packages are link: dependencies outside this project's
      // default fs.allow root. The nested comrak link serves the Wasm binary.
      allow: [".", "../markdown-viewer", "../comrak-wasm"],
    },
  },
});
