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
import { createChatProfileServer } from "./chat-server.mjs";
import { analyzeChatChrome } from "./chat-trace.mjs";
import { chatWorkload } from "./chat-workload.mjs";

test("button and snapshot captures reject incomplete or incompatible setups", () => {
  for (const [args, message] of [
    [["--scenario=buttons", "--stream-ms=7000"], /buttons scenario needs/],
    [["--scenario=buttons", "--seconds=19"], /buttons scenario needs/],
    [["--safari-snapshots"], /--safari-snapshots requires/],
    [
      ["--browser=safari", "--scenario=buttons", "--safari-snapshots"],
      /--safari-snapshots requires/,
    ],
    [
      [
        "--browser=safari",
        "--scenario=buttons",
        "--mode=diagnostic",
        "--safari-snapshots",
        "--safari-detached",
      ],
      /--safari-snapshots requires/,
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL("../profile-chat.mjs", import.meta.url).pathname, ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
  }
});

test("native Safari samples reject incompatible browsers and timing mode", () => {
  for (const [browser, mode] of [
    ["firefox", "diagnostic"],
    ["safari", "timing"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL("../profile-chat.mjs", import.meta.url).pathname,
        `--browser=${browser}`,
        `--mode=${mode}`,
        "--safari-sample=13.7:2:10",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--safari-sample requires/);
    assert.equal(result.stdout, "");
  }
});

test("detached Safari rejects incompatible captures before launching", () => {
  for (const [browser, scenario] of [
    ["chrome", "follow"],
    ["safari", "scrollback"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL("../profile-chat.mjs", import.meta.url).pathname,
        `--browser=${browser}`,
        `--scenario=${scenario}`,
        "--safari-detached",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--safari-detached requires/);
    assert.equal(result.stdout, "");
  }
});

test("self-timed capture waits for its server gate and cancelled gates reject startup", async () => {
  for (const action of ["release", "close"]) {
    const server = await createChatProfileServer({ sections: 2, history: 10 });
    try {
      let responded = false;
      const response = fetch(new URL("/__chat-profile/start", server.url)).then(
        (value) => {
          responded = true;
          return value;
        },
      );
      const deadline = Date.now() + 2000;
      while (!server.captureArmed && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(server.captureArmed, true);
      assert.equal(responded, false);
      if (action === "release") server.releaseCapture();
      else await server.close();
      assert.equal((await response).status, action === "release" ? 204 : 503);
      assert.equal(server.captureArmed, false);
    } finally {
      await server.close();
    }
  }
});

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
      /Profiling (target|hook) changed/,
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
    {
      url: "http://localhost:4197",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.document.hasFocus = () => true;
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
    w.document.hasFocus = () => false;
    assert.throws(() => api.start(), /focused, visible/);
    w.document.hasFocus = () => true;
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
    api.coverage({ scrollTop: 100, height: 100 }, 200, [
      [100, 50, true],
      [150, 50, false],
    ]);
    api.coverage({ scrollTop: 100, height: 100 }, 200, [
      [150, 50, true],
      [100, 60, true],
    ]);
    viewport.scrollTop = 42;
    api.delivery("response.output_text.delta", 10);
    api.delivery("response.completed", 0);
    const result = api.stop();
    assert.deepEqual(
      Array.from(result.coverage, (row) => row.missingPx),
      [50, 0],
    );
    assert.equal(result.scrollWrites[0].top, 42);
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

test("button captures require every destination and report glide stalls and replanning", () => {
  const r = recording();
  r.scenario = "buttons";
  r.scroll.ends = 4;
  r.navigation = ["top", "bottom", "top", "bottom"].map((direction, i) => ({
    time: i * 100,
    direction,
    reached: true,
  }));
  r.glides = [
    {
      id: 1,
      time: 0,
      timestamp: 0,
      current: 0,
      written: 10,
      target: 100,
      rebased: false,
      phase: "button-bottom",
    },
    {
      id: 1,
      time: 16,
      timestamp: 16,
      current: 10,
      written: 20,
      target: 100,
      rebased: false,
    },
    {
      id: 1,
      time: 32,
      timestamp: 32,
      current: 10,
      written: 11,
      target: 150,
      rebased: true,
    },
    {
      id: 1,
      time: 64,
      timestamp: 64,
      current: 11,
      written: 30,
      target: 150,
      rebased: false,
    },
    { id: 1, time: 80, completed: true },
  ];
  const summary = analyzeChat(r);
  assert.equal(summary.valid, true);
  assert.equal(summary.navigation[0].writesAvailable, false);
  assert.equal(summary.navigation[0].writeCount, null);
  r.scrollWrites = Array.from({ length: 141 }, (_, time) => ({
    time,
    top: time,
  }));
  const writes = analyzeChat(r).navigation[0];
  assert.equal(writes.writesAvailable, true);
  assert.equal(writes.writeCount, 141);
  assert.equal(writes.omittedWrites, 21);
  assert.equal(writes.writes.length, 120);
  const trip = summary.glides.trips[0];
  assert.equal(trip.completed, true);
  assert.equal(trip.rebases, 1);
  assert.equal(trip.targetChanges, 1);
  assert.equal(trip.stalledFrames, 1);
  assert.equal(trip.writeErrorPx.max, 10);
  assert.equal(trip.frameMs.max, 32);
  assert.equal(summary.navigation.length, 4);
  r.navigation[0].reached = false;
  assert.deepEqual(analyzeChat(r).invalidReasons, [
    "Incomplete button navigation or missing scroll-end events",
  ]);
});

test("scheduler probe preserves callbacks and cancellation, bounds records, and closes its tasks", () => {
  const dom = new JSDOM(
    '<div id="viewport"></div><textarea id="prompt"></textarea><button id="send-btn"></button>',
    {
      url: "http://localhost:4197",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.document.hasFocus = () => true;
  let time = 100,
    next = 0,
    closed = 0,
    posted = 0;
  const callbacks = new Map(),
    timers = new Map();
  w.requestAnimationFrame = (callback) => {
    callbacks.set(++next, callback);
    return next;
  };
  const originalRaf = w.requestAnimationFrame;
  w.cancelAnimationFrame = (id) => callbacks.delete(id);
  w.setTimeout = (callback) => {
    timers.set(++next, callback);
    return next;
  };
  w.clearTimeout = (id) => timers.delete(id);
  let channel;
  w.MessageChannel = class {
    constructor() {
      channel = this;
    }
    port1 = {
      close() {
        closed++;
      },
    };
    port2 = {
      postMessage() {
        posted++;
      },
      close() {
        closed++;
      },
    };
  };
  w.performance.now = () => time;
  w.performance.mark = () => {};
  w.performance.getEntriesByName = () => [{}];
  w.PerformanceObserver = { supportedEntryTypes: [] };
  try {
    w.eval(
      `(${installChatProbe.toString()})(${JSON.stringify({ turns: [], workload: {}, scheduler: true, diagnostic: false, limit: 2, scenario: "follow", trail: "off" })})`,
    );
    const api = w.__chatProfile;
    api.start();
    const cancelled = w.requestAnimationFrame(() =>
      assert.fail("cancelled callback"),
    );
    w.cancelAnimationFrame(cancelled);
    assert.equal(callbacks.has(cancelled), false);
    let receiver, timestamp;
    w.requestAnimationFrame(function paint(value) {
      receiver = this;
      timestamp = value;
      time += 4;
    });
    const due = [...callbacks.values()];
    callbacks.clear();
    time = 120;
    for (const callback of due) callback.call(w, 116);
    assert.equal(receiver, w);
    assert.equal(timestamp, 116);
    time = 130;
    channel.port1.onmessage();
    // A busy main thread delivers the due timer late; reschedule from now.
    for (let i = 0; i < 3; i++) {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      time += 30;
      callback();
    }
    const throwing = w.requestAnimationFrame(() => {
      time += 9;
      throw new Error("callback failed");
    });
    assert.throws(
      () => callbacks.get(throwing).call(w, time),
      /callback failed/,
    );
    const result = api.stop();
    assert.deepEqual(Array.from(result.scheduling.rafWork[0]), [
      20,
      4,
      "paint",
      16,
      null,
    ]);
    assert.deepEqual(Array.from(result.scheduling.tasks[0]), [20, 30]);
    assert.equal(result.scheduling.version, 2);
    assert.equal(result.scheduling.rafWork[1][1], 9);
    assert.match(result.scheduling.rafWork[1][4], /callback failed/);
    assert.deepEqual(Array.from(result.scheduling.timers[0]), [0, 16, 60]);
    assert.equal(result.scheduling.timers.length, 2);
    assert.equal(result.dropped.timers, 1);
    assert.equal(posted, 1);
    assert.equal(closed, 2);
    assert.equal(timers.size, 0);
    assert.equal(w.requestAnimationFrame, originalRaf);
  } finally {
    w.close();
  }
});

test("scheduler analysis distinguishes a frame gap with responsive tasks from delayed tasks", () => {
  const r = recording();
  r.frames.forEach((frame) => {
    frame[11] = frame[0] + 2;
  });
  r.frames[1][0] = 96;
  r.frames[1][11] = 98;
  for (let i = 2; i < r.frames.length; i++) {
    r.frames[i][0] += 80;
    r.frames[i][11] += 80;
  }
  r.scheduling = {
    version: 1,
    timerPeriodMs: 16,
    timers: [
      [0, 16, 17],
      [17, 33, 34],
      [34, 50, 51],
      [51, 67, 68],
      [68, 84, 85],
    ],
    tasks: [[2, 3]],
    rafWork: [[2, 1, "paint", 0]],
    trailChanges: [{ time: 97, layersRemoved: 1 }],
  };
  const responsive = analyzeChat(r);
  assert.equal(responsive.slowFrames[0].callbackGapMs, 96);
  assert.equal(responsive.slowFrames[0].scheduling.timerTicks, 5);
  assert.equal(responsive.slowFrames[0].scheduling.timerLatenessMs.max, 1);
  assert.equal(responsive.scheduling.trailDisposals[0].frameMs.max, 96);
  assert.equal(responsive.scheduling.trailDisposals[0].timerLatenessMs.max, 1);
  r.scheduling.timers = [[0, 16, 97]];
  r.scheduling.tasks = [[2, 97]];
  r.scheduling.rafWork = [
    [3, 80, "paint", 0],
    [98, 50, "next-frame", 96],
  ];
  const blocked = analyzeChat(r);
  assert.equal(blocked.slowFrames[0].scheduling.timerLatenessMs.max, 81);
  assert.equal(blocked.slowFrames[0].scheduling.postRafTaskMs.max, 95);
  assert.equal(blocked.scheduling.trailDisposals[0].timerLatenessMs.max, 81);
  assert.equal(blocked.slowFrames[0].scheduling.rafCallbacks[0].durationMs, 80);
  assert.equal(blocked.slowFrames[0].scheduling.rafCallbacks.length, 1);
  assert.equal(blocked.slowFrames[0].scheduling.rafCallbacks[0].overlapMs, 80);
  assert.equal(blocked.slowFrames[0].scheduling.trailChanges.length, 1);
  assert.deepEqual(
    compareChat(responsive, analyzeChat(recording())).mismatches,
    ["scheduler"],
  );
});

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
  after.nativeSampling = {
    atSeconds: 13.7,
    durationSeconds: 2,
    intervalMs: 10,
  };
  assert.deepEqual(compareChat(before, after).mismatches, ["nativeSampling"]);
  after.nativeSampling = null;
  after.renderSnapshots = true;
  assert.deepEqual(compareChat(before, after).mismatches, ["renderSnapshots"]);
  after.renderSnapshots = false;
  after.probeVersion = 2;
  assert.deepEqual(compareChat(before, after).mismatches, ["probeVersion"]);
  after.probeVersion = before.probeVersion;
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
