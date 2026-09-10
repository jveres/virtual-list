import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeProfile } from "./attribute.mjs";

function fixture() {
  const names = [
    "UserTiming",
    "RefreshDriverTick",
    "Styles",
    "Reflow (sync)",
    "outer (http://localhost:5173/src/runtime.ts:1:2)[1]",
    "read (http://localhost:5173/src/measure.ts?t=123:3:4)[2]",
    "Reflow http://localhost:5173/demo/",
    "Layout http://localhost:5173/demo/",
    "setText (http://localhost:5173/demos/status.ts:5:6)[3]",
    "set Node.textContent",
    "inner (resource://gre/modules/example.sys.mjs:7:8)[4]",
    "http://localhost:5173/src/module.ts[5]",
  ];
  const thread = {
    pid: 42,
    name: "GeckoMain",
    stringTable: names,
    frameTable: {
      schema: { location: 0 },
      data: names.map((_, index) => [index]),
    },
    stackTable: {
      schema: { prefix: 0, frame: 1 },
      data: [
        [null, 4],
        [0, 5],
        [1, 6],
        [null, 6],
        [null, 7],
        [null, 8],
        [5, 9],
        [1, 10],
        [null, 11],
        [0, 4],
      ],
    },
    samples: {
      schema: { time: 0, stack: 1 },
      data: [
        [99, 1],
        [111, 2],
        [112, 3],
        [113, 4],
        [114, null],
        [115, 7],
        [116, 8],
        [117, 9],
        [201, 1],
      ],
    },
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, data: 4 },
      data: [
        [0, 100, 0, 0, { name: "ff-profile-start" }],
        [1, 110, 119, 1],
        [1, 130, 139, 1],
        [1, 150, 159, 1],
        [2, 111, 112, 1, { elementsStyled: 1 }],
        [2, 113, 114, 1, { elementsStyled: 2 }],
        [2, 115, 116, 1, { elementsStyled: 0 }],
        [2, 131, 132, 1, { elementsStyled: 1 }],
        // These lie outside complete refresh intervals and must not count.
        [2, 105, 106, 1, { elementsStyled: 2 }],
        [2, 151, 152, 1, { elementsStyled: 2 }],
        [
          3,
          140,
          143,
          1,
          {
            stack: {
              samples: { schema: { time: 0, stack: 1 }, data: [[120, 6]] },
            },
          },
        ],
        [3, 144, 145, 1],
        [0, 200, 0, 0, { name: "ff-profile-end" }],
      ],
    },
  };
  return { threads: [], processes: [{ threads: [thread] }] };
}

test("native URL labels neither count as scripts nor steal the caller's self samples", () => {
  const [result] = attributeProfile(fixture());
  assert.equal(result.samples, 7);
  assert.equal(result.samplesWithScript, 4);
  assert.deepEqual(result.self, [
    { name: "read (/src/measure.ts:3:4)[2]", count: 1 },
    { name: "/src/module.ts[5]", count: 1 },
    { name: "outer (/src/runtime.ts:1:2)[1]", count: 1 },
  ]);
  assert.equal(
    result.inclusive.find(({ name }) => name.startsWith("outer ")).count,
    3,
  );
  assert.equal(
    result.inclusive.find(({ name }) => name.startsWith("read ")).count,
    2,
  );
});

test("a non-HTTP JavaScript callee owns its self time even when the caller matches the filter", () => {
  const [result] = attributeProfile(fixture(), { filter: "resource://" });
  assert.deepEqual(result.self, [
    { name: "inner (resource://gre/modules/example.sys.mjs:7:8)[4]", count: 1 },
  ]);
});

test("reflow stacks describe earlier invalidations, not synchronous flush callers", () => {
  const [result] = attributeProfile(fixture());
  assert.equal(Object.hasOwn(result, "reflowCauses"), false);
  assert.deepEqual(result.reflowInvalidations, [
    {
      name: "setText (/demos/status.ts:5:6)[3] via set Node.textContent",
      count: 1,
      total: 3,
      p50: 3,
      p95: 3,
      max: 3,
      invalidationToReflowMs: {
        count: 1,
        total: 20,
        p50: 20,
        p95: 20,
        max: 20,
      },
    },
    {
      name: "(no stack)",
      count: 1,
      total: 1,
      p50: 1,
      p95: 1,
      max: 1,
      invalidationToReflowMs: {
        count: 0,
        total: 0,
        p50: null,
        p95: null,
        max: null,
      },
    },
  ]);
});

test("style passes are counted per complete refresh interval, excluding no-op passes", () => {
  const [result] = attributeProfile(fixture());
  assert.deepEqual(result.stylePassesPerRefreshInterval, {
    intervals: 2,
    nonemptyPasses: 3,
    intervalsWithMultiplePasses: 1,
    maxPasses: 2,
  });
});

test("attribution rejects incomplete and processed profiles and invalid ranking limits", () => {
  assert.throws(() => attributeProfile({ threads: [] }), /No complete/);
  assert.throws(
    () => attributeProfile({ threads: [{ markers: {} }] }),
    /raw Firefox profile/,
  );
  for (const top of [0, -1, 1.5, Number.NaN])
    assert.throws(() => attributeProfile(fixture(), { top }), /Invalid --top/);
  assert.equal(attributeProfile(fixture(), { top: 1 })[0].inclusive.length, 1);
});
