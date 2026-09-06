import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    count: sorted.length,
    total: round(sorted.reduce((sum, value) => sum + value, 0)),
    p50: sorted.length ? round(sorted[Math.floor(sorted.length * 0.5)]) : null,
    p95: sorted.length ? round(sorted[Math.floor(sorted.length * 0.95)]) : null,
    max: sorted.length ? round(sorted.at(-1)) : null,
  };
}

export function markers(thread) {
  const schema = thread.markers.schema;
  const result = [];
  const pending = new Map();
  for (const row of thread.markers.data) {
    const name = thread.stringTable[row[schema.name]];
    const phase = row[schema.phase];
    const entry = {
      name,
      start: row[schema.startTime],
      end: phase === 0 ? row[schema.startTime] : row[schema.endTime],
      data: row[schema.data],
    };
    if (phase === 0 || phase === 1) result.push(entry);
    if (phase === 2) {
      if (!pending.has(name)) pending.set(name, []);
      pending.get(name).push(entry);
    }
    if (phase === 3) {
      const start = pending.get(name)?.pop();
      if (start) result.push({ ...start, end: entry.end });
    }
  }
  return result;
}

export function analyze(profile, recording) {
  const processes = [];
  const visit = (process) => {
    processes.push(process);
    process.processes?.forEach(visit);
  };
  visit(profile);
  const threads = processes.flatMap((process) => process.threads ?? []);
  if (threads.some((thread) => !thread.markers?.schema)) {
    throw new Error(
      "Expected a raw Firefox profile, not a processed share export",
    );
  }
  let selected;
  let range;
  for (const thread of threads.filter(
    (thread) => thread.name === "GeckoMain",
  )) {
    const entries = markers(thread);
    const start = entries.find(
      (entry) => entry.data?.name === "ff-profile-start",
    );
    const end = entries.find((entry) => entry.data?.name === "ff-profile-end");
    if (!start || !end || end.start <= start.start) continue;
    range = [start.start, end.start];
    selected = entries.filter(
      (entry) => entry.start >= range[0] && entry.end <= range[1],
    );
    break;
  }
  if (!selected)
    throw new Error("No complete ff-profile-start/end measurement");
  const intervals = [];
  const movingIntervals = [];
  for (let index = 1; index < recording.frames.length; index++) {
    const frame = recording.frames[index];
    const previous = recording.frames[index - 1];
    const interval = frame[0] - previous[0];
    intervals.push(interval);
    if (frame[1] !== previous[1]) movingIntervals.push(interval);
  }
  const threshold = 1500 / recording.refreshHz;
  const duration = (entry) => entry.end - entry.start;
  const ticks = selected.filter((entry) => entry.name === "RefreshDriverTick");
  return {
    capture: recording.capture ?? "unspecified",
    display: recording.display,
    refreshHz: recording.refreshHz,
    durationMs: range[1] - range[0],
    animationFrameIntervalsMs: stats(intervals),
    movingAnimationFrameIntervalsMs: stats(movingIntervals),
    longIntervalThresholdMs: threshold,
    longIntervals: intervals.filter((interval) => interval > threshold).length,
    scrollPositionWrites: recording.writes,
    scrollEvents: recording.scrollEvents,
    scrollEnds: recording.scrollEnds,
    bursts: recording.bursts,
    markersMs: Object.fromEntries(
      [
        "RefreshDriverTick",
        "DisplayList",
        "Reflow (sync)",
        "Styles",
        "DoFlushPendingNotifications",
        "GCMinor",
        "GCSlice",
      ].map((name) => [
        name,
        stats(selected.filter((entry) => entry.name === name).map(duration)),
      ]),
    ),
    scrollHandlersMs: stats(
      selected
        .filter(
          (entry) =>
            entry.name === "DOMEvent" && entry.data?.eventType === "scroll",
        )
        .map(duration),
    ),
    longestRefreshTicks: ticks
      .toSorted((a, b) => duration(b) - duration(a))
      .slice(0, 8)
      .map((entry) => ({ start: entry.start, duration: duration(entry) })),
    capturedThreads: threads.map((thread) => ({
      name: thread.name,
      process: thread.processType,
    })),
    limitations: [
      "Animation-frame timing is not physical display presentation timing.",
      recording.capture === "live"
        ? "Live capture includes the threads available at collection; inspect capturedThreads."
        : "Shutdown capture can omit GPU-process threads; inspect capturedThreads.",
      "Native scripted gestures have no trackpad momentum tail.",
      "Marker durations are nested; do not add them as independent CPU costs.",
    ],
  };
}

export async function analyzeDirectory(directory) {
  let bytes;
  try {
    bytes = await readFile(resolve(directory, "profile.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = gunzipSync(await readFile(resolve(directory, "profile.json.gz")));
  }
  return analyze(
    JSON.parse(bytes),
    JSON.parse(await readFile(resolve(directory, "frames.json"))),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node scripts/firefox-profile/analyze.mjs RUN_DIRECTORY",
    );
  console.log(JSON.stringify(await analyzeDirectory(process.argv[2]), null, 2));
}
