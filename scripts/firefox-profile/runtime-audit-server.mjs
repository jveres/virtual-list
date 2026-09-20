// Owns a local diagnostic server, never an existing application server.
import { createHash } from "node:crypto";
import { createServer } from "vite";
import {
  installRuntimeAudit,
  instrumentDemo,
  instrumentRuntime,
} from "./runtime-audit.mjs";

const port = Number(process.argv[2] ?? 4196);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Expected a port from 1024 through 65535");
const server = await createServer({
  logLevel: "error",
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  plugins: [
    {
      name: "runtime-audit",
      enforce: "pre",
      transform(source, id) {
        if (!id.endsWith("/src/virtual-list.ts"))
          return instrumentDemo(source, id);
        console.log(
          JSON.stringify({
            runtimeSha256: createHash("sha256").update(source).digest("hex"),
          }),
        );
        return instrumentRuntime(source);
      },
      transformIndexHtml() {
        return [
          {
            tag: "script",
            children: `(${installRuntimeAudit.toString()})();`,
            injectTo: "head-prepend",
          },
        ];
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
    JSON.stringify({ pid: process.pid, url: server.resolvedUrls.local[0] }),
  );
} catch (error) {
  await close();
  throw error;
}
