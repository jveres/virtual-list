import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { JSDOM } from "jsdom";
import { analyzeChat } from "./chat-analysis.mjs";
import { installChatProbe } from "./chat-probe.mjs";
import { createChatProfileServer } from "./chat-server.mjs";
import {
  fastSteadyScrollPlan,
  scrollPlan,
  steadyScrollArguments,
  steadyScrollPlan,
  steadyScrollSetup,
} from "./steady-scroll.mjs";

test("steady speed rejects unsupported plans and non-steady CLI scenarios", () => {
  assert.equal(scrollPlan("normal"), steadyScrollPlan);
  assert.equal(scrollPlan("fast"), fastSteadyScrollPlan);
  assert.throws(() => scrollPlan("faster"), /Invalid steady scroll speed/);
  for (const [args, expected] of [
    [["--scenario=steady", "--steady-speed=NaN"], /Invalid --steady-speed/],
    ...["follow", "scrollback", "manual", "buttons"].map((scenario) => [
      [`--scenario=${scenario}`, "--steady-speed=fast"],
      /--steady-speed requires --scenario=steady/,
    ]),
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL("../profile-chat.mjs", import.meta.url).pathname, ...args],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, "");
  }
});

test("pointer control validates values and rejects captures without scripted Firefox input", () => {
  const cases = [
    ...["NaN", "Infinity", "0", "1", "-0.1"].map((value) => [
      ["--scenario=steady", `--pointer-x=${value}`],
      /Invalid --pointer-x/,
    ]),
    ...["chrome", "safari", "engine-firefox"].map((browser) => [
      ["--scenario=scrollback", `--browser=${browser}`, "--pointer-x=0.02"],
      /requires installed Firefox scrollback or steady/,
    ]),
    ...["follow", "buttons", "manual"].map((scenario) => [
      [`--scenario=${scenario}`, "--pointer-x=0.02"],
      /requires installed Firefox scrollback or steady/,
    ]),
    // Valid fractions reach the next validation without starting a browser.
    ...["0.01", "0.02", "0.5", "0.99"].map((value) => [
      ["--scenario=steady", "--history=19", `--pointer-x=${value}`],
      /requires --history=20/,
    ]),
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync(
      process.execPath,
      [new URL("../profile-chat.mjs", import.meta.url).pathname, ...args],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, "");
  }
});

test("native pointer control rejects manual and idle captures before creating artifacts", {
  skip: process.platform !== "darwin",
}, () => {
  for (const capture of ["--manual-seconds=5", "--idle-seconds=5"]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL("../firefox-profile.mjs", import.meta.url).pathname,
        capture,
        "--pointer-x=0.02",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--pointer-x requires scripted gestures/);
    assert.equal(result.stdout, "");
  }
});

test("steady CLI rejects other browsers and partial histories before launch", () => {
  for (const [argument, message] of [
    ["--browser=safari", /requires --browser=firefox or chrome/],
    ["--browser=engine-firefox", /requires --browser=firefox or chrome/],
    ["--history=19", /requires --history=20/],
    ["--history=21", /requires --history=20/],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL("../profile-chat.mjs", import.meta.url).pathname,
        "--scenario=steady",
        argument,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
  }
  const chrome = spawnSync(
    process.execPath,
    [
      new URL("../profile-chat.mjs", import.meta.url).pathname,
      "--scenario=steady",
      "--browser=chrome",
      "--history=19",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(chrome.status, 1);
  assert.match(chrome.stderr, /requires --history=20/);
  assert.equal(chrome.stdout, "");
});

test("steady server defaults to the whole 20-turn history", async () => {
  const server = await createChatProfileServer({ scenario: "steady" });
  try {
    assert.equal(server.workload.history, 20);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
  await assert.rejects(
    createChatProfileServer({ scenario: "steady", history: 21 }),
    /whole 20-turn history/,
  );
});

test("steady setup replays the interior position and never submits a reply", () => {
  const dom = new JSDOM(
    '<div id="viewport"></div><span id="window-status">loaded 1-20/20 · load none</span><textarea id="prompt"></textarea><button id="send-btn"></button>',
    {
      url: "http://localhost:4197",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.document.hasFocus = () => true;
  let callback;
  w.requestAnimationFrame = (fn) => {
    callback = fn;
    return 1;
  };
  w.cancelAnimationFrame = () => {};
  let time = 100;
  w.performance.now = () => time;
  w.performance.mark = () => {};
  w.performance.getEntriesByName = () => [{}];
  w.PerformanceObserver = { supportedEntryTypes: [] };
  const viewport = w.document.querySelector("#viewport");
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 10800 },
  });
  try {
    w.eval(
      `(${installChatProbe.toString()})(${JSON.stringify({ turns: [], workload: { history: 20, characters: 10, chunks: 1 }, diagnostic: false, limit: 20, scenario: "steady", trail: "off" })})`,
    );
    const api = w.__chatProfile;
    assert.throws(() => api.start(), /requires setup/);
    const setup = w.eval(steadyScrollSetup());
    assert.equal(setup.top, 2840);
    assert.equal(viewport.scrollTop, 2840);
    assert.equal(setup.maximum - setup.top - setup.plan.oneWayPx, setup.top);
    assert.deepEqual(steadyScrollArguments("saved-setup.js"), [
      "--setup=saved-setup.js",
      "--down=3",
      "--up=3",
      "--ticks=90",
      "--delta=16",
      "--interval-ms=16.667",
      "--settle-ms=700",
    ]);
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 5000,
    });
    assert.throws(() => w.eval(steadyScrollSetup()), /interior scroll space/);
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 10800,
    });
    w.document.querySelector("#window-status").textContent =
      "loaded 2-20/20 · load top";
    assert.throws(() => w.eval(steadyScrollSetup()), /whole history loaded/);
    w.document.querySelector("#window-status").textContent = setup.status;
    assert.throws(() => api.start({ submit: true }), /no submission/);
    let sends = 0;
    w.document
      .querySelector("#send-btn")
      .addEventListener("click", () => sends++);
    w.__runtimeAudit.start();
    // A forbidden read here would catch geometry in the frame sampler.
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get() {
        throw new Error("sampler geometry read");
      },
    });
    time += 16;
    callback(time);
    const skipped = new w.Event("contentvisibilityautostatechange");
    Object.defineProperty(skipped, "skipped", { value: true });
    viewport.dispatchEvent(skipped);
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 800,
    });
    const result = w.__runtimeAudit.stop();
    assert.equal(sends, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(result.stream)), {
      done: false,
      characters: 0,
      chunks: 0,
      events: 0,
    });
    assert.equal(result.deliveries.length, 0);
    assert.equal(result.frames[0][10], false);
    assert.equal(result.steady.plan.oneWayPx, 4320);
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.steady.visibilityChanges)),
      [[116, true]],
    );
  } finally {
    w.close();
  }
});

function steadyRecording() {
  const state = (start = 1) => ({
    count: 21,
    start,
    end: start + 4,
    held: false,
    totalSize: 10800,
    loadedStart: 0,
    loadedEnd: 20,
    loading: false,
    latestLoaded: true,
    navigationPending: false,
  });
  const boundary = () => ({
    top: 2840,
    scrollHeight: 10800,
    height: 800,
    window: {},
    status: "loaded 1-20/20 · load none",
    state: state(),
  });
  return {
    schema: 1,
    probeVersion: 6,
    durationMs: 15000,
    startTime: 100,
    mode: "timing",
    scenario: "steady",
    userAgent: "test",
    workload: { hash: "steady", history: 20, characters: 100, chunks: 10 },
    steady: { plan: steadyScrollPlan, responseRequests: 0 },
    initial: boundary(),
    final: boundary(),
    frames: Array.from({ length: 241 }, (_, i) => [
      i * 50,
      2840 + Math.min(i, 240 - i) * 36,
      "steady",
      0,
      i,
      false,
      21,
      10800,
      false,
      null,
      false,
    ]),
    states: Array.from({ length: 13 }, (_, i) => [
      i * 1000,
      state(1 + Math.min(i, 12 - i)),
    ]),
    inputs: [],
    spans: [],
    operations: [],
    access: [],
    entries: [],
    deliveries: [],
    errors: [],
    invalidations: [],
    dropped: {},
    capabilities: {},
    stream: { done: false, characters: 0, chunks: 0, events: 0 },
    scroll: { wheels: 540, ends: 6 },
    mutations: null,
  };
}

test("steady analysis accepts real churn without requiring a fabricated stream", () => {
  const summary = analyzeChat(steadyRecording(), { native: true });
  assert.equal(summary.valid, true, summary.invalidReasons.join("; "));
  assert.equal(summary.stream.done, false);
  assert.equal(summary.frames.streamingMs.count, 0);
  assert.equal(summary.steady.downPx, 4320);
  assert.equal(summary.steady.upPx, 4320);
  assert.equal(summary.steady.rangeChanges, 12);
  assert.equal(summary.steady.mounts, null);
});

test("fast input covers the same band and analysis enforces its lower input count", () => {
  for (const plan of [steadyScrollPlan, fastSteadyScrollPlan]) {
    assert.equal(plan.down * plan.ticks * plan.delta, 4320);
    assert.equal(plan.up * plan.ticks * plan.delta, 4320);
  }
  const args = steadyScrollArguments("setup.js", "fast");
  assert.ok(args.includes("--ticks=30"));
  assert.ok(args.includes("--delta=48"));
  const recording = steadyRecording();
  recording.steady.plan = fastSteadyScrollPlan;
  recording.scroll.wheels = 135;
  assert.equal(analyzeChat(recording, { native: true }).valid, true);
  recording.scroll.wheels = 134;
  assert.equal(analyzeChat(recording, { native: true }).valid, false);
  recording.scroll.wheels = 180;
  recording.steady.plan = { ...fastSteadyScrollPlan, ticks: 31 };
  const summary = analyzeChat(recording, { native: true });
  assert.equal(summary.valid, false);
  assert.ok(
    summary.invalidReasons.includes(
      "Steady scroll must use a supported native input plan",
    ),
  );
});

test("steady analysis rejects size changes and counts only measured browser skipping", () => {
  const recording = steadyRecording();
  assert.deepEqual(analyzeChat(recording).steady.browserSkipping, {
    available: false,
    skipped: null,
    rendered: null,
    eventLimitReached: null,
  });
  recording.steady.visibilityChanges = [
    [99, true],
    [100, true],
    [1000, false],
    [15100, true],
    [15101, false],
  ];
  const summary = analyzeChat(recording, { native: true });
  assert.deepEqual(summary.steady.browserSkipping, {
    available: true,
    skipped: 2,
    rendered: 1,
    eventLimitReached: false,
  });
  const capped = structuredClone(recording);
  capped.steady.visibilityChanges = Array.from({ length: 1000 }, () => [
    1000,
    true,
  ]);
  const cappedSummary = analyzeChat(capped, { native: true });
  assert.equal(cappedSummary.valid, false);
  assert.equal(cappedSummary.steady.browserSkipping.eventLimitReached, true);
  assert.ok(
    cappedSummary.invalidReasons.includes(
      "Steady browser-skipping telemetry reached its event limit",
    ),
  );
  for (const change of [
    (r) => {
      r.states[2][1].totalSize += 1;
    },
    (r) => {
      r.frames[4][7] += 1;
    },
    (r) => {
      r.final.height += 1;
    },
    (r) => {
      r.final.scrollHeight += 1;
    },
  ]) {
    const invalid = structuredClone(recording);
    change(invalid);
    const result = analyzeChat(invalid, { native: true });
    assert.equal(result.valid, false);
    assert.ok(
      result.invalidReasons.includes(
        "Steady scroll geometry changed during the loaded-history run",
      ),
    );
  }
});

test("steady image history requires decoded images at both boundaries regardless of URL representation", () => {
  const recording = steadyRecording();
  recording.workload.historyContent = "images";
  recording.workload.historyImageSize = { width: 960, height: 360 };
  recording.initial.images = [
    { complete: true, width: 960, height: 360, sourceKind: "data" },
  ];
  recording.final.images = [
    { complete: true, width: 960, height: 360, sourceKind: "blob" },
  ];
  const summary = analyzeChat(recording, { native: true });
  assert.equal(summary.valid, true, summary.invalidReasons.join("; "));
  assert.deepEqual(summary.steady.imageBoundaries, [
    { mounted: 1, decoded: 1 },
    { mounted: 1, decoded: 1 },
  ]);
  assert.match(summary.steady.imageReadinessLimit, /natural dimensions only/);
  assert.match(summary.steady.imageReadinessLimit, /GPU readiness/);
  for (const boundary of ["initial", "final"]) {
    for (const images of [
      [],
      [{ complete: false, width: 960, height: 360 }],
      [{ complete: true, width: 0, height: 0 }],
      [{ complete: true, width: 1, height: 1 }],
      [
        { complete: true, width: 960, height: 360 },
        { complete: false, width: 960, height: 360 },
      ],
      [
        { complete: true, width: 960, height: 360 },
        { complete: true, width: 0, height: 0 },
      ],
      [
        { complete: true, width: 960, height: 360 },
        { complete: true, width: 1, height: 1 },
      ],
    ]) {
      const invalid = structuredClone(recording);
      invalid[boundary].images = images;
      const result = analyzeChat(invalid, { native: true });
      assert.equal(result.valid, false);
      assert.ok(
        result.invalidReasons.includes(
          "Steady image history needs decoded mounted images at both boundaries",
        ),
      );
    }
  }
});

test("steady analysis requires the planned input coverage and all six scroll ends", () => {
  for (const [wheels, ends, valid] of [
    [404, 6, false],
    [405, 6, true],
    [537, 6, true],
    [538, 6, true],
    [540, 5, false],
    [540, 6, true],
    [undefined, 6, false],
    [540, undefined, false],
  ]) {
    const recording = steadyRecording();
    recording.scroll = { wheels, ends };

    const summary = analyzeChat(recording, { native: true });

    assert.equal(summary.valid, valid, `${wheels} wheels, ${ends} scroll ends`);
    assert.equal(
      summary.invalidReasons.includes(
        "Steady scroll needs at least 405 wheel events and 6 scroll-end events",
      ),
      !valid,
    );
  }
});

test("steady analysis rejects streaming, transient paging, stale setup, and weak churn", () => {
  for (const change of [
    (r) => {
      r.steady.responseRequests = 1;
    },
    (r) => {
      delete r.steady.responseRequests;
    },
    (r) => {
      r.deliveries.push([1, "response.completed", 0]);
    },
    (r) => {
      r.stream.characters = 1;
    },
    (r) => {
      r.stream.done = true;
    },
    (r) => {
      r.states[2][1].loading = true;
    },
    (r) => {
      r.states[2][1].loadedStart = 1;
    },
    (r) => {
      r.states[2][1].count = 22;
    },
    (r) => {
      r.states[2][1].held = true;
    },
    (r) => {
      r.frames[4][8] = true;
    },
    (r) => {
      r.final.status = "loaded 2-20/20 · load top";
    },
    (r) => {
      r.frames.forEach((frame) => {
        frame[1] = 2840;
      });
    },
    (r) => {
      r.states.forEach((entry) => {
        entry[1].start = 1;
        entry[1].end = 5;
      });
    },
    (r) => {
      r.initial.top = 799;
    },
    (r) => {
      r.frames[4][1] = 0;
    },
    (r) => {
      r.mode = "diagnostic";
    },
  ]) {
    const recording = steadyRecording();
    change(recording);
    assert.equal(analyzeChat(recording).valid, false, change.toString());
  }
  const recording = steadyRecording();
  recording.mode = "diagnostic";
  recording.operations = ["mountRow", "unmountRow"].map((name) => ({
    name: `src/virtual-list.ts:${name}`,
    count: 4,
    selfMs: 1,
  }));
  assert.equal(analyzeChat(recording).valid, true);
});
