import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeInputCadence } from "./input-cadence.mjs";

const PERIOD = 16.667;

/** A parent process with vsync and pan IPC markers, and a GPU renderer. */
function capture(panTimes, { frames = 240, marks = [] } = {}) {
  const vsync = Array.from({ length: frames }, (_, i) => 1000 + i * PERIOD);
  const parentMain = {
    name: "GeckoMain",
    stringTable: ["PAPZInputBridge::Msg_ReceivePanGestureInputEvent"],
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
      data: panTimes.flatMap((time) => [
        [0, time, 0, 2, null],
        [0, 0, time + 0.1, 3, null],
      ]),
    },
  };
  const compositor = {
    name: "Compositor",
    stringTable: ["VsyncTimestamp"],
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
      data: vsync.map((time) => [0, time, 0, 0, null]),
    },
  };
  const renderer = {
    name: "Renderer",
    stringTable: ["WR OS Compositor frame"],
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
      data: vsync.map((time) => [0, time + 0.2, time + 0.6, 1, null]),
    },
  };
  return {
    profile: {
      meta: { startTime: 500 },
      threads: [parentMain, compositor],
      processes: [{ meta: { startTime: 500 }, threads: [renderer] }],
    },
    recording: { timeOrigin: 500, frames: [], marks },
  };
}

test("one event per frame never alternates", () => {
  // Events 4 ms before each vsync, with no delivery noise.
  const pan = Array.from(
    { length: 200 },
    (_, i) => 1000 + (i + 1) * PERIOD - 4,
  );
  const { profile, recording } = capture(pan);
  const result = analyzeInputCadence(profile, recording);
  assert.equal(result.flipsPerSecond, 0);
  assert.equal(result.eventsPerVsync[2] ?? 0, 0);
  assert.equal(result.gestures.length, 1);
  assert.ok(
    result.gestures[0].meanPhase > 0.7 && result.gestures[0].meanPhase < 0.8,
  );
  assert.equal(result.vsyncPeriodMs, 16.667);
});

test("late deliveries past the vsync edge alternate 0 and 2", () => {
  // Every fifth event slips 5 ms, past the next vsync.
  const pan = Array.from(
    { length: 200 },
    (_, i) => 1000 + (i + 1) * PERIOD - 3 + (i % 5 === 0 ? 5 : 0),
  );
  const { profile, recording } = capture(pan, { marks: [{ time: 3000 }] });
  const result = analyzeInputCadence(profile, recording);
  assert.ok(result.flipsPerSecond > 5, `flips ${result.flipsPerSecond}`);
  assert.ok(result.eventsPerVsync[0] > 30 && result.eventsPerVsync[2] > 30);
  assert.ok(result.lateInputShare > 0.15);
  assert.equal(result.marks.length, 1);
  assert.ok(result.marks[0].flipsPerSecondBefore > 5);
});

test("rejects a capture without vsync or pan markers", () => {
  const { profile, recording } = capture([]);
  assert.throws(
    () => analyzeInputCadence(profile, recording),
    /Expected vsync and pan-gesture markers/,
  );
});
