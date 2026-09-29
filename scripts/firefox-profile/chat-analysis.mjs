import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { analyzeSteadyScroll } from "./steady-scroll.mjs";

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

/** Compact scroll-response evidence; position sampling does not prove presentation. */
export function summarizeScrollMotion(recording) {
  const writes = recording.scrollWrites;
  if (!Array.isArray(writes)) return { available: false };
  return {
    available: true,
    phases: [...new Set(writes.map((write) => write.phase ?? "unknown"))].map(
      (phase) => {
        const selected = writes.filter(
          (write) => (write.phase ?? "unknown") === phase,
        );
        const smooth = selected.filter((write) => write.behavior === "smooth");
        const measured = smooth.filter(
          (write) =>
            Number.isFinite(write.beforeTop) && Number.isFinite(write.afterTop),
        );
        const steps = [];
        for (let i = 1; i < recording.frames.length; i++) {
          const previous = recording.frames[i - 1];
          const frame = recording.frames[i];
          if (previous[2] === phase && frame[2] === phase)
            steps.push(Math.abs(frame[1] - previous[1]));
        }
        return {
          phase,
          writes: selected.length,
          smooth: smooth.length,
          instant: selected.filter(
            (write) =>
              write.method === "scrollTop" || write.behavior === "instant",
          ).length,
          measuredSmoothRequests: measured.length,
          synchronousSmoothJumps: measured.filter(
            (write) => Math.abs(write.afterTop - write.beforeTop) > 1,
          ).length,
          synchronousMovementPx: distribution(
            measured.map((write) => Math.abs(write.afterTop - write.beforeTop)),
          ),
          requestedDistancePx: distribution(
            measured
              .map((write) => Math.abs(write.top - write.beforeTop))
              .filter(Number.isFinite),
          ),
          observedMovingStepsPx: distribution(
            steps.filter((step) => step > 0.01),
          ),
          stationaryFrames: steps.filter((step) => step <= 0.01).length,
        };
      },
    ),
  };
}

function schedulingWindow(recording, frame) {
  const scheduling = recording.scheduling;
  if (!scheduling || frame.callbackStart === null || frame.callbackEnd === null)
    return null;
  const { callbackStart: start, callbackEnd: end } = frame;
  const overlaps = (a, b) => a < end && b > start;
  return {
    timerTicks: scheduling.timers.filter(
      (tick) => tick[2] > start && tick[2] <= end,
    ).length,
    timerLatenessMs: distribution(
      scheduling.timers
        .filter((tick) => overlaps(tick[1], tick[2]))
        .map((tick) => Math.max(0, tick[2] - tick[1])),
    ),
    postRafTaskMs: distribution(
      scheduling.tasks
        .filter((task) => overlaps(task[0], task[1]))
        .map((task) => task[1] - task[0]),
    ),
    rafCallbacks: scheduling.rafWork
      .filter((work) => overlaps(work[0], work[0] + work[1]))
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([time, durationMs, name, , source]) => ({
        time,
        durationMs,
        overlapMs: Math.max(
          0,
          Math.min(time + durationMs, end) - Math.max(time, start),
        ),
        name,
        source: source ?? null,
      })),
    trailChanges: scheduling.trailChanges.filter(
      (change) => change.time >= start - 100 && change.time <= end + 100,
    ),
  };
}

function analyzeScheduling(recording, intervals) {
  const scheduling = recording.scheduling;
  if (!scheduling) return { available: false };
  const callbacks = new Map();
  for (const [, duration, name, , source] of scheduling.rafWork) {
    const entry = callbacks.get(name) ?? {
      name,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
    };
    entry.calls++;
    entry.totalMs += duration;
    entry.maxMs = Math.max(entry.maxMs, duration);
    if (source && duration === entry.maxMs) entry.slowestSource = source;
    callbacks.set(name, entry);
  }
  return {
    available: true,
    version: scheduling.version,
    timerPeriodMs: scheduling.timerPeriodMs,
    timerLatenessMs: distribution(
      scheduling.timers.map((tick) => Math.max(0, tick[2] - tick[1])),
    ),
    postRafTaskMs: distribution(
      scheduling.tasks.map((task) => task[1] - task[0]),
    ),
    worstTimers: scheduling.timers
      .toSorted((a, b) => b[2] - b[1] - (a[2] - a[1]))
      .slice(0, 10)
      .map(([scheduled, due, ran]) => ({
        scheduled,
        due,
        ran,
        lateMs: Math.max(0, ran - due),
      })),
    rafCallbacks: [...callbacks.values()].sort((a, b) => b.totalMs - a.totalMs),
    trailChanges: scheduling.trailChanges,
    trailDisposals: scheduling.trailChanges
      .filter((change) => change.layersRemoved > 0)
      .map((change) => {
        const start = change.time - 100,
          end = change.time + 200;
        const frames = intervals.filter(
          (frame) => frame.start < end && frame.end > start,
        );
        const window = schedulingWindow(recording, {
          callbackStart: start,
          callbackEnd: end,
        });
        return {
          time: change.time,
          window: [start, end],
          frameMs: distribution(frames.map((frame) => frame.duration)),
          callbackGapMs: distribution(
            frames
              .map((frame) => frame.callbackGapMs)
              .filter((value) => value !== null),
          ),
          timerLatenessMs: window.timerLatenessMs,
          postRafTaskMs: window.postRafTaskMs,
        };
      }),
    limitations: [
      "Timer lateness and posted-task delay include scheduling and browser work; they are not JS CPU or paint timings.",
      "rAF callback names can collide; durations exclude work outside callbacks and callbacks queued before probe start.",
      "Trail markers record direct child-list changes at MutationObserver delivery, not animation completion or removal cost.",
      "This opt-in probe adds one 16 ms timer, at most one queued task, rAF wrappers, and a child-list observer. Compare with the same probe settings.",
    ],
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
        callbackStart: Number.isFinite(previous[11]) ? previous[11] : null,
        callbackEnd: Number.isFinite(frame[11]) ? frame[11] : null,
        callbackGapMs:
          Number.isFinite(previous[11]) && Number.isFinite(frame[11])
            ? frame[11] - previous[11]
            : null,
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
  const steady =
    recording.scenario === "steady" ? analyzeSteadyScroll(recording) : null;
  if (steady) reasons.push(...steady.reasons);
  if (
    !steady &&
    (!recording.stream.done ||
      recording.stream.characters !== recording.workload.characters ||
      recording.stream.chunks !== recording.workload.chunks)
  )
    reasons.push("Stream did not complete with the expected input");
  if (moving.length < 30) reasons.push("Insufficient scroll movement");
  if (
    ["scrollback", "manual", "steady"].includes(recording.scenario) &&
    (recording.scroll.wheels < 30 || recording.scroll.ends < 1)
  )
    reasons.push("Missing gesture input or scroll-end events");
  if (
    recording.scenario === "buttons" &&
    (recording.navigation?.length !== 4 ||
      recording.navigation.some((command) => command.reached !== true) ||
      recording.scroll.ends < 4)
  )
    reasons.push("Incomplete button navigation or missing scroll-end events");
  if (recording.errors.length) reasons.push("Page errors occurred");
  if (recording.invalidations.length)
    reasons.push("Focus, visibility, or geometry changed during capture");
  if (Object.values(recording.dropped).some((count) => count > 0))
    reasons.push("Telemetry buffer overflow");
  if (!recording.frames.length) reasons.push("No frame samples");
  if (!isDeepStrictEqual(recording.initial.window, recording.final.window))
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
        scheduling: schedulingWindow(recording, frame),
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
    probeVersion: recording.probeVersion ?? 1,
    transport: recording.transport ?? "unspecified",
    nativeSampling: recording.nativeSampling ?? null,
    renderSnapshots: recording.renderSnapshots ?? false,
    valid: reasons.length === 0,
    invalidReasons: reasons,
    evidence: native
      ? "installed-browser-native-input-or-follow"
      : "automation-correctness-only",
    mode: recording.mode,
    traceInvalidations: recording.traceInvalidations ?? false,
    traceSelectorStats: recording.traceSelectorStats ?? false,
    scenario: recording.scenario,
    workload: recording.workload,
    ...(steady ? { steady } : {}),
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
      callbackGapMs: distribution(
        intervals.map((frame) => frame.callbackGapMs).filter(Number.isFinite),
      ),
      callbackEntryLagMs: distribution(
        recording.frames
          .filter((frame) => Number.isFinite(frame[11]))
          .map((frame) => frame[11] - frame[0]),
      ),
      longThresholdMs: threshold,
      longIntervals: intervals.filter((frame) => frame.duration > threshold)
        .length,
      movingLongIntervals: moving.filter((frame) => frame.duration > threshold)
        .length,
    },
    phases,
    slowFrames,
    scheduling: analyzeScheduling(recording, intervals),
    coverage: {
      available: Array.isArray(recording.coverage),
      samples: recording.coverage?.length ?? 0,
      missingPx: distribution(
        (recording.coverage ?? []).map((entry) => entry.missingPx),
      ),
      gaps: (recording.coverage ?? [])
        .filter((entry) => entry.missingPx > 1)
        .slice(0, 20),
      note: "Cached row geometry and DOM connection at publication; this does not prove that pixels were painted or cover compositor-only movement between events.",
    },
    scrollMotion: summarizeScrollMotion(recording),
    navigation: (recording.navigation ?? []).map((command) => {
      const frames = intervals.filter(
        (frame) =>
          frame.end >= command.time && frame.start <= command.time + 1800,
      );
      const writes = (recording.scrollWrites ?? []).filter(
        (write) =>
          write.time >= command.time && write.time <= command.time + 1800,
      );
      const request = writes.find((write) => write.behavior === "smooth");
      const firstMovement =
        request &&
        frames.find(
          (frame) =>
            (frame.callbackEnd ?? frame.end) >= request.time &&
            (command.direction === "bottom"
              ? frame.movement > 1
              : frame.movement < -1),
        );
      return {
        ...command,
        windowMs: 1800,
        firstSmoothRequestMs: request ? request.time - command.time : null,
        firstDirectionalMovementMs: firstMovement
          ? (firstMovement.callbackEnd ?? firstMovement.end) - command.time
          : null,
        frameMs: distribution(frames.map((frame) => frame.duration)),
        movingFrameMs: distribution(
          frames
            .filter((frame) => Math.abs(frame.movement) > 0.01)
            .map((frame) => frame.duration),
        ),
        distance: frames.reduce(
          (sum, frame) => sum + Math.abs(frame.movement),
          0,
        ),
        writesAvailable: Array.isArray(recording.scrollWrites),
        writeCount: Array.isArray(recording.scrollWrites)
          ? writes.length
          : null,
        omittedWrites: Array.isArray(recording.scrollWrites)
          ? Math.max(0, writes.length - 120)
          : null,
        writes: writes.slice(0, 120),
      };
    }),
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
      domOperations: recording.domOperations ?? null,
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
      "Navigation request latency measures API submission. First directional movement is a sampled position change after that request; concurrent momentum or layout can also change position. Neither measures physical presentation.",
      "Animation callbacks and input-to-rAF timing are not physical presentation or event-to-photon latency.",
      "Repeated calls and unchanged text are candidates, not proof of redundant work: tools, cursor, mount state, or geometry may differ.",
      "Inclusive operation times overlap; self time subtracts only other instrumented synchronous calls, not browser work or asynchronous continuations.",
      "Geometry access counts do not prove forced reflow. Use the native trace and invalidation stacks to attribute layout cost.",
      "Slow DOM operations retain at most 64 calls of at least 4 ms, with tag/class metadata and child counts after the call. Up to 64 instrumented spans lasting at least 16 ms retain mutation bursts, each with at most 16 method/tag groups. Native-call timings exclude recorder bookkeeping; enclosing spans include it. No text content or geometry is read for these records.",
      "DOM connection groups classify the wrapped insertBefore/removeChild/remove calls from pre-call tree state, not subtree size or paint cost. Moving into a detached parent counts as connected removal; detached-insert includes construction and detached reordering. Same-position inserts still count as moves. No-op means a parentless remove or an empty fragment insertion; exceptions count as failed calls.",
      "Unsupported performance entries and heap metrics are unavailable, not zero. Event Timing here is not field INP; layout shifts are not a full CLS score.",
      "Diagnostic observers, wrappers, and timers perturb execution. Compare repeated timing-mode captures before evaluating an optimization.",
    ],
  };
}

export function compareChat(before, after) {
  const mismatches = [];
  for (const [key, fallback] of [
    ["probeVersion", 1],
    ["renderSnapshots", false],
    ["traceSelectorStats", false],
  ])
    if ((before[key] ?? fallback) !== (after[key] ?? fallback))
      mismatches.push(key);
  if (
    !isDeepStrictEqual(
      before.nativeSampling ?? null,
      after.nativeSampling ?? null,
    )
  )
    mismatches.push("nativeSampling");
  if (
    (before.scheduling?.version ?? null) !== (after.scheduling?.version ?? null)
  )
    mismatches.push("scheduler");
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
  if (
    (before.traceInvalidations ?? false) !== (after.traceInvalidations ?? false)
  )
    mismatches.push("traceInvalidations");
  if (!isDeepStrictEqual(before.monitor, after.monitor))
    mismatches.push("monitor");
  if (before.workload.hash !== after.workload.hash) mismatches.push("workload");
  if (before.workload.trail !== after.workload.trail) mismatches.push("trail");
  if (!isDeepStrictEqual(before.initial.window, after.initial.window))
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
