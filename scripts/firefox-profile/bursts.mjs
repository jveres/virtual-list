import { runAnalysisCli, selectCapture, stackFrames } from "./capture.mjs";

/** Inspect the three longest content-thread awake intervals and write/input order. */
export function inspectBursts(profile, recording) {
  const { process, thread, entries, start, end } = selectCapture(
    profile,
    recording,
  );
  const selected = entries.filter((e) => e.start >= start && e.end <= end);
  const blocks = selected
    .filter((e) => e.name === "Awake")
    .toSorted((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, 3);
  const awake = blocks.map((block) => {
    const stacks = new Map();
    for (const sample of thread.samples.data) {
      const time = sample[thread.samples.schema.time];
      if (time < block.start || time > block.end) continue;
      const key = stackFrames(thread, sample[thread.samples.schema.stack])
        .slice(0, 16)
        .join("\n");
      stacks.set(key, (stacks.get(key) ?? 0) + 1);
    }
    return {
      start: block.start,
      durationMs: block.end - block.start,
      intervals: selected
        .filter(
          (e) =>
            e.start >= block.start &&
            e.end <= block.end &&
            e.end - e.start > 0.5,
        )
        .map((e) => ({
          name: e.name,
          start: e.start,
          durationMs: e.end - e.start,
          type: e.data?.eventType,
        })),
      stacks: [...stacks]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([stack, samples]) => ({ stack, samples })),
    };
  });
  const writes = recording.writes
    .filter((w) => !w.phase.startsWith("settle-"))
    .map((write) => {
      const time = write.time + recording.timeOrigin - process.meta.startTime;
      return {
        write,
        time,
        nearbyInput: selected
          .filter(
            (e) =>
              e.name === "DOMEvent" &&
              ["wheel", "scrollend"].includes(e.data?.eventType) &&
              Math.abs(e.start - time) < 180,
          )
          .map((e) => ({ type: e.data.eventType, start: e.start })),
      };
    });
  return {
    contentPid: thread.pid,
    start,
    end,
    awake,
    writes,
    limitations: [
      "Awake intervals may include multiple tasks; nested marker durations overlap.",
      "Stacks are sampled, truncated to 16 frames, and may contain unsymbolicated native addresses.",
      "Harness phases start before native input delivery; nearby events show actual observed order.",
    ],
  };
}

await runAnalysisCli(import.meta.url, inspectBursts);
