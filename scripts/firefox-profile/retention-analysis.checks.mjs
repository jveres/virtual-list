import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { summarizeRetentionMemory } from "./retention-analysis.mjs";

test("retention report sums fixture leaves without cross-counting other windows or totals", () => {
  const process = "Web Content (pid 123)";
  const prefix =
    "explicit/window-objects/top(http://localhost/fixture.html, id=1)/active/window";
  const rows = [
    { process, path: `${prefix}/dom/element-nodes`, amount: 10 },
    { process, path: `${prefix}/layout/frames`, amount: 20 },
    { process, path: `${prefix}/js-zone/strings`, amount: 30 },
    {
      process,
      path: "explicit/window-objects/top(about:blank)/dom/nodes",
      amount: 999,
    },
    { process, path: "window-objects/dom/element-nodes", amount: 999 },
    { process, path: "heap-allocated", amount: 100 },
    { process: "Parent", path: "heap-allocated", amount: 999 },
  ];
  assert.deepEqual(summarizeRetentionMemory(rows, "/fixture.html"), {
    process,
    windowBytes: 60,
    windowDomBytes: 10,
    windowLayoutBytes: 20,
    contentHeapAllocated: 100,
    contentResident: null,
    contentJsGcHeap: null,
    contentHeapUnclassified: null,
    windowClasses: {},
  });
  assert.equal(
    summarizeRetentionMemory(
      rows.map((row) => ({
        ...row,
        path: row.path.replace(
          "http://localhost/fixture.html",
          "http:\\\\localhost\\fixture.html",
        ),
      })),
      "/fixture.html",
    ).windowBytes,
    60,
  );
  assert.throws(
    () => summarizeRetentionMemory(rows, "/missing.html"),
    /Missing fixture/,
  );
  assert.throws(
    () =>
      summarizeRetentionMemory(
        [...rows, { ...rows[0], process: "Other" }],
        "/fixture.html",
      ),
    /multiple processes/,
  );
});

test("retention summary preserves buffer accounting separately from window classes", () => {
  const prefix =
    "explicit/window-objects/top(http://localhost/fixture.html)/active/window/js-realm/classes";
  const rows = [
    {
      process: "content",
      path: `${prefix}/class(Float64Array)/objects/gc-heap`,
      amount: 80,
    },
    {
      process: "content",
      path: `${prefix}/class(Float64Array)/objects/malloc-heap/elements/array-buffer`,
      amount: 8000,
    },
    { process: "content", path: "explicit/heap-unclassified", amount: 16000 },
    { process: "parent", path: "explicit/heap-unclassified", amount: 99999 },
  ];
  const summary = summarizeRetentionMemory(rows, "/fixture.html");
  assert.equal(summary.windowBytes, 8080);
  assert.deepEqual(summary.windowClasses, { Float64Array: 8080 });
  assert.equal(summary.contentHeapUnclassified, 16000);
});

test("retention CLI help is portable and does not launch a browser", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/firefox-profile/runtime-retention.mjs", "--help"],
    { encoding: "utf8" },
  );
  assert.match(output, /GC\+CC/);
  assert.match(output, /--workload=lifecycle\|structures\|structures-natural/);
  assert.match(output, /mixed-natural/);
  assert.match(output, /--allocations/);
});

test("retention CLI rejects oversized allocation traces and irrelevant skipping controls before launch", () => {
  for (const [args, message] of [
    [
      [
        "--workload=mixed-natural",
        "--diagnostic",
        "--allocations",
        "--cycles=44",
      ],
      /cycles must be 4\.\.40/,
    ],
    [
      ["--workload=rendering", "--scenario=resize", "--variant=skip"],
      /Block skipping is a huge-row experiment/,
    ],
    [
      ["--workload=mixed-natural", "--allocations"],
      /JS allocation sampling requires/,
    ],
  ]) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/firefox-profile/runtime-retention.mjs", ...args],
          { stdio: "pipe" },
        ),
      (error) => {
        assert.match(error.stderr.toString(), message);
        return true;
      },
    );
  }
});
