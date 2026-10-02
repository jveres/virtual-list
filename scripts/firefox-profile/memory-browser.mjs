import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { SafariMcp } from "./safari-mcp.mjs";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function processes() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      assert.ok(match, "Invalid process table");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        name: match[3],
      };
    });
}
export function descendants(pid, all = processes()) {
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of all)
      if (ids.has(p.parent) && !ids.has(p.pid)) {
        ids.add(p.pid);
        changed = true;
      }
  }
  return all.filter((p) => ids.has(p.pid));
}
async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  child.kill("SIGTERM");
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(100);
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function launchFirefox(directory, { profiler = false } = {}) {
  const profile = join(directory, "profile");
  await mkdir(profile);
  await writeFile(
    join(profile, "user.js"),
    [
      'user_pref("browser.aboutwelcome.enabled",false);',
      'user_pref("browser.shell.checkDefaultBrowser",false);',
      'user_pref("browser.startup.homepage_override.mstone","ignore");',
      ...(profiler
        ? [
            'user_pref("browser.download.folderList",2);',
            `user_pref("browser.download.dir",${JSON.stringify(resolve(directory))});`,
            'user_pref("browser.download.useDownloadDir",true);',
          ]
        : []),
    ].join("\n"),
  );
  const port = await freePort();
  const child = spawn(
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    [
      "--no-remote",
      "--remote-allow-system-access",
      "--profile",
      profile,
      "--remote-debugging-port",
      String(port),
      "about:blank",
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        MOZ_APP_DATA: join(profile, "app-data"),
        MOZ_LOCAL_APP_DATA: join(profile, "local-data"),
      },
    },
  );
  let launchError;
  child.once("error", (error) => {
    launchError = error;
  });
  let ws;
  let next = 0;
  const pending = new Map();
  const close = async () => {
    for (const waiter of pending.values())
      waiter.reject(Error("Browser closed"));
    ws?.close();
    await stop(child);
    await rm(profile, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error("Firefox exited during startup");
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Firefox connection timed out")),
            1000,
          );
          socket.onopen = () => {
            clearTimeout(timer);
            resolve();
          };
          socket.onerror = (error) => {
            clearTimeout(timer);
            reject(error);
          };
        });
        ws = socket;
        break;
      } catch {
        socket.close();
        await delay(100);
      }
    }
    assert.ok(ws, "Firefox connection unavailable");
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      message.type === "error"
        ? waiter.reject(Error(JSON.stringify(message)))
        : waiter.resolve(message.result);
    };
    ws.onclose = () => {
      for (const waiter of pending.values())
        waiter.reject(Error("Firefox connection closed"));
    };
    const command = (method, params = {}, timeout = 30000) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const finish = (fn, result) => {
          clearTimeout(timer);
          pending.delete(id);
          fn(result);
        };
        const timer = setTimeout(
          () => finish(reject, Error(`${method} timed out`)),
          timeout,
        );
        pending.set(id, {
          resolve: (r) => finish(resolve, r),
          reject: (e) => finish(reject, e),
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const session = await command("session.new", { capabilities: {} });
    const context = (await command("browsingContext.getTree", { maxDepth: 0 }))
      .contexts[0].context;
    return {
      pid: child.pid,
      version: session.capabilities.browserVersion,
      build: session.capabilities["moz:buildID"],
      processes: () => descendants(child.pid),
      close,
      startProfile: ({ features = ["js"] } = {}) => {
        assert.ok(profiler, "Profiler was not enabled");
        return command("moz:profiler.start", {
          entries: 8388608,
          interval: 2,
          features,
          threads: ["GeckoMain"],
          activeContext: context,
        });
      },
      finishProfile: async () => {
        assert.ok(profiler, "Profiler was not enabled");
        const saved = await command("moz:profiler.stop", {}, 60000);
        assert.equal(typeof saved.path, "string", "Missing live profile");
        assert.equal(dirname(saved.path), resolve(directory));
        try {
          return JSON.parse(await readFile(saved.path, "utf8"));
        } finally {
          await rm(saved.path, { force: true });
        }
      },
      navigate: (url) =>
        command("browsingContext.navigate", { context, url, wait: "complete" }),
      memoryReport: async ({
        minimize = false,
        minBytes = 4 * 1024 * 1024,
      } = {}) => {
        assert.ok(Number.isSafeInteger(minBytes) && minBytes >= 0);
        const memoryContext = (
          await command("browsingContext.create", { type: "tab" })
        ).context;
        try {
          await command("browsingContext.navigate", {
            context: memoryContext,
            url: "about:memory",
            wait: "complete",
          });
          const result = await command("script.evaluate", {
            expression: `(async () => {
              const manager = Cc['@mozilla.org/memory-reporter-manager;1'].getService(Ci.nsIMemoryReporterManager);
              if (${Boolean(minimize)}) await new Promise(resolve => manager.minimizeMemoryUsage({run:resolve}));
              return JSON.stringify(await new Promise(resolve => {
              const rows = [];
              manager.getReports({ callback(process,path,kind,units,amount) {
                if (units === Ci.nsIMemoryReporter.UNITS_BYTES && amount >= ${minBytes})
                  rows.push({process,path:path.replace(/data:image[^)]*/g,'inline-image').slice(0,500),kind,amount});
              }}, null, {callback(){resolve(rows)}}, null, false);
            })); })()`,
            target: { context: memoryContext },
            awaitPromise: true,
          });
          if (result.type === "exception")
            throw Error(JSON.stringify(result.exceptionDetails));
          return JSON.parse(result.result.value);
        } finally {
          await command("browsingContext.close", { context: memoryContext });
        }
      },
      evaluate: async (expression) => {
        const result = await command("script.evaluate", {
          expression: `(async()=>JSON.stringify(await (${expression})))()`,
          target: { context },
          awaitPromise: true,
        });
        if (result.type === "exception")
          throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value === undefined
          ? undefined
          : JSON.parse(result.result.value);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function launchSafari(counter) {
  const existing = new Set(processes().map((p) => p.pid));
  const child = spawn("/usr/bin/safaridriver", ["--mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const client = new SafariMcp(child);
  let tab, pid;
  const close = async () => {
    if (tab)
      await client
        .tool("close_tab", { handle: tab }, { timeoutMs: 5000 })
        .catch(() => {});
    child.stdin.end();
    await stop(child);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  try {
    await client.initialize();
    tab = JSON.parse(
      await client.tool("create_tab", { url: "about:blank" }),
    ).handle;
    const candidates = processes().filter(
      (p) =>
        !existing.has(p.pid) &&
        p.name.endsWith("/Safari.app/Contents/MacOS/Safari"),
    );
    assert.equal(
      candidates.length,
      1,
      "Expected one owned Safari automation process",
    );
    const candidatePid = candidates[0].pid;
    const args = execFileSync(
      "/bin/ps",
      ["-p", String(candidatePid), "-o", "args="],
      {
        encoding: "utf8",
      },
    );
    assert.match(
      args,
      /(?:^|\s)--automation(?:\s|$)/,
      "Safari must be isolated",
    );
    // Cleanup may terminate only a process whose isolation was verified.
    pid = candidatePid;
    const evaluate = async (expression) =>
      JSON.parse(
        await client.tool("evaluate_javascript", {
          expression: `return (${expression});`,
        }),
      );
    return {
      pid,
      version: await evaluate("navigator.userAgent"),
      build: execFileSync(
        "/usr/libexec/PlistBuddy",
        [
          "-c",
          "Print CFBundleVersion",
          "/Applications/Safari.app/Contents/Info.plist",
        ],
        { encoding: "utf8" },
      ).trim(),
      evaluate,
      close,
      processes: () => {
        assert.ok(counter, "Safari memory requires a process ownership helper");
        const candidates = processes().filter(
          (p) => p.pid === pid || /com\.apple\.WebKit\./.test(p.name),
        );
        const owned = new Set(
          execFileSync(
            counter,
            ["--owned", String(pid), ...candidates.map((p) => String(p.pid))],
            { encoding: "utf8" },
          )
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number),
        );
        assert.ok(owned.has(pid), "Safari ownership could not be established");
        return candidates.filter((p) => owned.has(p.pid));
      },
      navigate: async (url) => {
        await evaluate(`(location.href=${JSON.stringify(url)},true)`);
        await delay(1000);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function launchChrome() {
  const server = await chromium.launchServer({
    channel: "chrome",
    headless: false,
  });
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    const pid = server.process().pid;
    return {
      pid,
      version: browser.version(),
      processes: () => descendants(pid),
      navigate: (url) => page.goto(url),
      evaluate: (expression) => page.evaluate(expression),
      close: async () => {
        try {
          await browser.close();
        } finally {
          await server.close();
        }
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
