import assert from "node:assert/strict";
import { distribution } from "./chat-analysis.mjs";

export function analyzeChatChrome(trace, cpu = null) {
  assert.ok(Array.isArray(trace?.traceEvents), "Expected Chrome traceEvents");
  const marks = (name) =>
    trace.traceEvents.filter(
      (event) => event.name === name && ["I", "R"].includes(event.ph),
    );
  const starts = marks("chat-profile-start"),
    ends = marks("chat-profile-end");
  assert.equal(starts.length, 1, "Expected one chat-profile-start marker");
  assert.equal(ends.length, 1, "Expected one chat-profile-end marker");
  const start = starts[0],
    end = ends[0];
  assert.ok(
    end.ts > start.ts && start.pid === end.pid && start.tid === end.tid,
    "Mismatched chat trace markers",
  );
  const categories = new Map();
  const invalidations = new Map();
  let invalidationRecords = 0;
  const styledElements = [];
  const threads = new Map();
  const threadNames = new Map();
  const processNames = new Map();
  for (const event of trace.traceEvents) {
    if (event.ph !== "M") continue;
    if (event.name === "thread_name")
      threadNames.set(`${event.pid}:${event.tid}`, event.args?.name);
    if (event.name === "process_name")
      processNames.set(event.pid, event.args?.name);
  }
  const presentations = new Set();
  const longest = [];
  for (const event of trace.traceEvents) {
    const renderer = event.pid === start.pid && event.tid === start.tid;
    if (
      renderer &&
      event.ts >= start.ts &&
      event.ts <= end.ts &&
      /InvalidationTracking$/.test(event.name)
    ) {
      const data = event.args?.data ?? {};
      invalidationRecords++;
      const frame = data.stackTrace?.[0];
      const key = JSON.stringify([
        event.name,
        data.reason,
        data.changedAttribute,
        data.changedClass,
        data.changedPseudo,
        data.selectorPart,
        data.subtree,
        data.selectors?.map((selector) => selector.selector),
        frame?.functionName,
        frame?.url,
        frame?.lineNumber,
      ]);
      const group = invalidations.get(key) ?? {
        name: event.name,
        count: 0,
        example: {
          reason: data.reason,
          nodeName: data.nodeName,
          subtree: data.subtree,
          changedAttribute: data.changedAttribute,
          changedClass: data.changedClass,
          changedPseudo: data.changedPseudo,
          selectorPart: data.selectorPart,
          selectors: data.selectors?.slice(0, 8),
          omittedSelectors: Math.max(0, (data.selectors?.length ?? 0) - 8),
          stackTrace: data.stackTrace?.slice(0, 8),
          omittedStackFrames: Math.max(0, (data.stackTrace?.length ?? 0) - 8),
        },
      };
      group.count++;
      invalidations.set(key, group);
    }
    if (
      renderer &&
      event.name === "AnimationFrame::Presentation" &&
      event.ts >= start.ts &&
      event.ts <= end.ts
    )
      presentations.add(event.ts);
    if (
      event.ph !== "X" ||
      !Number.isFinite(event.dur) ||
      event.ts >= end.ts ||
      event.ts + event.dur <= start.ts
    )
      continue;
    const overlapMs =
      (Math.min(event.ts + event.dur, end.ts) - Math.max(event.ts, start.ts)) /
      1000;
    if (
      renderer &&
      event.name === "UpdateLayoutTree" &&
      Number.isFinite(event.args?.elementCount)
    )
      styledElements.push(event.args.elementCount);
    if (!renderer) {
      const key = `${event.pid}:${event.tid}`;
      const thread = threads.get(key) ?? {
        pid: event.pid,
        tid: event.tid,
        process: processNames.get(event.pid) ?? "unknown",
        name: threadNames.get(key) ?? "unknown",
        categories: new Map(),
      };
      const durations = thread.categories.get(event.name) ?? [];
      durations.push(overlapMs);
      thread.categories.set(event.name, durations);
      threads.set(key, thread);
      continue;
    }
    const category = categories.get(event.name) ?? [];
    category.push(overlapMs);
    categories.set(event.name, category);
    if (overlapMs >= 2)
      longest.push({
        name: event.name,
        startMs: (event.ts - start.ts) / 1000,
        overlapMs,
        args: event.args,
      });
  }
  const samples = new Map();
  if (cpu) {
    const nodes = new Map(cpu.nodes.map((node) => [node.id, node]));
    let time = cpu.startTime;
    for (let i = 0; i < cpu.samples.length; i++) {
      const delta = cpu.timeDeltas[i];
      time += delta;
      if (time < start.ts || time > end.ts) continue;
      const node = nodes.get(cpu.samples[i]);
      if (!node) continue;
      const frame = node.callFrame;
      const key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
      const sample = samples.get(key) ?? {
        ...frame,
        samples: 0,
        sampledWallMs: 0,
      };
      sample.samples++;
      sample.sampledWallMs += delta / 1000;
      samples.set(key, sample);
    }
  }
  const times = [...presentations].sort((a, b) => a - b);
  return {
    durationMs: (end.ts - start.ts) / 1000,
    renderer: { pid: start.pid, tid: start.tid },
    styleRecalculationElements: distribution(styledElements),
    invalidationRecords,
    omittedInvalidationGroups: Math.max(0, invalidations.size - 64),
    invalidations: [...invalidations.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 64),
    categories: [...categories]
      .map(([name, values]) => ({
        name,
        durationMs: distribution(values),
        summedInclusiveMs: values.reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.summedInclusiveMs - a.summedInclusiveMs),
    longestEvents: longest
      .sort((a, b) => b.overlapMs - a.overlapMs)
      .slice(0, 50),
    scriptSamples: [...samples.values()]
      .sort((a, b) => b.sampledWallMs - a.sampledWallMs)
      .slice(0, 50),
    otherThreads: [...threads.values()].map(({ categories, ...thread }) => ({
      ...thread,
      categories: [...categories]
        .map(([name, values]) => ({
          name,
          durationMs: distribution(values),
          summedInclusiveMs: values.reduce((a, b) => a + b, 0),
        }))
        .sort((a, b) => b.summedInclusiveMs - a.summedInclusiveMs)
        .slice(0, 30),
    })),
    presentationIntervalsMs:
      times.length > 1
        ? distribution(
            times.slice(1).map((time, i) => (time - times[i]) / 1000),
          )
        : null,
    limits: [
      "Event durations are nested inclusive wall time; do not sum categories as CPU.",
      "V8 samples are sampled wall time, not thread CPU utilization.",
      "Invalidation records are diagnostic-only causes; their counts are not flush durations. Empty records in timing mode mean the category was not enabled.",
      "Other threads summarize overlapping compositor, raster, GPU, and browser events. Shared process work is not necessarily caused by this page; durations overlap and are not CPU utilization.",
      "Missing presentation events mean unavailable telemetry. Presentation records do not independently measure a physical screen.",
    ],
  };
}
