import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { installIpadScrollProbe } from "./ipad-scroll-probe.mjs";
import { connectWebKit } from "./ipad-scroll-trace.mjs";

class FakeSocket {
  readyState = 1;
  sent = [];
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  receive(message) {
    this.onmessage({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
  }
  target() {
    this.receive({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "page-1" } },
    });
  }
  reply(result) {
    const request = JSON.parse(this.sent.at(-1).params.message);
    this.receive({
      method: "Target.dispatchMessageFromTarget",
      params: { message: JSON.stringify({ id: request.id, result }) },
    });
  }
}

test("bridge distinguishes delivery acknowledgment from nested result", async () => {
  const ws = new FakeSocket();
  const bridge = connectWebKit(ws);
  try {
    ws.target();
    await bridge.ready;
    const result = bridge.evaluate("42");
    ws.receive({ id: ws.sent.at(-1).id, result: {} });
    ws.reply({ result: { value: 42 }, wasThrown: false });
    assert.equal(await result, 42);
  } finally {
    bridge.close();
  }
});

for (const failure of [
  "outer",
  "inner",
  "close",
  "error",
  "malformed",
  "send",
  "timeout",
]) {
  test(`bridge rejects pending calls on ${failure} without hanging`, async () => {
    const ws = new FakeSocket();
    const bridge = connectWebKit(ws, 20);
    try {
      ws.target();
      await bridge.ready;
      if (failure === "send")
        ws.send = () => {
          throw new Error("send failed");
        };
      const result = bridge.command("Runtime.evaluate");
      const rejected = assert.rejects(result);
      if (failure === "outer")
        ws.receive({ id: ws.sent.at(-1).id, error: { message: "No target" } });
      if (failure === "inner") {
        const inner = JSON.parse(ws.sent.at(-1).params.message);
        ws.receive({
          method: "Target.dispatchMessageFromTarget",
          params: {
            message: JSON.stringify({
              id: inner.id,
              error: { message: "No method" },
            }),
          },
        });
      }
      if (failure === "close") {
        ws.readyState = 3;
        ws.onclose();
      }
      if (failure === "error") ws.onerror();
      if (failure === "malformed") ws.onmessage({ data: "{" });
      await rejected;
    } finally {
      bridge.close();
    }
  });
}

test("bridge rejects readiness when connection fails", async () => {
  const ws = new FakeSocket();
  const bridge = connectWebKit(ws);
  const rejected = assert.rejects(bridge.ready, /connection failed/);
  ws.onerror();
  await rejected;
  bridge.close();
});

test("bridge ignores responses from a different target", async () => {
  const ws = new FakeSocket();
  const bridge = connectWebKit(ws);
  try {
    ws.target();
    await bridge.ready;
    const result = bridge.evaluate("42");
    const inner = JSON.parse(ws.sent.at(-1).params.message);
    ws.receive({
      method: "Target.dispatchMessageFromTarget",
      params: {
        targetId: "other-page",
        message: JSON.stringify({
          id: inner.id,
          result: { result: { value: 99 } },
        }),
      },
    });
    ws.reply({ result: { value: 42 } });
    assert.equal(await result, 42);
  } finally {
    bridge.close();
  }
});

test("closing the inspected target rejects all pending calls", async () => {
  const ws = new FakeSocket();
  const bridge = connectWebKit(ws);
  try {
    ws.target();
    await bridge.ready;
    const first = assert.rejects(bridge.command("first"), /page closed/);
    const second = assert.rejects(bridge.command("second"), /page closed/);
    ws.receive({
      method: "Target.targetDestroyed",
      params: { targetId: "page-1" },
    });
    await Promise.all([first, second]);
    await assert.rejects(bridge.command("late"), /page closed/);
  } finally {
    bridge.close();
  }
});

test("evaluation exceptions are not successful captures", async () => {
  const ws = new FakeSocket();
  const bridge = connectWebKit(ws);
  try {
    ws.target();
    await bridge.ready;
    const result = bridge.evaluate("throw new Error()");
    const rejected = assert.rejects(result, /evaluation failed/);
    ws.reply({ wasThrown: true, result: {} });
    await rejected;
  } finally {
    bridge.close();
  }
});

function page({ failObserver = false, ownAccessor = false } = {}) {
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 0;
  let observerActive = false;
  class Target {
    addEventListener(type, listener) {
      listeners.add({ target: this, type, listener });
    }
    removeEventListener(type, listener) {
      for (const entry of listeners)
        if (
          entry.target === this &&
          entry.type === type &&
          entry.listener === listener
        )
          listeners.delete(entry);
    }
    emit(type) {
      for (const entry of [...listeners])
        if (entry.target === this && entry.type === type)
          entry.listener({ type, target: this });
    }
  }
  class Element extends Target {
    position = 250;
    style = { overflowY: "auto" };
    get scrollTop() {
      return this.position;
    }
    set scrollTop(value) {
      this.position = value;
    }
    closest() {
      return null;
    }
    contains(target) {
      return target === this;
    }
  }
  const vp = new Element();
  if (ownAccessor)
    Object.defineProperty(vp, "scrollTop", { configurable: true, value: 250 });
  const document = new Target();
  document.getElementById = (id) => (id === "viewport" ? vp : new Element());
  const window = new Target();
  const context = {
    window,
    document,
    Element,
    Node: Element,
    location: { pathname: "/demos/streaming/index.html" },
    navigator: { userAgent: "Test browser" },
    innerWidth: 1180,
    innerHeight: 734,
    devicePixelRatio: 2,
    getComputedStyle: () => ({ touchAction: "auto" }),
    performance: { now: () => 10 },
    setTimeout: (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    MutationObserver: class {
      observe() {
        observerActive = true;
        if (failObserver) throw new Error("Observe failed");
      }
      disconnect() {
        observerActive = false;
      }
    },
  };
  return {
    context,
    vp,
    window,
    document,
    timers,
    listeners,
    observing: () => observerActive,
    install: () =>
      runInNewContext(
        `(${installIpadScrollProbe.toString()})("owned")`,
        context,
      ),
  };
}

test("probe retains viewport metadata and restores hooks on dispose", () => {
  const p = page();
  p.install();
  const probe = p.window.__pencilTrace;
  p.vp.scrollTop = 123;
  p.vp.emit("scroll");
  p.document.emit("click"); // Non-Element targets must not throw.
  const data = JSON.parse(JSON.stringify(probe.snapshot()));
  assert.deepEqual(data.size, [1180, 734, 2]);
  assert.equal(data.touchAction, "auto");
  assert.equal(data.browser, "Test browser");
  assert.deepEqual(data.records.slice(1, 3), [
    [0, "write", 123],
    [0, "scroll", 123],
  ]);
  assert.equal(data.records.at(-1)[2], "outside");
  probe.dispose();
  probe.dispose();
  assert.equal(Object.hasOwn(p.vp, "scrollTop"), false);
  assert.equal(p.vp.scrollTop, 123);
  assert.equal(p.listeners.size, 0);
  assert.equal(p.timers.size, 0);
  assert.equal(p.observing(), false);
  assert.equal(p.window.__pencilTrace, undefined);
});

test("failed probe installation rolls back listeners and accessors", () => {
  const p = page({ failObserver: true });
  assert.throws(p.install, /Observe failed/);
  assert.equal(p.listeners.size, 0);
  assert.equal(p.timers.size, 0);
  assert.equal(p.observing(), false);
  assert.equal(Object.hasOwn(p.vp, "scrollTop"), false);
});

test("probe refuses to bypass an existing scrollTop accessor", () => {
  const p = page({ ownAccessor: true });
  assert.throws(p.install, /already instrumented/);
  assert.equal(p.listeners.size, 0);
  assert.equal(p.vp.scrollTop, 250);
});

for (const reason of ["lease expired", "pagehide"]) {
  test(`probe removes hooks after ${reason}`, () => {
    const p = page();
    p.install();
    if (reason === "lease expired") [...p.timers.values()][0]();
    else p.window.emit("pagehide");
    assert.equal(p.listeners.size, 0);
    assert.equal(p.timers.size, 0);
    assert.equal(Object.hasOwn(p.vp, "scrollTop"), false);
  });
}

test("probe cleanup preserves a newer accessor and probe owner", () => {
  const p = page();
  p.install();
  const probe = p.window.__pencilTrace;
  const get = () => 900;
  Object.defineProperty(p.vp, "scrollTop", { configurable: true, get });
  const newer = { id: "newer" };
  p.window.__pencilTrace = newer;
  probe.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(p.vp, "scrollTop").get, get);
  assert.equal(p.window.__pencilTrace, newer);
});

test("probe bounds records and renews only one cleanup lease", () => {
  const p = page();
  p.install();
  const probe = p.window.__pencilTrace;
  for (let i = 0; i < 20001; i++) probe.record("write", i);
  const data = probe.snapshot();
  assert.equal(data.records.length, 20000);
  assert.equal(data.dropped, 2);
  for (let i = 0; i < 10; i++) probe.snapshot();
  assert.equal(p.timers.size, 1);
  probe.dispose();
});

test("help needs no device and creates no capture", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./ipad-scroll-trace.mjs", import.meta.url).pathname, "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});
