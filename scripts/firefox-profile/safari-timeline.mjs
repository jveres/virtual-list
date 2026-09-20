import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const eventNames = new Set([
  "scroll",
  "scrollend",
  "wheel",
  "click",
  "change",
  "input",
  "load",
  "error",
  "resize",
  "keydown",
  "keyup",
  "message",
  "visibilitychange",
  "pointerover",
  "pointerout",
  "pointermove",
  "pointerdown",
  "pointerup",
  "mouseover",
  "mouseout",
  "mousemove",
  "mousedown",
  "mouseup",
  "mouseenter",
  "mouseleave",
  "touchstart",
  "touchmove",
  "touchend",
]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const rounded = (value) => Math.round(value * 1e6) / 1e6;
const label = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,100}$/.test(value)
    ? value
    : "unknown";

export function sanitizeSource(value) {
  if (typeof value !== "string" || !value) return "[no-source]";
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return "[data-url]";
    if (url.protocol === "blob:") return "[blob-url]";
    if (url.protocol === "file:") return "[local-file]";
    if (!["http:", "https:"].includes(url.protocol)) return "[other-source]";
    const name = url.pathname.split("/").at(-1);
    return /^[a-zA-Z0-9_.-]+\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(name ?? "")
      ? name
      : "[remote-source]";
  } catch {
    return "[unresolved-source]";
  }
}

function unionMs(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals.toSorted(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let start = sorted[0].start;
  let end = sorted[0].end;
  let total = 0;
  for (const interval of sorted.slice(1)) {
    if (interval.start > end) {
      total += end - start;
      start = interval.start;
    }
    end = Math.max(end, interval.end);
  }
  return rounded((total + end - start) * 1000);
}

function durationsSummary(intervals) {
  const durations = intervals
    .map((x) => (x.end - x.start) * 1000)
    .sort((a, b) => a - b);
  return {
    timedCount: durations.length,
    maxMs: durations.length ? rounded(durations.at(-1)) : null,
    p95Ms: durations.length
      ? rounded(durations[Math.ceil(durations.length * 0.95) - 1])
      : null,
    summedInclusiveMs: rounded(
      durations.reduce((sum, value) => sum + value, 0),
    ),
    unionIntervalMs: unionMs(intervals),
  };
}

function summarizeSamples(groups, start, end) {
  const calls = new Map();
  const result = {
    count: 0,
    timestampZeroCount: 0,
    missingTimestampCount: 0,
    timestampInsideRecordingCount: 0,
    timestampOutsideRecordingCount: 0,
    invalidDurationCount: 0,
    durationArrayMismatchCount: 0,
    weightedDurationMs: 0,
    timestampZeroWeightedDurationMs: 0,
    emptyStackWeightedDurationMs: 0,
  };
  for (const group of groups) {
    const traces = Array.isArray(group.stackTraces) ? group.stackTraces : [];
    const durations = Array.isArray(group.durations) ? group.durations : [];
    if (traces.length !== durations.length) result.durationArrayMismatchCount++;
    for (const [index, trace] of traces.entries()) {
      result.count++;
      const timestamp = trace?.timestamp;
      if (timestamp === 0) result.timestampZeroCount++;
      else if (!finite(timestamp)) result.missingTimestampCount++;
      else if (timestamp >= start && timestamp <= end)
        result.timestampInsideRecordingCount++;
      else result.timestampOutsideRecordingCount++;
      const duration = durations[index];
      if (!finite(duration) || duration < 0) {
        result.invalidDurationCount++;
        continue;
      }
      const weight = duration * 1000;
      result.weightedDurationMs += weight;
      if (timestamp === 0) result.timestampZeroWeightedDurationMs += weight;
      const stack = Array.isArray(trace.stackFrames) ? trace.stackFrames : [];
      if (!stack.length) result.emptyStackWeightedDurationMs += weight;
      const seen = new Set();
      for (const [frameIndex, frame] of stack.entries()) {
        const name =
          typeof frame.name === "string" &&
          /^[\w$.[\] ()<>:@-]{1,120}$/.test(frame.name)
            ? frame.name
            : "[unnamed]";
        const identity = {
          name,
          source: sanitizeSource(frame.url),
          line: Number.isInteger(frame.line) ? frame.line : null,
          column: Number.isInteger(frame.column) ? frame.column : null,
        };
        const key = JSON.stringify(identity);
        let call = calls.get(key);
        if (!call) {
          call = {
            ...identity,
            inclusiveSamples: 0,
            selfSamples: 0,
            inclusiveWeightedMs: 0,
            selfWeightedMs: 0,
          };
          calls.set(key, call);
        }
        if (!seen.has(key)) {
          call.inclusiveSamples++;
          call.inclusiveWeightedMs += weight;
          seen.add(key);
        }
        // Safari serializes the sampled leaf first, followed by its callers.
        if (frameIndex === 0) {
          call.selfSamples++;
          call.selfWeightedMs += weight;
        }
      }
    }
  }
  for (const key of [
    "weightedDurationMs",
    "timestampZeroWeightedDurationMs",
    "emptyStackWeightedDurationMs",
  ])
    result[key] = rounded(result[key]);
  return {
    ...result,
    calls: [...calls.values()]
      .map((call) => ({
        ...call,
        inclusiveWeightedMs: rounded(call.inclusiveWeightedMs),
        selfWeightedMs: rounded(call.selfWeightedMs),
      }))
      .sort(
        (a, b) =>
          b.inclusiveWeightedMs - a.inclusiveWeightedMs ||
          b.selfWeightedMs - a.selfWeightedMs,
      ),
  };
}

export function analyzeSafariTimeline(input, { worstCount = 12 } = {}) {
  assert.ok(
    Number.isInteger(worstCount) && worstCount >= 0 && worstCount <= 100,
    "Invalid worstCount",
  );
  const recording = input?.recording;
  assert.ok(
    recording && Array.isArray(recording.records),
    "Missing recording records",
  );
  assert.ok(
    finite(recording.startTime) &&
      finite(recording.endTime) &&
      recording.endTime >= recording.startTime,
    "Invalid recording interval",
  );
  const { startTime, endTime } = recording;
  const types = new Map();
  const events = new Map();
  const intervals = [];
  let invalidTimedRecords = 0;
  for (const record of recording.records) {
    const type = label(record?.type);
    types.set(type, (types.get(type) ?? 0) + 1);
    const event = [
      type,
      ...(record?.eventType ? [label(record.eventType)] : []),
      ...(record?.eventType === "event-dispatched" &&
      eventNames.has(record.details)
        ? [record.details]
        : []),
    ].join("/");
    if (!events.has(event))
      events.set(event, { event, count: 0, intervals: [] });
    const group = events.get(event);
    group.count++;
    if (record?.startTime === undefined && record?.endTime === undefined)
      continue;
    if (
      !finite(record.startTime) ||
      !finite(record.endTime) ||
      record.endTime < record.startTime
    ) {
      invalidTimedRecords++;
      continue;
    }
    const interval = { event, start: record.startTime, end: record.endTime };
    intervals.push(interval);
    group.intervals.push(interval);
  }
  const enabled = Array.isArray(recording.instrumentTypes)
    ? recording.instrumentTypes.map(label)
    : [];
  const longest = intervals
    .toSorted((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, worstCount);
  return {
    formatVersion: finite(input.version) ? input.version : null,
    durationMs: rounded((endTime - startTime) * 1000),
    recordCount: recording.records.length,
    enabledInstruments: enabled,
    serializedTypes: Object.fromEntries(
      [...types].sort(([a], [b]) => a.localeCompare(b)),
    ),
    enabledWithoutSerializedRecords: enabled.filter((type) => !types.has(type)),
    renderingFrameRecords:
      types.get("timeline-record-type-rendering-frame") ?? 0,
    invalidTimedRecords,
    eventTiming: durationsSummary(intervals),
    events: [...events.values()]
      .map((group) => ({
        event: group.event,
        count: group.count,
        ...durationsSummary(group.intervals),
      }))
      .sort(
        (a, b) =>
          (b.maxMs ?? 0) - (a.maxMs ?? 0) || a.event.localeCompare(b.event),
      ),
    longestTimedRecords: longest.map((interval) => {
      const overlapping = intervals.filter(
        (other) =>
          other !== interval &&
          other.start < interval.end &&
          other.end > interval.start,
      );
      const contained = overlapping.filter(
        (other) => other.start >= interval.start && other.end <= interval.end,
      );
      return {
        event: interval.event,
        startMs: rounded((interval.start - startTime) * 1000),
        endMs: rounded((interval.end - startTime) * 1000),
        inclusiveMs: rounded((interval.end - interval.start) * 1000),
        containedOtherRecords: contained.length,
        containedUnionMs: unionMs(contained),
        overlappingOtherRecords: overlapping.length,
        overlapUnionMs: unionMs(
          overlapping.map((other) => ({
            start: Math.max(interval.start, other.start),
            end: Math.min(interval.end, other.end),
          })),
        ),
      };
    }),
    javascriptSamples: summarizeSamples(
      Array.isArray(recording.samples) ? recording.samples : [],
      startTime,
      endTime,
    ),
    limitations: [
      "Event durations are elapsed instrument intervals, not CPU time. Inclusive durations overlap and must not be added as independent work.",
      "Containment is a timing relationship, not proof of parent-child execution. CPU/network records without start/end fields are counted but not timed here.",
      "JS weights are sampled durations, not complete process CPU time. Inclusive call weights include callees and recursion is counted once per sample.",
      "Zero/missing/out-of-range JS timestamps cannot be aligned to recording events. An enabled instrument does not prove its records were exported.",
      "Web Inspector timings do not establish WindowServer presentation, GPU execution or the transform displayed on each physical frame.",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node scripts/firefox-profile/safari-timeline.mjs <Safari Web Inspector export.json>\nPrints a sanitized offline timing/sample summary as JSON. Reads only; no browser or native capture.",
    );
  } else {
    try {
      assert.equal(
        process.argv.length,
        3,
        "Provide exactly one Safari export file",
      );
      let input;
      try {
        input = JSON.parse(await readFile(process.argv[2], "utf8"));
      } catch {
        throw new Error("Unable to read or parse Safari timeline export");
      }
      console.log(JSON.stringify(analyzeSafariTimeline(input), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
