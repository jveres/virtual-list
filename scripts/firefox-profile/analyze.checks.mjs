import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { analyze, markers, stats } from "./analyze.mjs";

function thread(data) {
  return {
    name: "GeckoMain",
    processType: "tab",
    stringTable: ["UserTiming", "RefreshDriverTick", "DOMEvent"],
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
      data,
    },
  };
}
const fixture = () => ({
  threads: [thread([])],
  processes: [
    {
      threads: [
        thread([
          [0, 100, 0, 0, { name: "ff-profile-start" }],
          [1, 10, 90, 1], // Startup is outside the measurement.
          [1, 110, 120, 1],
          [2, 111, 113, 1, { eventType: "scroll" }],
          [0, 200, 0, 0, { name: "ff-profile-end" }],
        ]),
      ],
    },
  ],
});
const recording = () => ({
  frames: [
    [0, 0],
    [16, 24],
    [48, 24],
    [64, 48],
  ],
  refreshHz: 60,
  writes: [],
  bursts: [],
  scrollEvents: 2,
  scrollEnds: 1,
});

test("empty measurements are unavailable, not zero-duration successes", () => {
  assert.deepEqual(stats([]), {
    count: 0,
    total: 0,
    p50: null,
    p95: null,
    max: null,
  });
});

test("marker pairing handles nested intervals and ignores unmatched endings", () => {
  const result = markers(
    thread([
      [1, 10, 0, 2],
      [1, 11, 0, 2],
      [1, 0, 12, 3],
      [1, 0, 15, 3],
      [1, 0, 20, 3],
    ]),
  );
  assert.deepEqual(
    result.map(({ start, end }) => [start, end]),
    [
      [11, 12],
      [10, 15],
    ],
  );
});

test("analysis finds the marked child process and excludes startup", () => {
  const result = analyze(fixture(), recording());
  assert.equal(result.durationMs, 100);
  assert.deepEqual(result.markersMs.RefreshDriverTick, {
    count: 1,
    total: 10,
    p50: 10,
    p95: 10,
    max: 10,
  });
  assert.equal(result.scrollHandlersMs.max, 2);
  assert.equal(result.animationFrameIntervalsMs.count, 3);
  assert.equal(result.movingAnimationFrameIntervalsMs.count, 2);
  assert.equal(result.longIntervals, 1);
  assert.deepEqual(result.scrollPositionWrites, []);
});

test("the long-frame threshold follows the recorded display refresh rate", () => {
  const result = analyze(fixture(), { ...recording(), refreshHz: 120 });
  assert.equal(result.longIntervalThresholdMs, 12.5);
  assert.equal(result.longIntervals, 3);
});

test("analysis retains bounded fixture counters without raw audit events", () => {
  const fixtureSummary = { created: 12, reused: 300 };
  const input = {
    ...recording(),
    runtimeAudit: { fixtureSummary, events: ["temporary diagnostic input"] },
  };
  const result = analyze(fixture(), input);
  assert.deepEqual(result.fixtureSummary, fixtureSummary);
  assert.equal("runtimeAudit" in result, false);
  assert.equal("fixtureSummary" in analyze(fixture(), recording()), false);
  input.runtimeAudit.fixtureSummary = { data: "x".repeat(65536) };
  assert.throws(() => analyze(fixture(), input), /exceeds 64 KiB/);
});

test("analysis reports live capture without labelling it as shutdown capture", () => {
  const result = analyze(fixture(), { ...recording(), capture: "live" });
  assert.equal(result.capture, "live");
  assert.equal(
    result.limitations.some((line) => line.startsWith("Shutdown capture")),
    false,
  );
  assert.equal(
    result.limitations.some((line) => line.startsWith("Live capture")),
    true,
  );
});

test("incomplete profiles cannot produce a successful summary", () => {
  assert.throws(
    () => analyze({ threads: [thread([])] }, recording()),
    /No complete/,
  );
  assert.throws(
    () => analyze({ threads: [{ markers: {} }] }, recording()),
    /raw Firefox profile/,
  );
});

test("help does not launch Firefox or compile a helper", () => {
  const help = execFileSync(
    process.execPath,
    ["scripts/firefox-profile.mjs", "--help"],
    { encoding: "utf8" },
  );
  assert.match(help, /--manual-seconds/);
  assert.match(help, /--list-displays/);
  const forwarded = execFileSync(
    process.execPath,
    ["scripts/firefox-profile.mjs", "--", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(forwarded, help);
});
