import assert from "node:assert/strict";

export const MiB = 1024 ** 2;

/** Reduced-precision clocks can vary; a page-owned identity cannot survive reload. */
export function assertMemoryDocument(page, previous) {
  assert.ok(
    typeof page.documentId === "string" && page.documentId.length > 0,
    "Page guard missing",
  );
  if (previous)
    assert.equal(page.documentId, previous.documentId, "Page reloaded");
}

export function parseFootprints(output) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const values = line.trim().split(/\s+/).map(Number);
      assert.ok(
        values.length === 4 && values.every(Number.isSafeInteger),
        "Invalid process memory sample",
      );
      const [pid, footprint, resident, peak] = values;
      assert.ok(
        pid > 0 && footprint >= 0 && resident >= 0 && peak >= footprint,
        "Invalid process memory counters",
      );
      return { pid, footprint, resident, peak };
    });
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Process peaks catch allocations that are already purgeable at a checkpoint. */
export function assessMemory(samples, budget) {
  for (const key of ["processPeak", "total", "growth", "tailRange"])
    assert.ok(
      Number.isFinite(budget[key]) && budget[key] > 0,
      `Invalid ${key} budget`,
    );
  assert.ok(samples.length >= 6, "At least six completed cycles required");
  for (const sample of samples) {
    assert.ok(sample.processes.length > 0, "Missing memory counters");
    assert.ok(
      sample.page.distance > 10000 && sample.page.events > 20,
      "Invalid stationary workload",
    );
    assert.equal(sample.page.done, true, "Incomplete workload");
    assert.equal(sample.page.error, undefined, "Workload failed");
    for (const p of sample.processes)
      assert.ok(
        Number.isFinite(p.footprint) &&
          p.footprint >= 0 &&
          Number.isFinite(p.peak) &&
          p.peak >= p.footprint,
        "Invalid memory counters",
      );
  }
  const totals = samples.map((s) =>
    s.processes.reduce((sum, p) => sum + p.footprint, 0),
  );
  const processPeak = Math.max(
    ...samples.flatMap((s) => s.processes.map((p) => p.peak)),
  );
  const growth = median(totals.slice(-3)) - median(totals.slice(0, 3));
  const tailRange =
    Math.max(...totals.slice(-3)) - Math.min(...totals.slice(-3));
  const result = {
    processPeak,
    maxTotal: Math.max(...totals),
    growth,
    tailRange,
    failures: [],
  };
  if (processPeak > budget.processPeak)
    result.failures.push("process peak exceeds budget");
  if (result.maxTotal > budget.total)
    result.failures.push("browser total exceeds budget");
  if (growth > budget.growth)
    result.failures.push("repeated-cycle growth exceeds budget");
  if (tailRange > budget.tailRange)
    result.failures.push("final cycles have not settled within budget");
  return result;
}
