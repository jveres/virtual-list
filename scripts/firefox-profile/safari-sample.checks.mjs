import assert from "node:assert/strict";
import test from "node:test";
import {
  calibratedPid,
  sampleOptions,
  scheduleSample,
  summarizeSample,
} from "./safari-sample.mjs";

test("cancelled native sampling never launches its delayed process", async () => {
  const sample = scheduleSample(0, "/unused", {
    atSeconds: 60,
    durationSeconds: 2,
    intervalMs: 10,
  });
  await sample.close();
  assert.equal(sample.metadata.status, "cancelled");
  assert.equal(sample.metadata.closed, true);
  await assert.rejects(sample.complete(), /did not start/);
});

test("native sampling validates its time window before any process starts", () => {
  assert.equal(sampleOptions(undefined, 20), null);
  assert.deepEqual(sampleOptions("13.7:2:10", 20), {
    atSeconds: 13.7,
    durationSeconds: 2,
    intervalMs: 10,
  });
  for (const value of [
    "",
    "1:2",
    "1:2:10:1",
    "NaN:2:10",
    "-1:2:10",
    "0:0:10",
    "0:11:10",
    "0:2:0",
    "0:2:101",
    "18:2:10",
  ])
    assert.throws(() => sampleOptions(value, 20), /--safari-sample uses/);
});

test("CPU calibration selects only a new candidate and rejects ambiguous or vanished pages", () => {
  const before = " 1 00:01.00\n 2 01:00.00\n 99 00:10.00";
  const after = " 1 00:01.01\n 2 01:00.60\n 99 00:15.00";
  assert.equal(calibratedPid([1, 2], before, after).pid, 2);
  assert.throws(() => calibratedPid([1, 2], before, before), /unambiguously/);
  assert.throws(
    () => calibratedPid([1, 2], before, "1 00:01.50\n2 01:00.60"),
    /unambiguously/,
  );
  assert.throws(() => calibratedPid([2], before, ""), /unambiguously/);
});

test("native summary isolates the main thread and counts recursive stacks once", () => {
  const source = `Call graph:
    10 Thread_1 worker
    + 10 WebCore::unrelated()  (in WebCore) + 1 [0x1]
    10 Thread_2 DispatchQueue_1: com.apple.main-thread (serial)
    + 10 start  (in dyld) + 1 [0x1]
    +   6 WebCore::resolve()  (in WebCore) + 1 [0x1]
    +     4 WebCore::resolve()  (in WebCore) + 1 [0x1]
    +       4 WebCore::leaf()  (in WebCore) + 1 [0x1]
    +   4 idle  (in system) + 1 [0x1]
    10 Thread_3 worker
    + 10 WebCore::unrelated()  (in WebCore) + 1 [0x1]
Total number in stack
`;
  const summary = summarizeSample(source);
  assert.equal(summary.mainThreadSamples, 10);
  assert.deepEqual(summary.symbols, [
    { name: "WebCore::resolve()", samples: 6, percent: 60 },
    { name: "WebCore::leaf()", samples: 4, percent: 40 },
  ]);
  assert.throws(() => summarizeSample("empty"), /call graph/);
  assert.throws(
    () => summarizeSample("Call graph:\n    10 Thread_1 worker"),
    /main thread/,
  );
});
