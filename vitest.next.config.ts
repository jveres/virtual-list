import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { parityPattern } from "./next/tests/parity.js";
import { nextRuntime } from "./vite.next.config.js";

/** Run the src/ contract suite under next's one commit rule ("live"). */
function liveHarness(): Plugin {
  return {
    name: "virtual-list-next-live-harness",
    transform(code, id) {
      if (!id.endsWith("tests/unit/virtual-list.test.ts")) return null;
      const harness = 'hooks.scrollingUpdates ?? "same-height"';
      if (!code.includes(harness))
        throw new Error("the contract suite's harness moved");
      return code.replace(harness, 'hooks.scrollingUpdates ?? "live"');
    },
  };
}

/**
 * The runtime's contract suite, run against virtual-list-next through the
 * same module swap the demos use, plus next's own tests. See
 * next/tests/parity.ts for the excluded, intentionally changed tests.
 */
export default defineConfig({
  // The suite describes runtime anchoring; jsdom claims native support.
  plugins: [nextRuntime("runtime"), liveHarness()],
  test: {
    include: ["next/tests/**/*.test.ts", "tests/unit/virtual-list.test.ts"],
    testNamePattern: parityPattern,
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});
