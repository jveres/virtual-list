import { runAnalysisCli, selectCapture, stackFrames } from "./capture.mjs";

/** Retain representative write/input ordering without repeating the full stream. */
export function compactBursts(report) {
  const count = report.writeCount ?? report.writes.length;
  const writes =
    report.writes.length > 64
      ? Array.from(
          { length: 64 },
          (_, index) =>
            report.writes[
              Math.round((index * (report.writes.length - 1)) / 63)
            ],
        )
      : report.writes;
  const note =
    "Write details are limited to 64 evenly spaced writes and their 8 nearest input events; counts include omitted details. Rerun the fixture with expanded analysis for other event-order questions.";
  return {
    ...report,
    writeCount: count,
    omittedWriteDetails: count - writes.length,
    writes: writes.map((entry) => ({
      ...entry,
      nearbyInputCount: entry.nearbyInputCount ?? entry.nearbyInput.length,
      nearbyInput: entry.nearbyInput
        .toSorted(
          (a, b) =>
            Math.abs(a.start - entry.time) - Math.abs(b.start - entry.time),
        )
        .slice(0, 8)
        .sort((a, b) => a.start - b.start),
    })),
    limitations: [...new Set([...report.limitations, note])],
  };
}

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
  return compactBursts({
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
  });
}

await runAnalysisCli(import.meta.url, inspectBursts);
