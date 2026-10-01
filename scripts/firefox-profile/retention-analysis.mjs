import assert from "node:assert/strict";

/** Firefox reporters are leaves; sum one explicit subtree, not cross-cut totals. */
export function summarizeRetentionMemory(rows, pagePath) {
  const pageRows = rows.filter(
    (row) =>
      row.path.startsWith("explicit/window-objects/top(") &&
      row.path.replaceAll("\\", "/").includes(pagePath),
  );
  assert.ok(
    pageRows.length > 0,
    `Missing fixture window memory reporters: ${JSON.stringify(
      rows
        .filter((row) => row.path.startsWith("explicit/window-objects/"))
        .slice(0, 3)
        .map((row) => row.path),
    )}`,
  );
  const owners = [...new Set(pageRows.map((row) => row.process))];
  assert.equal(
    owners.length,
    1,
    "Fixture memory belongs to multiple processes",
  );
  const process = owners[0];
  const ownRows = rows.filter((row) => row.process === process);
  const total = (values) => values.reduce((sum, row) => sum + row.amount, 0);
  const metric = (path) =>
    ownRows.find((row) => row.path === path)?.amount ?? null;
  return {
    process,
    windowBytes: total(pageRows),
    windowDomBytes: total(pageRows.filter((row) => row.path.includes("/dom/"))),
    windowLayoutBytes: total(
      pageRows.filter((row) => row.path.includes("/layout/")),
    ),
    contentHeapAllocated: metric("heap-allocated"),
    contentResident: metric("resident"),
    contentJsGcHeap: metric("js-main-runtime-gc-heap-committed"),
  };
}
