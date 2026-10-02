import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeStructureProfile } from "./structure-analysis.mjs";

function fixture() {
  return {
    meta: { interval: 2 },
    threads: [
      {
        name: "GeckoMain",
        pid: 12,
        stringTable: [
          "UserTiming",
          "GCMinor",
          "GCSlice",
          "indexItems (http://localhost/src/virtual-list.ts:100:2)",
        ],
        markers: {
          schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
          data: [
            [0, 0, null, 0, { name: "ff-profile-start" }],
            [0, 10, null, 0, { name: "structure:list:1000:update-item:start" }],
            [1, 8, 12, 1, {}],
            [2, 18, 22, 1, {}],
            [0, 20, null, 0, { name: "structure:list:1000:update-item:end" }],
            [1, 25, 29, 1, {}],
            [0, 30, null, 0, { name: "ff-profile-end" }],
          ],
        },
        samples: {
          schema: { time: 0, stack: 1 },
          data: [
            [5, 0],
            [12, 0],
            [19, 0],
            [25, 0],
          ],
        },
        stackTable: { schema: { prefix: 0, frame: 1 }, data: [[null, 0]] },
        frameTable: { schema: { location: 0 }, data: [[3]] },
      },
    ],
  };
}
test("structure profile clips slices to their phase and excludes diagnostic gaps", () => {
  const result = summarizeStructureProfile(fixture());
  const phase = result.phases[0];
  assert.equal(result.pid, 12);
  assert.equal(phase.label, "list:1000:update-item");
  assert.equal(phase.gc.GCMinor.total, 2);
  assert.equal(phase.gc.GCSlice.total, 2);
  assert.equal(phase.gc.CCSlice.count, 0);
  assert.equal(phase.samples, 2);
  assert.deepEqual(phase.nearestRuntime, [
    ["indexItems (/src/virtual-list.ts)", 2],
  ]);
  const numericName = fixture();
  numericName.threads[0].markers.data.push([0, 15, null, 0, { name: 3 }]);
  assert.deepEqual(summarizeStructureProfile(numericName), result);
});
test("structure profile rejects missing capture and phase boundaries", () => {
  const missingEnd = fixture();
  missingEnd.threads[0].markers.data.pop();
  assert.throws(
    () => summarizeStructureProfile(missingEnd),
    /Incomplete diagnostic/,
  );
  const missingPhase = fixture();
  missingPhase.threads[0].markers.data.splice(4, 1);
  assert.throws(() => summarizeStructureProfile(missingPhase), /Unclosed/);
});

test("structure CPU intervals are clipped and unavailable counters stay unavailable", () => {
  const profile = fixture();
  profile.meta.sampleUnits = { threadCPUDelta: "µs" };
  const samples = profile.threads[0].samples;
  samples.schema.threadCPUDelta = 2;
  samples.data = [
    [5, 0, 0],
    [12, 0, 7000],
    [19, 0, 3500],
    [25, 0, 3000],
  ];
  assert.equal(summarizeStructureProfile(profile).phases[0].cpuMs, 6);
  samples.data[2][2] = null;
  const missing = summarizeStructureProfile(profile).phases[0];
  assert.equal(missing.cpuMs, null);
  assert.equal(missing.missingCpuSamples, 1);
  assert.equal(summarizeStructureProfile(fixture()).phases[0].cpuMs, null);
  profile.meta.sampleUnits.threadCPUDelta = "unknown";
  assert.throws(
    () => summarizeStructureProfile(profile),
    /Unsupported CPU unit/,
  );
});

test("structure rendering spans exclude work outside the marked operation", () => {
  const profile = fixture();
  const thread = profile.threads[0];
  thread.stringTable.push("Reflow");
  thread.markers.data.push(
    [4, 7, 12, 1, {}],
    [4, 18, 25, 1, {}],
    [4, 25, 29, 1, {}],
  );
  const rendering = summarizeStructureProfile(profile).phases[0].rendering;
  assert.equal(rendering.Reflow.count, 2);
  assert.equal(rendering.Reflow.total, 4);
  assert.equal(rendering.Styles.count, 0);
});

test("allocation attribution counts only sampled objects inside workload phases", () => {
  const profile = fixture();
  const thread = profile.threads[0];
  thread.stringTable.push("JS allocation", "render (/scripts/fixture.js:3:4)");
  const payload = (size, withStack = true) => ({
    type: "JS allocation",
    size,
    className: "Array",
    inNursery: true,
    ...(withStack
      ? { stack: { samples: { schema: { stack: 0 }, data: [[0]] } } }
      : {}),
  });
  thread.markers.data.push(
    [4, 12, null, 0, payload(64)],
    [4, 19, null, 0, payload(32, false)],
    [4, 25, null, 0, payload(1024)],
  );
  const result = summarizeStructureProfile(profile).jsAllocations;
  assert.equal(result.count, 2);
  assert.equal(result.bytes, 96);
  assert.equal(result.nurseryCount, 2);
  assert.equal(result.missingStacks, 1);
  assert.deepEqual(result.classes, [{ site: "Array", count: 2, bytes: 96 }]);
  assert.deepEqual(result.nearestRuntime, [
    { site: "indexItems (/src/virtual-list.ts:100:2)", count: 1, bytes: 64 },
  ]);
  assert.equal(summarizeStructureProfile(fixture()).jsAllocations.count, 0);
  thread.markers.data.push([4, 15, null, 0, payload(-1)]);
  assert.throws(
    () => summarizeStructureProfile(profile),
    /Invalid sampled JS allocation/,
  );
});

test("allocation attribution keeps host allocation separate from its runtime caller", () => {
  const profile = fixture();
  const thread = profile.threads[0];
  thread.stringTable.push(
    "JS allocation",
    "render (http://localhost/scripts/fixture.js:3:4)",
  );
  thread.frameTable.data.push([5]);
  thread.stackTable.data.push([0, 1]);
  thread.markers.data.push([
    4,
    12,
    null,
    0,
    {
      type: "JS allocation",
      size: 128,
      coarseType: "Object",
      inNursery: false,
      stack: { samples: { schema: { stack: 0 }, data: [[1]] } },
    },
  ]);
  const result = summarizeStructureProfile(profile).jsAllocations;
  assert.equal(result.nurseryCount, 0);
  assert.deepEqual(result.nearestPage, [
    { site: "render (/scripts/fixture.js:3:4)", count: 1, bytes: 128 },
  ]);
  assert.deepEqual(result.nearestRuntime, [
    { site: "indexItems (/src/virtual-list.ts:100:2)", count: 1, bytes: 128 },
  ]);
});
