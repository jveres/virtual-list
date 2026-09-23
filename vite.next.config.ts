import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import base from "./vite.config.js";

const root = fileURLToPath(new URL(".", import.meta.url));

/** The runtime modules that virtual-list-next replaces, by resolved path. */
const nextRuntimeSwaps = new Map([
  [`${root}src/virtual-list.ts`, `${root}next/src/virtual-list.ts`],
  [`${root}src/index.ts`, `${root}next/src/index.ts`],
]);

type Anchoring = "auto" | "native" | "runtime";
const WRAPPED = "\0virtual-list-next:";

/**
 * Serve the unchanged demos on virtual-list-next: any import that resolves
 * to a replaced runtime module loads its next/ counterpart instead. With
 * `anchoring`, `createVirtualList` defaults to that mode (an explicit
 * option still wins), for side-by-side comparison and for jsdom tests.
 */
export function nextRuntime(anchoring?: Anchoring): Plugin {
  return {
    name: "virtual-list-next",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      const next = resolved && nextRuntimeSwaps.get(resolved.id);
      if (!next) return null;
      return anchoring ? `${WRAPPED}${next}` : { ...resolved, id: next };
    },
    load(id) {
      if (!id.startsWith(WRAPPED)) return null;
      const next = JSON.stringify(id.slice(WRAPPED.length));
      return [
        `export * from ${next};`,
        `import { createVirtualList as create } from ${next};`,
        "export function createVirtualList(viewport, options) {",
        `  return create(viewport, { anchoring: ${JSON.stringify(anchoring)}, ...options });`,
        "}",
      ].join("\n");
    },
  };
}

/** "auto" (native anchoring where supported), "native", or "runtime". */
const anchoring = (process.env.VITE_VL_ANCHORING ?? "auto") as Anchoring;

export default mergeConfig(base, {
  plugins: [nextRuntime(anchoring === "auto" ? undefined : anchoring)],
  // Keep each server's dependency cache apart, so they can run side by side.
  cacheDir: `node_modules/.vite-next-${anchoring}`,
});
