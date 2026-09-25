import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, firefox, webkit } from "playwright";
import "../firefox-app-data.mjs";
import { attributeProfile } from "./attribute.mjs";
import { inspectBursts } from "./bursts.mjs";
import { readCapture } from "./capture.mjs";
import { analyzeChatChrome } from "./chat-trace.mjs";
import { auditCpu } from "./cpu.mjs";
import { SafariMcp } from "./safari-mcp.mjs";
import {
  identifyWebContent,
  scheduleSample,
  webContentPids,
} from "./safari-sample.mjs";
import { validateDisplay } from "./safari-validation.mjs";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));

async function waitFor(test, signal, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await test();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("Browser readiness deadline exceeded");
}

async function nativeTools(directory, requested) {
  assert.equal(process.platform, "darwin", "Native input requires macOS");
  const cache = join(directory, "../.swift-cache");
  await mkdir(cache, { recursive: true });
  const helper = join(directory, "native");
  await exec(
    "/usr/bin/swiftc",
    [
      "-module-cache-path",
      cache,
      fileURLToPath(new URL("./native.swift", import.meta.url)),
      "-o",
      helper,
    ],
    { timeout: 120000 },
  );
  const displays = JSON.parse((await exec(helper, ["displays"])).stdout);
  const display = requested
    ? displays.find(
        (item) => item.name === requested || String(item.index) === requested,
      )
    : (displays.find((item) => !item.builtin) ?? displays[0]);
  assert.ok(display, "Requested display not found");
  return { helper, display };
}

export async function captureFirefox(server, directory, options, signal) {
  // Reuse compiler modules across captures instead of copying ~200 MiB per run.
  const cache = join(directory, "../.swift-cache");
  await mkdir(cache, { recursive: true });
  await mkdir(join(directory, "firefox"));
  await symlink(cache, join(directory, "firefox/.swift-cache"));
  const args = [
    "run",
    "profile:firefox",
    "--",
    `--url=${server.url}`,
    "--layout=none",
    "--live",
    "--temporary-raw",
    `--output=${join(directory, "firefox")}`,
  ];
  if (options.display) args.push(`--display=${options.display}`);
  if (options.refreshHz) args.push(`--refresh-hz=${options.refreshHz}`);
  if (["follow", "buttons"].includes(options.scenario))
    args.push(`--idle-seconds=${options.seconds}`);
  else if (options.scenario === "manual")
    args.push(`--manual-seconds=${options.seconds}`);
  else
    args.push(
      "--down=0",
      `--up=${Math.ceil(options.seconds / 2.2)}`,
      "--delta=12",
    );
  const log = createWriteStream(join(directory, "capture.log"));
  const child = spawn("pnpm", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  // Forward cancellation to the runner, which owns and cleans up its browser.
  const abort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await new Promise((resolve) => log.end(resolve));
  }
  const runs = (await readdir(join(directory, "firefox"))).filter((name) =>
    name.startsWith("run-"),
  );
  assert.equal(runs.length, 1, "Expected one Firefox capture");
  const path = join(directory, "firefox", runs[0]);
  const metadata = JSON.parse(await readFile(join(path, "run.json"), "utf8"));
  options.onBrowser?.(metadata);
  assert.equal(
    code,
    0,
    `Firefox capture failed: ${metadata.error ?? metadata.status}`,
  );
  assert.equal(metadata.status, "complete", "Firefox capture incomplete");
  const { profile, recording } = await readCapture(path);
  await json(join(directory, "firefox-cpu.json"), auditCpu(profile, recording));
  await json(
    join(directory, "firefox-bursts.json"),
    inspectBursts(profile, recording),
  );
  await json(
    join(directory, "firefox-attribution.json"),
    attributeProfile(profile, { filter: "", top: 50 }),
  );
  return {
    recording: recording.runtimeAudit,
    metadata,
    refreshHz: recording.refreshHz,
    native: true,
  };
}

export async function capturePlaywright(server, directory, options, signal) {
  const installed = options.browser === "chrome";
  const engine = installed
    ? chromium
    : {
        "engine-firefox": firefox,
        "engine-chromium": chromium,
        "engine-webkit": webkit,
      }[options.browser];
  assert.ok(engine, "Unknown browser");
  const native = installed
    ? await nativeTools(directory, options.display)
    : null;
  const browser = await engine.launch({
    headless: !installed,
    ...(installed ? { channel: "chrome" } : {}),
  });
  const abort = () => {
    void browser.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  let cdp;
  try {
    const context = await browser.newContext({
      viewport: installed ? null : { width: 1200, height: 900 },
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });
    if (installed) {
      cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const d = native.display;
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: d.x + 10,
          top: d.y + 10,
          width: d.width - 20,
          height: d.height - 20,
          windowState: "normal",
        },
      });
      if (options.maximize)
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "maximized" },
        });
    }
    await page.goto(server.url);
    await waitFor(
      () => page.evaluate(() => globalThis.__chatProfile?.ready()),
      signal,
    );
    await page.waitForTimeout(2000);
    await options.preparePage?.(page);
    await page.bringToFront();
    const geometry = await page.evaluate(() => ({
      x: screenX,
      y: screenY,
      outerWidth,
      outerHeight,
      innerWidth,
      innerHeight,
      dpr: devicePixelRatio,
    }));
    if (native) validateDisplay(native.display, geometry);
    let pid;
    const point = await page.evaluate(() => {
      const v = document.querySelector("#viewport"),
        r = v.getBoundingClientRect();
      v.tabIndex = -1;
      v.focus({ preventScroll: true });
      return {
        x: screenX + r.x + r.width / 2,
        y: screenY + outerHeight - innerHeight + r.y + r.height / 2,
      };
    });
    if (installed) {
      const session = await browser.newBrowserCDPSession();
      const processes = await session.send("SystemInfo.getProcessInfo");
      pid = processes.processInfo.find((item) => item.type === "browser")?.id;
      assert.ok(pid, "No owned Chrome browser process");
      await cdp.send("Performance.enable");
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
      await cdp.send("Profiler.start");
      await cdp.send("Tracing.start", {
        categories:
          "devtools.timeline,blink.user_timing,toplevel,v8,gpu,cc,disabled-by-default-devtools.timeline.frame" +
          (options.traceInvalidations
            ? ",disabled-by-default-devtools.timeline.invalidationTracking"
            : ""),
        transferMode: "ReturnAsStream",
      });
    }
    const metricsBefore = cdp ? await cdp.send("Performance.getMetrics") : null;
    await page.evaluate(() => globalThis.__chatProfile.start());
    const end = Date.now() + options.seconds * 1000;
    if (options.scenario === "manual")
      console.log("Scroll the foreground test Chrome now.");
    while (Date.now() < end) {
      signal.throwIfAborted();
      if (options.scenario === "scrollback") {
        if (native)
          await exec(
            native.helper,
            [
              "scroll",
              String(pid),
              String(point.x),
              String(point.y),
              "12",
              "90",
              "16667",
            ],
            { timeout: 10000 },
          );
        else {
          await page.locator("#viewport").hover();
          await page.mouse.wheel(0, -800);
        }
        await sleep(700);
      } else await sleep(200);
    }
    const recording = await page.evaluate(() =>
      globalThis.__chatProfile.stop(),
    );
    recording.traceInvalidations = options.traceInvalidations ?? false;
    await json(join(directory, "recording.json"), recording);
    const metadata = {
      browser: browser.version(),
      display: native?.display ?? null,
      geometry,
      nativeInput:
        installed && ["scrollback", "manual"].includes(options.scenario),
      isolated: true,
    };
    if (cdp) {
      const metricsAfter = await cdp.send("Performance.getMetrics");
      const { profile } = await cdp.send("Profiler.stop");
      await json(join(directory, "chrome-cpu-profile.json"), profile);
      await json(join(directory, "chrome-metrics.json"), {
        before: metricsBefore,
        after: metricsAfter,
      });
      const complete = new Promise((resolve) =>
        cdp.once("Tracing.tracingComplete", resolve),
      );
      await cdp.send("Tracing.end");
      const { stream } = await Promise.race([
        complete,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Trace completion timed out")),
            15000,
          ).unref(),
        ),
      ]);
      const chunks = [];
      try {
        for (;;) {
          const part = await cdp.send("IO.read", { handle: stream });
          chunks.push(
            Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8"),
          );
          if (part.eof) break;
        }
      } finally {
        await cdp.send("IO.close", { handle: stream });
      }
      await writeFile(
        join(directory, "chrome-trace.json.gz"),
        gzipSync(Buffer.concat(chunks)),
      );
      await json(
        join(directory, "chrome-analysis.json"),
        analyzeChatChrome(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          profile,
        ),
      );
    }
    await page.screenshot({ path: join(directory, "final.png") });
    return {
      recording,
      metadata,
      refreshHz:
        options.refreshHz ?? native?.display.maximumFramesPerSecond ?? 60,
      native: installed,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
}

export async function captureSafari(server, directory, options, signal) {
  const driverVersion = (
    await exec("/usr/bin/safaridriver", ["--version"])
  ).stdout.trim();
  const help = await exec("/usr/bin/safaridriver", ["--help"]).catch(
    (error) => {
      // safaridriver exits 1 for --help on some releases.
      if (error.code === 1 && error.stdout.includes("Usage:")) return error;
      throw error;
    },
  );
  assert.ok(
    help.stdout.includes("--mcp"),
    "Automatic Safari capture requires Safari 27+ with safaridriver --mcp. Use the documented standalone manual recorder on older Safari versions.",
  );
  return captureSafariMcp(server, directory, options, signal, driverVersion);
}

async function safariPids() {
  const result = await exec("/usr/bin/pgrep", ["-x", "Safari"]).catch(
    (error) => {
      if (error.code === 1) return { stdout: "" };
      throw error;
    },
  );
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

async function newSafariAutomationPid(existing) {
  const candidates = [];
  for (const candidate of await safariPids()) {
    if (existing.has(candidate)) continue;
    const { stdout } = await exec("/bin/ps", [
      "-p",
      String(candidate),
      "-o",
      "args=",
    ]);
    if (/(?:^|\s)--automation(?:\s|$)/.test(stdout)) candidates.push(candidate);
  }
  assert.ok(
    candidates.length <= 1,
    "Ambiguous new Safari automation instances",
  );
  return candidates[0];
}

async function captureSafariMcp(
  server,
  directory,
  options,
  signal,
  driverVersion,
) {
  const native = await nativeTools(directory, options.display);
  const existing = new Set(await safariPids());
  const oldContent = options.safariSample
    ? new Set(await webContentPids())
    : null;
  let sampler;
  signal.throwIfAborted();
  const log = createWriteStream(join(directory, "safaridriver.log"));
  const driver = spawn("/usr/bin/safaridriver", ["--mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  driver.stderr.pipe(log, { end: false });
  const exited = new Promise((resolve) => driver.once("close", resolve));
  const client = new SafariMcp(driver);
  const tool = (name, args) => client.tool(name, args, { signal });
  const evaluate = async (expression) =>
    JSON.parse(
      await tool("evaluate_javascript", {
        expression: `return (${expression});`,
      }),
    );
  let tab;
  let pid;
  const metadata = {
    driverVersion,
    driverPid: driver.pid,
    transport: "safaridriver-mcp",
    isolated: true,
    nativeInput: ["scrollback", "manual"].includes(options.scenario),
    display: native.display,
    nativeTimeline: "unavailable; use a separate Web Inspector capture",
    connectionOverhead:
      "Inspector-backed MCP connection; compare with the same transport",
  };
  options.onBrowser?.(metadata);
  try {
    metadata.stage = "initializing";
    metadata.server = await client.initialize({ signal });
    metadata.stage = "creating-tab";
    tab = JSON.parse(await tool("create_tab", { url: server.url })).handle;
    assert.equal(typeof tab, "string", "Safari did not return an owned tab");
    // Only inspect newly created PIDs, then require Safari's automation argument.
    // Never target the user's pre-existing Safari process or an unrelated launch.
    pid = await newSafariAutomationPid(existing);
    assert.ok(pid, "Expected one new Safari automation instance");
    metadata.browserPid = pid;
    metadata.stage = "placing-window";
    const d = native.display;
    await exec(
      native.helper,
      [
        "place",
        String(pid),
        String(d.x + 10),
        String(d.y + 10),
        String(d.width - 20),
        String(d.height - 20),
      ],
      { timeout: 10000 },
    );
    metadata.stage = "waiting-for-demo";
    await waitFor(
      () => evaluate("Boolean(globalThis.__chatProfile?.ready())"),
      signal,
    );
    await sleep(2000);
    const geometry = await evaluate(
      "({x:screenX,y:screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})",
    );
    validateDisplay(d, geometry);
    metadata.geometry = geometry;
    metadata.browser = await evaluate("navigator.userAgent");
    const snapshotCrop = options.safariSnapshots
      ? await evaluate(
          "(() => {const r=document.querySelector('#viewport').getBoundingClientRect();const m=document.querySelector('.message').getBoundingClientRect();return {x:Math.max(r.x,m.x)/innerWidth,y:r.y/innerHeight,width:Math.min(r.width,m.width)/innerWidth,height:r.height/innerHeight};})()",
        )
      : null;
    const point = await evaluate(
      "(() => { const r=document.querySelector('#viewport').getBoundingClientRect(); return {x:screenX+r.x+r.width/2,y:screenY+outerHeight-innerHeight+r.y+r.height/2}; })()",
    );
    await exec(
      native.helper,
      ["focus", String(pid), String(point.x), String(point.y)],
      { timeout: 10000 },
    );
    assert.equal(
      await evaluate("document.hasFocus()"),
      true,
      "Safari test document is not focused",
    );
    if (oldContent) {
      metadata.webContent = await identifyWebContent(oldContent, evaluate);
      await sleep(1000);
    }
    if (options.safariDetached) {
      await evaluate(`(fetch('/__chat-profile/start').then(response => {
        if (!response.ok) throw new Error('Capture start cancelled');
        globalThis.__chatProfile.start();
        setTimeout(() => fetch('/__chat-profile/recording', {
          method:'POST', body:JSON.stringify(globalThis.__chatProfile.stop())
        }), ${options.seconds * 1000});
      }), true)`);
      await waitFor(() => server.captureArmed, signal);
      // EOF asks MCP to close its automation window. Terminating only the
      // owned driver lets us test whether the page survives without Inspector.
      driver.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Safari driver did not detach before capture")),
            1500,
          ).unref(),
        ),
      ]);
      metadata.driverClosed = true;
      metadata.driverDetach =
        "SIGKILL of owned driver before releasing server start gate";
      metadata.transport = "safaridriver-mcp-detached";
      metadata.connectionOverhead =
        "Driver exited before self-timed capture; no Inspector client commands during measurement";
      await sleep(500);
      signal.throwIfAborted();
      assert.ok(
        (await safariPids()).includes(pid),
        "Safari exited during driver detach",
      );
      server.releaseCapture();
    } else await evaluate("globalThis.__chatProfile.start()");
    metadata.stage = "capturing";
    if (options.safariSample) {
      sampler = scheduleSample(
        metadata.webContent.pid,
        directory,
        options.safariSample,
      );
      metadata.nativeSample = sampler.metadata;
    }
    const capturedAt = Date.now();
    const end = capturedAt + options.seconds * 1000;
    const snapshots = options.safariSnapshots
      ? [
          options.durationMs / 4 + 150,
          options.durationMs / 4 + 650,
          options.durationMs / 2 + 150,
          options.durationMs + 3150,
          options.durationMs + 3650,
          options.durationMs + 5650,
        ]
      : [];
    metadata.snapshots = [];
    if (options.scenario === "manual")
      console.log("Scroll the foreground test Safari now.");
    while (Date.now() < end) {
      signal.throwIfAborted();
      if (snapshots.length && Date.now() - capturedAt >= snapshots[0]) {
        const snapshot = {
          requestedAt: snapshots.shift(),
          startedAt: Date.now() - capturedAt,
          file: `snapshot-${metadata.snapshots.length}.png`,
        };
        await tool("screenshot", {
          savePath: join(directory, snapshot.file),
          full_page: false,
        });
        snapshot.completedAt = Date.now() - capturedAt;
        metadata.snapshots.push(snapshot);
      }
      if (options.scenario === "scrollback") {
        await exec(
          native.helper,
          [
            "scroll",
            String(pid),
            String(point.x),
            String(point.y),
            "12",
            "90",
            "16667",
          ],
          { timeout: 10000, signal },
        );
        await sleep(700);
      } else await sleep(200);
    }
    if (!options.safariDetached)
      await evaluate(
        "(fetch('/__chat-profile/recording',{method:'POST',body:JSON.stringify(globalThis.__chatProfile.stop())}),true)",
      );
    const recording = await waitFor(() => server.recording, signal);
    recording.transport = metadata.transport;
    recording.nativeSampling = options.safariSample ?? null;
    recording.renderSnapshots = options.safariSnapshots ?? false;
    // Persist before cleanup so a failed browser shutdown cannot lose it.
    await json(join(directory, "recording.json"), recording);
    await sampler?.complete();
    if (snapshotCrop) {
      for (const snapshot of metadata.snapshots) {
        const result = await exec(native.helper, [
          "image-metrics",
          join(directory, snapshot.file),
          ...[
            snapshotCrop.x,
            snapshotCrop.y,
            snapshotCrop.width,
            snapshotCrop.height,
          ].map(String),
        ]);
        snapshot.pixels = JSON.parse(result.stdout);
      }
      metadata.snapshotCrop = snapshotCrop;
      metadata.snapshotLimitations =
        "Browser snapshots can force paint and add overhead. Pixel density can reveal blank content, but is not physical presentation timing; interpret with mounted-row coverage and inspect representative images.";
    }
    metadata.stage = "captured";
    return {
      recording,
      metadata,
      refreshHz: options.refreshHz ?? d.maximumFramesPerSecond,
      native: true,
    };
  } catch (error) {
    metadata.captureError = String(error);
    throw error;
  } finally {
    await sampler?.close();
    try {
      if (
        tab &&
        !signal.aborted &&
        driver.exitCode === null &&
        driver.signalCode === null
      )
        await client.tool("close_tab", { handle: tab }, { timeoutMs: 5000 });
    } finally {
      driver.stdin.end();
      const terminate = setTimeout(() => driver.kill("SIGTERM"), 3000);
      const kill = setTimeout(() => driver.kill("SIGKILL"), 8000);
      await exited;
      metadata.driverClosed = true;
      clearTimeout(terminate);
      clearTimeout(kill);
      try {
        // A cancelled create_tab may have launched Safari before replying.
        pid ??= await newSafariAutomationPid(existing);
        metadata.browserPid ??= pid;
        if (pid) {
          // Closing the last automation tab can leave Safari's app process
          // alive. Terminate only the new instance we identified above.
          if ((await safariPids()).includes(pid)) {
            const { stdout } = await exec("/bin/ps", [
              "-p",
              String(pid),
              "-o",
              "args=",
            ]);
            assert.match(
              stdout,
              /(?:^|\s)--automation(?:\s|$)/,
              "Owned Safari process identity changed",
            );
            await exec(native.helper, ["quit", String(pid)], {
              timeout: 10000,
            });
          }
          await waitFor(
            async () => !(await safariPids()).includes(pid),
            new AbortController().signal,
            10000,
          );
          metadata.browserClosed = true;
        } else metadata.browserClosed = true; // No automation process was created.
      } finally {
        await new Promise((resolve) => log.end(resolve));
      }
    }
  }
}
