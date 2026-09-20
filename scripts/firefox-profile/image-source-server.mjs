// Frozen, demo-only source overlays for the image-source microbenchmark.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/firefox-profile/image-source-server.mjs [working|commit-hex] [port]\nServes a synthetic image-source benchmark; no browser is launched. Call window.runImageSourceBenchmark({lengths:[65536,524288,2097152],repeats:5,iterations:8}) in Safari or Firefox. Sources are frozen at server startup. ORDERED_CONTENT_PROBE=1 enables the diagnostic render callback bridge for scenario:'ordered-content', orderedCache:'off'|'on'; application files are not edited.",
  );
  process.exit(0);
}
const [revision = "working", portText = "4196"] = process.argv.slice(2);
if (revision !== "working" && !/^[a-f0-9]{7,40}$/.test(revision))
  throw new Error("Expected working or hexadecimal commit ID");
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid port");
if (![undefined, "0", "1"].includes(process.env.ORDERED_CONTENT_PROBE))
  throw new Error("ORDERED_CONTENT_PROBE must be 0 or 1");
const orderedContentProbe = process.env.ORDERED_CONTENT_PROBE === "1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const paths = [
  "demos/streaming/image-preview.ts",
  "demos/streaming/attachments.ts",
  "demos/streaming/message-content.ts",
];
const sources = new Map(
  await Promise.all(
    paths.map(async (path) => [
      path,
      revision === "working"
        ? await readFile(new URL(`../../${path}`, import.meta.url), "utf8")
        : execFileSync("git", ["show", `${revision}:${path}`], {
            cwd: root,
            encoding: "utf8",
          }),
    ]),
  ),
);
const metadata = {
  revision,
  orderedContentProbe,
  sourceSha256: Object.fromEntries(
    [...sources].map(([path, source]) => [
      path,
      createHash("sha256").update(source).digest("hex"),
    ]),
  ),
};
if (orderedContentProbe) {
  const path = "demos/streaming/message-content.ts";
  const source = sources.get(path);
  const target = "markdown.innerHTML = renderMarkdown(part.text);";
  if (source.split(target).length !== 2)
    throw new Error("Static renderer changed; review the diagnostic bridge");
  const transformed = source.replace(
    target,
    "markdown.innerHTML = globalThis.__imageSourceBenchmarkRenderText ? globalThis.__imageSourceBenchmarkRenderText(message, part.key, part.text, renderMarkdown) : renderMarkdown(part.text);",
  );
  sources.set(path, transformed);
  metadata.diagnosticSourceSha256 = createHash("sha256")
    .update(transformed)
    .digest("hex");
}
const server = await createServer({
  root,
  logLevel: "error",
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    open: false,
    hmr: false,
  },
  plugins: [
    {
      name: "image-source-revision",
      enforce: "pre",
      transform(code, id) {
        for (const [path, source] of sources)
          if (id.split("?")[0].endsWith(`/${path}`)) return source;
        return code;
      },
      configureServer(vite) {
        vite.middlewares.use("/__image-source/metadata", (_req, res) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(metadata));
        });
      },
    },
  ],
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
try {
  await server.listen();
  console.log(
    JSON.stringify(
      {
        ...metadata,
        pid: process.pid,
        url: `${server.resolvedUrls.local[0]}scripts/firefox-profile/fixtures/image-source.html`,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await close();
  throw error;
}
