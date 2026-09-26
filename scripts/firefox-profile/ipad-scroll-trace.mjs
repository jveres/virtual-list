// Requires an already-running local ios_webkit_debug_proxy and no other debugger.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeReproduction } from "./artifacts.mjs";
import { installIpadScrollProbe } from "./ipad-scroll-probe.mjs";

/** Keep page transitions and aggregate motion, without retaining frame traces. */
export function summarizeIpadScroll(data) {
  const { records, ...metadata } = data;
  const counts = {};
  const transitions = [];
  let lastTop = data.top;
  let minTop = lastTop;
  let maxTop = lastTop;
  let travel = 0;
  let lastWrite;
  let comparedWrites = 0;
  let maxWriteError = 0;
  let trustedTouchStarts = 0;
  for (const record of records) {
    const [time, type, value] = record;
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === "touchstart" && record[6] === true) trustedTouchStarts++;
    if (type === "write") lastWrite = { time, top: value };
    if (type === "scroll") {
      minTop = Math.min(minTop, value);
      maxTop = Math.max(maxTop, value);
      travel += Math.abs(value - lastTop);
      lastTop = value;
      if (lastWrite && time - lastWrite.time <= 100) {
        comparedWrites++;
        maxWriteError = Math.max(
          maxWriteError,
          Math.abs(value - lastWrite.top),
        );
      }
    }
    if (
      [
        "paging",
        "window",
        "settle",
        "takeover",
        "viewport",
        "touchstart",
        "touchend",
        "touchcancel",
        "scrollend",
      ].includes(type)
    )
      transitions.push(record);
  }
  return {
    ...metadata,
    counts,
    trustedTouchStarts,
    motion: { minTop, maxTop, lastTop, travel },
    writes: {
      comparedScrolls: comparedWrites,
      maxErrorWithin100ms: maxWriteError,
    },
    transitions: transitions.slice(-200),
    omittedTransitions: Math.max(0, transitions.length - 200),
  };
}

/** Route both bridge-level failures and nested WebKit responses. */
export function connectWebKit(ws, timeoutMs = 8000) {
  const pending = new Map();
  const scripts = [];
  let sequence = 0;
  let target;
  let failure;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finish = (entry, error, result) => {
    clearTimeout(entry.timer);
    pending.delete(entry.inner);
    pending.delete(entry.outer);
    if (error) entry.reject(error);
    else entry.resolve(result);
  };
  const fail = (error) => {
    failure ??= error;
    clearTimeout(readyTimer);
    rejectReady(failure);
    for (const entry of new Set(pending.values())) finish(entry, failure);
  };
  const readyTimer = setTimeout(
    () => fail(new Error("No device target")),
    timeoutMs,
  );
  ws.onclose = () => fail(new Error("Device bridge closed"));
  ws.onerror = () => fail(new Error("Device bridge connection failed"));
  ws.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (message.method === "Target.targetCreated" && !target) {
        target = message.params.targetInfo.targetId;
        clearTimeout(readyTimer);
        resolveReady();
      }
      if (
        message.method === "Target.targetDestroyed" &&
        message.params.targetId === target
      ) {
        fail(new Error("Inspected page closed"));
        return;
      }
      if (
        message.method === "Target.dispatchMessageFromTarget" &&
        message.params.targetId !== undefined &&
        message.params.targetId !== target
      )
        return;
      const response =
        message.method === "Target.dispatchMessageFromTarget"
          ? JSON.parse(message.params.message)
          : message;
      if (response.method === "Debugger.scriptParsed")
        scripts.push(response.params);
      const entry = pending.get(response.id);
      if (!entry) return;
      if (response.error)
        finish(entry, new Error(JSON.stringify(response.error)));
      else if (response.id === entry.inner)
        finish(entry, null, response.result);
      // A successful outer response only acknowledges bridge delivery.
    } catch (error) {
      fail(error);
    }
  };
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (failure || !target || ws.readyState !== 1) {
        reject(failure ?? new Error("Device bridge is not ready"));
        return;
      }
      const entry = {
        inner: ++sequence,
        outer: ++sequence,
        resolve,
        reject,
        timer: undefined,
      };
      entry.timer = setTimeout(
        () => finish(entry, new Error(`Device command timed out: ${method}`)),
        timeoutMs,
      );
      pending.set(entry.inner, entry);
      pending.set(entry.outer, entry);
      try {
        ws.send(
          JSON.stringify({
            id: entry.outer,
            method: "Target.sendMessageToTarget",
            params: {
              targetId: target,
              message: JSON.stringify({ id: entry.inner, method, params }),
            },
          }),
        );
      } catch (error) {
        finish(entry, error);
      }
    });
  return {
    ready,
    scripts,
    command,
    evaluate: async (expression) => {
      const result = await command("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (result.wasThrown) throw new Error("Device evaluation failed");
      return result.result?.value;
    },
    close: () => {
      fail(new Error("Device bridge disposed"));
      ws.close();
    },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      state: { type: "boolean" },
      seconds: { type: "string", default: "180" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/firefox-profile/ipad-scroll-trace.mjs ws://127.0.0.1:PORT/devtools/page/ID [--state] [--seconds 180]\nConnect to an existing local iOS bridge. Close other debugger sessions first.\nCapture defaults to three minutes (maximum 30); Ctrl-C stops early. No message contents are recorded.",
    );
    return;
  }
  const seconds = Number(values.seconds);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800)
    throw new Error("seconds must be an integer from 1 to 1800");
  if (positionals.length !== 1) throw new Error("Expected one bridge endpoint");
  const endpoint = new URL(positionals[0]);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname)
  )
    throw new Error("Expected a local WebKit debugging bridge");
  await mkdir("browser-artifacts/ipad-scroll", { recursive: true });
  const dir = await mkdtemp("browser-artifacts/ipad-scroll/run-");
  await writeReproduction(dir, {
    command: [
      "node",
      "scripts/firefox-profile/ipad-scroll-trace.mjs",
      endpoint.href,
      ...(values.state ? ["--state"] : []),
      "--seconds",
      String(seconds),
    ],
  });
  const session = connectWebKit(new WebSocket(endpoint));
  const { command, evaluate } = session;
  const id = randomUUID();
  const ownedProbe = `(window.__pencilTrace?.id === ${JSON.stringify(id)} ? window.__pencilTrace : undefined)`;
  const breakpoints = [];
  const cleanupErrors = [];
  let stopping = false;
  let installing = false;
  let last = 0;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const cleanup = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    await session.ready;
    if (stopping) return;
    // Attempt cleanup even if installation succeeds remotely but its reply is lost.
    installing = true;
    const metadata = await evaluate(
      `(${installIpadScrollProbe.toString()})(${JSON.stringify(id)})`,
    );
    if (values.state) {
      await command("Debugger.enable");
      for (const script of session.scripts) {
        const path = new URL(script.url || "about:blank", "http://localhost")
          .pathname;
        if (!["/src/virtual-list.ts", "/src/scroll-settle.ts"].includes(path))
          continue;
        const { scriptSource } = await command("Debugger.getScriptSource", {
          scriptId: script.scriptId,
        });
        const probes = path.endsWith("virtual-list.ts")
          ? [
              [
                "function interruptNativeScroll(",
                '"takeover",controller.isScrollPhaseActive(),reason,viewport.scrollTop',
              ],
              [
                "const finish = (applied, error",
                '"window",applied,cancelRequested,signal?.aborted ?? false,job?.width ?? null,viewportWidth,job?.structure ?? null,structure,viewport.scrollTop',
              ],
            ]
          : [
              [
                "function finishScrollPhase(",
                '"settle",scrollPhaseActive,scrollPhaseMoved,performance.now()-lastScrollSampleAt,viewport.scrollTop',
              ],
            ];
        for (const [needle, args] of probes) {
          const line = scriptSource
            .split("\n")
            .findIndex((value) => value.includes(needle));
          if (line < 0) throw new Error(`Missing state probe: ${needle}`);
          const result = await command("Debugger.setBreakpoint", {
            location: { scriptId: script.scriptId, lineNumber: line + 1 },
            options: {
              autoContinue: true,
              actions: [
                { type: "evaluate", data: `${ownedProbe}?.record(${args})` },
              ],
            },
          });
          breakpoints.push(result.breakpointId);
        }
      }
      if (breakpoints.length !== 3)
        throw new Error("Expected all three runtime state probes");
      await command("Debugger.setBreakpointsActive", { active: true });
    }
    console.log("RECORDING READY", dir, JSON.stringify(metadata));
    const until = Date.now() + seconds * 1000;
    while (!stopping && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const data = await evaluate(`${ownedProbe}?.snapshot()`);
      if (!data) throw new Error("Device trace disappeared");
      await writeFile(
        `${dir}/summary.json`,
        JSON.stringify(summarizeIpadScroll(data), null, 2),
      );
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
      await cleanup(() =>
        command("Debugger.removeBreakpoint", { breakpointId }),
      );
    if (breakpoints.length)
      await cleanup(() =>
        command("Debugger.setBreakpointsActive", { active: false }),
      );
    if (installing) await cleanup(() => evaluate(`${ownedProbe}?.dispose()`));
    session.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (cleanupErrors.length) {
      process.exitCode = 1;
      console.error(
        "Remote cleanup incomplete; page hooks expire after 30 seconds without polling.",
        cleanupErrors.map((error) => error.message),
      );
    }
    console.log("Trace stopped:", dir);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
