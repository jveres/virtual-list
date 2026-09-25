import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeDirectory } from "./firefox-profile/analyze.mjs";
import { discardRaw, writeReproduction } from "./firefox-profile/artifacts.mjs";
import { attributeProfile } from "./firefox-profile/attribute.mjs";
import { inspectBursts } from "./firefox-profile/bursts.mjs";
import { readCapture } from "./firefox-profile/capture.mjs";
import { auditCpu } from "./firefox-profile/cpu.mjs";
import { serializedExpression } from "./firefox-profile/expression.mjs";

const { values: options } = parseArgs({
  args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
  options: {
    help: { type: "boolean" },
    "list-displays": { type: "boolean" },
    display: { type: "string" },
    firefox: {
      type: "string",
      default: "/Applications/Firefox.app/Contents/MacOS/firefox",
    },
    url: { type: "string", default: "http://127.0.0.1:4193/demos/gallery/" },
    viewport: { type: "string", default: "#viewport" },
    layout: { type: "string", default: "masonry" },
    output: { type: "string", default: "browser-artifacts/firefox" },
    down: { type: "string", default: "6" },
    up: { type: "string", default: "4" },
    ticks: { type: "string", default: "90" },
    delta: { type: "string", default: "24" },
    "interval-ms": { type: "string", default: "16.667" },
    "settle-ms": { type: "string", default: "700" },
    "warmup-ms": { type: "string", default: "2000" },
    setup: { type: "string" },
    live: { type: "boolean", default: false },
    "refresh-hz": { type: "string" },
    "manual-seconds": { type: "string", default: "0" },
    "idle-seconds": { type: "string", default: "0" },
    "temporary-raw": { type: "boolean", default: false },
  },
});
if (options.help) {
  console.log(`Firefox-first native macOS scroll profiling
  --list-displays          List monitor indices, names, scale, and refresh ceiling
  --display INDEX|NAME    Target monitor (default: first external, otherwise built-in)
  --firefox PATH          Installed Firefox executable, not a Playwright build
  --url URL              Default: http://127.0.0.1:4193/demos/gallery/
  --viewport SELECTOR    Scroll element (default: #viewport)
  --layout masonry|rows|none  Gallery layout; use none for other demos
  --output DIRECTORY     Parent of a NEW unique run directory
  --down N --up N        Gesture bursts (default: 6 down, 4 up)
  --ticks N --delta N    Events per gesture and pixel delta (default: 90, 24)
  --interval-ms N        Native event interval (default: 16.667)
  --settle-ms N          Pause after each gesture (default: 700)
  --warmup-ms N          Pause after load and optional setup (default: 2000)
  --setup FILE           Local JS expression evaluated after warmup, before capture
  --live                 Save before shutdown using Firefox's moz:profiler command
  --refresh-hz N         Actual refresh rate, if different from reported maximum
  --manual-seconds N     Capture your real gestures instead of scripted input
  --idle-seconds N       Capture automatic scrolling without injecting gestures
Requires macOS, Node 22+, Swift, Accessibility, and a running demo server.
See docs/firefox-profiling.md. Artifacts stay local; nothing is uploaded.`);
  process.exit(0);
}
if (process.platform !== "darwin")
  throw new Error("Native capture requires macOS; the analyzer is portable");
function number(key, minimum, maximum, integer = false) {
  const value = Number(options[key]);
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `Invalid --${key}: expected ${integer ? "integer" : "number"} ${minimum}..${maximum}`,
    );
  }
  return value;
}
const down = number("down", 0, 100, true);
const up = number("up", 0, 100, true);
const ticks = number("ticks", 1, 600, true);
const delta = number("delta", 1, 1000, true);
const interval = number("interval-ms", 1, 100);
const settle = number("settle-ms", 0, 10000);
const warmup = number("warmup-ms", 0, 60000);
const manual = number("manual-seconds", 0, 600);
const automatic = number("idle-seconds", 0, 600);
if (manual && automatic) throw new Error("Choose manual or idle capture");
if (!manual && !automatic && down + up === 0)
  throw new Error("Specify at least one gesture burst");
if (!["masonry", "rows", "none"].includes(options.layout))
  throw new Error("Invalid --layout");
const url = new URL(options.url);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("Expected an HTTP(S) URL");

await mkdir(resolve(options.output), { recursive: true });
const disk = await statfs(resolve(options.output));
if (disk.bavail * disk.bsize < 10 * 1024 ** 3)
  throw new Error(
    "Profiling requires at least 10 GiB free; no capture started",
  );
// Compiler modules are reusable; a private copy per run costs about 200 MiB.
const compilerCache = join(resolve(options.output), ".swift-cache");
await mkdir(compilerCache, { recursive: true });
const directory = await mkdtemp(join(resolve(options.output), "run-"));
console.log(`Artifacts: ${directory}`);
const helper = join(directory, "native");
execFileSync(
  "/usr/bin/swiftc",
  [
    "-module-cache-path",
    await realpath(compilerCache),
    fileURLToPath(new URL("./firefox-profile/native.swift", import.meta.url)),
    "-o",
    helper,
  ],
  { timeout: 120000 },
);
const displays = JSON.parse(
  execFileSync(helper, ["displays"], { encoding: "utf8" }),
);
if (options["list-displays"]) {
  console.log(JSON.stringify(displays, null, 2));
  process.exit(0);
}
const monitor =
  options.display === undefined
    ? (displays.find((display) => !display.builtin) ?? displays[0])
    : displays.find(
        (display) =>
          String(display.index) === options.display ||
          display.name === options.display,
      );
if (!monitor) throw new Error("Display not found; run with --list-displays");
const refreshHz =
  options["refresh-hz"] === undefined
    ? monitor.maximumFramesPerSecond
    : number("refresh-hz", 1, 1000);
if (!Number.isFinite(refreshHz) || refreshHz <= 0) {
  throw new Error("Display refresh rate is unavailable; specify --refresh-hz");
}
const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
await response.body?.cancel();
if (!response.ok) throw new Error(`Demo server returned ${response.status}`);
const browserProfile = join(directory, "browser-profile");
await mkdir(browserProfile);
// macOS 27 can reject direct launches during profile discovery even with an
// explicit --profile. Isolate discovery/cache data too (Mozilla bug 2060476).
// Both directories share the temporary profile's owned cleanup lifecycle.
const browserAppData = join(browserProfile, "app-data");
const browserLocalData = join(browserProfile, "local-data");
await mkdir(browserAppData);
await mkdir(browserLocalData);
await writeFile(
  join(browserProfile, "user.js"),
  [
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.startup.page", 0);',
    ...(options.live
      ? [
          'user_pref("browser.download.folderList", 2);',
          `user_pref("browser.download.dir", ${JSON.stringify(directory)});`,
          'user_pref("browser.download.useDownloadDir", true);',
        ]
      : []),
  ].join("\n"),
);
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const metadata = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  options,
  monitor,
  refreshHz,
  started: new Date().toISOString(),
  status: "starting",
};
const saveMetadata = () =>
  writeFile(join(directory, "run.json"), JSON.stringify(metadata, null, 2));
await saveMetadata();
if (!options["temporary-raw"]) {
  const command = ["pnpm", "run", "profile:firefox", "--"];
  for (const [key, value] of Object.entries(options)) {
    if (
      ["output", "temporary-raw", "help", "list-displays"].includes(key) ||
      value === undefined ||
      value === false
    )
      continue;
    command.push(value === true ? `--${key}` : `--${key}=${value}`);
  }
  if (options.setup) {
    await writeFile(
      join(directory, "reproduce-setup.js"),
      await readFile(options.setup),
    );
    command[command.findIndex((arg) => arg.startsWith("--setup="))] =
      "--setup=reproduce-setup.js";
  }
  await writeReproduction(directory, { revision: metadata.revision, command });
}
const child = spawn(
  options.firefox,
  [
    "--no-remote",
    "--profile",
    browserProfile,
    "--remote-debugging-port",
    String(port),
    "about:blank",
  ],
  {
    env: {
      ...process.env,
      MOZ_APP_DATA: browserAppData,
      MOZ_LOCAL_APP_DATA: browserLocalData,
      MOZ_PROFILER_STARTUP: "1",
      MOZ_PROFILER_STARTUP_INTERVAL: "1",
      MOZ_PROFILER_STARTUP_ENTRIES: "16777216",
      MOZ_PROFILER_STARTUP_FEATURES: "js,stackwalk,processcpu",
      MOZ_PROFILER_STARTUP_FILTERS:
        "GeckoMain,Compositor,Renderer,SwComposite,RenderBackend,SceneBuilder,WrWorker,TextureUpdate",
      MOZ_PROFILER_SHUTDOWN: join(
        directory,
        options.live ? "shutdown-profile.json" : "profile.json",
      ),
    },
  },
);
const log = createWriteStream(join(directory, "browser.log"));
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
let ended = false;
let spawnError;
const exited = new Promise((resolve) => {
  child.once("error", (error) => {
    spawnError = error;
    ended = true;
    resolve();
  });
  child.once("exit", () => {
    ended = true;
    resolve();
  });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Map();
let ws;
let nextId = 0;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.on("SIGHUP", interrupt);
function rejectPending() {
  for (const waiter of pending.values())
    waiter.reject(new Error("Firefox connection closed"));
  pending.clear();
}
function command(method, params = {}, timeout = 20000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, timeout);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    if (ws?.readyState !== 1) {
      pending.get(id).reject(new Error("Firefox is not connected"));
      pending.delete(id);
      return;
    }
    ws.send(JSON.stringify({ id, method, params }));
  });
}
let evaluate;
let display;
let recordingStarted = false;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (ended || interrupted)
      throw spawnError ?? new Error("Firefox exited or capture interrupted");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("Connection timeout"));
        }, 1000);
        socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Connection refused"));
        };
      });
      ws = socket;
      break;
    } catch {
      socket.close();
      await sleep(250);
    }
  }
  if (!ws)
    throw new Error(
      `Could not connect; inspect ${join(directory, "browser.log")}`,
    );
  ws.onclose = rejectPending;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.type === "error")
      waiter.reject(new Error(JSON.stringify(message)));
    else waiter.resolve(message.result);
  };
  const session = await command("session.new", { capabilities: {} });
  metadata.browser = session.capabilities;
  const { contexts } = await command("browsingContext.getTree", {
    maxDepth: 0,
  });
  const context = contexts[0].context;
  evaluate = async (expression) => {
    const result = await command("script.evaluate", {
      expression: serializedExpression(expression),
      target: { context },
      awaitPromise: true,
    });
    if (result.type === "exception") throw new Error(JSON.stringify(result));
    return result.result.value === undefined
      ? undefined
      : JSON.parse(result.result.value);
  };
  await command("browsingContext.navigate", {
    context,
    url: url.href,
    wait: "interactive",
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    ready = await evaluate(
      `Boolean(document.querySelector(${JSON.stringify(options.viewport)}))`,
    );
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error("Scroll viewport not found");
  if (options.layout !== "none") {
    await evaluate(
      `(() => { document.querySelector('[data-layout="${options.layout}"]').click(); return true; })()`,
    );
  }
  execFileSync(
    "osascript",
    [
      "-e",
      `tell application "System Events"
    tell first application process whose unix id is ${child.pid}
      set frontmost to true
      set position of front window to {${Math.round(monitor.x + 10)}, ${Math.round(monitor.y + 10)}}
      set size of front window to {${Math.floor(monitor.width - 20)}, ${Math.floor(monitor.height - 20)}}
    end tell
  end tell`,
    ],
    { timeout: 15000 },
  );
  // Window activation can leave Firefox's address bar focused. Click an inert
  // overlay, never a photo/control, then move focus to the scroll container.
  // All layout reads and the temporary element are outside measurement.
  async function focusViewport() {
    const focusTarget = await evaluate(`(() => {
    const v=document.querySelector(${JSON.stringify(options.viewport)}),r=v.getBoundingClientRect();
    const target=document.createElement('div');
    target.id='ff-profile-focus-target';target.tabIndex=-1;
    target.style.cssText='position:fixed;width:20px;height:20px;z-index:2147483647;opacity:0;pointer-events:auto';
    target.style.left=(r.x+r.width/2-10)+'px';target.style.top=(r.y+r.height/2-10)+'px';
    target.addEventListener('click',event=>event.stopPropagation());
    document.body.append(target);
    return {x:screenX+r.x+r.width/2,y:screenY+(outerHeight-innerHeight)+r.y+r.height/2,visible:r.width>0&&r.height>0};
  })()`);
    if (
      !focusTarget.visible ||
      focusTarget.x < monitor.x ||
      focusTarget.x >= monitor.x + monitor.width ||
      focusTarget.y < monitor.y ||
      focusTarget.y >= monitor.y + monitor.height
    )
      throw new Error("Focus target is outside the selected monitor");
    await sleep(100);
    execFileSync(
      helper,
      [
        "focus",
        String(child.pid),
        String(focusTarget.x),
        String(focusTarget.y),
      ],
      { timeout: 5000 },
    );
    await sleep(100);
    metadata.documentFocus = await evaluate(`(() => {
    document.querySelector('#ff-profile-focus-target')?.remove();
    const v=document.querySelector(${JSON.stringify(options.viewport)});
    if (!v.hasAttribute('tabindex')) v.tabIndex=-1;
    v.focus({preventScroll:true});
    return {focused:document.hasFocus()&&document.activeElement===v,activeElement:document.activeElement?.id};
  })()`);
    if (!metadata.documentFocus.focused)
      throw new Error("Test gallery did not receive document focus");
  }
  await focusViewport();
  await sleep(warmup);
  if (options.setup) {
    const source = await readFile(resolve(options.setup), "utf8");
    await writeFile(join(directory, "setup.js"), source);
    metadata.setupResult = await evaluate(source);
    await sleep(warmup);
  }
  if (interrupted) throw new Error("Capture interrupted");
  await focusViewport();
  display = await evaluate(
    `({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height,userAgent:navigator.userAgent})`,
  );
  if (
    display.dpr !== monitor.scale ||
    display.x < monitor.x ||
    display.x >= monitor.x + monitor.width
  ) {
    throw new Error("Browser geometry does not match the requested display");
  }
  metadata.display = display;
  metadata.status = "recording";
  await saveMetadata();
  console.log(
    `Firefox ${session.capabilities.browserVersion} on ${monitor.name}: ${display.innerWidth}×${display.innerHeight} @${display.dpr}x`,
  );
  await evaluate(`(() => {
    const viewport=document.querySelector(${JSON.stringify(options.viewport)});
    window.__ffProfile={timeOrigin:performance.timeOrigin,frames:[],writes:[],bursts:[],scrollEvents:0,scrollEnds:0,phase:'start',lastTop:viewport.scrollTop};
    window.addEventListener('scroll',event=>{if(event.target===viewport){window.__ffProfile.lastTop=viewport.scrollTop;window.__ffProfile.scrollEvents++;}}, {capture:true,passive:true});
    window.addEventListener('scrollend',event=>{if(event.target===viewport)window.__ffProfile.scrollEnds++;},true);
    const owner=Object.hasOwn(viewport,'scrollTop')?viewport:Element.prototype;
    const descriptor=Object.getOwnPropertyDescriptor(owner,'scrollTop');
    if(!descriptor?.get||!descriptor.set||!descriptor.configurable)throw new Error('Cannot instrument scrollTop safely');
    Object.defineProperty(owner,'scrollTop',{...descriptor,set(value){if(this===viewport)window.__ffProfile.writes.push({time:performance.now(),value,phase:window.__ffProfile.phase});descriptor.set.call(this,value);}});
    const sample=time=>{window.__ffProfile.frames.push([time,window.__ffProfile.lastTop,window.__ffProfile.phase]);window.__ffProfile.frame=requestAnimationFrame(sample);};
    window.__runtimeAudit?.start();performance.mark('ff-profile-start');window.__ffProfile.frame=requestAnimationFrame(sample);return true;
  })()`);
  recordingStarted = true;
  if (manual || automatic) {
    console.log(
      manual
        ? `Manual capture: scroll the test window for ${manual} seconds.`
        : `Automatic capture: observe streaming for ${automatic} seconds.`,
    );
    for (let second = 0; second < (manual || automatic); second++) {
      if (interrupted) throw new Error("Capture interrupted");
      await sleep(1000);
    }
  } else
    for (let burst = 0; burst < down + up; burst++) {
      if (interrupted) throw new Error("Capture interrupted");
      const phase = `${burst < down ? "down" : "up"}-${burst}`;
      const point = await evaluate(`(() => {
      const v=document.querySelector(${JSON.stringify(options.viewport)}),r=v.getBoundingClientRect();
      window.__ffProfile.phase=${JSON.stringify(phase)};performance.mark(${JSON.stringify(`ff-${phase}`)});
      return {x:screenX+r.x+r.width/2,y:screenY+(outerHeight-innerHeight)+r.y+r.height/2,visible:r.width>0&&r.height>0};
    })()`);
      if (
        !point.visible ||
        point.x < monitor.x ||
        point.x >= monitor.x + monitor.width ||
        point.y < monitor.y ||
        point.y >= monitor.y + monitor.height
      ) {
        throw new Error("Scroll target is outside the selected monitor");
      }
      execFileSync(
        helper,
        [
          "scroll",
          String(child.pid),
          String(point.x),
          String(point.y),
          String(burst < down ? -delta : delta),
          String(ticks),
          String(Math.round(interval * 1000)),
        ],
        { timeout: Math.ceil(ticks * interval + 10000) },
      );
      await evaluate(
        `(() => {window.__ffProfile.phase=${JSON.stringify(`settle-${phase}`)};return true;})()`,
      );
      await sleep(settle);
      const state = await evaluate(`(() => {
      const v=document.querySelector(${JSON.stringify(options.viewport)});
      const state={time:performance.now(),top:v.scrollTop,height:v.scrollHeight,phase:window.__ffProfile.phase,scrollEvents:window.__ffProfile.scrollEvents,scrollEnds:window.__ffProfile.scrollEnds,status:document.querySelector('#status')?.textContent,lab:Object.fromEntries([...document.querySelectorAll('[id^="s-"]')].map(el=>[el.id,el.textContent]))};
      window.__ffProfile.bursts.push(state);return state;
    })()`);
      console.log(
        `${phase}: top=${state.top}, height=${state.height}, scrollend=${state.scrollEnds}`,
      );
    }
  if (interrupted) throw new Error("Capture interrupted");
  const recording = await evaluate(
    `(() => {performance.mark('ff-profile-end');cancelAnimationFrame(window.__ffProfile.frame);if(window.__runtimeAudit)window.__ffProfile.runtimeAudit=window.__runtimeAudit.stop();return window.__ffProfile;})()`,
  );
  await writeFile(
    join(directory, "frames.json"),
    JSON.stringify({
      ...recording,
      display,
      refreshHz,
      capture: options.live ? "live" : "shutdown",
    }),
  );
  if (!recording.scrollEvents)
    throw new Error("No scrolling recorded; this is not a valid scroll trial");
  if (options.live) {
    const saved = await command("moz:profiler.stop", {}, 60000);
    if (typeof saved.path !== "string" || dirname(saved.path) !== directory)
      throw new Error(
        "Live profile was not saved inside the capture directory",
      );
    await rename(saved.path, join(directory, "profile.json"));
    metadata.capture = "live";
  } else {
    metadata.capture = "shutdown";
  }
  const screenshot = await command("browsingContext.captureScreenshot", {
    context,
  });
  await writeFile(
    join(directory, "final.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  metadata.status = "captured";
} catch (error) {
  metadata.status = "failed";
  metadata.error = String(error);
  if (recordingStarted && evaluate) {
    try {
      const partial = await evaluate("window.__ffProfile");
      await writeFile(
        join(directory, "partial-frames.json"),
        JSON.stringify(partial),
      );
    } catch {
      /* The browser may already be gone; preserve the log and metadata. */
    }
  }
  process.exitCode = 1;
  console.error(error);
} finally {
  if (!ended && ws?.readyState === 1) {
    try {
      await command("browser.close", {}, 8000);
    } catch {
      /* Fall back to the owned PID only. */
    }
  }
  if (!ended) await Promise.race([exited, sleep(3000)]);
  if (!ended && child.pid) {
    try {
      execFileSync(helper, ["quit", String(child.pid)], { timeout: 5000 });
    } catch {
      /* Try SIGTERM below. */
    }
    await Promise.race([exited, sleep(5000)]);
  }
  if (!ended) {
    child.kill("SIGTERM");
    metadata.status = "failed";
    metadata.error =
      "Firefox did not shut down cleanly; the profile may be incomplete";
    process.exitCode = 1;
    await Promise.race([exited, sleep(3000)]);
    if (!ended) {
      // Only this runner's child, never other Firefox instances.
      child.kill("SIGKILL");
      await exited;
    }
  }
  ws?.close();
  rejectPending();
  log.end();
  metadata.finished = new Date().toISOString();
  // This exact directory belongs to the child above. Never remove it while
  // that browser is alive. Raw captures are discarded after analysis below.
  if (ended) {
    try {
      await rm(browserProfile, { recursive: true });
      metadata.browserProfileRemoved = true;
    } catch (error) {
      metadata.browserProfileRemoved = false;
      metadata.cleanupError = String(error);
      process.exitCode = 1;
      console.error("Temporary browser profile cleanup failed:", error);
    }
  }
  await saveMetadata();
}
try {
  if (metadata.status === "captured") {
    try {
      const summary = await analyzeDirectory(directory);
      await writeFile(
        join(directory, "summary.json"),
        JSON.stringify(summary, null, 2),
      );
      if (!options["temporary-raw"]) {
        const { profile, recording } = await readCapture(directory);
        for (const [name, result] of [
          ["cpu.json", auditCpu(profile, recording)],
          ["bursts.json", inspectBursts(profile, recording)],
          [
            "attribution.json",
            attributeProfile(profile, { filter: "", top: 50 }),
          ],
        ])
          await writeFile(
            join(directory, name),
            JSON.stringify(result, null, 2),
          );
      }
      console.log(
        JSON.stringify(
          {
            frames: summary.animationFrameIntervalsMs,
            scrollEvents: summary.scrollEvents,
            longIntervals: summary.longIntervals,
            writes: summary.scrollPositionWrites.length,
          },
          null,
          2,
        ),
      );
      metadata.status = "complete";
      await saveMetadata();
    } catch (error) {
      metadata.status = "failed";
      metadata.error = `Artifact analysis failed: ${String(error)}`;
      await saveMetadata();
      throw error;
    }
  }
} finally {
  // A parent chat capture owns temporary raw files until its own analysis ends.
  if (!options["temporary-raw"]) {
    await discardRaw(directory);
    metadata.rawDataRemoved = true;
    await saveMetadata();
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.removeListener(signal, interrupt);
}
