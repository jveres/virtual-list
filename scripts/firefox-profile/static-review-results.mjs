// Read local native captures. Never launch a browser or mutate input artifacts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stats } from "./analyze.mjs";
import { attributeProfile } from "./attribute.mjs";
import { readCapture, selectCapture } from "./capture.mjs";
import { auditCpu } from "./cpu.mjs";

if (process.argv.length < 3)
  throw new Error("Pass at least one completed native capture directory");

for (const directory of process.argv.slice(2)) {
  const metadata = JSON.parse(
    await readFile(join(directory, "run.json"), "utf8"),
  );
  if (metadata.status !== "complete" || !metadata.browserProfileRemoved)
    throw new Error(`Incomplete capture: ${directory}`);
  const { profile, recording } = await readCapture(directory);
  if (recording.components && recording.components.status !== "complete")
    throw new Error(`Incomplete component measurements: ${directory}`);
  const cpu = auditCpu(profile, recording);
  const runtime = attributeProfile(profile, {
    filter: "/src/",
    top: Number.MAX_SAFE_INTEGER,
  })[0];
  const capture = selectCapture(profile, recording);
  const offset = recording.timeOrigin - capture.process.meta.startTime;
  const content = cpu.cpuThreads.find(
    (thread) => thread.pid === cpu.contentPid && thread.name === "GeckoMain",
  );
  const groups = new Map();
  for (const result of recording.components?.results ?? []) {
    const key = `${result.kind}/${result.variant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  const components = Object.fromEntries(
    [...groups].map(([key, values]) => [
      key,
      {
        rounds: values.length,
        roundTotals: values.map(
          (value) =>
            value.duration ?? value.durations.reduce((a, b) => a + b, 0),
        ),
        perOperation: stats(
          values.flatMap((value) =>
            value.durations
              ? value.durations.map(
                  (duration) => duration / (value.updatesPerBatch ?? 1),
                )
              : [value.duration / (value.calls ?? 1)],
          ),
        ),
        geometry: values.map((value) => value.height ?? value.size ?? null),
        refreshTicks: stats(
          capture.entries
            .filter(
              (entry) =>
                entry.name === "RefreshDriverTick" &&
                values.some(
                  (value) =>
                    Number.isFinite(value.start) &&
                    entry.start >= value.start + offset &&
                    entry.start < value.end + offset,
                ),
            )
            .map((entry) => entry.end - entry.start),
        ),
      },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        directory,
        url: metadata.options.url,
        display: metadata.display,
        scrollEvents: recording.scrollEvents,
        scrollEnds: recording.scrollEnds,
        movingFrames: recording.frames.filter(
          (frame, i) => i && frame[1] !== recording.frames[i - 1][1],
        ).length,
        componentStatus: recording.components?.status,
        componentError: recording.components?.error,
        components,
        durationMs: cpu.durationMs,
        contentCpuMs: content?.totalCpuMs,
        contentCpuPercent: content?.averagePercentOneCore,
        peak100MsPercent: content?.percentOneCorePer100Ms.max,
        markers: cpu.markerDurationsMs.filter((entry) =>
          [
            "DOMEvent:scroll",
            "Awake",
            "CCSlice",
            "GCSlice",
            "RefreshDriverTick",
          ].includes(entry.name),
        ),
        runtimeSelf: cpu.runtimeSelf,
        measurementSelfSamples: runtime.self
          .filter((entry) => entry.name.includes("measureMany"))
          .reduce((sum, entry) => sum + entry.count, 0),
      },
      null,
      2,
    ),
  );
}
