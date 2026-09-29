import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  assertMemoryDocument,
  assessMemory,
  MiB,
  parseFootprints,
} from "./memory-analysis.mjs";
import { startMemoryCycle } from "./memory-workload.mjs";

const budget = {
  processPeak: 600 * MiB,
  total: 1400 * MiB,
  growth: 64 * MiB,
  tailRange: 40 * MiB,
};
test("reload guard tolerates rounded clocks but rejects a replaced document", () => {
  const previous = { documentId: "capture-page", timeOrigin: 1000 };
  assert.doesNotThrow(() =>
    assertMemoryDocument({ ...previous, timeOrigin: 1001 }, previous),
  );
  assert.throws(
    () =>
      assertMemoryDocument({ ...previous, documentId: "new-page" }, previous),
    /Page reloaded/,
  );
  assert.throws(
    () => assertMemoryDocument({ timeOrigin: 1000 }),
    /Page guard missing/,
  );
});
const sample = (footprint, peak = footprint) => ({
  processes: [
    {
      pid: 1,
      footprint: footprint * MiB,
      resident: footprint * MiB,
      peak: peak * MiB,
    },
  ],
  page: { distance: 100000, events: 100, done: true },
});
test("memory plateau passes despite bounded cache variation", () => {
  assert.deepEqual(
    assessMemory(
      [200, 210, 220, 221, 219, 220].map((n) => sample(n)),
      budget,
    ).failures,
    [],
  );
});
test("transient graphics explosion fails even after reclamation", () => {
  const samples = Array.from({ length: 6 }, () => sample(200, 1200));
  assert.deepEqual(assessMemory(samples, budget).failures, [
    "process peak exceeds budget",
  ]);
});
test("retained growth and unstable tail fail", () => {
  const result = assessMemory(
    [200, 220, 240, 300, 350, 400].map((n) => sample(n)),
    budget,
  );
  assert.deepEqual(result.failures, [
    "repeated-cycle growth exceeds budget",
    "final cycles have not settled within budget",
  ]);
});
test("missing, stationary and interrupted measurements cannot pass", () => {
  const samples = Array.from({ length: 6 }, () => sample(200));
  for (const page of [
    { distance: 0, events: 0, done: true },
    { distance: 100000, events: 100, done: false },
  ])
    assert.throws(() =>
      assessMemory([{ ...samples[0], page }, ...samples.slice(1)], budget),
    );
  assert.throws(() => assessMemory([], budget));
  assert.throws(() =>
    assessMemory(
      [{ ...samples[0], processes: [] }, ...samples.slice(1)],
      budget,
    ),
  );
});
test("footprint parser rejects missing or inconsistent counters", () => {
  assert.deepEqual(parseFootprints("123 200 300 400\n"), [
    { pid: 123, footprint: 200, resident: 300, peak: 400 },
  ]);
  assert.throws(() => parseFootprints("123 200 300"));
  assert.throws(() => parseFootprints("123 200 300 100"));
});

test("invalid budgets, counters, and workload errors fail closed", () => {
  const samples = Array.from({ length: 6 }, () => sample(200));
  assert.throws(() =>
    assessMemory(samples, { ...budget, processPeak: undefined }),
  );
  assert.throws(() => assessMemory(samples, { ...budget, growth: NaN }));
  assert.throws(() =>
    assessMemory(
      [
        { ...samples[0], processes: [{ footprint: NaN, peak: NaN }] },
        ...samples.slice(1),
      ],
      budget,
    ),
  );
  assert.throws(() =>
    assessMemory(
      [
        { ...samples[0], page: { ...samples[0].page, error: "failed" } },
        ...samples.slice(1),
      ],
      budget,
    ),
  );
});

test("memory CLI help is portable and does not launch a capture", () => {
  const help = execFileSync(
    process.execPath,
    ["scripts/profile-memory.mjs", "--help"],
    { encoding: "utf8" },
  );
  assert.match(help, /--input=steps\|native/);
  assert.match(help, /physical trackpad momentum/);
});

test("native recorder checks decoded images and releases listeners between cycles", () => {
  const listeners = new Map();
  const row = {
    dataset: { key: "photo" },
    querySelectorAll: () => [
      { complete: true, naturalWidth: 800, hasAttribute: () => true },
    ],
  };
  const viewport = {
    scrollTop: 0,
    querySelectorAll: () => [row],
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      assert.equal(listeners.get(name), fn);
      listeners.delete(name);
    },
  };
  const context = {
    window: {},
    document: {
      querySelector: (selector) =>
        selector === "#viewport"
          ? viewport
          : { classList: { contains: () => true } },
    },
  };
  for (let i = 0; i < 3; i++) {
    runInNewContext(
      `(${startMemoryCycle.toString()})({external:true})`,
      context,
    );
    viewport.scrollTop += 900;
    listeners.get("scroll")();
    listeners.get("scrollend")();
    listeners.get("wheel")();
    context.window.__finishMemoryCycle();
    const result = context.window.__memoryCycle;
    assert.equal(result.done, true);
    assert.equal(result.distance, 900);
    assert.deepEqual([...result.decodedImageKeys], ["photo"]);
    assert.equal(result.streamingObserved, true);
    assert.equal(listeners.size, 0);
    assert.equal(context.window.__finishMemoryCycle, undefined);
  }
});
