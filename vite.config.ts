import { defineConfig, searchForWorkspaceRoot } from "vite";

const projectRoot = new URL(".", import.meta.url).pathname;
const typefmRoot = new URL("../../typefm", import.meta.url).pathname;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: new URL("index.html", import.meta.url).pathname,
        dynamicChat: new URL(
          "demos/dynamic-chat/dynamic-chat.html",
          import.meta.url,
        ).pathname,
        streaming: new URL("demos/streaming/streaming.html", import.meta.url)
          .pathname,
      },
    },
  },
  server: {
    open: true,
    fs: {
      allow: [searchForWorkspaceRoot(projectRoot), typefmRoot],
    },
  },
});
