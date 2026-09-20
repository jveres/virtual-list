// Read device event evidence through an already-running local ios_webkit_debug_proxy.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

const endpoint = new URL(
  process.argv[2] ?? "ws://127.0.0.1:9232/devtools/page/3",
);
if (
  endpoint.protocol !== "ws:" ||
  !["127.0.0.1", "localhost"].includes(endpoint.hostname)
)
  throw new Error("Expected a local WebKit debugging bridge");
await mkdir("browser-artifacts/ipad-scroll", { recursive: true });
const dir = await mkdtemp("browser-artifacts/ipad-scroll/run-");
const ws = new WebSocket(endpoint);
const pending = new Map();
let sequence = 0;
let target;
let stopping = false;
let installed = false;
let last = 0;
let resolveTarget;
const scripts = [];
const breakpoints = [];
const ready = new Promise((resolve) => {
  resolveTarget = resolve;
});
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Target.targetCreated") {
    target = message.params.targetInfo.targetId;
    resolveTarget();
  }
  const response =
    message.method === "Target.dispatchMessageFromTarget"
      ? JSON.parse(message.params.message)
      : message;
  if (response.method === "Debugger.scriptParsed")
    scripts.push(response.params);
  const command = pending.get(response.id);
  if (!command) return;
  pending.delete(response.id);
  clearTimeout(command.timer);
  if (response.error) command.reject(new Error(JSON.stringify(response.error)));
  else command.resolve(response.result);
};
const command = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Device evaluation timed out"));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
    ws.send(
      JSON.stringify({
        id: ++sequence,
        method: "Target.sendMessageToTarget",
        params: {
          targetId: target,
          message: JSON.stringify({ id, method, params }),
        },
      }),
    );
  });
const evaluate = (expression) =>
  command("Runtime.evaluate", { expression, returnByValue: true });
function install() {
  const vp = document.getElementById("viewport");
  if (!vp || !location.pathname.startsWith("/demos/streaming"))
    throw new Error("Not the streaming demo");
  if (window.__pencilTrace)
    throw new Error("A device trace is already installed");
  const records = [];
  const start = performance.now();
  let dropped = 0;
  const record = (type, ...values) => {
    if (records.length >= 20000) {
      dropped++;
      return;
    }
    records.push([performance.now() - start, type, ...values]);
  };
  const input = (e) =>
    record(
      e.type,
      e.target.closest?.("#scroll-top-btn")
        ? "top"
        : e.target.closest?.("#scroll-bottom-btn")
          ? "bottom"
          : vp.contains(e.target)
            ? "viewport"
            : "outside",
      e.pointerType ?? null,
      e.pointerId ?? null,
      e.detail ?? null,
      e.isTrusted,
    );
  const types = [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "click",
    "dblclick",
    "touchstart",
    "touchend",
    "touchcancel",
  ];
  for (const type of types)
    document.addEventListener(type, input, { capture: true, passive: true });
  const scroll = () => record("scroll", vp.scrollTop);
  vp.addEventListener("scroll", scroll, { passive: true });
  const own = Object.getOwnPropertyDescriptor(vp, "scrollTop");
  const accessor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  Object.defineProperty(vp, "scrollTop", {
    configurable: true,
    get: () => accessor.get.call(vp),
    set: (value) => {
      record("write", value);
      accessor.set.call(vp, value);
    },
  });
  const observer = new MutationObserver((entries) => {
    for (const e of entries)
      record(
        "overflow",
        e.oldValue?.match(/(?:^|;)\s*overflow-y:\s*([^;]+)/)?.[1] ?? "",
        vp.style.overflowY,
      );
  });
  observer.observe(vp, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["style"],
  });
  const resized = () =>
    record("viewport", innerWidth, innerHeight, visualViewport?.scale ?? 1);
  visualViewport?.addEventListener("resize", resized);
  resized();
  window.__pencilTrace = {
    record,
    snapshot: () => ({ browser: navigator.userAgent, records, dropped }),
    dispose: () => {
      for (const type of types) document.removeEventListener(type, input, true);
      vp.removeEventListener("scroll", scroll);
      visualViewport?.removeEventListener("resize", resized);
      observer.disconnect();
      if (own) Object.defineProperty(vp, "scrollTop", own);
      else Reflect.deleteProperty(vp, "scrollTop");
      delete window.__pencilTrace;
    },
  };
  return {
    path: location.pathname,
    size: [innerWidth, innerHeight, devicePixelRatio],
    top: vp.scrollTop,
    touchAction: getComputedStyle(document.getElementById("scroll-top-btn"))
      .touchAction,
  };
}
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});
try {
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("No device target")), 8000),
    ),
  ]);
  const result = await evaluate(`(${install.toString()})()`);
  if (result.wasThrown) throw new Error(JSON.stringify(result));
  installed = true;
  if (process.argv.includes("--state")) {
    await command("Debugger.enable", {});
    for (const script of scripts) {
      const path = new URL(script.url || "about:blank", "http://localhost")
        .pathname;
      if (!["/src/virtual-list.ts", "/src/scroll-settle.ts"].includes(path))
        continue;
      const { scriptSource } = await command("Debugger.getScriptSource", {
        scriptId: script.scriptId,
      });
      const lines = scriptSource.split("\n");
      const probes = path.endsWith("virtual-list.ts")
        ? [
            [
              "function interruptNativeScroll(",
              'window.__pencilTrace?.record("takeover",controller.isScrollPhaseActive(),reason,viewport.scrollTop)',
            ],
          ]
        : [
            [
              "function finishScrollPhase(",
              'window.__pencilTrace?.record("settle",scrollPhaseActive,scrollPhaseMoved,performance.now()-lastScrollSampleAt,viewport.scrollTop)',
            ],
          ];
      for (const [needle, data] of probes) {
        const line = lines.findIndex((value) => value.includes(needle));
        if (line < 0) throw new Error(`Missing state probe: ${needle}`);
        const result = await command("Debugger.setBreakpoint", {
          location: { scriptId: script.scriptId, lineNumber: line + 1 },
          options: {
            autoContinue: true,
            actions: [{ type: "evaluate", data }],
          },
        });
        breakpoints.push(result.breakpointId);
      }
    }
    if (breakpoints.length !== 2)
      throw new Error("Expected both runtime state probes");
    await command("Debugger.setBreakpointsActive", { active: true });
  }
  console.log("RECORDING READY", dir, JSON.stringify(result));
  const until = Date.now() + 180000;
  while (!stopping && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await evaluate("window.__pencilTrace?.snapshot()");
    if (result.wasThrown || !result.result?.value)
      throw new Error("Device trace disappeared");
    const data = result.result.value;
    await writeFile(`${dir}/trace.json`, JSON.stringify(data));
    const fresh = data.records.slice(last);
    last = data.records.length;
    if (fresh.length)
      console.log(
        JSON.stringify({
          events: fresh.filter((r) => !["write", "scroll"].includes(r[1])),
          writes: fresh.filter((r) => r[1] === "write").length,
          scrolls: fresh.filter((r) => r[1] === "scroll").length,
          dropped: data.dropped,
        }),
      );
  }
} finally {
  for (const breakpointId of breakpoints)
    await command("Debugger.removeBreakpoint", { breakpointId }).catch(
      (error) => console.error("Breakpoint cleanup:", error.message),
    );
  if (breakpoints.length)
    await command("Debugger.setBreakpointsActive", { active: false }).catch(
      (error) => console.error("Debugger cleanup:", error.message),
    );
  if (installed)
    await evaluate("window.__pencilTrace?.dispose()").catch((error) =>
      console.error("Trace cleanup:", error.message),
    );
  ws.close();
  for (const { timer } of pending.values()) clearTimeout(timer);
  console.log("Trace stopped:", dir);
}
