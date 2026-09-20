import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/firefox-profile/run-image-source.mjs safari|firefox URL [config-json]\nUses an owned Safari window or installed Firefox with fresh profile/app-data/local-data. Requires the existing native helper browser-artifacts/safari-native-scroll/native and external display at x=1440. Does not own the supplied server. Writes a JSON report under ignored browser-artifacts/image-source/.",
  );
  process.exit(0);
}
assert.equal(process.platform, "darwin");
const [engine, urlText, configText = "{}"] = process.argv.slice(2);
assert.ok(["safari", "firefox"].includes(engine), "Invalid browser");
const url = new URL(urlText);
assert.ok(
  url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname),
  "Expected local benchmark server",
);
const config = JSON.parse(configText);
const native = resolve("browser-artifacts/safari-native-scroll/native");
assert.ok(
  existsSync(native),
  "Native focus helper missing; build it using the Safari diagnostic runner first",
);
const exec = promisify(execFile);
const apple = async (source) =>
  (await exec("osascript", ["-e", source], { timeout: 20000 })).stdout.trim();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
await mkdir("browser-artifacts/image-source", { recursive: true });
const dir = await mkdtemp("browser-artifacts/image-source/run-");
const report = {
  engine,
  config,
  dir,
  status: "starting",
  startedAt: new Date().toISOString(),
};
console.log("Artifacts:", dir);
let child, exited, ws, windowId, evaluate, profile;
let childEnded = false;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const until = async (predicate, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (true) {
    if (interrupted || childEnded)
      throw new Error("Capture interrupted or browser exited");
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Benchmark wait timed out");
    await pause(100);
  }
};
const pending = new Map();
let sequence = 0;
const command = (method, params) =>
  new Promise((fulfill, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`BiDi timeout: ${method}`));
    }, 10000);
    pending.set(id, {
      fulfill: (result) => {
        clearTimeout(timer);
        fulfill(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
try {
  report.displays = JSON.parse((await exec(native, ["displays"])).stdout);
  let pid;
  if (engine === "safari") {
    const plist = "/Applications/Safari.app/Contents/Info.plist";
    for (const [name, key] of [
      ["browserVersion", "CFBundleShortVersionString"],
      ["browserBuild", "CFBundleVersion"],
    ]) {
      report[name] = (
        await exec("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])
      ).stdout.trim();
    }
    const safariWindowIds = async () =>
      (
        await apple(
          'tell application "/Applications/Safari.app" to get id of every window',
        )
      )
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0);
    const previousWindowIds = new Set(await safariWindowIds());
    await apple(
      'tell application "/Applications/Safari.app" to make new document with properties {URL:"about:blank"}',
    );
    await until(async () => {
      const created = (await safariWindowIds()).filter(
        (id) => !previousWindowIds.has(id),
      );
      assert.ok(
        created.length <= 1,
        "Cannot establish exclusive Safari window ownership",
      );
      windowId = created[0];
      return Boolean(windowId);
    }, 5000);
    await apple(
      `tell application "/Applications/Safari.app"\nset bounds of window id ${windowId} to {1440, 31, 3360, 1080}\nset URL of current tab of window id ${windowId} to ${JSON.stringify(url.href)}\nactivate\nend tell`,
    );
    pid = Number(
      await apple(
        'tell application "System Events" to get unix id of first application process whose bundle identifier is "com.apple.Safari"',
      ),
    );
    evaluate = async (expression) =>
      JSON.parse(
        await apple(
          `tell application "/Applications/Safari.app" to do JavaScript ${JSON.stringify(`JSON.stringify(${expression})`)} in current tab of window id ${windowId}`,
        ),
      );
  } else {
    profile = resolve(dir, "profile");
    const appData = resolve(profile, "app-data");
    const localData = resolve(profile, "local-data");
    await mkdir(appData, { recursive: true });
    await mkdir(localData);
    await writeFile(
      resolve(profile, "user.js"),
      'user_pref("browser.aboutwelcome.enabled",false);\nuser_pref("browser.shell.checkDefaultBrowser",false);\nuser_pref("browser.startup.homepage_override.mstone","ignore");\nuser_pref("browser.startup.page",0);\n',
    );
    const reservation = createServer();
    await new Promise((done, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", done);
    });
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    child = spawn(
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      [
        "--no-remote",
        "--profile",
        profile,
        "--remote-debugging-port",
        String(port),
        "about:blank",
      ],
      {
        env: {
          ...process.env,
          MOZ_APP_DATA: appData,
          MOZ_LOCAL_APP_DATA: localData,
        },
        stdio: "ignore",
      },
    );
    exited = new Promise((done) => {
      child.once("error", (error) => {
        report.launchError = String(error);
        childEnded = true;
        done();
      });
      child.once("exit", () => {
        childEnded = true;
        done();
      });
    });
    pid = child.pid;
    await until(async () => {
      const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`);
      const opened = await new Promise((done) => {
        const timer = setTimeout(() => {
          candidate.close();
          done(false);
        }, 500);
        candidate.onopen = () => {
          clearTimeout(timer);
          done(true);
        };
        candidate.onerror = () => {
          clearTimeout(timer);
          done(false);
        };
      });
      if (!opened) {
        candidate.close();
        return false;
      }
      ws = candidate;
      return true;
    }, 20000);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.type === "error") waiter.reject(new Error(message.message));
      else waiter.fulfill(message.result);
    };
    ws.onclose = () => {
      for (const waiter of pending.values())
        waiter.reject(new Error("Browser connection closed"));
      pending.clear();
    };
    const session = await command("session.new", { capabilities: {} });
    report.browserVersion = session.capabilities.browserVersion;
    const { contexts } = await command("browsingContext.getTree", {
      maxDepth: 0,
    });
    const context = contexts[0].context;
    evaluate = async (expression) => {
      const result = await command("script.evaluate", {
        expression: `JSON.stringify(${expression})`,
        target: { context },
        awaitPromise: true,
      });
      if (result.type === "exception")
        throw new Error("Benchmark browser evaluation failed");
      return JSON.parse(result.result.value);
    };
    await command("browsingContext.navigate", {
      context,
      url: url.href,
      wait: "interactive",
    });
    await apple(
      `tell application "System Events"\ntell first application process whose unix id is ${pid}\nset frontmost to true\nset position of front window to {1440,31}\nset size of front window to {1920,1049}\nend tell\nend tell`,
    );
  }
  assert.ok(Number.isInteger(pid) && pid > 0);
  report.pid = pid;
  await until(() => evaluate("Boolean(window.imageSourceBenchmarkReady)"));
  if (windowId) {
    await apple(
      `tell application "/Applications/Safari.app"\nset index of window id ${windowId} to 1\nactivate\nend tell`,
    );
    report.windowBounds = (
      await apple(
        `tell application "/Applications/Safari.app" to get bounds of window id ${windowId}`,
      )
    )
      .split(",")
      .map(Number);
  }
  const bounds = report.windowBounds ?? [1440, 31, 3360, 1080];
  await exec(
    native,
    [
      "focus",
      String(pid),
      String((bounds[0] + bounds[2]) / 2),
      String((bounds[1] + bounds[3]) / 2),
    ],
    { timeout: 10000 },
  );
  await until(() => evaluate("document.hasFocus()"), 5000);
  report.focused = await evaluate("document.hasFocus()");
  assert.equal(report.focused, true, "Benchmark document is not focused");
  await evaluate(
    `(() => { window.__benchmarkInvalidations=[]; addEventListener("blur",()=>window.__benchmarkInvalidations.push("blur")); document.addEventListener("visibilitychange",()=>window.__benchmarkInvalidations.push("visibilitychange")); window.runImageSourceBenchmark(${JSON.stringify(config)}).catch(error=>window.__benchmarkError=String(error)); return true; })()`,
  );
  await until(async () => {
    const state = await evaluate(
      "({done:Boolean(window.imageSourceBenchmarkResult),error:window.__benchmarkError??null})",
    );
    if (state.error) throw new Error(state.error);
    return state.done;
  });
  report.result = await evaluate("window.imageSourceBenchmarkResult");
  report.invalidations = await evaluate("window.__benchmarkInvalidations");
  assert.deepEqual(
    report.invalidations,
    [],
    "Benchmark lost focus or visibility",
  );
  report.status = "measured";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  ws?.close();
  if (child && !childEnded) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (profile) {
    await rm(profile, { recursive: true, force: true });
    report.profileRemoved = true;
  }
  if (windowId) {
    try {
      await apple(
        `tell application "/Applications/Safari.app" to close window id ${windowId}`,
      );
    } catch (error) {
      report.cleanupError = String(error);
      report.status = "failed";
      process.exitCode = 1;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        status: report.status,
        error: report.error,
        entries: report.result?.entries.length,
        dir,
      },
      null,
      2,
    ),
  );
}
