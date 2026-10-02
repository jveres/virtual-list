import "./firefox-app-data.mjs";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const regressionRoot = resolve(root, "scripts/regressions");

export async function discover(directory = regressionRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const cases = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(resolve(directory, entry.name));
    for (const file of files) {
      if (!file.endsWith("-regression.mjs")) continue;
      cases.push({
        group: entry.name,
        name: file.replace(/-regression\.mjs$/, ""),
        path: resolve(directory, entry.name, file),
      });
    }
  }
  return cases.sort((a, b) => a.path.localeCompare(b.path));
}

export function selectCases(cases, group, match) {
  const groups = group?.split(",") ?? [...new Set(cases.map((c) => c.group))];
  for (const name of groups) {
    if (!cases.some((c) => c.group === name)) {
      throw new Error(`Unknown group: ${name}`);
    }
  }
  const selected = cases.filter(
    (c) => groups.includes(c.group) && (!match || c.name.includes(match)),
  );
  if (!selected.length) throw new Error("No regressions matched the selection");
  return selected;
}

export function options(args) {
  const { values } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    options: {
      group: { type: "string" },
      match: { type: "string" },
      timeout: { type: "string", default: "600" },
      list: { type: "boolean" },
      help: { type: "boolean" },
      "fail-fast": { type: "boolean" },
    },
  });
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) {
    throw new Error(
      "--timeout must be between 0 (exclusive) and 86400 seconds",
    );
  }
  return { ...values, timeout: timeout * 1000 };
}

// A worker owns all Playwright browser instances, including failed-test cleanup.
export async function runCase(test, { url, timeout, signal }) {
  if (signal.aborted) return { status: "interrupted", durationMs: 0 };
  const started = performance.now();
  return new Promise((resolveResult) => {
    let status;
    let forceTimer;
    const child = spawn(
      process.execPath,
      [resolve(root, "scripts/regression-worker.mjs"), test.path],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, BROWSER_MATRIX_URL: url },
      },
    );
    const stop = (reason) => {
      if (status) return;
      status = reason;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const abort = () => stop("interrupted");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timed out"), timeout);
    const finish = (result) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal.removeEventListener("abort", abort);
      resolveResult({
        status: status ?? result,
        durationMs: Math.round(performance.now() - started),
      });
    };
    child.once("error", (error) => finish(`failed: ${error.message}`));
    child.once("exit", (code, exitSignal) => {
      finish(code === 0 ? "passed" : `failed (${exitSignal ?? code})`);
    });
    if (signal.aborted) abort();
  });
}

async function main(args = process.argv.slice(2)) {
  const config = options(args);
  if (config.help) {
    console.log(
      "Usage: pnpm run test:regression [--group=name,name] [--match=text]\n" +
        "       [--list] [--timeout=seconds] [--fail-fast]\n" +
        "Uses each script's existing browser coverage. BROWSER_MATRIX_URL reuses a server.",
    );
    return;
  }
  const cases = selectCases(await discover(), config.group, config.match);
  if (config.list) {
    for (const test of cases) console.log(`${test.group}: ${test.name}`);
    console.log(`${cases.length} regression scripts`);
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let server;
  const results = [];
  try {
    let url = process.env.BROWSER_MATRIX_URL;
    if (!url) {
      const { createServer } = await import("vite");
      server = await createServer({
        root,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0, open: false, hmr: false },
      });
      await server.listen();
      url = server.resolvedUrls.local[0];
    }
    if (controller.signal.aborted) return;
    const response = await fetch(url, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok)
      throw new Error(`Server returned HTTP ${response.status}`);
    console.log(`Running ${cases.length} regression scripts against ${url}`);
    for (const test of cases) {
      if (controller.signal.aborted) break;
      console.log(
        `\n[${results.length + 1}/${cases.length}] ${test.group}/${test.name}`,
      );
      const result = await runCase(test, {
        url,
        timeout: config.timeout,
        signal: controller.signal,
      });
      results.push({ ...test, ...result });
      console.log(
        `${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`,
      );
      if (config["fail-fast"] && result.status !== "passed") break;
    }
  } finally {
    await server?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const failed = results.filter((r) => r.status !== "passed");
    console.log(
      `\nRegression summary: ${results.length - failed.length} passed, ` +
        `${failed.length} failed, ${cases.length - results.length} not run`,
    );
    for (const result of failed) {
      console.log(`  ${result.group}/${result.name}: ${result.status}`);
    }
    if (controller.signal.aborted) process.exitCode = 130;
    else if (failed.length || results.length !== cases.length)
      process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
