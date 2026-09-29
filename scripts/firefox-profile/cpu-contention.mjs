// Run a profiling command under a bounded, reproducible CPU-only background load.
// This models CPU contention, not GPU pressure, memory pressure, or real trackpad input.
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

const [separator, command, ...args] = process.argv.slice(2);
if (separator !== "--" || !command) {
  throw new Error("Usage: node cpu-contention.mjs -- COMMAND [ARGS...]");
}
const count = 4;
const periodMs = 20;
const busyMs = 10;
const workers = [];
let child;
const stop = () => child?.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  for (let i = 0; i < count; i++) {
    workers.push(
      new Worker(
        `
      const { workerData } = require('node:worker_threads');
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      while (true) {
        const start = performance.now();
        while (performance.now() - start < workerData.busyMs) {}
        Atomics.wait(sleep, 0, 0, Math.max(0,
          workerData.periodMs - (performance.now() - start)));
      }
    `,
        { eval: true, workerData: { periodMs, busyMs } },
      ),
    );
  }
  console.log(
    JSON.stringify({ cpuContention: { workers: count, periodMs, busyMs } }),
  );
  child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      VIRTUAL_LIST_CPU_CONTENTION: JSON.stringify({
        workers: count,
        periodMs,
        busyMs,
      }),
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await Promise.all(workers.map((worker) => worker.terminate()));
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
