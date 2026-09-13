// Build a copied consumer with no demo files, workspace links, or renderer dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "virtual-list-consumer-"));
try {
  await cp(join(root, "src"), join(directory, "src"), { recursive: true });
  for (const example of ["streaming-basic", "streaming-paged"]) {
    await cp(
      join(root, "examples", example),
      join(directory, "examples", example),
      { recursive: true },
    );
    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
        join(directory, "examples", example),
        "--outDir",
        join(directory, "output", example),
      ],
      { cwd: directory, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.status, 0, "isolated consumer build failed");
    assert.ok(
      (await readdir(join(directory, "output", example))).includes(
        "index.html",
      ),
    );
    console.log(`Source distribution: isolated ${example} build passed`);
  }
} finally {
  // Only the fresh, owned temporary directory; never the workspace or captures.
  await rm(directory, { recursive: true, force: true });
}
