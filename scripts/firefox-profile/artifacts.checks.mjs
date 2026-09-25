import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discardRaw, writeReproduction } from "./artifacts.mjs";

test("raw cleanup preserves summaries and source replay while removing nested captures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-retention-"));
  try {
    await mkdir(join(directory, "firefox"));
    for (const path of [
      "summary.json",
      "run.json",
      "reproduce.json",
      "reproduce.patch",
      "upstream.patch",
      "recording.json",
      "chrome-trace.json.gz",
      "safari-sample.txt",
      "safari-sample-summary.json",
      "snapshot-0.png",
      "firefox/profile.json",
    ])
      await writeFile(join(directory, path), "owned fixture");
    await discardRaw(directory);
    assert.deepEqual((await readdir(directory)).sort(), [
      "reproduce.json",
      "reproduce.patch",
      "run.json",
      "safari-sample-summary.json",
      "summary.json",
      "upstream.patch",
    ]);
    assert.equal(
      await readFile(join(directory, "summary.json"), "utf8"),
      "owned fixture",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reproduction patch reconstructs modified, deleted, and untracked source at the recorded revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-reproduce-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "-q"]);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "integrations"));
    await mkdir(join(root, "patches"));
    await mkdir(join(root, "capture"));
    await writeFile(join(root, "src/value.js"), "export const value = 1;\n");
    await writeFile(
      join(root, "integrations/viewer.css"),
      "p { color: red; }\n",
    );
    await writeFile(
      join(root, "src/removed.js"),
      "export const removed = true;\n",
    );
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "blockExoticSubdeps: false\n",
    );
    git(["add", "src", "integrations", "pnpm-workspace.yaml"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "Fixture",
    ]);
    const revision = git(["rev-parse", "HEAD"]).trim();
    await writeFile(join(root, "src/value.js"), "export const value = 2;\n");
    await writeFile(join(root, "src/new.js"), "export const added = true;\n");
    await writeFile(
      join(root, "integrations/viewer.css"),
      "p { color: blue; }\n",
    );
    git(["rm", "src/removed.js"]);
    await writeFile(
      join(root, "patches/viewer.patch"),
      "reproducible dependency patch\n",
    );
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "patchedDependencies:\n  viewer@1.0.0: patches/viewer.patch\n",
    );
    await writeReproduction(
      join(root, "capture"),
      {
        revision,
        options: {
          browser: "chrome",
          scenario: "follow",
          diagnostic: true,
          traceInvalidations: true,
          scheduler: true,
          safariDetached: true,
          safariSnapshots: true,
          safariSample: { atSeconds: 13.7, durationSeconds: 2, intervalMs: 10 },
          durationMs: 12000,
          seconds: 20,
        },
      },
      root,
    );
    const saved = JSON.parse(
      await readFile(join(root, "capture/reproduce.json"), "utf8"),
    );
    assert.equal(saved.revision, revision);
    assert.ok(saved.command.includes("--browser=chrome"));
    assert.ok(saved.command.includes("--trace-invalidations"));
    assert.ok(saved.command.includes("--scheduler"));
    assert.ok(saved.command.includes("--safari-detached"));
    assert.ok(saved.command.includes("--safari-snapshots"));
    assert.ok(saved.command.includes("--safari-sample=13.7:2:10"));
    assert.ok(saved.command.includes("--stream-ms=12000"));
    assert.equal(Object.keys(saved.sourceHashes).length, 6);
    assert.match(
      saved.sourceHashes["integrations/viewer.css"],
      /^[a-f0-9]{64}$/,
    );
    assert.equal(saved.sourceHashes["src/removed.js"], null);
    await writeReproduction(
      join(root, "capture"),
      {
        revision,
        options: { traceInvalidations: false },
      },
      root,
    );
    const defaults = JSON.parse(
      await readFile(join(root, "capture/reproduce.json"), "utf8"),
    );
    assert.equal(
      defaults.command.some((arg) => arg.startsWith("--trace-invalidations")),
      false,
    );
    git([
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "src",
      "integrations",
      "pnpm-workspace.yaml",
    ]);
    await rm(join(root, "src/new.js"));
    await rm(join(root, "patches/viewer.patch"));
    git(["apply", "capture/reproduce.patch"]);
    await assert.rejects(readFile(join(root, "src/removed.js")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(root, "src/value.js"), "utf8"),
      "export const value = 2;\n",
    );
    assert.equal(
      await readFile(join(root, "src/new.js"), "utf8"),
      "export const added = true;\n",
    );
    assert.equal(
      await readFile(join(root, "integrations/viewer.css"), "utf8"),
      "p { color: blue; }\n",
    );
    assert.equal(
      await readFile(join(root, "patches/viewer.patch"), "utf8"),
      "reproducible dependency patch\n",
    );
    assert.equal(
      await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
      "patchedDependencies:\n  viewer@1.0.0: patches/viewer.patch\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
