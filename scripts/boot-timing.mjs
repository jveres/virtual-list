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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const directory = await mkdtemp(join(tmpdir(), "boot-timing-"));
const profile = join(directory, "profile");
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
const port = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const firefox = spawn(
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

let socket = null;
for (let attempt = 0; attempt < 100 && !socket; attempt++) {
  await sleep(200);
  socket = await new Promise((resolve) => {
    const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`);
    candidate.onopen = () => resolve(candidate);
    candidate.onerror = () => resolve(null);
  });
}
if (!socket) throw new Error("Firefox did not open its WebDriver BiDi port");
let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.type === "error")
    waiter.reject(new Error(`${message.error}: ${message.message}`));
  else waiter.resolve(message.result);
};
const command = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

try {
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
  for (const mode of options.modes.split(",")) {
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
        times = await readMarks().catch(() => null);
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
  socket.close();
  if (firefox.exitCode === null) {
    const exited = new Promise((resolve) => firefox.once("exit", resolve));
    firefox.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
