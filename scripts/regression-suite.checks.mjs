import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  discover,
  options,
  root,
  runCase,
  selectCases,
} from "./regression-suite.mjs";

test("discovers grouped regressions without duplicate paths or names", async () => {
  const cases = await discover();
  assert.ok(cases.length > 0);
  assert.equal(new Set(cases.map((c) => c.path)).size, cases.length);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
  assert.deepEqual(
    cases.map((c) => c.path),
    cases.map((c) => c.path).sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(
    (await readdir(resolve(root, "scripts"))).filter((name) =>
      name.endsWith("-regression.mjs"),
    ),
    [],
    "regressions belong in a feature folder so the suite discovers them",
  );
});

const cases = [
  { group: "chat-tree", name: "chat-tree-zoom" },
  { group: "chat-tree", name: "chat-tree-reveal" },
  { group: "gallery", name: "gallery-paging" },
];

test("selects all cases by default and filters multiple feature groups", () => {
  assert.deepEqual(selectCases(cases), cases);
  assert.deepEqual(selectCases(cases, "chat-tree"), cases.slice(0, 2));
  assert.deepEqual(selectCases(cases, "chat-tree,gallery"), cases);
  assert.deepEqual(selectCases(cases, undefined, "zoom"), [cases[0]]);
  assert.deepEqual(selectCases(cases, "chat-tree", "reveal"), [cases[1]]);
});

test("rejects unknown groups and empty matches instead of passing an empty suite", () => {
  assert.throws(() => selectCases(cases, "typo"), /Unknown group: typo/);
  assert.throws(() => selectCases(cases, "gallery", "zoom"), /No regressions/);
});

test("parses pnpm separators and validates timeouts and unknown flags", () => {
  assert.equal(options([]).timeout, 600000);
  assert.equal(options(["--", "--group=gallery", "--list"]).group, "gallery");
  assert.equal(options(["--list"]).list, true);
  assert.equal(options(["--fail-fast"])["fail-fast"], true);
  for (const value of ["0", "-1", "NaN", "Infinity", "86401"]) {
    assert.throws(() => options([`--timeout=${value}`]), /--timeout must/);
  }
  assert.throws(() => options(["--typo"]), /Unknown option/);
});

async function fixture(t, source) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "virtual-list-regression-check-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "fixture.mjs");
  await writeFile(path, source);
  return { path };
}

test("worker forwards the suite URL and runs from the repository root", async (t) => {
  const script = await fixture(
    t,
    'import assert from "node:assert/strict";\n' +
      'assert.equal(process.env.BROWSER_MATRIX_URL, "http://127.0.0.1:1");\n' +
      `assert.equal(process.cwd(), ${JSON.stringify(root)});\n`,
  );
  const result = await runCase(script, {
    url: "http://127.0.0.1:1",
    timeout: 10000,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "passed");
});

test("worker reports an assertion failure without terminating the runner", async (t) => {
  const script = await fixture(
    t,
    'throw new Error("expected fixture failure");',
  );
  const result = await runCase(script, {
    url: "http://127.0.0.1:1",
    timeout: 10000,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "failed (1)");
});

test("worker times out a stuck script", async (t) => {
  const script = await fixture(t, "setInterval(() => {}, 1000);");
  const result = await runCase(script, {
    url: "http://127.0.0.1:1",
    timeout: 1500,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "timed out");
});

test("worker stops a running script on cancellation", async (t) => {
  const script = await fixture(t, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  t.after(() => clearTimeout(timer));
  const result = await runCase(script, {
    url: "http://127.0.0.1:1",
    timeout: 10000,
    signal: controller.signal,
  });
  assert.equal(result.status, "interrupted");
});

test("already-cancelled runs never spawn a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCase(
    { path: "/nonexistent" },
    {
      url: "http://127.0.0.1:1",
      timeout: 10000,
      signal: controller.signal,
    },
  );
  assert.deepEqual(result, { status: "interrupted", durationMs: 0 });
});

test("CLI lists a filtered group without starting a server", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/regression-suite.mjs"),
      "--group=gallery",
      "--match=paging",
      "--list",
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, BROWSER_MATRIX_URL: "invalid" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "gallery: gallery-paging\n1 regression scripts\n",
  );
});

test("CLI returns a nonzero exit code for a mistyped group", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/regression-suite.mjs"), "--group=typo"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown group: typo/);
  assert.equal(result.stdout, "");
});
