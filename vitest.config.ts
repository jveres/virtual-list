import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    // The viewer ships bundler-resolved imports; exercise its actual parser.
    server: { deps: { inline: ["markdown-viewer", "loom"] } },
  },
});
