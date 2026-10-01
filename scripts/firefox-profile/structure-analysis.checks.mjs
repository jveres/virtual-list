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
