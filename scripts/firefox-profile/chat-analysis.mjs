import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
      : null;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
  };
}

export function analyzeChat(
  recording,
  { refreshHz = 60, native = false, metadata = null } = {},
) {
  assert.equal(recording?.schema, 1, "Expected chat profile schema 1");
  assert.ok(
    Number.isFinite(refreshHz) && refreshHz > 0,
    "Invalid refresh rate",
  );
  assert.ok(
    Number.isFinite(recording.durationMs) && recording.durationMs > 0,
    "Invalid capture duration",
  );
  for (const key of [
    "frames",
    "inputs",
    "spans",
    "operations",
    "entries",
    "states",
    "deliveries",
    "errors",
    "invalidations",
  ])
    assert.ok(Array.isArray(recording[key]), `Missing ${key}`);
  const intervals = [];
  let previous = null;
  for (const frame of recording.frames) {
    assert.ok(
      Array.isArray(frame) &&
        Number.isFinite(frame[0]) &&
        Number.isFinite(frame[1]),
      "Invalid frame",
    );
    if (previous) {
      assert.ok(frame[0] >= previous[0], "Unordered frame timestamps");
      intervals.push({
        start: previous[0],
        end: frame[0],
        duration: frame[0] - previous[0],
        movement: frame[1] - previous[1],
        phase: previous[2],
        streaming: previous[10] ?? previous[3] < recording.workload.characters,
      });
    }
    previous = frame;
  }
  const moving = intervals.filter((frame) => Math.abs(frame.movement) > 0.01);
  const streaming = intervals.filter((frame) => frame.streaming);
  const reasons = [];
  if (
    !recording.stream.done ||
    recording.stream.characters !== recording.workload.characters ||
    recording.stream.chunks !== recording.workload.chunks
  )
    reasons.push("Stream did not complete with the expected input");
  if (moving.length < 30) reasons.push("Insufficient scroll movement");
  if (
    recording.scenario !== "follow" &&
    (recording.scroll.wheels < 30 || recording.scroll.ends < 1)
  )
    reasons.push("Missing gesture input or scroll-end events");
  if (recording.errors.length) reasons.push("Page errors occurred");
  if (recording.invalidations.length)
    reasons.push("Focus, visibility, or geometry changed during capture");
  if (Object.values(recording.dropped).some((count) => count > 0))
    reasons.push("Telemetry buffer overflow");
  if (!recording.frames.length) reasons.push("No frame samples");
  if (
    JSON.stringify(recording.initial.window) !==
    JSON.stringify(recording.final.window)
  )
    reasons.push("Window/display geometry changed during capture");
  const threshold = 1500 / refreshHz;
  const expensive = recording.operations.toSorted(
    (a, b) => b.selfMs - a.selfMs,
  );
  const groups = new Map();
  for (const span of recording.spans) {
    assert.ok(
      span.length === 8 &&
        [span[0], span[1], span[2], span[4]].every(Number.isFinite),
      "Invalid operation span",
    );
    const key = `${span[3]}|${span[4]}`;
    const group = groups.get(key) ?? {
      operation: span[3],
      frame: span[4],
      count: 0,
      inclusiveMs: 0,
      unchangedText: 0,
    };
    group.count++;
    group.inclusiveMs += span[1];
    group.unchangedText += Number(span[7]);
    groups.set(key, group);
  }
  const slowFrames = intervals
    .filter((frame) => frame.duration > threshold)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 20)
    .map((frame) => {
      const overlapping = new Map();
      for (const span of recording.spans) {
        if (span[0] < frame.end && span[0] + span[1] > frame.start) {
          const item = overlapping.get(span[3]) ?? {
            name: span[3],
            calls: 0,
            inclusiveMs: 0,
          };
          item.calls++;
          item.inclusiveMs += Math.max(
            0,
            Math.min(frame.end, span[0] + span[1]) -
              Math.max(frame.start, span[0]),
          );
          overlapping.set(span[3], item);
        }
      }
      return {
        ...frame,
        operations: [...overlapping.values()]
          .sort((a, b) => b.inclusiveMs - a.inclusiveMs)
          .slice(0, 10),
      };
    });
  const byType = {};
  for (const [type, capability] of Object.entries(recording.capabilities)) {
    const entries = recording.entries.filter((entry) => entry.type === type);
    byType[type] = capability.supported
      ? {
          available: true,
          durationMs: distribution(entries.map((entry) => entry.duration)),
          count: entries.length,
        }
      : { available: false };
  }
  const deltas = recording.deliveries.filter(
    (delivery) => delivery[1] === "response.output_text.delta",
  );
  const completed = recording.deliveries.find(
    (delivery) => delivery[1] === "response.completed",
  );
  const streamDurationMs =
    deltas.length && completed ? completed[0] - deltas[0][0] : null;
  const phases = [...new Set(intervals.map((frame) => frame.phase))].map(
    (phase) => {
      const frames = intervals.filter((frame) => frame.phase === phase);
      return {
        phase,
        intervalsMs: distribution(frames.map((frame) => frame.duration)),
        movingFrames: frames.filter((frame) => Math.abs(frame.movement) > 0.01)
          .length,
        longIntervals: frames.filter((frame) => frame.duration > threshold)
          .length,
      };
    },
  );
  return {
    schema: 1,
    transport: recording.transport ?? "unspecified",
    valid: reasons.length === 0,
    invalidReasons: reasons,
    evidence: native
      ? "installed-browser-native-input-or-follow"
      : "automation-correctness-only",
    mode: recording.mode,
    scenario: recording.scenario,
    workload: recording.workload,
    userAgent: recording.userAgent,
    browserBuild:
      metadata?.driverVersion ??
      (typeof metadata?.browser === "string"
        ? metadata.browser
        : metadata?.browser?.browserVersion) ??
      null,
    monitor: metadata?.monitor ?? metadata?.display ?? null,
    durationMs: recording.durationMs,
    refreshHz,
    frames: {
      allMs: distribution(intervals.map((frame) => frame.duration)),
      movingMs: distribution(moving.map((frame) => frame.duration)),
      streamingMs: distribution(streaming.map((frame) => frame.duration)),
      longThresholdMs: threshold,
      longIntervals: intervals.filter((frame) => frame.duration > threshold)
        .length,
      movingLongIntervals: moving.filter((frame) => frame.duration > threshold)
        .length,
    },
    phases,
    slowFrames,
    input: {
      ...recording.scroll,
      deliveryToNextRafMs: distribution(
        recording.frames
          .map((frame) => frame[9])
          .filter((value) => value !== null),
      ),
      wheelEventAgeMs: distribution(
        recording.inputs
          .map((input) => input[0] - input[1])
          .filter((value) => value >= 0),
      ),
    },
    stream: {
      ...recording.stream,
      durationMs: streamDurationMs,
      deltaIntervalsMs: distribution(
        deltas.slice(1).map((delta, index) => delta[0] - deltas[index][0]),
      ),
      charactersPerSecond:
        streamDurationMs > 0
          ? recording.stream.characters / (streamDurationMs / 1000)
          : null,
    },
    work: {
      expensive,
      repeatedWithinFrame: [...groups.values()]
        .filter((group) => group.count > 1)
        .sort((a, b) => b.inclusiveMs - a.inclusiveMs)
        .slice(0, 40),
      unchangedTextCandidates: expensive.filter(
        (operation) => operation.unchangedText > 0,
      ),
      geometryAccess: recording.access.toSorted((a, b) => b.count - a.count),
      mutations: recording.mutations,
    },
    performanceEntries: byType,
    initial: recording.initial,
    final: recording.final,
    paging: {
      initialStatus: recording.initial.status,
      finalStatus: recording.final.status,
      countChanges: recording.states.filter(
        (state, index) =>
          index > 0 && state[1].count !== recording.states[index - 1][1].count,
      ).length,
      heldSamples: recording.frames.filter((frame) => frame[8]).length,
    },
    limits: [
      "Animation callbacks and input-to-rAF timing are not physical presentation or event-to-photon latency.",
      "Repeated calls and unchanged text are candidates, not proof of redundant work: tools, cursor, mount state, or geometry may differ.",
      "Inclusive operation times overlap; self time subtracts only other instrumented synchronous calls, not browser work or asynchronous continuations.",
      "Geometry access counts do not prove forced reflow. Use the native trace and invalidation stacks to attribute layout cost.",
      "Unsupported performance entries and heap metrics are unavailable, not zero. Event Timing here is not field INP; layout shifts are not a full CLS score.",
      "Diagnostic observers, wrappers, and timers perturb execution. Compare repeated timing-mode captures before evaluating an optimization.",
    ],
  };
}

export function compareChat(before, after) {
  const mismatches = [];
  for (const key of [
    "mode",
    "scenario",
    "refreshHz",
    "userAgent",
    "evidence",
    "transport",
    "browserBuild",
  ])
    if (before[key] !== after[key]) mismatches.push(key);
  if (JSON.stringify(before.monitor) !== JSON.stringify(after.monitor))
    mismatches.push("monitor");
  if (before.workload.hash !== after.workload.hash) mismatches.push("workload");
  if (before.workload.trail !== after.workload.trail) mismatches.push("trail");
  if (
    JSON.stringify(before.initial.window) !==
    JSON.stringify(after.initial.window)
  )
    mismatches.push("window/display");
  if (!before.valid || !after.valid) mismatches.push("invalid capture");
  return {
    comparable: mismatches.length === 0,
    mismatches,
    movingP95Ms: [before.frames.movingMs.p95, after.frames.movingMs.p95],
    movingLongIntervals: [
      before.frames.movingLongIntervals,
      after.frames.movingLongIntervals,
    ],
    note: "A single pair is diagnostic evidence, not proof of improvement. Repeat in interleaved order.",
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values, positionals: args } = parseArgs({
    allowPositionals: true,
    options: {
      compare: { type: "boolean" },
      manual: { type: "boolean" },
      "refresh-hz": { type: "string", default: "60" },
    },
  });
  if (values.compare && args.length === 2) {
    const [before, after] = await Promise.all(
      args.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    console.log(JSON.stringify(compareChat(before, after), null, 2));
  } else {
    if (args.length !== 1 || values.compare)
      throw new Error(
        "Expected recording.json [--manual --refresh-hz=60] or --compare BEFORE-summary.json AFTER-summary.json",
      );
    console.log(
      JSON.stringify(
        analyzeChat(JSON.parse(await readFile(args[0], "utf8")), {
          native: values.manual ?? false,
          refreshHz: Number(values["refresh-hz"]),
        }),
        null,
        2,
      ),
    );
  }
}
