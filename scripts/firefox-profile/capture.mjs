// Shared offline input handling. Never launch a browser or modify a capture.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { markers } from "./analyze.mjs";

export function selectCapture(profile, recording) {
  if (
    !Number.isFinite(recording?.timeOrigin) ||
    !Array.isArray(recording.frames) ||
    !Array.isArray(recording.writes)
  ) {
    throw new Error("Expected frames.json with timeOrigin, frames, and writes");
  }
  let lastTime = -Infinity;
  for (const frame of recording.frames) {
    if (
      !Array.isArray(frame) ||
      !Number.isFinite(frame[0]) ||
      frame[0] < lastTime ||
      typeof frame[2] !== "string"
    ) {
      throw new Error("Expected ordered frame times and phase labels");
    }
    lastTime = frame[0];
  }
  for (const write of recording.writes) {
    if (!Number.isFinite(write.time) || typeof write.phase !== "string") {
      throw new Error("Expected timed scroll writes with phase labels");
    }
  }
  const processes = [];
  function visit(process) {
    if (
      !Array.isArray(process?.threads) ||
      !Number.isFinite(process.meta?.startTime)
    ) {
      throw new Error(
        "Expected a raw Firefox profile with process start times",
      );
    }
    processes.push(process);
    process.processes?.forEach(visit);
  }
  visit(profile);
  const candidates = [];
  for (const process of processes) {
    for (const thread of process.threads) {
      if (
        !thread.markers?.schema ||
        !thread.samples?.schema ||
        !thread.stackTable?.schema ||
        !thread.frameTable?.schema
      ) {
        throw new Error(
          "Expected a raw Firefox profile, not a processed export",
        );
      }
      if (thread.name !== "GeckoMain") continue;
      const entries = markers(thread);
      const starts = entries.filter((e) => e.data?.name === "ff-profile-start");
      const ends = entries.filter((e) => e.data?.name === "ff-profile-end");
      if (!starts.length && !ends.length) continue;
      if (
        starts.length !== 1 ||
        ends.length !== 1 ||
        !Number.isFinite(starts[0].start) ||
        !Number.isFinite(ends[0].start) ||
        ends[0].start <= starts[0].start
      ) {
        throw new Error(
          "Expected one complete ff-profile-start/end measurement",
        );
      }
      candidates.push({
        process,
        thread,
        entries,
        start: starts[0].start,
        end: ends[0].start,
      });
    }
  }
  if (candidates.length !== 1) {
    throw new Error("Expected one complete ff-profile-start/end measurement");
  }
  return { ...candidates[0], processes };
}

export async function readCapture(directory) {
  let bytes;
  try {
    bytes = await readFile(resolve(directory, "profile.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = gunzipSync(await readFile(resolve(directory, "profile.json.gz")));
  }
  return {
    profile: JSON.parse(bytes),
    recording: JSON.parse(await readFile(resolve(directory, "frames.json"))),
  };
}

export async function runAnalysisCli(url, analyze) {
  if (!process.argv[1] || url !== pathToFileURL(resolve(process.argv[1])).href)
    return;
  const args = process.argv.slice(2);
  const usage = `Usage: node ${process.argv[1]} RUN_DIRECTORY`;
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      `${usage}\nRead profile.json (or .gz) and frames.json; print JSON without modifying the capture.`,
    );
    return;
  }
  if (args.length !== 1 || args[0].startsWith("-")) throw new Error(usage);
  const { profile, recording } = await readCapture(args[0]);
  console.log(JSON.stringify(analyze(profile, recording), null, 2));
}

export function stackFrames(thread, stack) {
  const frames = [];
  const seen = new Set();
  while (stack != null) {
    const row = thread.stackTable.data[stack];
    if (!row || seen.has(stack)) throw new Error("Invalid sample stack");
    seen.add(stack);
    const frame = thread.frameTable.data[row[thread.stackTable.schema.frame]];
    if (!frame) throw new Error("Invalid sample frame");
    frames.push(thread.stringTable[frame[thread.frameTable.schema.location]]);
    stack = row[thread.stackTable.schema.prefix];
  }
  return frames;
}
