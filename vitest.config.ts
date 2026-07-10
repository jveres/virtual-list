import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});
