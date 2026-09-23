// Serve the same demos/dependencies with one historical runtime (src/ tree).
// Baselines isolate runtime changes, not whole-release differences: demos,
// integrations, and dependencies stay at the working tree.
import { execFileSync } from "node:child_process";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const [revision = "working", portText = "4193"] = process.argv.slice(2);
if (revision !== "working" && !/^[a-f0-9]{7,40}$/.test(revision))
  throw new Error("Expected working or a hexadecimal commit ID");
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Expected port 1024..65535");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The revision's src/ files, by repository path; none for the working tree.
const files =
  revision === "working"
    ? new Set()
    : new Set(
        execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "src"], {
          cwd: root,
          encoding: "utf8",
        })
          .split("\n")
          .filter(Boolean),
      );
const inRevision = (id) => {
  const path = relative(root, id.split("?")[0]).split("\\").join("/");
  return files.has(path) ? path : null;
};
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port, strictPort: true, open: false },
  plugins: [
    {
      name: "profile-runtime-revision",
      enforce: "pre",
      // A relative import between the revision's modules may name a file
      // the working tree no longer has (an older runtime's helpers).
      resolveId(source, importer) {
        if (files.size === 0 || !importer || !source.startsWith(".")) return;
        const from = inRevision(importer);
        if (!from) return;
        const base = posix.join(posix.dirname(from), source);
        for (const path of [
          base,
          base.replace(/\.js$/, ".ts"),
          `${base}.ts`,
          `${base}/index.ts`,
        ])
          if (files.has(path)) return resolve(root, path);
      },
      load(id) {
        const path = files.size > 0 ? inRevision(id) : null;
        if (!path) return;
        return execFileSync("git", ["show", `${revision}:${path}`], {
          cwd: root,
          encoding: "utf8",
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
  console.log({
    pid: process.pid,
    revision,
    url: server.resolvedUrls.local[0],
  });
} catch (error) {
  await close();
  throw error;
}
