import { stats } from "./analyze.mjs";
import { attributeProfile } from "./attribute.mjs";
import { runAnalysisCli, selectCapture } from "./capture.mjs";

export function auditCpu(profile, recording) {
  const {
    thread,
    process: content,
    start,
    end,
    processes,
    entries: allEntries,
  } = selectCapture(profile, recording);
  const entries = allEntries.filter((e) => e.start >= start && e.end <= end);
  const duration = (e) => e.end - e.start;
  const groups = new Map();
  for (const entry of entries) {
    const name =
      entry.name === "DOMEvent"
        ? `DOMEvent:${entry.data?.eventType}`
        : entry.name;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(duration(entry));
  }
  const unit = content.meta.sampleUnits?.threadCPUDelta;
  if (unit !== "µs") throw new Error(`Unsupported CPU unit: ${unit}`);
  const cpuThreads = [];
  const frames = recording.frames.map(([time, top, phase]) => [
    time + recording.timeOrigin - content.meta.startTime,
    top,
    phase,
  ]);
  function phaseAt(time) {
    let low = 0,
      high = frames.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (frames[mid][0] <= time) low = mid + 1;
      else high = mid;
    }
    return frames[low - 1]?.[2] ?? "unknown";
  }
  const binPhases = Array.from(
    { length: Math.floor((end - start) / 100) },
    (_, index) => {
      const from = start + index * 100;
      const to = from + 100;
      const phase = phaseAt(from);
      return frames.some(
        ([time, , next]) => time > from && time <= to && next !== phase,
      )
        ? "mixed"
        : phase;
    },
  );
  for (const process of processes) {
    if (process.meta.sampleUnits?.threadCPUDelta !== "µs")
      throw new Error("Unsupported CPU unit in captured process");
    const offset = content.meta.startTime - process.meta.startTime;
    for (const candidate of process.threads ?? []) {
      const schema = candidate.samples.schema;
      const selected = candidate.samples.data.filter(
        (row) =>
          row[schema.time] >= start + offset &&
          row[schema.time] <= end + offset,
      );
      if (!selected.length) continue;
      const count = binPhases.length;
      const bins = new Array(count).fill(0);
      let totalUs = 0;
      let missing = 0;
      for (const row of selected) {
        const cpu = row[schema.threadCPUDelta];
        if (cpu == null) {
          missing++;
          continue;
        }
        if (!Number.isFinite(cpu) || cpu < 0)
          throw new Error("Invalid CPU delta");
        totalUs += cpu;
        const bin = Math.floor((row[schema.time] - start - offset) / 100);
        if (bin >= 0 && bin < count) bins[bin] += cpu / 1000;
      }
      // Each full bin is 100 ms: CPU milliseconds are numerically % of one core.
      const indexedBins = bins.map((percentOneCore, index) => ({
        start: start + index * 100,
        percentOneCore,
        phase: binPhases[index],
      }));
      cpuThreads.push({
        name: candidate.name,
        process: candidate.processType,
        pid: candidate.pid,
        totalCpuMs: missing ? null : totalUs / 1000,
        averagePercentOneCore: missing ? null : totalUs / ((end - start) * 10),
        percentOneCorePer100Ms: stats(missing ? [] : bins),
        missingCpuSamples: missing,
        activeInputPercentOneCorePer100Ms: stats(
          (missing ? [] : indexedBins)
            .filter((b) => /^(up|down)-/.test(b.phase))
            .map((b) => b.percentOneCore),
        ),
        top100MsBins: (missing ? [] : indexedBins)
          .toSorted((a, b) => b.percentOneCore - a.percentOneCore)
          .slice(0, 5),
      });
    }
  }
  const runtime = attributeProfile(profile, {
    filter: "/src/",
    top: Number.MAX_SAFE_INTEGER,
  })[0];
  const allScripts = attributeProfile(profile, { filter: "", top: 20 })[0];
  return {
    contentPid: thread.pid,
    start,
    end,
    durationMs: end - start,
    markerDurationsMs: [...groups]
      .map(([name, values]) => ({ name, ...stats(values) }))
      .sort((a, b) => b.max - a.max),
    longestMarkers: entries
      .filter(
        (e) =>
          duration(e) > 8 &&
          /^(Awake|RefreshDriverTick|requestAnimationFrame callbacks|setTimeout callback|Perform microtasks|GCMinor|GCSlice|CCSlice|DOMEvent)$/.test(
            e.name,
          ),
      )
      .sort((a, b) => duration(b) - duration(a))
      .slice(0, 30)
      .map((e) => ({
        name: e.name,
        start: e.start,
        durationMs: duration(e),
        data: e.data,
      })),
    cpuThreads: cpuThreads.sort((a, b) => b.totalCpuMs - a.totalCpuMs),
    runtimeNearestJsSamples: runtime.self.reduce(
      (sum, entry) => sum + entry.count,
      0,
    ),
    runtimeSamplePercent:
      runtime.samples === 0
        ? null
        : (runtime.self.reduce((sum, entry) => sum + entry.count, 0) /
            runtime.samples) *
          100,
    runtimeSelf: runtime.self.slice(0, 15),
    topScriptSelf: allScripts.self,
    sampleCount: runtime.samples,
    samplesWithScript: runtime.samplesWithScript,
    limits: [
      "CPU is sampled thread CPU delta, not whole-machine utilization.",
      "100 ms bins exclude the final partial bin and are not a continuous-task measure.",
      "Nearest-JS sample attribution includes native descendants, not pure JS CPU.",
      "Nested marker durations must not be added as independent costs.",
      "CPU deltas are credited to their sample timestamp; bin boundaries have sampling uncertainty.",
      "Incomplete CPU telemetry is unavailable, not zero CPU.",
    ],
  };
}

await runAnalysisCli(import.meta.url, auditCpu);
