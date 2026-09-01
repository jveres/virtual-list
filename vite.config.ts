import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: new URL("index.html", import.meta.url).pathname,
        streaming: new URL("demos/streaming/index.html", import.meta.url)
          .pathname,
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
