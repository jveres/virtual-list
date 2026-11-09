import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArguments, summarize } from "./runtime-ab.mjs";

test("should parse a baseline and apply the defaults", () => {
  assert.deepEqual(parseArguments(["--baseline=437e93a"]), {
    baseline: "437e93a",
    browser: "firefox",
    trials: 3,
    scenarios: [],
    port: 4198,
  });
  assert.deepEqual(
    parseArguments([
      "--baseline=437e93a",
      "--browser=chromium",
      "--trials=1",
      "--scenarios=append-measured,boot-declared",
      "--port=4200",
    ]),
    {
      baseline: "437e93a",
      browser: "chromium",
      trials: 1,
      scenarios: ["append-measured", "boot-declared"],
      port: 4200,
    },
  );
});

test("should reject invalid arguments before creating resources", () => {
  for (const argv of [
    [],
    ["--baseline=working"],
    ["--baseline=437e93a", "--browser=safari"],
    ["--baseline=437e93a", "--trials=4"],
    ["--baseline=437e93a", "--trials=0"],
    ["--baseline=437e93a", "--port=80"],
    ["--baseline=437e93a", "--unknown=1"],
  ])
    assert.throws(() => parseArguments(argv), /Expected|Unknown/);
});

test("should report each trial's medians and the median trial delta", () => {
  const trial = (baseline, candidate) => ({
    append: { baseline, candidate },
  });

  const summary = summarize([
    trial([10, 12, 30], [6, 5, 7]),
    trial([10, 10, 10], [9, 9, 9]),
    trial([20, 20, 20], [10, 10, 10]),
  ]);

  assert.deepEqual(summary, {
    append: {
      trials: [
        { baselineMs: 12, candidateMs: 6, deltaPct: -50 },
        { baselineMs: 10, candidateMs: 9, deltaPct: -10 },
        { baselineMs: 20, candidateMs: 10, deltaPct: -50 },
      ],
      medianDeltaPct: -50,
    },
  });
});

test("should summarize no trials as no scenarios", () => {
  assert.deepEqual(summarize([]), {});
});
