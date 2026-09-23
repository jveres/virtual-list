import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import base from "./vite.config.js";

const root = fileURLToPath(new URL(".", import.meta.url));

/** The runtime modules that virtual-list-next replaces, by resolved path. */
export const nextRuntimeSwaps = new Map([
  [`${root}src/virtual-list.ts`, `${root}next/src/virtual-list.ts`],
  [`${root}src/index.ts`, `${root}next/src/index.ts`],
]);

/**
 * Serve the unchanged demos on virtual-list-next: any import that resolves
 * to a replaced runtime module loads its next/ counterpart instead.
 */
export function nextRuntime(): Plugin {
  return {
    name: "virtual-list-next",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      const next = resolved && nextRuntimeSwaps.get(resolved.id);
      return next ? { ...resolved, id: next } : null;
    },
  };
}

export default mergeConfig(base, {
  plugins: [nextRuntime()],
  // Keep the dependency cache apart from a concurrently running main server.
  cacheDir: "node_modules/.vite-next",
});
