import { defineConfig } from "vite";

export default defineConfig({
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
