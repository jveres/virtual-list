import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { parseSync } from "vite";
import {
  analyzeChat,
  compareChat,
  summarizeScrollMotion,
} from "./chat-analysis.mjs";
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

test("prose stress keeps history and deadlines while streaming plain prose", () => {
  const rich = chatWorkload({ content: "rich" });
  const prose = chatWorkload({ content: "prose" });
  assert.deepEqual(prose, chatWorkload({ content: "prose" }));
  assert.deepEqual(prose.turns, rich.turns);
  const reply = prose.events
    .filter(({ event }) => event.type === "response.output_text.delta")
    .map(({ event }) => event.delta)
    .join("");
  assert.equal(reply.length, prose.metadata.characters);
  assert.doesNotMatch(reply, /[\n*_`$]/);
  assert.equal(prose.metadata.content, "prose");
  assert.notEqual(prose.metadata.hash, rich.metadata.hash);
  assert.equal(prose.events.at(-1).at, rich.events.at(-1).at);
  assert.throws(() => chatWorkload({ content: "unknown" }), /Invalid content/);
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

test("live-commit read spans preserve values and close after a failed read", () => {
  const path = "src/virtual-list.ts";
  const source = `${chatTargets[path]
    .filter((name) => !["liveCommit", "viewportState"].includes(name))
    .map((name) => `function ${name}() { return null; }`)
    .join("\n")}
    let reads = 0;
    function viewportState() {
      if (++reads === 2 && fail) throw new Error("read failed");
      return reads;
    }
    function liveCommit() {
      const before = viewportState();
      return (() => before + viewportState())();
    }`;
  const changed = instrumentChat(source, path, true);
  for (const fail of [false, true]) {
    const names = [];
    const open = [];
    const context = {
      fail,
      __chatProfile: {
        enter(name) {
          names.push(name);
          open.push(name);
          return name;
        },
        leave(name) {
          assert.equal(open.pop(), name);
        },
      },
    };
    const run = () => runInNewContext(`${changed}; liveCommit()`, context);
    if (fail) assert.throws(run, /read failed/);
    else assert.equal(run(), 3);
    assert.deepEqual(
      names.filter((name) => name.includes(".viewportRead")),
      [
        `${path}:liveCommit.viewportRead[0]`,
        `${path}:liveCommit.viewportRead[1]`,
      ],
    );
    assert.deepEqual(open, []);
  }
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
  const insertBefore = w.Node.prototype.insertBefore;
  const measuredInsert = function (...args) {
    time += 5;
    return insertBefore.apply(this, args);
  };
  w.Node.prototype.insertBefore = measuredInsert;
  try {
    w.eval(
      `(${installChatProbe.toString()})(${JSON.stringify({ turns: [], workload: { characters: 10, chunks: 1 }, diagnostic: true, limit: 2, scenario: "follow", trail: "off", landing: "prompt" })})`,
    );
    const api = w.__chatProfile;
    w.document.hasFocus = () => false;
    assert.throws(() => api.start(), /focused, visible/);
    w.document.hasFocus = () => true;
    let sends = 0;
    w.document
      .querySelector("#send-btn")
      .addEventListener("click", () => sends++);
    const prompt = w.document.querySelector("#prompt");
    prompt.value = "User-prepared input";
    api.start({ submit: false });
    assert.equal(sends, 0, "external keyboard input must own submission");
    assert.equal(prompt.value, "User-prepared input");
    assert.equal(
      JSON.parse(w.localStorage.getItem("virtual-list:chat-options")).landing,
      "prompt",
    );
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
    viewport.dataset.key = "diagnostic-row";
    const mutationSpan = api.enter("mutation-burst", viewport);
    for (let i = 0; i < 3; i++) {
      const child = w.document.createElement("span");
      assert.equal(viewport.insertBefore(child, null), child);
    }
    assert.throws(
      () =>
        viewport.insertBefore(
          w.document.createElement("span"),
          w.document.createElement("span"),
        ),
      { name: "NotFoundError" },
    );
    api.leave(mutationSpan);
    const result = api.stop();
    assert.equal(result.probeVersion, 6);
    assert.equal(result.domOperations.slow.length, 2);
    assert.equal(result.domOperations.omitted, 2);
    assert.equal(result.domOperations.slow[0].row, "diagnostic-row");
    assert.equal(result.domOperations.slow[0].subject.tag, "SPAN");
    assert.equal(result.domOperations.slow[0].parent.childrenAfter, 1);
    assert.equal(result.domOperations.slow[0].durationMs, 5);
    const insertions = result.domOperations.totals.find(
      (entry) => entry.name === "insertBefore",
    );
    assert.equal(insertions.count, 4);
    assert.equal(insertions.inclusiveMs, 20);
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.domOperations.byConnection)),
      [
        {
          name: "insertBefore",
          connection: "connected-insert",
          count: 3,
          inclusiveMs: 15,
          maxMs: 5,
        },
        {
          name: "insertBefore",
          connection: "failed",
          count: 1,
          inclusiveMs: 5,
          maxMs: 5,
        },
      ],
    );
    assert.equal(result.domOperations.bursts.length, 1);
    assert.equal(result.domOperations.bursts[0].count, 4);
    assert.equal(result.domOperations.bursts[0].groups[0].subjectTag, "SPAN");
    assert.equal(result.domOperations.bursts[0].inclusiveMs, 20);
    assert.equal(w.Node.prototype.insertBefore, measuredInsert);
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

test("DOM totals separate connected changes, detached work, no-ops, and failed calls", () => {
  const dom = new JSDOM(
    '<div id="viewport"><div id="left"><i id="one"></i><i id="two"></i></div><div id="right"></div></div><textarea id="prompt"></textarea><button id="send-btn"></button>',
    {
      url: "http://localhost:4197",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.document.hasFocus = () => true;
  w.requestAnimationFrame = () => 1;
  w.cancelAnimationFrame = () => {};
  let time = 100;
  w.performance.now = () => time;
  w.performance.mark = () => {};
  w.performance.getEntriesByName = () => [{}];
  w.PerformanceObserver = { supportedEntryTypes: [] };
  for (const [prototype, name] of [
    [w.Node.prototype, "insertBefore"],
    [w.Node.prototype, "removeChild"],
    [w.Element.prototype, "remove"],
  ]) {
    const original = prototype[name];
    prototype[name] = function (...args) {
      time += 0.25;
      return original.apply(this, args);
    };
  }
  try {
    w.eval(
      `(${installChatProbe.toString()})(${JSON.stringify({ turns: [], workload: { characters: 10, chunks: 1 }, diagnostic: true, limit: 2, scenario: "follow", trail: "off" })})`,
    );
    const api = w.__chatProfile;
    api.start({ submit: false });
    const left = w.document.querySelector("#left");
    const right = w.document.querySelector("#right");
    const one = w.document.querySelector("#one");
    const two = w.document.querySelector("#two");
    const staged = w.document.createElement("div");
    const parking = w.document.createElement("div");
    const fresh = w.document.createElement("span");
    const fragment = w.document.createDocumentFragment();
    const fragmentChild = w.document.createElement("b");
    fragment.append(fragmentChild, w.document.createTextNode("fixture"));
    const emptyFragment = w.document.createDocumentFragment();
    const bounds = w.Element.prototype.getBoundingClientRect;
    const query = w.Element.prototype.querySelectorAll;
    w.Element.prototype.getBoundingClientRect = () => {
      throw new Error("DOM classification must not read geometry");
    };
    w.Element.prototype.querySelectorAll = () => {
      throw new Error("DOM classification must not walk subtrees");
    };
    staged.insertBefore(fresh, null);
    left.insertBefore(staged, null);
    right.insertBefore(one, null);
    // Even an unchanged position can cause native remove/insert work.
    right.insertBefore(one, null);
    parking.insertBefore(one, null);
    assert.equal(parking.removeChild(one), one);
    assert.equal(left.removeChild(two), two);
    two.remove();
    staged.remove();
    fresh.remove();
    assert.equal(left.insertBefore(emptyFragment, null), emptyFragment);
    assert.equal(left.insertBefore(fragment, null), fragment);
    assert.equal(fragmentChild.isConnected, true);
    assert.equal(fragment.firstChild, null);
    assert.throws(() => left.removeChild(fresh), { name: "NotFoundError" });
    assert.throws(() => left.insertBefore(fresh, right), {
      name: "NotFoundError",
    });
    for (let i = 0; i < 100; i++) two.remove();
    w.Element.prototype.getBoundingClientRect = bounds;
    w.Element.prototype.querySelectorAll = query;
    const result = api.stop();
    const byConnection = Object.fromEntries(
      result.domOperations.byConnection.map((entry) => [
        `${entry.name}:${entry.connection}`,
        entry.count,
      ]),
    );
    assert.deepEqual(byConnection, {
      "insertBefore:detached-insert": 1,
      "insertBefore:connected-insert": 2,
      "insertBefore:connected-move": 2,
      "insertBefore:connected-remove": 1,
      "removeChild:detached-remove": 1,
      "removeChild:connected-remove": 1,
      "remove:no-op": 101,
      "remove:connected-remove": 1,
      "remove:detached-remove": 1,
      "insertBefore:no-op": 1,
      "removeChild:failed": 1,
      "insertBefore:failed": 1,
    });
    for (const total of result.domOperations.totals) {
      const classes = result.domOperations.byConnection.filter(
        (entry) => entry.name === total.name,
      );
      assert.equal(
        classes.reduce((sum, entry) => sum + entry.count, 0),
        total.count,
      );
      assert.equal(
        classes.reduce((sum, entry) => sum + entry.inclusiveMs, 0),
        total.inclusiveMs,
      );
      assert.equal(total.inclusiveMs, total.count * 0.25);
      assert.equal(total.maxMs, 0.25);
    }
    assert.equal(result.domOperations.slow.length, 0);
    assert.equal(result.domOperations.bursts.length, 0);
    const summary = JSON.parse(JSON.stringify(analyzeChat(result)));
    assert.deepEqual(
      summary.work.domOperations.byConnection,
      JSON.parse(JSON.stringify(result.domOperations.byConnection)),
      "compact summaries must retain classifications after raw data is removed",
    );
  } finally {
    dom.window.close();
  }
});

test("bottom completion requires the restored tail and a finished window handoff", () => {
  const dom = new JSDOM(
    '<div id="viewport"></div><textarea id="prompt"></textarea><button id="send-btn"></button><button id="scroll-top-btn"></button><button id="scroll-bottom-btn"></button>',
    {
      url: "http://localhost:4197",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  let time = 100;
  const timers = new Map();
  w.setTimeout = (fn, delay) => {
    timers.set(delay, fn);
    return delay;
  };
  w.clearTimeout = () => {};
  w.requestAnimationFrame = () => 1;
  w.cancelAnimationFrame = () => {};
  w.document.hasFocus = () => true;
  w.performance.now = () => time;
  w.performance.mark = () => {};
  w.performance.getEntriesByName = () => [{}];
  w.PerformanceObserver = { supportedEntryTypes: [] };
  try {
    w.eval(
      `(${installChatProbe.toString()})(${JSON.stringify({ turns: [], workload: { durationMs: 12000 }, scenario: "buttons", limit: 100 })})`,
    );
    const api = w.__chatProfile;
    api.start();
    timers.get(3000)();
    time = 120;
    api.state({ atStart: true });
    timers.get(6000)();
    time = 140;
    api.state({ atEnd: true }); // Missing metadata must fail closed.
    time = 160;
    api.state({ atEnd: true }, null, { latestLoaded: false, pending: true });
    time = 180;
    api.state({ atEnd: true }, null, { latestLoaded: true, pending: true });
    time = 200;
    api.state({ atEnd: false }, null, { latestLoaded: true, pending: false });
    time = 220;
    api.state({ atEnd: true }, null, { latestLoaded: true, pending: false });
    const result = api.stop();
    assert.equal(result.navigation[0].reachedAt, 20);
    assert.equal(result.navigation[1].reachedAt, 120);
    assert.equal(result.states.at(-1)[1].latestLoaded, true);
    assert.equal(result.states.at(-1)[1].navigationPending, false);
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

test("navigation distinguishes a smooth request from observed directional movement", () => {
  const r = recording();
  r.navigation = [{ time: 100, direction: "bottom", reached: true }];
  r.scrollWrites = [{ time: 110, behavior: "smooth", top: 1000 }];
  r.frames = [
    [96, 300],
    [112, 290],
    [128, 290],
    [144, 310],
  ];
  let navigation = analyzeChat(r).navigation[0];
  assert.equal(navigation.firstSmoothRequestMs, 10);
  assert.equal(navigation.firstDirectionalMovementMs, 44);
  r.frames[3][1] = 290;
  navigation = analyzeChat(r).navigation[0];
  assert.equal(navigation.firstSmoothRequestMs, 10);
  assert.equal(navigation.firstDirectionalMovementMs, null);
  r.scrollWrites = [];
  assert.equal(analyzeChat(r).navigation[0].firstSmoothRequestMs, null);
});

test("button captures require every destination and bound scroll-write records", () => {
  const r = recording();
  r.scenario = "buttons";
  r.scroll.ends = 4;
  r.navigation = ["top", "bottom", "top", "bottom"].map((direction, i) => ({
    time: i * 100,
    direction,
    reached: true,
  }));
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

test("Chrome slow-window stacks clip boundaries and deduplicate nested events and recursive frames", () => {
  const frame = (functionName) => ({
    functionName,
    url: "app.js",
    lineNumber: 0,
    columnNumber: 0,
  });
  const trace = {
    traceEvents: [
      { name: "chat-profile-start", ph: "R", ts: 10000, pid: 1, tid: 2 },
      { name: "chat-profile-end", ph: "R", ts: 110000, pid: 1, tid: 2 },
      { name: "Task", ph: "X", ts: 5000, dur: 60000, pid: 1, tid: 2 },
      { name: "Nested", ph: "X", ts: 20000, dur: 40000, pid: 1, tid: 2 },
      { name: "Later", ph: "X", ts: 70000, dur: 50000, pid: 1, tid: 2 },
      { name: "Other thread", ph: "X", ts: 10000, dur: 90000, pid: 1, tid: 3 },
    ],
  };
  const cpu = {
    startTime: 0,
    nodes: [
      { id: 1, callFrame: frame("root"), children: [2, 4] },
      { id: 2, callFrame: frame("recursive"), children: [3] },
      { id: 3, callFrame: frame("recursive") },
      { id: 4, callFrame: frame("other") },
    ],
    samples: [3, 3, 4, 3],
    timeDeltas: [20000, 30000, 25000, 45000],
  };
  const windows = analyzeChatChrome(trace, cpu).slowWindows;
  assert.deepEqual(
    windows.map(({ name, startMs, endMs, samples }) => ({
      name,
      startMs,
      endMs,
      samples,
    })),
    [
      { name: "Task", startMs: 0, endMs: 55, samples: 3 },
      { name: "Later", startMs: 60, endMs: 100, samples: 2 },
    ],
  );
  assert.equal(
    windows[0].frames.find((f) => f.functionName === "recursive").inclusiveMs,
    40,
  );
  assert.equal(
    windows[0].frames.find((f) => f.functionName === "recursive").selfMs,
    40,
  );
  assert.equal(
    windows[0].frames.find((f) => f.functionName === "root").inclusiveMs,
    55,
  );
  assert.equal(
    windows[1].frames.find((f) => f.functionName === "other").selfMs,
    5,
  );
  assert.equal(windows[1].maxSampleGapMs, 45);
  assert.equal(analyzeChatChrome(trace).slowWindows[0].frames, null);
});

test("Chrome slow-window stacks include single-frame stalls below 32 ms", () => {
  const trace = {
    traceEvents: [
      { name: "chat-profile-start", ph: "R", ts: 0, pid: 1, tid: 2 },
      { name: "chat-profile-end", ph: "R", ts: 100000, pid: 1, tid: 2 },
      { name: "Update", ph: "X", ts: 0, dur: 24000, pid: 1, tid: 2 },
      { name: "At threshold", ph: "X", ts: 30000, dur: 16000, pid: 1, tid: 2 },
      {
        name: "Below threshold",
        ph: "X",
        ts: 60000,
        dur: 15999,
        pid: 1,
        tid: 2,
      },
    ],
  };
  assert.deepEqual(
    analyzeChatChrome(trace).slowWindows.map(({ name, startMs, endMs }) => ({
      name,
      startMs,
      endMs,
    })),
    [
      { name: "Update", startMs: 0, endMs: 24 },
      { name: "At threshold", startMs: 30, endMs: 46 },
    ],
  );
});

test("Chrome slow-window summaries bound retained windows and stack frames", () => {
  const trace = {
    traceEvents: [
      { name: "chat-profile-start", ph: "R", ts: 0, pid: 1, tid: 2 },
      { name: "chat-profile-end", ph: "R", ts: 1000000, pid: 1, tid: 2 },
      ...Array.from({ length: 10 }, (_, i) => ({
        name: "Task",
        ph: "X",
        ts: i * 100000,
        dur: 40000,
        pid: 1,
        tid: 2,
      })),
    ],
  };
  const cpu = {
    startTime: 0,
    nodes: Array.from({ length: 25 }, (_, id) => ({
      id,
      callFrame: {
        functionName: `frame${id}`,
        url: "app.js",
        lineNumber: id,
        columnNumber: 0,
      },
      children: id < 24 ? [id + 1] : [],
    })),
    samples: [24],
    timeDeltas: [1000000],
  };
  const windows = analyzeChatChrome(trace, cpu).slowWindows;
  assert.equal(windows.length, 8);
  assert.equal(windows[0].frames.length, 20);
  assert.equal(windows[0].omittedFrames, 5);
  assert.equal(windows[0].maxSampleGapMs, 1000);
  assert.equal(windows[0].selfFrames.length, 1);
  assert.equal(windows[0].selfFrames[0].functionName, "frame24");
  assert.equal(windows[0].selfFrames[0].selfMs, 40);
  assert.equal(windows[0].omittedSelfFrames, 0);
});

test("Chrome backward sample timestamps cannot inflate a slow window", () => {
  const trace = {
    traceEvents: [
      { name: "chat-profile-start", ph: "R", ts: 0, pid: 1, tid: 2 },
      { name: "chat-profile-end", ph: "R", ts: 100000, pid: 1, tid: 2 },
      { name: "Task", ph: "X", ts: 0, dur: 50000, pid: 1, tid: 2 },
    ],
  };
  const cpu = {
    startTime: 0,
    nodes: [
      { id: 1, callFrame: { functionName: "first" } },
      { id: 2, callFrame: { functionName: "second" } },
    ],
    samples: [1, 2, 2, 1],
    timeDeltas: [30000, -5000, 20000, 20000],
  };
  const window = analyzeChatChrome(trace, cpu).slowWindows[0];
  assert.equal(window.overlappingSampleMs, 5);
  assert.equal(window.samples, 3);
  assert.equal(
    window.frames.find((f) => f.functionName === "first").selfMs,
    35,
  );
  assert.equal(
    window.frames.find((f) => f.functionName === "second").selfMs,
    15,
  );
  assert.equal(
    window.frames.reduce((sum, f) => sum + f.selfMs, 0),
    50,
  );
});

test("scroll motion summary separates synchronous jumps from native frame progress", () => {
  const summary = summarizeScrollMotion({
    frames: [
      [0, 0, "follow"],
      [16, 0, "follow"],
      [32, 20, "follow"],
      [48, 100, "follow"],
    ],
    scrollWrites: [
      {
        phase: "follow",
        method: "scrollTo",
        behavior: "smooth",
        top: 100,
        beforeTop: 0,
        afterTop: 0,
      },
      {
        phase: "follow",
        method: "scrollTo",
        behavior: "smooth",
        top: 200,
        beforeTop: 100,
        afterTop: 200,
      },
      { phase: "follow", method: "scrollTop", top: 210 },
    ],
  });
  const phase = summary.phases[0];
  assert.equal(phase.smooth, 2);
  assert.equal(phase.instant, 1);
  assert.equal(phase.synchronousSmoothJumps, 1);
  assert.equal(phase.synchronousMovementPx.max, 100);
  assert.equal(phase.observedMovingStepsPx.max, 80);
  assert.equal(phase.stationaryFrames, 1);
  assert.deepEqual(summarizeScrollMotion({ frames: [] }), { available: false });
});
