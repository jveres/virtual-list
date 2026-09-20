import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const markerPattern = /^top-probe-([a-z0-9-]+)-(\d+)-(start|end)$/;
const taskNames = new Set([
  "ThreadControllerImpl::RunTask",
  "ThreadPool_RunTask",
]);
const keyOf = (event) => `${event.pid}:${event.tid}`;
const milliseconds = (value) => Math.round(value) / 1000;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;

/** Offline diagnostic: trace presentation records are not physical-screen proof. */
export function analyzeChromePresentation(trace, measurements = null) {
  if (!Array.isArray(trace?.traceEvents))
    throw new Error("Expected a traceEvents array");
  if (measurements !== null && !Array.isArray(measurements?.results))
    throw new Error("Expected measurements.results to be an array");
  const threads = new Map();
  const gpuProcesses = new Set();
  const markers = new Map();
  const selected = [];
  for (const event of trace.traceEvents) {
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("Invalid trace event");
    if (event.name === "thread_name")
      threads.set(keyOf(event), event.args?.name);
    if (event.name === "process_name" && event.args?.name === "GPU Process")
      gpuProcesses.add(event.pid);
    const marker =
      typeof event.name === "string" && event.name.startsWith("top-probe-");
    const presentation = event.name === "AnimationFrame::Presentation";
    const task = event.ph === "X" && taskNames.has(event.name);
    if (!marker && !presentation && !task) continue;
    if (
      !nonnegative(event.ts) ||
      !Number.isInteger(event.pid) ||
      !Number.isInteger(event.tid)
    )
      throw new Error(`Invalid timestamp or thread identity: ${event.name}`);
    if (
      task &&
      (!nonnegative(event.dur) ||
        (event.tdur != null && !nonnegative(event.tdur)))
    )
      throw new Error(`Invalid task duration: ${event.name}`);
    if (marker) {
      const match = markerPattern.exec(event.name);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[2])) ||
        !["I", "R"].includes(event.ph) ||
        markers.has(event.name)
      )
        throw new Error(`Invalid or duplicate probe marker: ${event.name}`);
      markers.set(event.name, {
        ...event,
        workload: match[1],
        run: Number(match[2]),
        edge: match[3],
      });
    } else selected.push(event);
  }
  const starts = [...markers.values()]
    .filter((event) => event.edge === "start")
    .sort((a, b) => a.ts - b.ts);
  if (!starts.length) throw new Error("No top-probe start markers found");
  if (markers.size !== starts.length * 2)
    throw new Error("Unpaired probe markers");
  const results = starts.map((start) => {
    const end = markers.get(start.name.replace(/-start$/, "-end"));
    if (!end || keyOf(start) !== keyOf(end) || end.ts <= start.ts)
      throw new Error(`Missing or invalid end marker: ${start.name}`);
    const paired = measurements?.results.filter(
      (entry) => entry?.workload === start.workload && entry.run === start.run,
    );
    if (paired && paired.length !== 1)
      throw new Error(`Expected one measurement for ${start.name}`);
    const presentationTimes = new Set();
    const longest = new Map();
    for (const event of selected) {
      const key = keyOf(event);
      if (event.name === "AnimationFrame::Presentation") {
        if (key === keyOf(start) && event.ts >= start.ts && event.ts < end.ts)
          presentationTimes.add(event.ts);
        continue;
      }
      const renderer = key === keyOf(start);
      const gpu =
        gpuProcesses.has(event.pid) || threads.get(key) === "CrGpuMain";
      if (
        (!renderer && !gpu) ||
        event.ts >= end.ts ||
        event.ts + event.dur <= start.ts
      )
        continue;
      if (!longest.has(key) || event.dur > longest.get(key).dur)
        longest.set(key, event);
    }
    const times = [...presentationTimes].sort((a, b) => a - b);
    const gaps = times
      .slice(1)
      .map((time, index) => ({
        fromMs: milliseconds(times[index] - start.ts),
        toMs: milliseconds(time - start.ts),
        elapsedMs: milliseconds(time - times[index]),
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs);
    return {
      marker: start.name,
      durationMs: milliseconds(end.ts - start.ts),
      presentationRecords: times.length,
      maxPresentationGapMs: gaps[0]?.elapsedMs ?? null,
      largestPresentationGaps: gaps.slice(0, 10),
      longestThreadTasks: [...longest.values()]
        .sort((a, b) => b.dur - a.dur)
        .map((event) => ({
          pid: event.pid,
          tid: event.tid,
          thread: threads.get(keyOf(event)) ?? "unknown",
          role: keyOf(event) === keyOf(start) ? "renderer" : "gpu-process",
          name: event.name,
          startMs: milliseconds(event.ts - start.ts),
          elapsedMs: milliseconds(event.dur),
          cpuMs: event.tdur == null ? null : milliseconds(event.tdur),
          overlapMs: milliseconds(
            Math.min(end.ts, event.ts + event.dur) -
              Math.max(start.ts, event.ts),
          ),
          source: event.args?.src_file ?? null,
          function: event.args?.src_func ?? null,
        })),
      measurement: paired
        ? {
            initial: paired[0].initial ?? null,
            final: paired[0].final ?? null,
            summary: paired[0].summary ?? null,
            invalidations: paired[0].invalidations ?? null,
          }
        : null,
    };
  });
  return {
    browser: measurements?.browser ?? null,
    captureErrors: measurements?.errors ?? null,
    results,
    limits: [
      "Presentation records are Chrome telemetry, not independent physical-screen measurements.",
      "Gaps cover the whole marker window, including idle/paging; check actual movement before calling them stalls.",
      "Intervals use the marker's renderer thread; duplicate presentation timestamps are collapsed.",
      "Task elapsed and thread CPU durations are separate; missing CPU telemetry is null.",
      "Tasks may cross marker boundaries: overlapMs is the portion inside the window.",
      "GPU-process tasks are not measurements of hardware GPU utilization or proof of shader compilation.",
      "Absent records mean unavailable telemetry, not a successful smoothness check.",
    ],
  };
}

function readJson(path) {
  const bytes = readFileSync(path);
  return JSON.parse(
    (bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes)
      : bytes
    ).toString("utf8"),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: node scripts/firefox-profile/chrome-presentation.mjs TRACE.json[.gz] [MEASUREMENTS.json[.gz]]\nOffline top-probe presentation/task summary to stdout. Creates no artifacts.",
    );
  } else {
    try {
      if (
        args.length < 1 ||
        args.length > 2 ||
        args.some((arg) => arg.startsWith("--"))
      )
        throw new Error(
          "Expected a trace path and optional measurements path; use --help",
        );
      console.log(
        JSON.stringify(
          analyzeChromePresentation(
            readJson(args[0]),
            args[1] ? readJson(args[1]) : null,
          ),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(`Chrome presentation analysis failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
