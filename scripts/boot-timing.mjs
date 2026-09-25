// Time a demo's boot in the installed Firefox, driven over WebDriver BiDi
// (Playwright's Firefox build is not the one people use). Each run loads the
// page in a fresh navigation and reads the page's performance marks; cold
// runs bypass the HTTP cache, like a private window. Firefox runs with a
// temporary profile and app-data directories (see firefox-app-data.mjs), so
// a Firefox that is already open is not touched.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  options: {
    help: { type: "boolean" },
    firefox: {
      type: "string",
      default: "/Applications/Firefox.app/Contents/MacOS/firefox",
    },
    url: { type: "string", default: "http://127.0.0.1:5173/demos/streaming/" },
    marks: { type: "string", default: "chat:visible" },
    runs: { type: "string", default: "7" },
    modes: { type: "string", default: "cold,warm" },
    headless: { type: "boolean", default: false },
  },
});
if (options.help) {
  console.log(`Boot timing in the installed Firefox
  --url URL        Page to load (default: the streaming demo on :5173)
  --marks A,B      Performance marks to wait for and report
                   (default: chat:visible)
  --runs N         Loads per mode; the first is a warm-up (default: 7)
  --modes LIST     cold (HTTP cache bypassed) and/or warm (default: both)
  --firefox PATH   Firefox executable (default: /Applications/Firefox.app)
  --headless       Run without a window`);
  process.exit(0);
}
const marks = options.marks.split(",");
const runs = Number(options.runs);
if (!Number.isSafeInteger(runs) || runs < 2 || runs > 1000)
  throw new Error("--runs must be an integer between 2 and 1000");
const modes = options.modes.split(",");
if (modes.some((mode) => !["cold", "warm"].includes(mode)))
  throw new Error("--modes must contain cold and/or warm");
if (marks.some((mark) => !mark.trim()))
  throw new Error("--marks must contain nonempty performance mark names");
const url = new URL(options.url);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("--url must be an HTTP(S) URL");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const directory = await mkdtemp(join(tmpdir(), "boot-timing-"));
const profile = join(directory, "profile");
let firefox = null;
let socket = null;
let launchError = null;
let closed = null;
const pending = new Map();
const lifetime = new AbortController();
const interrupted = () => lifetime.abort(new Error("Boot timing interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  await mkdir(join(profile, "app-data"), { recursive: true });
  await mkdir(join(profile, "local-data"));
  await writeFile(
    join(profile, "user.js"),
    [
      'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("browser.startup.page", 0);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    ].join("\n"),
  );
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  firefox = spawn(
    options.firefox,
    [
      "--no-remote",
      "--profile",
      profile,
      "--remote-debugging-port",
      String(port),
      ...(options.headless ? ["--headless"] : []),
      "--width",
      "1200",
      "--height",
      "900",
      "about:blank",
    ],
    {
      env: {
        ...process.env,
        MOZ_APP_DATA: join(profile, "app-data"),
        MOZ_LOCAL_APP_DATA: join(profile, "local-data"),
      },
      stdio: "ignore",
    },
  );

  firefox.once("error", (error) => {
    launchError = error;
  });
  closed = new Promise((resolve) => firefox.once("close", resolve));
  for (let attempt = 0; attempt < 100 && !socket; attempt++) {
    lifetime.signal.throwIfAborted();
    if (launchError) throw launchError;
    if (firefox.exitCode !== null || firefox.signalCode !== null)
      throw new Error("Firefox exited before opening its WebDriver BiDi port");
    await sleep(200);
    socket = await new Promise((resolve) => {
      const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`);
      const finish = (connected) => {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", abort);
        candidate.onopen = null;
        candidate.onclose = null;
        candidate.onerror = () => {};
        if (!connected) candidate.close();
        resolve(connected ? candidate : null);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 1000);
      lifetime.signal.addEventListener("abort", abort, { once: true });
      candidate.onopen = () => finish(true);
      candidate.onerror = abort;
      candidate.onclose = abort;
    });
  }
  lifetime.signal.throwIfAborted();
  if (!socket) throw new Error("Firefox did not open its WebDriver BiDi port");
  let nextId = 0;
  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
  };
  socket.onclose = () => rejectPending(new Error("Firefox connection closed"));
  socket.onerror = () => rejectPending(new Error("Firefox connection failed"));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    if (message.type === "error")
      waiter.reject(new Error(`${message.error}: ${message.message}`));
    else waiter.resolve(message.result);
  };
  const command = (method, params) =>
    new Promise((resolve, reject) => {
      lifetime.signal.throwIfAborted();
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error("Firefox is not connected");
      const id = ++nextId;
      const finish = (callback, value) => {
        clearTimeout(timer);
        pending.delete(id);
        lifetime.signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, lifetime.signal.reason);
      const timer = setTimeout(
        () => finish(reject, new Error(`Timed out: ${method}`)),
        15000,
      );
      lifetime.signal.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        finish(reject, error);
      }
    });

  const session = await command("session.new", { capabilities: {} });
  const { contexts } = await command("browsingContext.getTree", {
    maxDepth: 0,
  });
  const context = contexts[0].context;
  // Mark start times, rounded ms from navigation start, or null until all
  // requested marks exist.
  const readMarks = async () => {
    const result = await command("script.evaluate", {
      expression: `JSON.stringify((() => {
        const times = {};
        for (const name of ${JSON.stringify(marks)}) {
          const mark = performance.getEntriesByName(name, "mark")[0];
          if (!mark) return null;
          times[name] = Math.round(mark.startTime);
        }
        return times;
      })())`,
      target: { context },
      awaitPromise: false,
    });
    return JSON.parse(result.result?.value ?? "null");
  };
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(
    `Firefox ${session.capabilities.browserVersion} · ${options.url}`,
  );
  for (const mode of modes) {
    await command("network.setCacheBehavior", {
      cacheBehavior: mode === "cold" ? "bypass" : "default",
    });
    const samples = [];
    for (let run = 0; run < runs; run++) {
      await command("browsingContext.navigate", {
        context,
        url: options.url,
        wait: "complete",
      });
      let times = null;
      for (let poll = 0; poll < 400 && !times; poll++) {
        lifetime.signal.throwIfAborted();
        times = await readMarks();
        if (!times) await sleep(25);
      }
      if (!times) throw new Error(`Marks missing after 10 s: ${marks}`);
      // The first load of each mode warms the dev server and the browser.
      if (run > 0) samples.push(times);
    }
    console.log(
      `${mode.padEnd(4)} median of ${samples.length}: ${marks
        .map((name) => `${name} ${median(samples.map((t) => t[name]))} ms`)
        .join(" · ")}`,
    );
  }
  await command("session.end", {}).catch(() => {});
} finally {
  lifetime.abort(new Error("Boot timing finished"));
  socket?.close();
  if (
    firefox?.pid &&
    firefox.exitCode === null &&
    firefox.signalCode === null
  ) {
    const timer = setTimeout(() => firefox.kill("SIGKILL"), 5000);
    try {
      firefox.kill();
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  await rm(directory, { recursive: true, force: true });
}
