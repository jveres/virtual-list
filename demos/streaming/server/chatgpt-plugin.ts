import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "vite";
import { ChatGPTAuth, fileCredentialStore } from "./chatgpt-auth.js";
import { createChatGPTRelay } from "./chatgpt-relay.js";

export function chatGPTPlugin(): Plugin {
  return {
    name: "chatgpt-demo-relay",
    apply: "serve",
    configureServer(server) {
      const auth = new ChatGPTAuth(
        fileCredentialStore(
          join(homedir(), ".config", "virtual-list-demo", "chatgpt.json"),
        ),
      );
      const relay = createChatGPTRelay({
        auth,
        ...(process.platform === "darwin"
          ? {
              openLogin: async (url: string) => {
                // Launch Services chooses the user's default browser. No shell,
                // executable selection, or browser profile comes from the client.
                await promisify(execFile)("/usr/bin/open", [url], {
                  timeout: 10_000,
                });
              },
            }
          : {}),
      });
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/__chatgpt/")) return next();
        void relay.handle(request, response);
      });
      server.httpServer?.once("close", () => relay.dispose());
    },
  };
}
