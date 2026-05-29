import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: new URL("index.html", import.meta.url).pathname,
        chatHistory: new URL("demos/chat-history/index.html", import.meta.url)
          .pathname,
        dynamicContent: new URL(
          "demos/dynamic-content/index.html",
          import.meta.url,
        ).pathname,
        streaming: new URL("demos/streaming/index.html", import.meta.url)
          .pathname,
      },
    },
  },
  server: {
    open: true,
  },
});
