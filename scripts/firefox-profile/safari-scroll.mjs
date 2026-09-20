import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  preview as createPreviewServer,
  createServer,
  build as viteBuild,
} from "vite";
import {
  installRuntimeAudit,
  instrumentDemo,
  instrumentRuntime,
} from "./runtime-audit.mjs";
import {
  cleanupCapture,
  selectDisplay,
  validateCapture,
  validateDisplay,
} from "./safari-validation.mjs";

const execAsync = promisify(execFile);
const exec = (file, args, options = {}) =>
  execAsync(file, args, { timeout: 20000, ...options });
if (process.argv.includes("--help")) {
  console.log(
    "Native Safari scroll diagnostic (macOS). Run from repository root.\nSAFARI_DISPLAY=builtin|external (default external), DEMO=gallery|streaming (default gallery), GALLERY_LAYOUT=rows|masonry, GALLERY_SIZE=s|m|l (default m). GEOMETRY=1 adds boundary layout reads; SAMPLE=1 captures native CPU samples; MANUAL_SECONDS=1..60 captures real trackpad input. RICH_CHAT=1 imports the synthetic fixture (streaming only); MATCH_OPTIONS=1 sets the reported chat options. COMPOSITING=current|rows|viewport|isolated selects a diagnostic control, not a runtime setting. Isolated retains current layers and isolates the scroll container's stacking context. SAFARI_NATIVE_HELPER can name an existing native helper; otherwise the runner compiles the current source. Requires Accessibility and Safari Allow JavaScript from Apple Events. Owns a temporary server and Safari window; preserves other windows. Captures are local under browser-artifacts/safari-native-scroll.",
  );
  console.log(
    "RECYCLING=normal|retain|all controls diagnostic row recycling. FIXED_ITEMS=1 disables gallery paging; ROUNDS=1..10 changes the number of gestures in each direction. Retain/all are unbounded diagnostic controls, never production settings.",
  );
  console.log(
    "PILL=current|no-paint (default current) controls date-pill painting. No-paint hides inline pills without changing their layout and hides the sticky overlay; it does not disable sticky-header updates.",
  );
  console.log(
    "SAFARI_APP=safari|preview (default safari) selects /Applications/Safari.app or /Applications/Safari Technology Preview.app. The selected app must already be installed and allow JavaScript from Apple Events. Records its installed version/build and closes only the capture window; never quits either browser.",
  );
  console.log(
    "CHAT_FILE imports a local Markdown transcript (DEMO=streaming only, incompatible with RICH_CHAT=1). Served in memory from an unguessable localhost route; reports keep only byte/hash/turn counts, not the source path or contents.",
  );
  console.log(
    "SERVE_MODE=dev|production (default dev) selects the development server or a fresh production build served by Vite preview. Production output and cache stay in the ignored capture directory; existing dist is unchanged.",
  );
  console.log(
    "RUNTIME_AUDIT=1 logs bounded numeric mount/height/preparation events without extra layout reads. TOP_COMMANDS=0..5 (streaming only) clicks Scroll to top after the native gestures and waits six seconds per command. This is a button-path diagnostic, not trackpad momentum.",
  );
  process.exit(0);
}
assert.equal(
  process.platform,
  "darwin",
  "Native Safari capture requires macOS",
);
const demo = process.env.DEMO || "gallery";
assert.ok(["gallery", "streaming"].includes(demo), "Invalid DEMO");
const topCommands = Number(process.env.TOP_COMMANDS || 0);
assert.ok(
  Number.isInteger(topCommands) && topCommands >= 0 && topCommands <= 5,
  "Invalid TOP_COMMANDS",
);
assert.ok(
  topCommands === 0 || demo === "streaming",
  "TOP_COMMANDS requires streaming",
);
assert.ok(
  [undefined, "0", "1"].includes(process.env.RUNTIME_AUDIT),
  "Invalid RUNTIME_AUDIT",
);
const serveMode = process.env.SERVE_MODE || "dev";
assert.ok(["dev", "production"].includes(serveMode), "Invalid SERVE_MODE");
const galleryLayout = process.env.GALLERY_LAYOUT || "rows";
const gallerySize = process.env.GALLERY_SIZE || "m";
assert.ok(
  ["rows", "masonry"].includes(galleryLayout),
  "Invalid GALLERY_LAYOUT",
);
assert.ok(["s", "m", "l"].includes(gallerySize), "Invalid GALLERY_SIZE");
const compositing = process.env.COMPOSITING || "current";
assert.ok(
  ["current", "rows", "viewport", "isolated"].includes(compositing),
  "Invalid COMPOSITING",
);
const recycling = process.env.RECYCLING || "normal";
assert.ok(["normal", "retain", "all"].includes(recycling), "Invalid RECYCLING");
const pill = process.env.PILL || "current";
assert.ok(["current", "no-paint"].includes(pill), "Invalid PILL");
const fixedItems = process.env.FIXED_ITEMS === "1";
assert.ok(!fixedItems || demo === "gallery", "FIXED_ITEMS requires gallery");
const rounds = Number(process.env.ROUNDS || 3);
assert.ok(
  Number.isInteger(rounds) && rounds >= 1 && rounds <= 10,
  "Invalid ROUNDS",
);
const richChat = process.env.RICH_CHAT === "1";
assert.ok(
  !richChat || demo === "streaming",
  "RICH_CHAT requires DEMO=streaming",
);
assert.ok(
  !process.env.CHAT_FILE || (demo === "streaming" && !richChat),
  "CHAT_FILE requires DEMO=streaming and RICH_CHAT disabled",
);
let chatBuffer;
if (process.env.CHAT_FILE) {
  try {
    chatBuffer = await readFile(process.env.CHAT_FILE);
  } catch {
    throw new Error("CHAT_FILE could not be read");
  }
}
const chatImport = chatBuffer
  ? {
      bytes: chatBuffer.length,
      sha256: createHash("sha256").update(chatBuffer).digest("hex"),
      expectedTurns: Array.from(
        chatBuffer
          .toString("utf8")
          .matchAll(/^\*\*(?:User|Assistant)\*\*[ \t]*\r?$/gm),
      ).length,
    }
  : null;
assert.ok(
  !chatImport || chatImport.expectedTurns > 0,
  "CHAT_FILE has no turn headers",
);
const chatRoute = chatImport ? `/__probe/chat-${randomUUID()}` : null;
const richChatSource = richChat
  ? await readFile(new URL("./fixtures/rich-chat.js", import.meta.url))
  : null;
const manual = Number(process.env.MANUAL_SECONDS || 0);
assert.ok(
  Number.isFinite(manual) && manual >= 0 && manual <= 60,
  "MANUAL_SECONDS must be 0..60",
);
assert.ok(
  ["builtin", "external"].includes(process.env.SAFARI_DISPLAY || "external"),
  "Invalid SAFARI_DISPLAY",
);
const safariApp = process.env.SAFARI_APP || "safari";
assert.ok(["safari", "preview"].includes(safariApp), "Invalid SAFARI_APP");
const application = {
  safari: {
    name: "Safari",
    path: "/Applications/Safari.app",
    bundleId: "com.apple.Safari",
  },
  preview: {
    name: "Safari Technology Preview",
    path: "/Applications/Safari Technology Preview.app",
    bundleId: "com.apple.SafariTechnologyPreview",
  },
}[safariApp];
const plist = `${application.path}/Contents/Info.plist`;
assert.ok(
  existsSync(plist),
  `${application.name} is not installed at ${application.path}`,
);
const readAppProperty = (key) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
assert.equal(
  readAppProperty("CFBundleIdentifier"),
  application.bundleId,
  "Selected Safari application has an unexpected bundle identifier",
);
const browser = {
  selection: safariApp,
  ...application,
  version: readAppProperty("CFBundleShortVersionString"),
  build: readAppProperty("CFBundleVersion"),
};
const appleApplication = `application ${JSON.stringify(application.path)}`;
await mkdir("browser-artifacts/safari-native-scroll", { recursive: true });
const native =
  process.env.SAFARI_NATIVE_HELPER ||
  "browser-artifacts/safari-native-scroll/native";
if (process.env.SAFARI_NATIVE_HELPER) {
  assert.ok(existsSync(native), "SAFARI_NATIVE_HELPER does not exist");
} else {
  // Rebuild from the current source instead of silently reusing a stale helper.
  const cache = "browser-artifacts/safari-native-scroll/.swift-cache";
  await mkdir(cache, { recursive: true });
  execFileSync(
    "/usr/bin/swiftc",
    [
      "-module-cache-path",
      cache,
      fileURLToPath(new URL("./native.swift", import.meta.url)),
      "-o",
      native,
    ],
    { timeout: 120000 },
  );
}
const screens = JSON.parse(
  execFileSync(native, ["displays"], { encoding: "utf8" }),
);
const screen = selectDisplay(screens, process.env.SAFARI_DISPLAY || "external");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = await mkdtemp("browser-artifacts/safari-native-scroll/run-");
const report = {
  dir,
  screen,
  status: "starting",
  browser,
  demo,
  serveMode,
  geometry: process.env.GEOMETRY === "1",
  gallery: { layout: galleryLayout, size: gallerySize, concurrency: 6 },
  compositing,
  richChat,
  recycling,
  pill,
  fixedItems,
  rounds,
  topCommands,
  chatImport,
  runtimeAudit: process.env.RUNTIME_AUDIT === "1",
  input: manual ? "manual-trackpad" : "scripted-native-no-momentum",
  manualSeconds: manual,
};
let server,
  windowId,
  channel,
  result,
  ready,
  started,
  sampler,
  sampleDone,
  calibrated;
let commandAcknowledged = 0;
let aborted = false;
const channels = new Set();
const interrupt = () => {
  aborted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const send = (value) => {
  assert.ok(channel && !channel.destroyed, "Browser probe disconnected");
  channel.write(`data: ${JSON.stringify(value)}\n\n`);
};
const waitFor = async (predicate) => {
  const end = Date.now() + 40000;
  while (true) {
    if (aborted || Date.now() > end)
      throw new Error("Wait interrupted or timed out");
    if (predicate()) return;
    await pause(100);
  }
};
function contentPids() {
  try {
    return execFileSync("pgrep", ["-f", "com.apple.WebKit.WebContent"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map(Number);
  } catch {
    return [];
  }
}
function cpuTimes(pids) {
  if (!pids.length) return new Map();
  const output = execFileSync(
    "ps",
    ["-o", "pid=,time=", "-p", pids.join(",")],
    { encoding: "utf8" },
  );
  return new Map(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, time] = line.trim().split(/\s+/);
        return [
          Number(pid),
          time.split(":").reduce((n, v) => n * 60 + Number(v), 0),
        ];
      }),
  );
}

async function browserProbe(compositing, richChat, pill, chat) {
  const post = (path, data) =>
    fetch(`/__probe/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  while (document.documentElement.classList.contains("booting"))
    await delay(50);
  await document.fonts.ready;
  if (pill === "no-paint") {
    const style = document.createElement("style");
    style.textContent =
      ".section-header-pill{visibility:hidden!important}.vl-sticky-header{display:none!important}";
    document.head.append(style);
  }
  await delay(1500);
  let importedImages;
  if (chat) {
    const savedConfirm = window.confirm;
    const savedAlert = window.alert;
    let accepted = false;
    let alerts = 0;
    let unexpectedConfirm = false;
    try {
      const response = await fetch(chat.route, { cache: "no-store" });
      if (!response.ok) throw new Error("Transcript fetch failed");
      const blob = await response.blob();
      if (blob.size !== chat.bytes)
        throw new Error("Transcript byte count mismatch");
      const input = document.querySelector("#import-file");
      const viewport = document.querySelector("#viewport");
      if (!input || !viewport?.firstElementChild)
        throw new Error("Transcript importer is unavailable");
      const oldCanvas = viewport.firstElementChild;
      window.confirm = (message) => {
        accepted =
          /^Replace the simulated history stored in this browser with the \d+ turns(?: \(including all versions\))? in safari-scroll-import\.md\?$/.test(
            String(message),
          );
        if (!accepted) unexpectedConfirm = true;
        return accepted;
      };
      window.alert = () => {
        alerts++;
      };
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([blob], "safari-scroll-import.md", { type: "text/markdown" }),
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const deadline = Date.now() + 25000;
      while (true) {
        if (alerts || unexpectedConfirm)
          throw new Error("Transcript import rejected");
        const status =
          document.querySelector("#window-status")?.textContent ?? "";
        const total = Number(
          status.match(/\/([\d,]+)(?:\s|$)/)?.[1]?.replaceAll(",", ""),
        );
        if (
          accepted &&
          viewport.firstElementChild !== oldCanvas &&
          total === chat.expectedTurns
        )
          break;
        if (Date.now() > deadline)
          throw new Error("Transcript import did not finish");
        await delay(100);
      }
      await document.fonts.ready;
      const images = [...viewport.querySelectorAll("img")];
      const decoded = Promise.allSettled(images.map((img) => img.decode()));
      let imagesTimedOut = false;
      let imageTimer;
      await Promise.race([
        decoded,
        new Promise((resolve) => {
          imageTimer = setTimeout(() => {
            imagesTimedOut = true;
            resolve();
          }, 10000);
        }),
      ]);
      clearTimeout(imageTimer);
      importedImages = {
        mounted: images.length,
        complete: images.filter((img) => img.complete).length,
        broken: images.filter((img) => img.complete && img.naturalWidth === 0)
          .length,
        decodeTimedOut: imagesTimedOut,
      };
      await post("import-status", {
        status: "imported",
        images: importedImages,
      });
      await delay(2000);
    } catch {
      await post("import-status", {
        status: "failed",
        alerts,
        unexpectedConfirm,
      });
      throw new Error("Private transcript import failed; see import metadata");
    } finally {
      window.confirm = savedConfirm;
      window.alert = savedAlert;
    }
  }
  if (richChat) {
    await import("/scripts/firefox-profile/fixtures/rich-chat.js");
    const deadline = Date.now() + 15000;
    while (
      !document.querySelector("#window-status")?.textContent.includes("/160")
    ) {
      if (Date.now() > deadline)
        throw new Error("Rich chat import did not finish");
      await delay(100);
    }
    await delay(2000);
    await document.fonts.ready;
  }
  const v = document.querySelector("#viewport");
  if (compositing === "isolated") v.style.isolation = "isolate";
  else if (compositing !== "current") {
    v.firstElementChild.style.transform = "none";
    v.firstElementChild.style.transformStyle = "flat";
    if (compositing === "viewport") v.style.transform = "translateZ(0)";
  }
  // Read once before measurement; never read styles in the frame sampler.
  const layerStyles = (element) => {
    const style = getComputedStyle(element);
    return {
      transform: style.transform,
      transformStyle: style.transformStyle,
      isolation: style.isolation,
      willChange: style.willChange,
    };
  };
  const layers = {
    viewport: layerStyles(v),
    canvas: layerStyles(v.firstElementChild),
  };
  await delay(1000);
  const shield = document.createElement("div");
  shield.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:transparent";
  document.body.append(shield);
  const data = {
    frames: [],
    scrolls: [],
    writes: [],
    wheels: [],
    ends: [],
    marks: [],
    mutations: [],
    rowChanges: [],
    pillChanges: [],
    commands: [],
    errors: [],
    invalidations: [],
    invalidationEvents: [],
    geometry: [],
  };
  const ids = new WeakMap();
  let sequence = 0;
  const geometryTimers = new Set();
  let delayedGeometryPending = false;
  const recordBoundary = (canvas, kind, key) => {
    if (!active) return;
    const scrollTop = v.scrollTop;
    data.geometry.push({
      time: performance.now(),
      kind,
      key,
      scrollTop,
      height: v.scrollHeight,
      rows: [...canvas.children].map((el) => {
        if (!ids.has(el)) ids.set(el, ++sequence);
        const r = el.getBoundingClientRect();
        return [ids.get(el), r.top + scrollTop, r.height];
      }),
    });
  };
  globalThis.__probeBoundary = (canvas, kind, key) => {
    recordBoundary(canvas, kind, key);
    if (!active || !kind.startsWith("before-") || delayedGeometryPending)
      return;
    // Diagnostic-only reads, outside the lightweight animation-frame sampler.
    // Follow surviving row coordinates across a rendering opportunity as well
    // as synchronously: a mutation's layout effect may be deferred by WebKit.
    delayedGeometryPending = true;
    recordBoundary(canvas, "delayed-baseline", key);
    for (const delayMs of [0, 50]) {
      const timer = setTimeout(() => {
        geometryTimers.delete(timer);
        recordBoundary(canvas, `after-${delayMs}ms`, key);
        if (delayMs === 50) delayedGeometryPending = false;
      }, delayMs);
      geometryTimers.add(timer);
    }
  };
  const markEvent = (e) => {
    if (e.code === "KeyJ")
      data.marks.push({ label: "user-jitter", time: performance.now(), top });
  };
  addEventListener("keydown", markEvent);
  let frame = 0,
    top = v.scrollTop,
    active = false,
    observer,
    pillObserver,
    performanceObserver;
  const own = Object.getOwnPropertyDescriptor(v, "scrollTop");
  const descriptor =
    own ?? Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const scroll = () => {
    top = v.scrollTop;
    data.scrolls.push([performance.now(), top]);
  };
  const wheel = (e) =>
    data.wheels.push([performance.now(), e.deltaY, e.deltaMode, e.timeStamp]);
  const end = () => data.ends.push(performance.now());
  const sample = (t) => {
    data.frames.push([t, top]);
    frame = requestAnimationFrame(sample);
  };
  const error = (e) => data.errors.push(String(e.message || e.reason));
  const invalidation = (e) => {
    data.invalidations.push(e.type);
    data.invalidationEvents.push([performance.now(), e.type]);
  };
  const command = (e) => {
    const button =
      e.target instanceof Element ? e.target.closest("button") : null;
    if (button?.id === "scroll-top-btn" || button?.id === "scroll-bottom-btn")
      data.commands.push([performance.now(), button.id, top]);
  };
  const recordPillChanges = (records, source) => {
    if (!active) return;
    const time = performance.now();
    for (const record of records) {
      const target = record.target;
      if (!(target instanceof HTMLElement)) continue;
      if (source === "inline" && !target.matches(".section-header-pill"))
        continue;
      // Do not record date labels or transcript text. Inline styles here are
      // only the overlay's geometry/visibility, not computed layout reads.
      data.pillChanges.push({
        time,
        source,
        tag: target.tagName,
        className: target.className,
        attribute: record.attributeName,
        added: record.addedNodes.length,
        removed: record.removedNodes.length,
        display: target.style.display,
        transform: target.style.transform,
        height: target.style.height,
      });
    }
  };
  const geometry = () => ({
    x: screenX,
    y: screenY,
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
    dpr: devicePixelRatio,
  });
  const state = () => ({
    time: performance.now(),
    top: v.scrollTop,
    total: v.scrollHeight,
    height: v.clientHeight,
    rows: v.querySelectorAll(".message, .photo-row, .masonry-card").length,
  });
  const events = new EventSource("/__probe/events");
  events.onmessage = async (e) => {
    const message = JSON.parse(e.data);
    if (message.action === "calibrate") {
      const until = performance.now() + 600;
      let n = 0;
      while (performance.now() < until) n++;
      await post("calibrated", { iterations: n });
    } else if (message.action === "start") {
      shield.remove();
      globalThis.__runtimeAudit?.start();
      active = true;
      Object.defineProperty(v, "scrollTop", {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          data.writes.push([performance.now(), value]);
          descriptor.set.call(this, value);
        },
      });
      v.addEventListener("scroll", scroll, { capture: true, passive: true });
      v.addEventListener("wheel", wheel, { capture: true, passive: true });
      v.addEventListener("scrollend", end);
      addEventListener("error", error);
      addEventListener("unhandledrejection", error);
      addEventListener("blur", invalidation);
      addEventListener("resize", invalidation);
      document.addEventListener("visibilitychange", invalidation);
      document.addEventListener("click", command, true);
      observer = new MutationObserver((records) => {
        recordPillChanges(records, "inline");
        const now = performance.now();
        data.mutations.push([now, records.length]);
        let added = 0;
        let removed = 0;
        for (const record of records) {
          if (
            record.target !== v.firstElementChild ||
            record.type !== "childList"
          )
            continue;
          added += record.addedNodes.length;
          removed += record.removedNodes.length;
        }
        if (added || removed) data.rowChanges.push([now, added, removed]);
      });
      observer.observe(v, { attributes: true, subtree: true, childList: true });
      const pillOverlay = v.parentElement.querySelector(".vl-sticky-header");
      if (pillOverlay) {
        pillObserver = new MutationObserver((records) =>
          recordPillChanges(records, "overlay"),
        );
        pillObserver.observe(pillOverlay, {
          attributes: true,
          subtree: true,
          childList: true,
        });
      }
      data.initial = {
        ...state(),
        ...geometry(),
        focused: document.hasFocus(),
        layers,
      };
      if (!document.hasFocus()) data.invalidations.push("unfocused-start");
      frame = requestAnimationFrame(sample);
      const entryTypes = ["longtask", "long-animation-frame"].filter((type) =>
        PerformanceObserver.supportedEntryTypes.includes(type),
      );
      if (entryTypes.length) {
        data.longTasks = [];
        performanceObserver = new PerformanceObserver((list) =>
          data.longTasks.push(...list.getEntries().map((e) => e.toJSON())),
        );
        performanceObserver.observe({ entryTypes });
      }
      await post("started", data.initial);
    } else if (message.action === "mark") {
      data.marks.push({ ...message, ...state() });
    } else if (message.action === "top") {
      const button = document.querySelector("#scroll-top-btn");
      data.marks.push({
        label: "top-command",
        sequence: message.sequence,
        disabled: button?.disabled ?? null,
        ...state(),
      });
      if (!button || button.disabled) {
        data.errors.push("Top command unavailable");
      } else button.click();
      await post("command", { sequence: message.sequence });
    } else if (message.action === "stop" && active) {
      active = false;
      if (globalThis.__runtimeAudit)
        data.runtimeAudit = globalThis.__runtimeAudit.stop();
      cancelAnimationFrame(frame);
      for (const timer of geometryTimers) clearTimeout(timer);
      geometryTimers.clear();
      delete globalThis.__probeBoundary;
      observer.disconnect();
      pillObserver?.disconnect();
      performanceObserver?.disconnect();
      v.removeEventListener("scroll", scroll, true);
      v.removeEventListener("wheel", wheel, true);
      v.removeEventListener("scrollend", end);
      removeEventListener("error", error);
      removeEventListener("unhandledrejection", error);
      removeEventListener("blur", invalidation);
      removeEventListener("resize", invalidation);
      removeEventListener("keydown", markEvent);
      document.removeEventListener("visibilitychange", invalidation);
      document.removeEventListener("click", command, true);
      if (own) Object.defineProperty(v, "scrollTop", own);
      else delete v.scrollTop;
      data.final = { ...state(), ...geometry() };
      events.close();
      await post("result", data);
    }
  };
  const resourcePaths = new Set(
    [
      ...[...document.scripts].map((script) => script.src).filter(Boolean),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].flatMap((url) => {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin ? [parsed.pathname] : [];
    }),
  );
  const assets = {
    viteClient: [...resourcePaths].filter((path) => path === "/@vite/client")
      .length,
    sourceTS: [...resourcePaths].filter((path) => /\.[cm]?tsx?$/.test(path))
      .length,
    bundledJS: [...resourcePaths].filter((path) =>
      /^\/assets\/.*\.js$/.test(path),
    ).length,
  };
  await post("ready", {
    assets,
    importedImages,
    ...state(),
    x: screenX,
    y: screenY,
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
    dpr: devicePixelRatio,
    userAgent: navigator.userAgent,
    focused: document.hasFocus(),
    timeOrigin: performance.timeOrigin,
    performanceEntries: PerformanceObserver.supportedEntryTypes,
  });
}

try {
  const probePlugin = {
    name: "local-safari-probe",
    enforce: "pre",
    transform(code, id) {
      if (report.runtimeAudit) code = instrumentDemo(code, id);
      if (fixedItems && id.endsWith("/demos/gallery/gallery.ts")) {
        const signature =
          "function loadMore(edge: Edge, context: ReachContext): void {";
        assert.equal(
          code.split(signature).length,
          2,
          "Gallery paging hook changed",
        );
        return code.replace(
          signature,
          `${signature}\n context.complete(); return;`,
        );
      }
      if (id.endsWith("/src/virtual-list.ts")) {
        report.runtimeSourceSha256 = createHash("sha256")
          .update(code)
          .digest("hex");
        if (report.runtimeAudit) code = instrumentRuntime(code);
        if (recycling === "all") {
          const needle = "const requestedOverscan = options.overscanPx;";
          assert.equal(code.split(needle).length, 2, "Overscan setup changed");
          code = code.replace(needle, "const requestedOverscan = 1e9;");
        } else if (recycling === "retain") {
          const needle = "function retire(row: Row<T>): void {";
          assert.equal(code.split(needle).length, 2, "Row retirement changed");
          code = code.replace(needle, `${needle}\n return;`);
        }
      }
      if (id.endsWith("/src/virtual-list.ts") && process.env.GEOMETRY === "1") {
        assert.equal(
          code.split("canvas.appendChild(row.slot);").length,
          2,
          "Mount boundary changed",
        );
        assert.equal(
          code.split("row.slot?.remove();\n    if (!retainSlot").length,
          2,
          "Unmount boundary changed",
        );
        return code
          .replace(
            "canvas.appendChild(row.slot);",
            'globalThis.__probeBoundary?.(canvas,"before-mount",row.key); canvas.appendChild(row.slot); globalThis.__probeBoundary?.(canvas,"after-mount",row.key);',
          )
          .replace(
            "row.slot?.remove();\n    if (!retainSlot",
            'globalThis.__probeBoundary?.(canvas,"before-unmount",row.key); row.slot?.remove(); globalThis.__probeBoundary?.(canvas,"after-unmount",row.key);\n    if (!retainSlot',
          );
      }
      return code;
    },
    transformIndexHtml(html, ctx) {
      if (
        !ctx.path.includes("/demos/streaming") &&
        !ctx.path.includes("/demos/gallery")
      )
        return html;
      return [
        ...(report.runtimeAudit
          ? [
              {
                tag: "script",
                children: `(${installRuntimeAudit.toString()})();`,
                injectTo: "head-prepend",
              },
            ]
          : []),
        {
          tag: "script",
          children: `localStorage.setItem('virtual-list:gallery-options',${JSON.stringify(JSON.stringify(report.gallery))});`,
          injectTo: "head-prepend",
        },
        ...(process.env.MATCH_OPTIONS === "1"
          ? [
              {
                tag: "script",
                children: `localStorage.setItem('virtual-list:chat-options',JSON.stringify({edge:'slot',sticky:true,follow:'keep-start',landing:'prompt',cursor:'bar',trail:'long'}));localStorage.setItem('virtual-list-theme','system');`,
                injectTo: "head-prepend",
              },
            ]
          : []),
        {
          tag: "script",
          attrs: { type: "module" },
          children: `(${browserProbe.toString()})(${JSON.stringify(compositing)},${richChat},${JSON.stringify(pill)},${JSON.stringify(chatImport ? { ...chatImport, route: chatRoute } : null)});`,
          injectTo: "body",
        },
      ];
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (
          richChatSource &&
          req.url === "/scripts/firefox-profile/fixtures/rich-chat.js"
        ) {
          res.writeHead(req.method === "GET" ? 200 : 405, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            Allow: "GET",
          });
          res.end(req.method === "GET" ? richChatSource : undefined);
          return;
        }
        if (chatRoute && req.url === chatRoute) {
          res.setHeader("Cache-Control", "no-store");
          if (req.method !== "GET") {
            res.writeHead(405, { Allow: "GET" });
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Length": chatBuffer.length,
          });
          res.end(chatBuffer);
          return;
        }
        if (req.url === "/__probe/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          channels.add(res);
          res.on("close", () => {
            channels.delete(res);
            if (channel === res) channel = undefined;
          });
          channel = res;
          return;
        }
        if (!req.url?.startsWith("/__probe/")) return next();
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8e6) req.destroy();
        });
        req.on("end", () => {
          try {
            const value = JSON.parse(body);
            if (req.url.endsWith("/ready")) ready = value;
            else if (req.url.endsWith("/started")) started = value;
            else if (req.url.endsWith("/result")) result = value;
            else if (req.url.endsWith("/calibrated")) calibrated = value;
            else if (req.url.endsWith("/command"))
              commandAcknowledged = value.sequence;
            else if (req.url.endsWith("/import-status"))
              Object.assign(report.chatImport, value);
            res.end("ok");
          } catch {
            res.statusCode = 400;
            res.end("bad data");
          }
        });
      });
    },
    configurePreviewServer(vite) {
      probePlugin.configureServer(vite);
    },
  };
  const config = {
    logLevel: "error",
    cacheDir: `${dir}/cache`,
    plugins: [probePlugin],
  };
  if (serveMode === "production") {
    const productionConfig = {
      ...config,
      build: { outDir: `${dir}/site`, emptyOutDir: true },
    };
    console.log("Building production diagnostic site");
    await viteBuild(productionConfig);
    server = await createPreviewServer({
      ...productionConfig,
      preview: { host: "127.0.0.1", port: 0, open: false },
    });
  } else {
    server = await createServer({
      ...config,
      server: { host: "127.0.0.1", port: 0, open: false, hmr: false },
    });
    await server.listen();
  }
  const url = `${server.resolvedUrls.local[0]}demos/${demo}/`;
  report.url = url;
  // Capture ownership before navigation or bounds changes can fail.
  const apple = `tell ${appleApplication}
    make new document with properties {URL:"about:blank"}
    return id of front window
  end tell`;
  windowId = Number(
    (await exec("osascript", ["-e", apple], { timeout: 20000 })).stdout.trim(),
  );
  assert.ok(Number.isInteger(windowId) && windowId > 0);
  report.windowId = windowId;
  await exec("osascript", [
    "-e",
    `tell ${appleApplication}
    set bounds of window id ${windowId} to {${screen.x}, ${screen.y}, ${screen.x + screen.width}, ${screen.y + screen.height}}
    set URL of current tab of window id ${windowId} to "${url}"
    activate
  end tell`,
  ]);
  console.log(`Opened normal ${application.name} window`, windowId, url);
  await waitFor(() => {
    if (report.chatImport?.status === "failed")
      throw new Error("Transcript import failed; see import metadata");
    return ready && channel;
  });
  report.initial = ready;
  if (serveMode === "production") {
    assert.equal(
      ready.assets?.viteClient,
      0,
      "Production capture loaded the Vite client",
    );
    assert.equal(
      ready.assets?.sourceTS,
      0,
      "Production capture loaded source TypeScript",
    );
    assert.ok(
      ready.assets?.bundledJS > 0,
      "Production capture did not load bundled JavaScript",
    );
  }
  try {
    validateDisplay(screen, ready);
  } catch {
    await exec("osascript", [
      "-e",
      `tell ${appleApplication} to set bounds of window id ${windowId} to {${screen.x}, ${screen.y}, ${screen.x + screen.width}, ${screen.y + screen.height}}`,
    ]);
    await pause(1000);
    const actual = JSON.parse(
      (
        await exec("osascript", [
          "-e",
          `tell ${appleApplication} to do JavaScript "JSON.stringify({x:screenX,y:screenY,innerWidth,innerHeight,outerWidth,outerHeight,height:document.querySelector('#viewport').clientHeight,dpr:devicePixelRatio})" in current tab of window id ${windowId}`,
        ])
      ).stdout,
    );
    Object.assign(ready, actual);
    validateDisplay(screen, ready);
  }
  const appPids = (
    await exec("osascript", [
      "-e",
      `tell application "System Events" to get unix id of every application process whose bundle identifier is ${JSON.stringify(application.bundleId)}`,
    ])
  ).stdout
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  assert.ok(
    appPids.length === 1 && Number.isInteger(appPids[0]) && appPids[0] > 0,
    `Expected one running ${application.name} process, found: ${appPids.join(", ")}`,
  );
  const pid = String(appPids[0]);
  report.browser.pid = appPids[0];
  const x = screen.x + screen.width / 2,
    y = screen.y + screen.height / 2;
  await exec(native, ["focus", pid, String(x), String(y)]);
  const candidates = contentPids(),
    before = cpuTimes(candidates);
  send({ action: "calibrate" });
  await waitFor(() => calibrated);
  const after = cpuTimes(candidates);
  const increases = candidates
    .map((pid) => ({ pid, seconds: after.get(pid) - before.get(pid) }))
    .filter(({ seconds }) => Number.isFinite(seconds) && seconds >= 0)
    .sort((a, b) => b.seconds - a.seconds);
  report.cpuCalibration = increases;
  if (
    process.env.SAMPLE === "1" &&
    increases[0]?.seconds > 0.4 &&
    (!increases[1] || increases[1].seconds < 0.2)
  ) {
    report.samplePid = increases[0].pid;
    sampler = spawn(
      "/usr/bin/sample",
      [
        String(report.samplePid),
        "19",
        "10",
        "-file",
        `${dir}/content-sample.txt`,
      ],
      { stdio: "ignore", timeout: 25000 },
    );
    sampleDone = new Promise((resolve) => {
      sampler.once("error", (error) => resolve({ error: String(error) }));
      sampler.once("close", (code, signal) => resolve({ code, signal }));
    });
  }
  await pause(2000);
  send({ action: "start" });
  await waitFor(() => started);
  validateDisplay(screen, started);
  assert.equal(started.focused, true, "Invalid: test document is not focused");
  report.captureStart = started;
  console.log("Capturing native scroll", JSON.stringify(started));
  const cpuStart = cpuTimes(candidates),
    wallStart = Date.now();
  if (manual) {
    console.log(
      "MANUAL CAPTURE: scroll normally now; press J when jitter occurs.",
    );
    const until = Date.now() + manual * 1000;
    while (Date.now() < until) {
      if (aborted) throw new Error("Interrupted");
      await pause(200);
    }
  } else {
    const speed = 12 * (demo === "gallery" ? -1 : 1);
    for (const delta of [
      ...Array(rounds).fill(speed),
      ...Array(rounds).fill(-speed),
    ]) {
      if (aborted) throw new Error("Interrupted");
      send({ action: "mark", label: "gesture-start", delta });
      await pause(50);
      await exec(native, [
        "scroll",
        pid,
        String(x),
        String(y),
        String(delta),
        "90",
        "16667",
      ]);
      await pause(1200);
      send({ action: "mark", label: "gesture-end", delta });
      console.log("Finished gesture", delta);
    }
  }
  for (let sequence = 1; sequence <= topCommands; sequence++) {
    send({ action: "top", sequence });
    await waitFor(() => commandAcknowledged === sequence);
    await pause(6000);
    send({ action: "mark", label: "top-command-end", sequence });
  }
  send({ action: "stop" });
  await waitFor(() => result);
  const cpuEnd = cpuTimes(candidates);
  report.cpuWindow = {
    seconds: (Date.now() - wallStart) / 1000,
    processes: candidates.map((pid) => ({
      pid,
      cpuSeconds: cpuEnd.get(pid) - cpuStart.get(pid),
    })),
  };
  await writeFile(`${dir}/capture.json`, JSON.stringify(result));
  validateDisplay(screen, result.final);
  for (const key of [
    "x",
    "y",
    "innerWidth",
    "innerHeight",
    "outerWidth",
    "outerHeight",
    "dpr",
  ]) {
    assert.equal(
      result.final[key],
      started[key],
      `Invalid: browser ${key} changed during capture`,
    );
  }
  const times = result.frames
    .slice(1)
    .map((f, i) => f[0] - result.frames[i][0]);
  const sorted = [...times].sort((a, b) => a - b);
  report.summary = {
    frames: result.frames.length,
    maxFrameMs: Math.max(...times),
    p95: sorted[Math.floor(sorted.length * 0.95)],
    over25ms: times.filter((t) => t > 25).length,
    movingFrames: result.frames
      .slice(1)
      .filter((f, i) => f[1] !== result.frames[i][1]).length,
    scrolls: result.scrolls.length,
    wheels: result.wheels.length,
    ends: result.ends.length,
    writes: result.writes.length,
    rowBatches: result.rowChanges.length,
    mounted: result.rowChanges.reduce((sum, row) => sum + row[1], 0),
    unmounted: result.rowChanges.reduce((sum, row) => sum + row[2], 0),
    errors: result.errors,
    invalidations: result.invalidations,
    marks: result.marks,
  };
  validateCapture(report.summary, aborted);
  if (sampleDone) {
    report.sample = await sampleDone;
    assert.equal(
      report.sample.code,
      0,
      `Native sample failed: ${JSON.stringify(report.sample)}`,
    );
  }
  assert.equal(aborted, false, "Invalid: interrupted capture");
  report.status = "captured";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  const cleaned = await cleanupCapture(report, {
    sampler: async () => {
      if (sampler && sampler.exitCode === null && sampler.signalCode === null)
        sampler.kill("SIGTERM");
      if (sampleDone) await sampleDone;
    },
    window: async () => {
      if (windowId)
        await exec(
          "osascript",
          ["-e", `tell ${appleApplication} to close window id ${windowId}`],
          { timeout: 10000 },
        );
    },
    channel: () => {
      for (const connection of channels) connection.end();
    },
    server: async () => {
      await server?.close();
    },
  });
  if (!cleaned || aborted) {
    report.status = "failed";
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("Artifacts:", dir);
}
