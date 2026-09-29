import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./cpu-contention.mjs", import.meta.url));
for (const code of [0, 7]) {
  test(`CPU contention workers exit with child status ${code}`, () => {
    const result = spawnSync(
      process.execPath,
      [runner, "--", process.execPath, "-e", `process.exit(${code})`],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, code);
    assert.deepEqual(JSON.parse(result.stdout), {
      cpuContention: { workers: 4, periodMs: 20, busyMs: 10 },
    });
  });
}
test("CPU contention workers exit if the command cannot start", () => {
  const result = spawnSync(
    process.execPath,
    [runner, "--", "/nonexistent/profiling-command"],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

test("CPU contention settings reach the child for reproduction metadata", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--",
      process.execPath,
      "-e",
      "console.log(process.env.VIRTUAL_LIST_CPU_CONTENTION)",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0);
  const [reported, inherited] = result.stdout
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(inherited, reported.cpuContention);
});
