import assert from "node:assert/strict";
import { markers, stats } from "./analyze.mjs";
import { stackFrames } from "./capture.mjs";

/** Compact per-workload samples and GC slices; never retain raw stacks or pages. */
export function summarizeStructureProfile(profile) {
  const threads = [];
  const visit = (process) => {
    threads.push(...(process.threads ?? []));
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
    limitations:
      "2 ms sampled stacks and clipped GC/CC slices. Nearest runtime frames can include native or host work beneath them. Phases include warmup and frame waits; pauses are not total collection-cycle durations. Profiling adds overhead.",
  };
}
