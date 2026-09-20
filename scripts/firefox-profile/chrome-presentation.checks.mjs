import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { analyzeChromePresentation } from "./chrome-presentation.mjs";

const script = fileURLToPath(
  new URL("./chrome-presentation.mjs", import.meta.url),
);
const event = (name, ts, extra = {}) => ({
  name,
  ts,
  pid: 1,
  tid: 10,
  ph: "I",
  ...extra,
});
const present = (ts, extra = {}) =>
  event("AnimationFrame::Presentation", ts, { ph: "n", ...extra });
const task = (ts, dur, extra = {}) =>
  event("ThreadControllerImpl::RunTask", ts, { ph: "X", dur, ...extra });
function fixture() {
  return {
    traceEvents: [
      event("thread_name", 0, { ph: "M", args: { name: "CrRendererMain" } }),
      event("thread_name", 0, {
        ph: "M",
        pid: 2,
        tid: 20,
        args: { name: "CrGpuMain" },
      }),
      event("process_name", 0, {
        ph: "M",
        pid: 2,
        tid: 0,
        args: { name: "GPU Process" },
      }),
      event("top-probe-default-0-start", 1000),
      present(1000),
      present(18000),
      present(168000),
      present(185000),
      task(2000, 3000, { tdur: 2000 }),
      task(30000, 130000, { pid: 2, tid: 20, tdur: 7000 }),
      event("top-probe-default-0-end", 201000),
    ],
  };
}

test("presentation gaps and task elapsed/CPU durations use distinct millisecond fields", () => {
  const result = analyzeChromePresentation(fixture()).results[0];

  assert.equal(result.durationMs, 200);
  assert.equal(result.presentationRecords, 4);
  assert.equal(result.maxPresentationGapMs, 150);
  assert.deepEqual(result.largestPresentationGaps[0], {
    fromMs: 17,
    toMs: 167,
    elapsedMs: 150,
  });
  assert.deepEqual(
    result.longestThreadTasks.map(({ role, elapsedMs, cpuMs }) => ({
      role,
      elapsedMs,
      cpuMs,
    })),
    [
      { role: "gpu-process", elapsedMs: 130, cpuMs: 7 },
      { role: "renderer", elapsedMs: 3, cpuMs: 2 },
    ],
  );
});

test("event ordering, duplicate timestamps, other renderer threads and out-of-window records do not alter gaps", () => {
  const trace = fixture();
  trace.traceEvents.push(
    present(18000),
    present(99000, { tid: 11 }),
    present(999),
    present(201000),
    task(2000, 180000, { pid: 9 }),
  );
  trace.traceEvents.reverse();

  const result = analyzeChromePresentation(trace).results[0];

  assert.equal(result.presentationRecords, 4);
  assert.equal(result.maxPresentationGapMs, 150);
  assert.equal(result.longestThreadTasks.length, 2);
});

test("missing CPU and presentation telemetry remain unavailable and crossing tasks report overlap", () => {
  const trace = fixture();
  trace.traceEvents = trace.traceEvents.filter(
    (entry) => entry.name !== "AnimationFrame::Presentation",
  );
  trace.traceEvents.push(task(0, 300000));

  const result = analyzeChromePresentation(trace).results[0];

  assert.equal(result.maxPresentationGapMs, null);
  assert.deepEqual(result.largestPresentationGaps, []);
  assert.equal(result.longestThreadTasks[0].cpuMs, null);
  assert.equal(result.longestThreadTasks[0].elapsedMs, 300);
  assert.equal(result.longestThreadTasks[0].overlapMs, 200);
  assert.equal(result.longestThreadTasks[0].startMs, -1);
});

test("each marker window is paired by workload and run, including zero-time starts", () => {
  const trace = fixture();
  trace.traceEvents.push(
    event("top-probe-rich-chat-1-start", 0, { pid: 3 }),
    event("top-probe-rich-chat-1-end", 500, { pid: 3 }),
  );
  const measurements = {
    browser: "Chrome test",
    errors: ["test warning"],
    results: [
      { workload: "default", run: 0, invalidations: [] },
      { workload: "rich-chat", run: 1, invalidations: ["blur"] },
    ],
  };

  const result = analyzeChromePresentation(trace, measurements);

  assert.equal(result.browser, "Chrome test");
  assert.deepEqual(result.captureErrors, ["test warning"]);
  assert.deepEqual(
    result.results.map((entry) => [
      entry.marker,
      entry.measurement.invalidations,
    ]),
    [
      ["top-probe-rich-chat-1-start", ["blur"]],
      ["top-probe-default-0-start", []],
    ],
  );
});

test("malformed traces, markers, durations and unmatched measurements are rejected", () => {
  for (const input of [null, {}, { traceEvents: [] }, { traceEvents: [null] }])
    assert.throws(() => analyzeChromePresentation(input));
  for (const extra of [
    event("top-probe-default-0-start", 1000),
    event("top-probe-broken", 1000),
    event("top-probe-default-1-end", 500000),
    task(1000, -1),
    task(1000, 1, { tdur: Number.NaN }),
    present(Number.NaN),
  ]) {
    const trace = fixture();
    trace.traceEvents.push(extra);
    assert.throws(() => analyzeChromePresentation(trace));
  }
  for (const extra of [{ ts: 1000 }, { tid: 11 }]) {
    const trace = fixture();
    Object.assign(trace.traceEvents.at(-1), extra);
    assert.throws(() => analyzeChromePresentation(trace), /end marker/);
  }
  assert.throws(
    () => analyzeChromePresentation(fixture(), {}),
    /measurements.results/,
  );
  assert.throws(
    () => analyzeChromePresentation(fixture(), { results: [] }),
    /one measurement/,
  );
});

test("CLI reads JSON and gzip, reports failures, and help creates no artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "chrome-presentation-check-"));
  try {
    const help = spawnSync(process.execPath, [script, "--help"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Creates no artifacts/);
    assert.deepEqual(readdirSync(directory), []);
    for (const gzip of [false, true]) {
      const path = join(directory, gzip ? "trace.json.gz" : "trace.json");
      const json = JSON.stringify(fixture());
      writeFileSync(path, gzip ? gzipSync(json) : json);
      const run = spawnSync(process.execPath, [script, path], {
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).results[0].maxPresentationGapMs, 150);
    }
    const invalid = spawnSync(process.execPath, [script, "--unknown"], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Expected a trace path/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
