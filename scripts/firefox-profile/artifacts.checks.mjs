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
      "recording.json",
      "chrome-trace.json.gz",
      "firefox/profile.json",
    ])
      await writeFile(join(directory, path), "owned fixture");
    await discardRaw(directory);
    assert.deepEqual((await readdir(directory)).sort(), [
      "reproduce.json",
      "reproduce.patch",
      "run.json",
      "summary.json",
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
    await mkdir(join(root, "capture"));
    await writeFile(join(root, "src/value.js"), "export const value = 1;\n");
    await writeFile(
      join(root, "src/removed.js"),
      "export const removed = true;\n",
    );
    git(["add", "src"]);
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
    git(["rm", "src/removed.js"]);
    await writeReproduction(
      join(root, "capture"),
      {
        revision,
        options: {
          browser: "safari",
          scenario: "follow",
          diagnostic: true,
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
    assert.ok(saved.command.includes("--browser=safari"));
    assert.ok(saved.command.includes("--stream-ms=12000"));
    assert.equal(Object.keys(saved.sourceHashes).length, 3);
    assert.equal(saved.sourceHashes["src/removed.js"], null);
    git(["restore", "--source=HEAD", "--staged", "--worktree", "src"]);
    await rm(join(root, "src/new.js"));
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
