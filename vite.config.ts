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
        gallery: new URL("demos/gallery/index.html", import.meta.url).pathname,
        newspaper: new URL("demos/newspaper/index.html", import.meta.url)
          .pathname,
        virtualListState: new URL(
          "demos/virtual-list-state/index.html",
          import.meta.url,
        ).pathname,
      },
    },
  },
  server: {
    open: true,
    fs: {
      // markdown-viewer is a link: dependency; its assets (e.g. the comrak
      // wasm binary) resolve through the symlink into the sibling checkout,
      // outside this project's default fs.allow root.
      allow: [".", "../markdown-viewer"],
    },
  },
});
