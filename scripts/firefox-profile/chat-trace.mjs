import assert from "node:assert/strict";
import { distribution } from "./chat-analysis.mjs";

// Retain attribution for a few isolated stalls before the raw CPU profile is
// discarded. Whole-capture totals can hide an expensive one-off operation.
function attributeSlowWindows(events, origin, cpu) {
  const windows = [];
  for (const event of [...events].sort((a, b) => b.overlapMs - a.overlapMs)) {
    if (event.overlapMs < 16 || windows.length === 8) break;
    const startMs = Math.max(0, event.startMs);
    const endMs = startMs + event.overlapMs;
    if (
      windows.some((window) => startMs < window.endMs && endMs > window.startMs)
    )
      continue;
    windows.push({ name: event.name, startMs, endMs });
  }
  const nodes = new Map((cpu?.nodes ?? []).map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of nodes.values())
    for (const child of node.children ?? []) parents.set(child, node.id);
  return windows.map((window) => {
    if (!cpu)
      return { ...window, samples: null, frames: null, selfFrames: null };
    const frames = new Map();
    let time = cpu.startTime;
    let coveredUntil = time;
    let samples = 0;
    let maxSampleGapMs = 0;
    let overlappingSampleMs = 0;
    const start = origin + window.startMs * 1000;
    const end = origin + window.endMs * 1000;
    for (const [index, leaf] of cpu.samples.entries()) {
      const delta = cpu.timeDeltas[index];
      const previous = time;
      time += delta;
      // V8 can report backward sample timestamps. Preserve the first
      // attribution for overlapping time rather than counting it twice.
      overlappingSampleMs += Math.max(
        0,
        (Math.min(time, coveredUntil, end) - Math.max(previous, start)) / 1000,
      );
      const overlap =
        (Math.min(time, end) - Math.max(previous, coveredUntil, start)) / 1000;
      coveredUntil = Math.max(coveredUntil, time);
      if (overlap <= 0) continue;
      samples++;
      maxSampleGapMs = Math.max(maxSampleGapMs, delta / 1000);
      const seenNodes = new Set();
      const seenFrames = new Set();
      let id = leaf;
      while (nodes.has(id) && !seenNodes.has(id)) {
        seenNodes.add(id);
        const frame = nodes.get(id).callFrame;
        const key = JSON.stringify([
          frame.url,
          frame.lineNumber,
          frame.columnNumber,
          frame.functionName,
        ]);
        if (!seenFrames.has(key)) {
          seenFrames.add(key);
          const entry = frames.get(key) ?? {
            ...frame,
            selfMs: 0,
            inclusiveMs: 0,
          };
          entry.inclusiveMs += overlap;
          if (id === leaf) entry.selfMs += overlap;
          frames.set(key, entry);
        }
        id = parents.get(id);
      }
    }
    const selfFrames = [...frames.values()]
      .filter((entry) => entry.selfMs > 0)
      .sort((a, b) => b.selfMs - a.selfMs);
    return {
      ...window,
      samples,
      maxSampleGapMs,
      overlappingSampleMs,
      frames: [...frames.values()]
        .sort((a, b) => b.inclusiveMs - a.inclusiveMs || b.selfMs - a.selfMs)
        .slice(0, 20),
      omittedFrames: Math.max(0, frames.size - 20),
      // A deep stack can fill every inclusive slot with ancestors. Keep the
      // expensive leaves too so the operation doing the work is not lost.
      selfFrames: selfFrames.slice(0, 12),
      omittedSelfFrames: Math.max(0, selfFrames.length - 12),
    };
  });
}

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
  const selectors = new Map();
  let selectorEvents = 0;
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
      event.name === "SelectorStats" &&
      event.ts >= start.ts &&
      event.ts <= end.ts
    ) {
      selectorEvents++;
      for (const timing of event.args?.selector_stats?.selector_timings ?? []) {
        const key = JSON.stringify([timing.style_sheet_id, timing.selector]);
        const entry = selectors.get(key) ?? {
          styleSheetId: timing.style_sheet_id,
          selector: timing.selector,
          elapsedMs: 0,
          attempts: 0,
          matches: 0,
          fastRejects: 0,
        };
        for (const [name, field, scale] of [
          ["elapsedMs", "elapsed (us)", 1000],
          ["attempts", "match_attempts", 1],
          ["matches", "match_count", 1],
          ["fastRejects", "fast_reject_count", 1],
        ]) {
          assert.ok(
            Number.isFinite(timing[field]) && timing[field] >= 0,
            `Invalid SelectorStats ${field}`,
          );
          entry[name] += timing[field] / scale;
        }
        selectors.set(key, entry);
      }
    }
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
    // Diagnostic-only: per-selector clocks perturb style matching. These
    // totals attribute work; they are not uninstrumented timing evidence.
    selectorStats: {
      events: selectorEvents,
      selectors: selectors.size,
      totals: [...selectors.values()].reduce(
        (total, entry) => {
          for (const key of Object.keys(total)) total[key] += entry[key];
          return total;
        },
        { elapsedMs: 0, attempts: 0, matches: 0, fastRejects: 0 },
      ),
      omitted: Math.max(0, selectors.size - 64),
      top: [...selectors.values()]
        .sort((a, b) => b.elapsedMs - a.elapsedMs || b.attempts - a.attempts)
        .slice(0, 64),
    },
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
    slowWindows: attributeSlowWindows(longest, start.ts, cpu),
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
      "Slow-window stacks clip sample intervals to at most eight non-overlapping renderer events of at least 16 ms. Recursive frames count once per stack. Long sample gaps weaken attribution; these stacks do not establish CPU utilization or causality.",
      "Invalidation records are diagnostic-only causes; their counts are not flush durations. Empty records in timing mode mean the category was not enabled.",
      "Other threads summarize overlapping compositor, raster, GPU, and browser events. Shared process work is not necessarily caused by this page; durations overlap and are not CPU utilization.",
      "Missing presentation events mean unavailable telemetry. Presentation records do not independently measure a physical screen.",
    ],
  };
}
