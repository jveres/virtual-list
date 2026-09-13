import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { inspectBursts } from "./bursts.mjs";
import { readCapture } from "./capture.mjs";
import { auditCpu } from "./cpu.mjs";

function fixture() {
  const thread = {
    name: "GeckoMain",
    pid: 2,
    processType: "tab",
    stringTable: [
      "UserTiming",
      "Awake",
      "DOMEvent",
      "CSS animation",
      "render (http://localhost/src/example.ts:1:1)",
    ],
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
      data: [
        [0, 0, 0, 0, { name: "ff-profile-start" }],
        [1, 20, 40, 1],
        [2, 25, 26, 1, { eventType: "wheel" }],
        [3, 1, 240, 1],
        [0, 250, 250, 0, { name: "ff-profile-end" }],
      ],
    },
    samples: {
      schema: { stack: 0, time: 1, threadCPUDelta: 2 },
      data: [
        [0, 25, 1000],
        [0, 125, 3000],
        [0, 225, 2000],
      ],
    },
    stackTable: { schema: { prefix: 0, frame: 1 }, data: [[null, 0]] },
    frameTable: { schema: { location: 0 }, data: [[4]] },
  };
  const content = {
    meta: { startTime: 1100, sampleUnits: { threadCPUDelta: "µs" } },
    threads: [thread],
  };
  const parentThread = structuredClone(thread);
  parentThread.pid = 1;
  parentThread.processType = "default";
  parentThread.markers.data = [];
  parentThread.samples.data = [
    [0, 25, 9000],
    [0, 125, 4000],
    [0, 350, 2000],
  ];
  return {
    profile: {
      meta: { startTime: 1000, sampleUnits: { threadCPUDelta: "µs" } },
      threads: [parentThread],
      processes: [content],
    },
    recording: {
      timeOrigin: 1100,
      frames: [
        [0, 0, "up-0"],
        [100, 10, "settle-up-0"],
        [200, 10, "settle-up-0"],
      ],
      writes: [{ time: 22, value: 10, phase: "up-0" }],
    },
    thread,
    content,
  };
}

test("CPU deltas use microseconds, align process clocks, and omit partial bins", () => {
  const { profile, recording } = fixture();
  const result = auditCpu(profile, recording);
  const child = result.cpuThreads.find((t) => t.pid === 2);
  assert.equal(child.totalCpuMs, 6);
  assert.equal(child.averagePercentOneCore, 2.4);
  assert.equal(child.percentOneCorePer100Ms.count, 2);
  assert.equal(child.percentOneCorePer100Ms.total, 4);
  assert.equal(result.cpuThreads.find((t) => t.pid === 1).totalCpuMs, 6);
  assert.equal(result.runtimeNearestJsSamples, 3);
  assert.equal(result.runtimeSamplePercent, 100);
});

test("a zero-time start marker is valid and async spans cannot hide an awake burst", () => {
  const { profile, recording } = fixture();
  const result = auditCpu(profile, recording);
  assert.deepEqual(
    result.longestMarkers.map((m) => m.name),
    ["Awake"],
  );
  const burst = inspectBursts(profile, recording);
  assert.equal(burst.awake[0].durationMs, 20);
  assert.equal(burst.awake[0].stacks[0].samples, 1);
  assert.deepEqual(burst.writes[0].nearbyInput, [{ type: "wheel", start: 25 }]);
  assert.equal(burst.writes[0].time, 22);
});

test("mixed phases are not credited as fully active input bins", () => {
  const { profile, recording } = fixture();
  recording.frames = [
    [0, 0, "up-0"],
    [150, 10, "settle-up-0"],
  ];
  const child = auditCpu(profile, recording).cpuThreads.find(
    (t) => t.pid === 2,
  );
  assert.equal(child.activeInputPercentOneCorePer100Ms.count, 1);
  assert.equal(child.activeInputPercentOneCorePer100Ms.max, 1);
});

test("missing CPU telemetry is unavailable rather than a zero-cost success", () => {
  const { profile, recording, thread } = fixture();
  thread.samples.data[0][2] = null;
  const child = auditCpu(profile, recording).cpuThreads.find(
    (t) => t.pid === 2,
  );
  assert.equal(child.missingCpuSamples, 1);
  assert.equal(child.averagePercentOneCore, null);
  assert.equal(child.totalCpuMs, null);
  assert.equal(child.percentOneCorePer100Ms.max, null);
  assert.deepEqual(child.top100MsBins, []);
});

test("a phase change and return inside a bin still makes that bin mixed", () => {
  const { profile, recording } = fixture();
  recording.frames = [
    [0, 0, "up-0"],
    [20, 1, "settle-up-0"],
    [40, 1, "up-0"],
  ];
  const child = auditCpu(profile, recording).cpuThreads.find(
    (t) => t.pid === 2,
  );
  assert.equal(child.activeInputPercentOneCorePer100Ms.count, 1);
  assert.equal(child.activeInputPercentOneCorePer100Ms.max, 3);
});

test("an unsampled measurement has no script percentage", () => {
  const { profile, recording, thread } = fixture();
  thread.samples.data = [];
  const result = auditCpu(profile, recording);
  assert.equal(result.runtimeSamplePercent, null);
  assert.equal(
    result.cpuThreads.some((t) => t.pid === 2),
    false,
  );
});

test("unsupported units, invalid CPU values, and unordered frames fail explicitly", () => {
  const { profile, recording, content, thread } = fixture();
  content.meta.sampleUnits.threadCPUDelta = "ns";
  assert.throws(() => auditCpu(profile, recording), /Unsupported CPU unit/);
  content.meta.sampleUnits.threadCPUDelta = "µs";
  thread.samples.data[0][2] = -1;
  assert.throws(() => auditCpu(profile, recording), /Invalid CPU delta/);
  recording.frames.reverse();
  assert.throws(() => inspectBursts(profile, recording), /ordered frame/);
});

test("incomplete, ambiguous, and processed profiles are rejected", () => {
  const { profile, recording, thread } = fixture();
  profile.processes.push(structuredClone(profile.processes[0]));
  assert.throws(() => auditCpu(profile, recording), /one complete/);
  profile.processes.pop();
  thread.markers.data.pop();
  assert.throws(() => inspectBursts(profile, recording), /one complete/);
  delete thread.markers.schema;
  assert.throws(() => auditCpu(profile, recording), /raw Firefox profile/);
});

test("plain and compressed captures are readable without overwriting evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ff-audit-check-"));
  const { profile, recording } = fixture();
  try {
    const source = JSON.stringify(profile);
    await writeFile(join(directory, "profile.json.gz"), gzipSync(source));
    await writeFile(join(directory, "frames.json"), JSON.stringify(recording));
    assert.deepEqual((await readCapture(directory)).profile, profile);
    await writeFile(join(directory, "profile.json"), source);
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/firefox-profile/cpu.mjs", directory],
        { encoding: "utf8" },
      ),
    );
    assert.equal(result.contentPid, 2);
    assert.equal(
      await readFile(join(directory, "profile.json"), "utf8"),
      source,
    );
    await writeFile(join(directory, "profile.json"), "invalid JSON");
    await assert.rejects(readCapture(directory), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analysis CLIs support help and reject missing or excess arguments before reading", () => {
  for (const script of ["cpu", "bursts"]) {
    const path = `scripts/firefox-profile/${script}.mjs`;
    assert.match(
      execFileSync(process.execPath, [path, "--help"], { encoding: "utf8" }),
      /RUN_DIRECTORY/,
    );
    for (const args of [[], ["one", "two"], ["--unknown"]]) {
      const result = spawnSync(process.execPath, [path, ...args], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Usage:/);
    }
  }
});
