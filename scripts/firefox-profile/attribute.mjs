// Attribute a capture's content-thread samples and synchronous reflows to
// JavaScript functions. Complements analyze.mjs (timing and marker totals)
// with "where does the runtime's time go" and "which call forced layout".
//
//   node scripts/firefox-profile/attribute.mjs RUN_DIR [--filter=/src/] [--top=25]
//
// Inclusive counts add a sample to every distinct function on its stack;
// self counts credit the innermost JavaScript frame. At the runner's 1ms
// sampling interval a count approximates milliseconds. Reflow causes come
// from the "Reflow (sync)" markers' captured stacks: the innermost
// JavaScript frame, the DOM API it called, and the nested marker duration.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { markers, stats } from "./analyze.mjs";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    filter: { type: "string", default: "/src/" },
    top: { type: "string", default: "25" },
  },
});
const directory = positionals[0];
if (!directory) {
  throw new Error(
    "Usage: node scripts/firefox-profile/attribute.mjs RUN_DIR [--filter=/src/] [--top=25]",
  );
}
const top = Number(options.top);
if (!Number.isInteger(top) || top < 1) throw new Error("Invalid --top");

let bytes;
try {
  bytes = await readFile(resolve(directory, "profile.json"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  bytes = gunzipSync(await readFile(resolve(directory, "profile.json.gz")));
}
const profile = JSON.parse(bytes);
const processes = [];
const visit = (process) => {
  processes.push(process);
  process.processes?.forEach(visit);
};
visit(profile);

const location = (name) =>
  name.replace(/https?:\/\/[^/]+/, "").replace(/\?t=\d+/, "");
const isScript = (name) => /^[^(]*\(?https?:\/\//.test(name);

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

function attribute(thread) {
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
    if (!causes.has(key)) causes.set(key, []);
    causes.get(key).push(entry.end - entry.start);
  }
  const rank = (map) =>
    [...map]
      .filter(([name]) => name.includes(options.filter))
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, count]) => ({ name, count }));
  return {
    pid: thread.pid,
    windowMs: end.start - start.start,
    samples,
    samplesWithScript: withScript,
    filter: options.filter,
    inclusive: rank(inclusive),
    self: rank(self),
    reflowCauses: [...causes]
      .map(([name, durations]) => ({ name, ...stats(durations) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, top),
  };
}

const threads = processes
  .flatMap((process) => process.threads ?? [])
  .filter((thread) => thread.name === "GeckoMain")
  .map(attribute)
  .filter(Boolean);
if (threads.length === 0)
  throw new Error("No complete ff-profile-start/end measurement");
console.log(JSON.stringify(threads, null, 2));
