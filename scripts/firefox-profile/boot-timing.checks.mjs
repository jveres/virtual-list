import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = new URL("../boot-timing.mjs", import.meta.url);

async function run(args, directory) {
  const child = spawn(process.execPath, [fileURLToPath(script), ...args], {
    env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 1, stderr);
    assert.deepEqual(
      (await readdir(directory)).filter((name) =>
        name.startsWith("boot-timing-"),
      ),
      [],
    );
    return stderr;
  } finally {
    clearTimeout(timer);
  }
}

test("boot timing rejects invalid measurements before launching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boot-check-"));
  try {
    for (const arg of [
      "--runs=1",
      "--runs=NaN",
      "--runs=2.5",
      "--modes=typo",
      "--marks=",
      "--url=file:///tmp/test",
    ]) {
      assert.match(await run([arg], directory), /--runs|--modes|--marks|--url/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("boot timing removes its profile after a failed launch or early browser exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boot-check-"));
  try {
    assert.match(
      await run([`--firefox=${join(directory, "missing")}`], directory),
      /ENOENT/,
    );
    // Node rejects Firefox's flags and exits immediately on every platform.
    assert.match(
      await run([`--firefox=${process.execPath}`], directory),
      /Firefox exited/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
