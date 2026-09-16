// Serve the same demos/dependencies with one historical runtime file.
// Baselines isolate virtual-list.ts changes, not whole-release differences.
import { execFileSync } from "node:child_process";
import { createServer } from "vite";

const [revision = "working", portText = "4193"] = process.argv.slice(2);
if (revision !== "working" && !/^[a-f0-9]{7,40}$/.test(revision))
  throw new Error("Expected working or a hexadecimal commit ID");
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Expected port 1024..65535");
const source =
  revision === "working"
    ? null
    : execFileSync("git", ["show", `${revision}:src/virtual-list.ts`], {
        encoding: "utf8",
      });
const server = await createServer({
  server: { host: "127.0.0.1", port, strictPort: true, open: false },
  plugins: [
    {
      name: "profile-runtime-revision",
      enforce: "pre",
      transform(code, id) {
        if (source !== null && id.endsWith("/src/virtual-list.ts"))
          return source;
        return code;
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
