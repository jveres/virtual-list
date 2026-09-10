// Attribute content-thread samples to JavaScript functions and reflow
// invalidations to their captured cause stacks. A cause is not necessarily
// the call that later flushes layout; "sync" means non-interruptible reflow.
//
//   node scripts/firefox-profile/attribute.mjs RUN_DIR [--filter=/src/] [--top=25]
//
// Inclusive counts add a sample to every distinct function on its stack;
// self counts credit the innermost JavaScript frame. At the runner's 1ms
// sampling interval a count approximates milliseconds, including native
// work beneath that JS frame. Reflow durations are nested wall-clock times,
// not time spent in the earlier invalidating call.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { markers, stats } from "./analyze.mjs";

const location = (name) =>
  name.replace(/https?:\/\/[^/]+/, "").replace(/\?t=\d+/, "");
// Match Gecko's JS function/location syntax, not native labels such as
// "Reflow http://...". Root evaluation can carry only a URI and source ID.
const isScript = (name) =>
  /^.+ \(.+:\d+(?::\d+)?\)(?:\[\d+\])?$/.test(name) ||
  /^\S+:\d+(?::\d+)?(?:\[\d+\])?$/.test(name) ||
  /^(?:https?|file|blob|data|resource|chrome|moz-extension):\S+\[\d+\]$/.test(
    name,
  );

function framesOf(thread, stack) {
  const stackSchema = thread.stackTable.schema;
  const frameSchema = thread.frameTable.schema;
  const frames = [];
  let index = stack;
  while (index != null) {
    const row = thread.stackTable.data[index];
    const frame = thread.frameTable.data[row[stackSchema.frame]];
    frames.push(thread.stringTable[frame[frameSchema.location]]);
    index = row[stackSchema.prefix];
  }
  return frames;
}

function stylePassesPerRefreshInterval(entries) {
  const ticks = entries
    .filter((entry) => entry.name === "RefreshDriverTick")
    .toSorted((a, b) => a.start - b.start);
  const styles = entries
    .filter(
      (entry) => entry.name === "Styles" && entry.data?.elementsStyled > 0,
    )
    .toSorted((a, b) => a.start - b.start);
  const counts = [];
  let next = 0;
  for (let index = 0; index + 1 < ticks.length; index++) {
    while (next < styles.length && styles[next].start < ticks[index].start)
      next++;
    let count = 0;
    while (
      next < styles.length &&
      styles[next].start < ticks[index + 1].start
    ) {
      count++;
      next++;
    }
    counts.push(count);
  }
  return {
    intervals: counts.length,
    nonemptyPasses: counts.reduce((sum, count) => sum + count, 0),
    intervalsWithMultiplePasses: counts.filter((count) => count > 1).length,
    maxPasses: counts.length ? Math.max(...counts) : null,
  };
}

function attribute(thread, { filter, top }) {
  const entries = markers(thread);
  const start = entries.find(
    (entry) => entry.data?.name === "ff-profile-start",
  );
  const end = entries.find((entry) => entry.data?.name === "ff-profile-end");
  if (!start || !end || end.start <= start.start) return null;
  const schema = thread.samples.schema;
  const inclusive = new Map();
  const self = new Map();
  let samples = 0;
  let withScript = 0;
  for (const sample of thread.samples.data) {
    const time = sample[schema.time];
    if (time < start.start || time > end.start) continue;
    samples += 1;
    const frames = framesOf(thread, sample[schema.stack]);
    const seen = new Set();
    let innermost = true;
    for (const frame of frames) {
      if (!isScript(frame)) continue;
      const name = location(frame);
      if (innermost) {
        self.set(name, (self.get(name) ?? 0) + 1);
        innermost = false;
      }
      if (!seen.has(name)) {
        seen.add(name);
        inclusive.set(name, (inclusive.get(name) ?? 0) + 1);
      }
    }
    if (!innermost) withScript += 1;
  }
  const causes = new Map();
  for (const entry of entries) {
    if (entry.name !== "Reflow (sync)") continue;
    if (entry.start < start.start || entry.end > end.start) continue;
    const stack = entry.data?.stack;
    const sampleSchema = stack?.samples?.schema;
    const first = stack?.samples?.data?.[0];
    let key = "(no stack)";
    if (sampleSchema && first) {
      const frames = framesOf(thread, first[sampleSchema.stack]);
      const scriptIndex = frames.findIndex(isScript);
      const api =
        frames
          .slice(0, scriptIndex < 0 ? frames.length : scriptIndex)
          .find((frame) =>
            /^(Element|Node|HTMLElement|get |set )/.test(frame),
          ) ?? "?";
      const caller =
        scriptIndex < 0 ? "(native)" : location(frames[scriptIndex]);
      key = `${caller} via ${api}`;
    }
    if (!causes.has(key)) causes.set(key, { durations: [], delays: [] });
    const group = causes.get(key);
    group.durations.push(entry.end - entry.start);
    const time = first?.[sampleSchema?.time];
    if (typeof time === "number") group.delays.push(entry.start - time);
  }
  const rank = (map) =>
    [...map]
      .filter(([name]) => name.includes(filter))
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, count]) => ({ name, count }));
  return {
    pid: thread.pid,
    windowMs: end.start - start.start,
    samples,
    samplesWithScript: withScript,
    filter,
    inclusive: rank(inclusive),
    self: rank(self),
    reflowInvalidations: [...causes]
      .map(([name, { durations, delays }]) => ({
        name,
        ...stats(durations),
        invalidationToReflowMs: stats(delays),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, top),
    stylePassesPerRefreshInterval: stylePassesPerRefreshInterval(
      entries.filter(
        (entry) => entry.start >= start.start && entry.end <= end.start,
      ),
    ),
    limitations: [
      "Self samples credit the nearest JavaScript frame, including native work beneath it.",
      "Reflow stacks record earlier invalidations, not necessarily calls that force layout.",
      "Reflow (sync) means non-interruptible, not necessarily JavaScript-forced layout.",
      "Reflow durations are nested wall-clock times, not CPU cost of the invalidating call.",
      "Style passes count nonempty Styles markers between consecutive refresh tick starts, not physical display frames.",
    ],
  };
}

export function attributeProfile(profile, { filter = "/src/", top = 25 } = {}) {
  if (!Number.isInteger(top) || top < 1) throw new Error("Invalid --top");
  const processes = [];
  const visit = (process) => {
    processes.push(process);
    process.processes?.forEach(visit);
  };
  visit(profile);
  const threads = processes.flatMap((process) => process.threads ?? []);
  if (threads.some((thread) => !thread.markers?.schema))
    throw new Error(
      "Expected a raw Firefox profile, not a processed share export",
    );
  const results = threads
    .filter((thread) => thread.name === "GeckoMain")
    .map((thread) => attribute(thread, { filter, top }))
    .filter(Boolean);
  if (results.length === 0)
    throw new Error("No complete ff-profile-start/end measurement");
  return results;
}

export async function attributeDirectory(directory, options) {
  let bytes;
  try {
    bytes = await readFile(resolve(directory, "profile.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = gunzipSync(await readFile(resolve(directory, "profile.json.gz")));
  }
  return attributeProfile(JSON.parse(bytes), options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      filter: { type: "string", default: "/src/" },
      top: { type: "string", default: "25" },
    },
  });
  if (!positionals[0])
    throw new Error(
      "Usage: node scripts/firefox-profile/attribute.mjs RUN_DIR [--filter=/src/] [--top=25]",
    );
  console.log(
    JSON.stringify(
      await attributeDirectory(positionals[0], {
        filter: values.filter,
        top: Number(values.top),
      }),
      null,
      2,
    ),
  );
}
