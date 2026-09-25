import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { parseSync } from "vite";
import { analyzeChat, compareChat } from "./chat-analysis.mjs";
import { chatTargets, instrumentChat } from "./chat-instrument.mjs";
import { installChatProbe } from "./chat-probe.mjs";
import { analyzeChatChrome } from "./chat-trace.mjs";
import { chatWorkload } from "./chat-workload.mjs";

test("invalidation tracing rejects unsupported browsers and timing mode before launching", () => {
  for (const [browser, mode] of [
    ["firefox", "diagnostic"],
    ["engine-chromium", "diagnostic"],
    ["chrome", "timing"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL("../profile-chat.mjs", import.meta.url).pathname,
        `--browser=${browser}`,
        `--mode=${mode}`,
        "--trace-invalidations",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /--trace-invalidations requires --browser=chrome --mode=diagnostic/,
    );
    assert.equal(result.stdout, "");
  }
});

test("workload has reproducible input, ordered deadlines, and a complete local response", () => {
  const a = chatWorkload(),
    b = chatWorkload();
  assert.deepEqual(a, b);
  assert.ok(
    a.events.every((event, i) => i === 0 || event.at >= a.events[i - 1].at),
  );
  assert.equal(a.events.at(-1).at, a.metadata.durationMs);
  assert.equal(a.events.at(-1).event.type, "response.completed");
  assert.equal(
    a.events
      .filter((item) => item.event.type === "response.output_text.delta")
      .reduce((count, item) => count + item.event.delta.length, 0),
    a.metadata.characters,
  );
  assert.notEqual(chatWorkload({ sections: 8 }).metadata.hash, a.metadata.hash);
  assert.throws(() => chatWorkload({ durationMs: 0 }), /Invalid durationMs/);
});

test("every source target is present once, parses after instrumentation, and fails closed on drift", async () => {
  for (const path of Object.keys(chatTargets)) {
    const source = await readFile(
      new URL(`../../${path}`, import.meta.url),
      "utf8",
    );
    const changed = instrumentChat(source, path, true);
    assert.deepEqual(parseSync(path, changed).errors, [], path);
    for (const name of chatTargets[path])
      assert.ok(changed.includes(JSON.stringify(`${path}:${name}`)));
    assert.throws(
      () => instrumentChat("", path, true),
      /Profiling target changed/,
    );
    if (
      !["demos/streaming/streaming.ts", "demos/streaming/openai.ts"].includes(
        path,
      )
    )
      assert.equal(instrumentChat(source, path, false), source);
  }
});

test("instrumented returns and exceptions preserve behavior and close spans", () => {
  const source =
    "function renderMarkdown(markdown) { if (markdown === 'fail') throw new Error('failure'); return markdown + '✓'; }";
  const changed = instrumentChat(source, "demos/shared/markdown.ts", true);
  let entered = 0,
    left = 0;
  const context = {
    __chatProfile: {
      enter() {
        return ++entered;
      },
      leave() {
        left++;
      },
    },
  };
  assert.equal(
    runInNewContext(`${changed}; renderMarkdown('content')`, context),
    "content✓",
  );
  assert.throws(
    () => runInNewContext(`${changed}; renderMarkdown('fail')`, context),
    /failure/,
  );
  assert.equal(entered, 2);
  assert.equal(left, 2);
});

test("recorder bounds telemetry, subtracts nested work, and restores DOM descriptors", () => {
  const dom = new JSDOM(
    '<div id="viewport"></div><textarea id="prompt"></textarea><button id="send-btn"></button>',
    { url: "http://localhost:4197", runScripts: "outside-only" },
  );
  const w = dom.window;
  let time = 100;
  let callback;
  w.requestAnimationFrame = (fn) => {
    callback = fn;
    return 1;
  };
  w.cancelAnimationFrame = () => {};
  w.performance.now = () => time;
  w.performance.mark = () => {};
  w.performance.getEntriesByName = () => [{}];
  w.PerformanceObserver = { supportedEntryTypes: [] };
  const descriptor = Object.getOwnPropertyDescriptor(
    w.Element.prototype,
    "scrollTop",
  );
  try {
    w.eval(
      `(${installChatProbe.toString()})(${JSON.stringify({ turns: [], workload: { characters: 10, chunks: 1 }, diagnostic: true, limit: 2, scenario: "follow", trail: "off" })})`,
    );
    const api = w.__chatProfile;
    api.start();
    const outer = api.enter("outer", null);
    time += 2;
    const inner = api.enter("inner", null);
    time += 3;
    api.leave(inner);
    time += 4;
    api.leave(outer);
    // Reading layout in the sampler would now throw.
    const viewport = w.document.querySelector("#viewport");
    Object.defineProperty(viewport, "clientHeight", {
      get() {
        throw new Error("sampler layout read");
      },
      configurable: true,
    });
    for (let i = 0; i < 4; i++) {
      time += 16;
      callback(time);
    }
    delete viewport.clientHeight;
    api.delivery("response.output_text.delta", 10);
    api.delivery("response.completed", 0);
    const result = api.stop();
    assert.equal(result.operations.find((op) => op.name === "outer").selfMs, 6);
    assert.equal(result.frames.length, 2);
    assert.equal(result.dropped.frames, 2);
    assert.equal(result.stream.done, true);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(w.Element.prototype, "scrollTop"),
      descriptor,
    );
    assert.throws(() => api.start(), /already started/);
  } finally {
    dom.window.close();
  }
});

function recording() {
  return {
    schema: 1,
    durationMs: 1000,
    mode: "timing",
    scenario: "follow",
    userAgent: "test",
    workload: { hash: "a", characters: 100, chunks: 10 },
    frames: Array.from({ length: 40 }, (_, i) => [
      i * 16,
      i * 10,
      "follow",
      i,
      i,
      true,
      30,
      1000,
      false,
      null,
    ]),
    inputs: [],
    spans: [],
    operations: [],
    access: [],
    entries: [],
    states: [],
    deliveries: [],
    errors: [],
    invalidations: [],
    dropped: {},
    capabilities: { longtask: { supported: false } },
    stream: { done: true, characters: 100, chunks: 10 },
    scroll: { wheels: 0, ends: 0 },
    initial: { window: {}, status: "30/160" },
    final: { window: {}, status: "30/160" },
    mutations: null,
  };
}

test("analysis rejects incomplete, stationary, overflowed, and interrupted evidence", () => {
  const valid = recording();
  assert.equal(analyzeChat(valid).valid, true);
  assert.deepEqual(analyzeChat(valid).performanceEntries.longtask, {
    available: false,
  });
  for (const modify of [
    (r) => {
      r.stream.done = false;
    },
    (r) => {
      r.frames.forEach((frame) => {
        frame[1] = 0;
      });
    },
    (r) => {
      r.dropped.spans = 1;
    },
    (r) => {
      r.invalidations.push({ type: "blur" });
    },
    (r) => {
      r.errors.push("renderer failed");
    },
    (r) => {
      r.scenario = "scrollback";
    },
    (r) => {
      r.final.window.dpr = 2;
    },
  ]) {
    const r = recording();
    modify(r);
    assert.equal(analyzeChat(r).valid, false);
  }
  const before = analyzeChat(valid),
    after = analyzeChat(valid);
  assert.equal(compareChat(before, after).comparable, true);
  after.mode = "diagnostic";
  assert.deepEqual(compareChat(before, after).mismatches, ["mode"]);
  after.mode = before.mode;
  after.traceInvalidations = true;
  assert.deepEqual(compareChat(before, after).mismatches, [
    "traceInvalidations",
  ]);
  after.traceInvalidations = before.traceInvalidations;
  delete before.traceInvalidations;
  assert.equal(compareChat(before, after).comparable, true);
  after.workload = { ...after.workload, trail: "off" };
  assert.deepEqual(compareChat(before, after).mismatches, ["trail"]);
  after.workload = before.workload;
  after.transport = "safaridriver-mcp";
  assert.deepEqual(compareChat(before, after).mismatches, ["transport"]);
  after.transport = before.transport;
  before.monitor = { name: "External", scale: 2, width: 1920 };
  after.monitor = { width: 1920, name: "External", scale: 2 };
  assert.equal(compareChat(before, after).comparable, true);
  after.monitor.scale = 1;
  assert.deepEqual(compareChat(before, after).mismatches, ["monitor"]);
});

test("Chrome attribution clips work to the marked renderer and preserves unavailable presentation", () => {
  const trace = {
    traceEvents: [
      { name: "chat-profile-start", ph: "R", ts: 1000, pid: 1, tid: 2 },
      { name: "chat-profile-end", ph: "R", ts: 11000, pid: 1, tid: 2 },
      { name: "Layout", ph: "X", ts: 0, dur: 4000, pid: 1, tid: 2 },
      { name: "Layout", ph: "X", ts: 2000, dur: 3000, pid: 3, tid: 2 },
      {
        name: "thread_name",
        ph: "M",
        pid: 3,
        tid: 2,
        args: { name: "Compositor" },
      },
      { name: "Paint", ph: "X", ts: 12000, dur: 3000, pid: 3, tid: 2 },
    ],
  };
  const summary = analyzeChatChrome(trace);
  assert.equal(summary.categories[0].summedInclusiveMs, 3);
  assert.equal(summary.otherThreads[0].name, "Compositor");
  assert.equal(summary.otherThreads[0].categories.length, 1);
  assert.equal(summary.otherThreads[0].categories[0].summedInclusiveMs, 3);
  assert.equal(summary.presentationIntervalsMs, null);
  assert.throws(
    () => analyzeChatChrome({ traceEvents: trace.traceEvents.slice(1) }),
    /start marker/,
  );
});

test("Chrome invalidation summaries group causes, bound examples, and exclude unrelated events", () => {
  const stackTrace = Array.from({ length: 12 }, (_, i) => ({
    functionName: `update${i}`,
    url: "http://localhost/viewer.js",
    lineNumber: i,
  }));
  const invalidation = {
    name: "StyleRecalcInvalidationTracking",
    ph: "I",
    ts: 2000,
    pid: 1,
    tid: 2,
    args: {
      data: {
        reason: "Related style rule",
        nodeName: "DIV",
        subtree: true,
        stackTrace,
      },
    },
  };
  const style = {
    name: "UpdateLayoutTree",
    ph: "X",
    ts: 2000,
    dur: 1000,
    pid: 1,
    tid: 2,
    args: { elementCount: 20 },
  };
  const summary = analyzeChatChrome({
    traceEvents: [
      { name: "chat-profile-start", ph: "R", ts: 1000, pid: 1, tid: 2 },
      { name: "chat-profile-end", ph: "R", ts: 11000, pid: 1, tid: 2 },
      invalidation,
      { ...invalidation, ts: 3000 },
      { ...invalidation, tid: 3 },
      { ...invalidation, ts: 12000 },
      style,
      { ...style, args: { elementCount: 100 } },
      { ...style, tid: 3 },
      { ...style, ts: 12000 },
    ],
  });
  assert.equal(summary.invalidationRecords, 2);
  assert.equal(summary.invalidations.length, 1);
  assert.equal(summary.invalidations[0].count, 2);
  assert.equal(summary.invalidations[0].example.stackTrace.length, 8);
  assert.equal(summary.invalidations[0].example.omittedStackFrames, 4);
  assert.equal(summary.omittedInvalidationGroups, 0);
  assert.equal(summary.styleRecalculationElements.count, 2);
  assert.equal(summary.styleRecalculationElements.max, 100);
});
