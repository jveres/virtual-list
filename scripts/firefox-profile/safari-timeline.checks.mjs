import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSafariTimeline, sanitizeSource } from "./safari-timeline.mjs";

const script = "timeline-record-type-script";
const layout = "timeline-record-type-layout";
const frames = "timeline-record-type-rendering-frame";
const fixture = (records = [], samples = []) => ({
  version: 1,
  recording: {
    startTime: 10,
    endTime: 11,
    instrumentTypes: [script, layout, frames],
    records,
    samples,
  },
});
const event = (eventType, startTime, endTime) => ({
  type: layout,
  eventType,
  startTime,
  endTime,
});
const frame = (name) => ({
  name,
  url: "https://localhost/src/runtime.ts?private=secret",
  line: 3,
  column: 2,
});

test("reports enabled rendering frames absent from serialized records", () => {
  const result = analyzeSafariTimeline(fixture([event("layout", 10, 10.01)]));
  assert.equal(result.durationMs, 1000);
  assert.equal(result.renderingFrameRecords, 0);
  assert.deepEqual(result.enabledWithoutSerializedRecords, [script, frames]);
  assert.deepEqual(result.serializedTypes, { [layout]: 1 });
});

test("separates overlapping inclusive intervals from union and reports relative times", () => {
  const result = analyzeSafariTimeline(
    fixture([
      event("layout", 10.1, 10.2),
      event("paint", 10.12, 10.16),
      event("paint", 10.15, 10.18),
      event("composite", 10.19, 10.22),
    ]),
  );
  assert.equal(result.eventTiming.summedInclusiveMs, 200);
  assert.equal(result.eventTiming.unionIntervalMs, 120);
  assert.deepEqual(result.longestTimedRecords[0], {
    event: `${layout}/layout`,
    startMs: 100,
    endMs: 200,
    inclusiveMs: 100,
    containedOtherRecords: 2,
    containedUnionMs: 60,
    overlappingOtherRecords: 3,
    overlapUnionMs: 70,
  });
  const paint = result.events.find(
    (value) => value.event === `${layout}/paint`,
  );
  assert.equal(paint.maxMs, 40);
  assert.equal(paint.p95Ms, 40);
  assert.equal(paint.unionIntervalMs, 60);
});

test("counts untimed CPU/network records without exposing their contents", () => {
  const input = fixture([
    {
      type: "timeline-record-type-network",
      entry: {
        request: { url: "data:image/png;SECRET" },
        response: { body: "PRIVATE" },
      },
    },
    { type: "timeline-record-type-cpu", timestamp: 10.5, usage: 20 },
    {
      type: script,
      eventType: "event-dispatched",
      details: "scroll",
      startTime: 10,
      endTime: 10.005,
    },
    {
      type: script,
      eventType: "event-dispatched",
      details: "PRIVATE_TRANSCRIPT",
      startTime: 10.1,
      endTime: 10.11,
    },
  ]);
  const result = analyzeSafariTimeline(input);
  assert.equal(result.recordCount, 4);
  assert.equal(result.eventTiming.timedCount, 2);
  assert.equal(
    result.events.find(
      (value) => value.event === "timeline-record-type-network",
    ).maxMs,
    null,
  );
  assert.ok(
    result.events.some(
      (value) => value.event === `${script}/event-dispatched/scroll`,
    ),
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|data:image/);
});

test("reports timestamp-zero sample weights and separates inclusive/self with recursion", () => {
  const result = analyzeSafariTimeline(
    fixture(
      [],
      [
        {
          stackTraces: [
            {
              timestamp: 0,
              stackFrames: [frame("leaf"), frame("caller"), frame("caller")],
            },
            { timestamp: 10.5, stackFrames: [frame("caller")] },
            { timestamp: 99, stackFrames: [] },
            { stackFrames: [] },
          ],
          durations: [0.002, 0.003, 0.001, -1],
        },
      ],
    ),
  ).javascriptSamples;
  assert.equal(result.count, 4);
  assert.equal(result.timestampZeroCount, 1);
  assert.equal(result.timestampZeroWeightedDurationMs, 2);
  assert.equal(result.timestampInsideRecordingCount, 1);
  assert.equal(result.timestampOutsideRecordingCount, 1);
  assert.equal(result.missingTimestampCount, 1);
  assert.equal(result.invalidDurationCount, 1);
  assert.equal(result.weightedDurationMs, 6);
  assert.equal(result.emptyStackWeightedDurationMs, 1);
  assert.deepEqual(result.calls[0], {
    name: "caller",
    source: "runtime.ts",
    line: 3,
    column: 2,
    inclusiveSamples: 2,
    selfSamples: 1,
    inclusiveWeightedMs: 5,
    selfWeightedMs: 3,
  });
  assert.equal(result.calls[1].selfWeightedMs, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret|localhost|https:/);
});

test("handles mismatched sample arrays and invalid timed records explicitly", () => {
  const result = analyzeSafariTimeline(
    fixture(
      [
        event("layout", 10.2, 10.1),
        event("layout", 10, undefined),
        event("layout", 10.4, 10.4),
      ],
      [{ stackTraces: [{ timestamp: 0, stackFrames: [] }], durations: [] }],
    ),
  );
  assert.equal(result.invalidTimedRecords, 2);
  assert.equal(result.eventTiming.timedCount, 1);
  assert.equal(result.eventTiming.maxMs, 0);
  assert.equal(result.javascriptSamples.durationArrayMismatchCount, 1);
  assert.equal(result.javascriptSamples.invalidDurationCount, 1);
});

for (const [value, expected] of [
  [
    "https://name:password@example.com/private/path/index.js?q=secret#fragment",
    "index.js",
  ],
  [
    "http://localhost/@fs/Users/private/repo/virtual-list.ts?secret",
    "virtual-list.ts",
  ],
  ["file:///Users/private/chat.md", "[local-file]"],
  ["data:text/javascript;base64,PRIVATE", "[data-url]"],
  ["blob:https://private/secret", "[blob-url]"],
  ["https://example.com/private-document", "[remote-source]"],
  ["/Users/private/file.ts", "[unresolved-source]"],
  ["", "[no-source]"],
])
  test(`sanitizes source category ${expected}`, () =>
    assert.equal(sanitizeSource(value), expected));

test("rejects invalid input intervals and excessive interval output", () => {
  assert.throws(() => analyzeSafariTimeline({}), /Missing recording/);
  assert.throws(
    () =>
      analyzeSafariTimeline({
        recording: { records: [], startTime: 2, endTime: 1 },
      }),
    /Invalid recording interval/,
  );
  assert.throws(
    () => analyzeSafariTimeline(fixture(), { worstCount: 101 }),
    /Invalid worstCount/,
  );
  assert.deepEqual(
    analyzeSafariTimeline(fixture(), { worstCount: 0 }).longestTimedRecords,
    [],
  );
});
