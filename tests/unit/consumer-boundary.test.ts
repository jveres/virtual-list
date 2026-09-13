import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : extname(path) === ".ts"
        ? [path]
        : [];
  });
}

describe("consumer boundaries", () => {
  it("should consume only supported library entry points from examples", () => {
    const invalid: string[] = [];
    for (const file of sources(resolve(root, "examples"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g,
      )) {
        const name = match[1]!;
        if (!name.startsWith(".")) continue;
        const target = resolve(dirname(file), name).replace(/\.(js|ts)$/, "");
        if (target.startsWith(`${resolve(root, "examples")}/`)) continue;
        if (
          ["src/index", "src/companions/index", "integrations/index"].some(
            (entry) => target === resolve(root, entry),
          )
        )
          continue;
        invalid.push(`${file}: ${name}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it("should keep demo and renderer dependencies out of the runtime", () => {
    const invalid: string[] = [];
    for (const file of sources(resolve(root, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const name = match[1]!;
        if (
          name.includes("demos/") ||
          name.includes("integrations/") ||
          name === "markdown-viewer"
        )
          invalid.push(`${file}: ${name}`);
      }
    }
    expect(invalid).toEqual([]);
  });
});
