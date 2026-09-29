import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { instrumentRuntime } from "./runtime-audit.mjs";
import {
  installScrollStateProbe,
  instrumentScrollState,
  summarizeScrollState,
} from "./scroll-state-probe.mjs";

test("page probe records paging and clicks, bounds data, and removes its hooks", async () => {
  const dom = new JSDOM(
    '<div id="viewport"></div><span id="window-status">loaded 1-24/48</span><button id="scroll-top-btn" class="scroll-jump"></button>',
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const { window } = dom;
  try {
    window.__scrollStateRead = {
      list: () => ({ jobs: 1 }),
      settle: () => ({ active: true }),
    };
    window.requestAnimationFrame = () => {
      throw new Error("No animation-frame polling");
    };
    window.eval(`(${installScrollStateProbe})()`);
    const probe = window.__scrollStateProbe;
    window.document.getElementById("scroll-top-btn").click();
    window.document.getElementById("window-status").textContent =
      "loading bottom";
    await Promise.resolve();
    const state = probe.snapshot();
    assert.equal(
      state.records,
      undefined,
      "checkpoints do not transfer the raw recording",
    );
    assert.equal(state.counts.click, 1);
    assert.equal(state.counts.paging, 2);
    assert.equal(state.status, "loading bottom");
    for (let i = 0; i < 20000; i++) probe.record("release-cleared");
    const stopped = probe.stop();
    assert.equal(stopped.records.length, 20000);
    assert.equal(stopped.dropped, 3);
    assert.equal(window.__scrollStateProbe, undefined);
    window.document.getElementById("scroll-top-btn").click();
    window.document.getElementById("window-status").textContent = "finished";
    await Promise.resolve();
    assert.equal(probe.snapshot().counts.click, 1);
    assert.equal(probe.snapshot().counts.paging, 2);
  } finally {
    dom.window.close();
  }
});

test("scroll-state overlays fail closed when source hooks change", async () => {
  for (const path of [
    "src/virtual-list.ts",
    "src/scroll-settle.ts",
    "src/native-glide.ts",
  ]) {
    const source = await readFile(
      new URL(`../../${path}`, import.meta.url),
      "utf8",
    );
    const changed = instrumentScrollState(source, `/${path}`);
    assert.ok(changed.includes("globalThis.__scrollState"));
    assert.throws(
      () => instrumentScrollState(changed, `/${path}`),
      /Already instrumented/,
    );
    assert.throws(
      () => instrumentScrollState("stale source", `/${path}`),
      /State hook changed/,
    );
    if (path.endsWith("virtual-list.ts"))
      assert.doesNotThrow(() => instrumentRuntime(changed));
  }
  assert.equal(
    instrumentScrollState("untouched", "/unrelated.ts"),
    "untouched",
  );
});

test("summary preserves lost release and held job evidence, without a raw scroll trace", () => {
  const records = [
    {
      time: 0,
      type: "paging",
      detail: "loading bottom",
      list: { jobs: 1, glide: false },
      settle: { active: true, pendingEnd: false },
    },
    {
      time: 10,
      type: "scrollend",
      list: { jobs: 1, glide: false },
      settle: { active: true, pendingEnd: true },
    },
    ...Array.from({ length: 100 }, (_, i) => ({
      time: 11 + i,
      type: "scroll",
      list: { jobs: 1, glide: false },
      settle: { active: true, pendingEnd: true },
    })),
    {
      time: 200,
      type: "wheel",
      detail: { delta: 7 },
      list: { jobs: 1, glide: false },
      settle: { active: true, pendingEnd: false },
    },
    {
      time: 300,
      type: "mark",
      list: { jobs: 1, glide: false },
      settle: { active: true, pendingEnd: false },
    },
  ];
  const summary = summarizeScrollState({
    records,
    dropped: 0,
    status: "loading bottom",
  });
  assert.equal(summary.records, undefined);
  assert.deepEqual(
    summary.stateChanges.map((record) => record.type),
    ["paging", "scrollend", "wheel"],
  );
  assert.deepEqual(
    summary.transitions.map((record) => record.type),
    ["paging", "mark"],
  );
  assert.equal(summary.status, "loading bottom");
});

test("summary bounds state transitions and exposes omissions", () => {
  const records = Array.from({ length: 300 }, (_, i) => ({
    type: "paging",
    time: i,
    list: { jobs: i % 2 },
  }));
  const summary = summarizeScrollState({ records });
  assert.equal(summary.transitions.length, 100);
  assert.equal(summary.omittedTransitions, 200);
  assert.equal(summary.stateChanges.length, 60);
  assert.equal(summary.omittedStateChanges, 240);
  assert.equal(summary.stateChanges.at(-1).time, 299);
});

test("summary retains pointer input when a jump button never receives a click", () => {
  const records = [
    { type: "pointerdown", detail: { button: "scroll-top-btn" } },
    { type: "pointercancel", detail: { button: "scroll-top-btn" } },
    { type: "pointerup", detail: { button: null } },
  ];
  const summary = summarizeScrollState({ records });
  assert.deepEqual(summary.transitions, records);
});

test("summary keeps the wheel that cancelled a command and its native request", () => {
  const command = [
    { type: "command", detail: "start", list: { glide: false } },
    { type: "native-request", detail: 0, list: { glide: true } },
    { type: "wheel-input", detail: { delta: 0 }, list: { glide: true } },
    {
      type: "native-result",
      detail: { completed: false },
      list: { glide: true },
    },
  ];
  const summary = summarizeScrollState({
    records: [
      ...command,
      { type: "wheel-input", detail: { delta: 8 }, list: { glide: false } },
    ],
  });
  assert.deepEqual(summary.transitions, command);
});
