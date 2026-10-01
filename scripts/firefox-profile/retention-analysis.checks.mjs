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

test("retention CLI help is portable and does not launch a browser", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/firefox-profile/runtime-retention.mjs", "--help"],
    { encoding: "utf8" },
  );
  assert.match(output, /GC\+CC/);
});
