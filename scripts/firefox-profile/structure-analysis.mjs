import assert from "node:assert/strict";
import { markers, stats } from "./analyze.mjs";
import { stackFrames } from "./capture.mjs";

function summarizeAllocations(thread, entries) {
  const classes = new Map();
  const nearestPage = new Map();
  const nearestRuntime = new Map();
  let bytes = 0;
  let nurseryCount = 0;
  let missingStacks = 0;
  const add = (map, name, size) => {
    const previous = map.get(name) ?? { count: 0, bytes: 0 };
    previous.count++;
    previous.bytes += size;
    map.set(name, previous);
  };
  for (const entry of entries) {
    const data = entry.data;
    assert.ok(
      Number.isFinite(data.size) && data.size >= 0,
      "Invalid sampled JS allocation size",
    );
    bytes += data.size;
    if (data.inNursery) nurseryCount++;
    add(classes, data.className ?? data.coarseType ?? "unknown", data.size);
    const samples = data.stack?.samples;
    const stack = samples?.data?.[0]?.[samples.schema?.stack];
    if (stack == null) {
      missingStacks++;
      continue;
    }
    // Keep page function/line attribution, without ports or browser internals.
    const frames = stackFrames(thread, stack)
      .filter((frame) => /\(https?:\/\/[^/]+\//.test(frame))
      .map((frame) =>
        frame.replace(/https?:\/\/[^/]+/, "").replace(/\[\d+\]$/, ""),
      );
    add(nearestPage, frames[0] ?? "unattributed", data.size);
    add(
      nearestRuntime,
      frames.find((frame) => /\([^)]*\/src\//.test(frame)) ?? "outside runtime",
      data.size,
    );
  }
  const rank = (map) =>
    [...map]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 20)
      .map(([site, totals]) => ({ site, ...totals }));
  return {
    count: entries.length,
    bytes,
    nurseryCount,
    missingStacks,
    classes: rank(classes),
    nearestPage: rank(nearestPage),
    nearestRuntime: rank(nearestRuntime),
    limitations:
      "Only sampled JS object creations inside marked workload phases. Bytes sum recorded sample sizes without extrapolation. No native allocations, frees or survival information. Nearest runtime frames can include host allocations underneath them. Allocation instrumentation changes timing and memory.",
  };
}

/** Compact per-workload samples and GC slices; never retain raw stacks or pages. */
export function summarizeStructureProfile(profile) {
  const threads = [];
  const metadata = new Map();
  const visit = (process) => {
    threads.push(...(process.threads ?? []));
    for (const thread of process.threads ?? [])
      metadata.set(thread, process.meta);
    process.processes?.forEach(visit);
  };
  visit(profile);
  const candidates = threads.filter(
    (thread) =>
      thread.name === "GeckoMain" &&
      markers(thread).some((entry) => entry.data?.name === "ff-profile-start"),
  );
  assert.equal(
    candidates.length,
    1,
    "Expected one complete diagnostic content thread",
  );
  const thread = candidates[0];
  const entries = markers(thread);
  const start = entries.find(
    (entry) => entry.data?.name === "ff-profile-start",
  ).start;
  const end = entries.find(
    (entry) => entry.data?.name === "ff-profile-end",
  )?.start;
  assert.ok(end > start, "Incomplete diagnostic profile");
  const phases = [];
  const pending = new Map();
  for (const entry of entries) {
    const name = entry.data?.name;
    const match =
      typeof name === "string"
        ? name.match(/^structure:(.+):(start|end)$/)
        : null;
    if (!match) continue;
    const [, label, edge] = match;
    if (edge === "start") {
      assert.ok(!pending.has(label), `Duplicate phase ${label}`);
      pending.set(label, entry.start);
    } else {
      const from = pending.get(label);
      assert.ok(
        Number.isFinite(from) && entry.start > from,
        `Incomplete phase ${label}`,
      );
      phases.push({ label, start: from, end: entry.start });
      pending.delete(label);
    }
  }
  assert.equal(pending.size, 0, "Unclosed diagnostic phases");
  assert.ok(phases.length > 0, "No diagnostic phases");
  for (const phase of phases) {
    phase.rendering = Object.fromEntries(
      [
        "Reflow",
        "Reflow (sync)",
        "Styles",
        "DisplayList",
        "RefreshDriverTick",
        "DoFlushPendingNotifications",
      ].map((name) => [
        name,
        stats(
          entries
            .filter(
              (entry) =>
                entry.name === name &&
                entry.start < phase.end &&
                entry.end > phase.start,
            )
            .map(
              (entry) =>
                Math.min(entry.end, phase.end) -
                Math.max(entry.start, phase.start),
            ),
        ),
      ]),
    );
    const schema = thread.samples.schema;
    let cpuMs = 0;
    let missingCpuSamples = 0;
    if (schema.threadCPUDelta !== undefined) {
      assert.equal(
        metadata.get(thread)?.sampleUnits?.threadCPUDelta,
        "µs",
        "Unsupported CPU unit",
      );
      for (let i = 1; i < thread.samples.data.length; i++) {
        const row = thread.samples.data[i];
        const from = thread.samples.data[i - 1][schema.time];
        const to = row[schema.time];
        const overlap = Math.min(to, phase.end) - Math.max(from, phase.start);
        if (overlap <= 0 || to <= from) continue;
        const delta = row[schema.threadCPUDelta];
        if (delta == null) missingCpuSamples++;
        else {
          assert.ok(Number.isFinite(delta) && delta >= 0, "Invalid CPU delta");
          cpuMs += ((delta / 1000) * overlap) / (to - from);
        }
      }
    }
    phase.cpuMs =
      schema.threadCPUDelta === undefined || missingCpuSamples
        ? null
        : +cpuMs.toFixed(3);
    phase.missingCpuSamples = missingCpuSamples;
    const pauses = entries.filter(
      (entry) =>
        /^(GCMinor|GCSlice|CCSlice)$/.test(entry.name) &&
        entry.start < phase.end &&
        entry.end > phase.start,
    );
    phase.gc = Object.fromEntries(
      ["GCMinor", "GCSlice", "CCSlice"].map((name) => [
        name,
        stats(
          pauses
            .filter((entry) => entry.name === name)
            .map(
              (entry) =>
                Math.min(entry.end, phase.end) -
                Math.max(entry.start, phase.start),
            ),
        ),
      ]),
    );
    const inclusive = new Map();
    const self = new Map();
    let samples = 0;
    for (const sample of thread.samples.data) {
      const time = sample[thread.samples.schema.time];
      if (time < phase.start || time >= phase.end) continue;
      samples++;
      const frames = stackFrames(thread, sample[thread.samples.schema.stack])
        .filter((frame) => /\([^)]*\/src\/[^)]+:\d+/.test(frame))
        .map((frame) =>
          frame.replace(/https?:\/\/[^/]+/, "").replace(/:\d+(?::\d+)?\)/, ")"),
        );
      if (frames[0]) self.set(frames[0], (self.get(frames[0]) ?? 0) + 1);
      for (const frame of new Set(frames))
        inclusive.set(frame, (inclusive.get(frame) ?? 0) + 1);
    }
    const rank = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 15);
    phase.samples = samples;
    phase.inclusive = rank(inclusive);
    phase.nearestRuntime = rank(self);
  }
  return {
    pid: thread.pid,
    intervalMs: profile.meta.interval,
    phases,
    jsAllocations: summarizeAllocations(
      thread,
      entries.filter(
        (entry) =>
          entry.data?.type === "JS allocation" &&
          phases.some(
            (phase) => entry.start >= phase.start && entry.start < phase.end,
          ),
      ),
    ),
    limitations:
      "2 ms sampled stacks, clipped rendering markers and GC/CC slices. Marker durations can overlap; absent markers do not establish zero work. CPU deltas interpolate phase boundaries and cover only the selected content main thread. Nearest runtime frames can include native or host work beneath them. Phases include warmup and frame waits; pauses are not total collection-cycle durations. Profiling adds overhead; animation-frame timing does not establish physical presentation.",
  };
}
