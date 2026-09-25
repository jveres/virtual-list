import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function sampleOptions(value, seconds) {
  if (value === undefined) return null;
  const parts = value.split(":").map(Number);
  const [atSeconds, durationSeconds, intervalMs] = parts;
  assert.ok(
    /^\d+(?:\.\d+)?:\d+:\d+$/.test(value) &&
      parts.length === 3 &&
      atSeconds >= 0 &&
      durationSeconds >= 1 &&
      durationSeconds <= 10 &&
      intervalMs >= 1 &&
      intervalMs <= 100 &&
      atSeconds + durationSeconds <= seconds - 1,
    "--safari-sample uses startSeconds:durationSeconds:intervalMs; duration 1..10, interval 1..100, ending >=1s before capture end",
  );
  return { atSeconds, durationSeconds, intervalMs };
}

export async function webContentPids() {
  const { stdout } = await exec("/usr/bin/pgrep", [
    "-f",
    "/com.apple.WebKit.WebContent$",
  ]).catch((error) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

function cpuTimes(stdout) {
  return new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, time] = line.trim().split(/\s+/);
        return [
          Number(pid),
          time.split(":").reduce((n, part) => n * 60 + Number(part), 0),
        ];
      }),
  );
}

export function calibratedPid(candidates, beforeText, afterText) {
  const before = cpuTimes(beforeText),
    after = cpuTimes(afterText);
  const ranked = candidates
    .map((pid) => ({
      pid,
      cpuSeconds: (after.get(pid) ?? 0) - (before.get(pid) ?? 0),
    }))
    .sort((a, b) => b.cpuSeconds - a.cpuSeconds);
  assert.ok(
    ranked[0]?.cpuSeconds > 0.4 && (!ranked[1] || ranked[1].cpuSeconds < 0.2),
    "Cannot unambiguously identify the owned Safari WebContent",
  );
  return { pid: ranked[0].pid, calibration: ranked };
}

export async function identifyWebContent(existing, evaluate) {
  // Never sample a pre-existing user process, even if it consumes CPU.
  const candidates = (await webContentPids()).filter(
    (pid) => !existing.has(pid),
  );
  assert.ok(candidates.length, "No new Safari WebContent process");
  const times = async () =>
    (await exec("/bin/ps", ["-o", "pid=,time=", "-p", candidates.join(",")]))
      .stdout;
  const before = await times();
  await evaluate(
    "(() => {const end=performance.now()+600;let n=0;while(performance.now()<end)n++;return n})()",
  );
  return calibratedPid(candidates, before, await times());
}

export function summarizeSample(source) {
  const graph = source
    .split("Call graph:\n")[1]
    ?.split("\nTotal number in stack")[0];
  assert.ok(graph, "Native sample has no call graph");
  const threads = graph.split(/(?=^ {4}\d+ Thread_)/m);
  const main = threads.find((thread) =>
    /^ {4}\d+ Thread_.*com\.apple\.main-thread/m.test(thread),
  );
  assert.ok(main, "Native sample has no main thread");
  const stack = [],
    totals = new Map();
  let samples = 0;
  for (const line of main.split("\n")) {
    const match = /^([ +!|:\s]*)(\d+) (.+)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length,
      count = Number(match[2]);
    const symbol = match[3].replace(/ {2}\(in .*$/, "");
    if (!samples) {
      samples = count;
      continue;
    }
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    // Recursive calls contribute once per path, not once per stack level.
    if (!stack.some((entry) => entry.symbol === symbol))
      totals.set(symbol, (totals.get(symbol) ?? 0) + count);
    stack.push({ depth, symbol });
  }
  assert.ok(samples > 0, "Native sample has no main-thread samples");
  return {
    schema: 1,
    mainThreadSamples: samples,
    symbols: [...totals]
      .filter(([name]) => /^(WebCore::|WebKit::|JSC::|IPC::)/.test(name))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([name, count]) => ({
        name,
        samples: count,
        percent: Math.round((count / samples) * 1000) / 10,
      })),
    note: "Inclusive stack sample counts overlap. Sampling suspends the process and can substantially amplify stalls; use separate unsampled timing captures. No per-frame timestamps or CPU durations are inferred.",
  };
}

export function scheduleSample(pid, directory, config) {
  let child, timer, done;
  const metadata = { ...config, pid, status: "scheduled" };
  const started = performance.now();
  timer = setTimeout(() => {
    metadata.status = "sampling";
    metadata.startedAtMs = performance.now() - started;
    const path = join(directory, "safari-sample.txt");
    child = spawn(
      "/usr/bin/sample",
      [
        String(pid),
        String(config.durationSeconds),
        String(config.intervalMs),
        "-file",
        path,
      ],
      { stdio: "ignore" },
    );
    done = new Promise((resolve) => {
      const timeout = setTimeout(
        () => child.kill("SIGKILL"),
        config.durationSeconds * 1000 + 15000,
      );
      child.once("error", (error) => resolve({ error: String(error) }));
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
  }, config.atSeconds * 1000);
  return {
    metadata,
    async complete() {
      assert.ok(done, "Native sample did not start");
      const outcome = await done;
      assert.equal(
        outcome.code,
        0,
        `Native sample failed: ${JSON.stringify(outcome)}`,
      );
      const summary = summarizeSample(
        await readFile(join(directory, "safari-sample.txt"), "utf8"),
      );
      metadata.status = "complete";
      await writeFile(
        join(directory, "safari-sample-summary.json"),
        JSON.stringify({ ...summary, capture: metadata }, null, 2),
      );
    },
    async close() {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (done) await done;
      if (metadata.status !== "complete") metadata.status = "cancelled";
      metadata.closed = true;
    },
  };
}
