import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

// Diagnostic capture, not a pass/fail test of physical scroll presentation.
// See docs/reports/scroll-presentation-investigation-2026-09-20.md.
if (process.argv.includes("--help")) {
  console.log(
    "Run with a local demo server on port 5173. PROBE_VARIANT=current|no-pill-paint|sticky-off|no-spinner; PROBE_RUNS=1..10; PROBE_DEFAULT_ONLY=1. No-spinner hides the paging spinner and disables its animation without changing layout. Uses installed Chrome and an external display at x=1440. Raw captures stay in browser-artifacts.",
  );
  process.exit(0);
}
const outputRoot = new URL(
  "../../browser-artifacts/chrome-scroll-top/",
  import.meta.url,
);
await mkdir(outputRoot, { recursive: true });
const outputDir = await mkdtemp(new URL("run-", outputRoot).pathname);
console.log("Capture directory:", outputDir);
const variant = process.env.PROBE_VARIANT ?? "current";
const label = process.env.PROBE_LABEL ?? "";
if (
  !["current", "no-pill-paint", "sticky-off", "no-spinner"].includes(variant) ||
  !/^[a-z0-9-]*$/.test(label)
)
  throw Error("Invalid probe variant/label");
const count = Number(process.env.PROBE_RUNS ?? 4);
if (!Number.isInteger(count) || count < 1 || count > 10)
  throw Error("Invalid run count");
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--window-position=1440,0", "--window-size=1920,1080"],
});
const shutdown = () => {
  void browser.close().finally(() => process.exit(130));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  const context = await browser.newContext({ viewport: null });
  if (variant === "sticky-off")
    await context.addInitScript(() =>
      localStorage.setItem(
        "virtual-list:chat-options",
        JSON.stringify({ sticky: false }),
      ),
    );
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: {
      left: 1440,
      top: 0,
      width: 1920,
      height: 1080,
      windowState: "normal",
    },
  });
  const errors = [];
  const metadata = {
    variant,
    label,
    browser: browser.version(),
    startedAt: new Date().toISOString(),
    geometry: null,
  };
  page.on("pageerror", (error) => errors.push(String(error)));
  for (const workload of process.env.PROBE_DEFAULT_ONLY === "1"
    ? ["default"]
    : ["default", "rich"]) {
    await page.goto("http://localhost:5173/demos/streaming/?instant");
    await page.waitForFunction(
      () =>
        !document.documentElement.classList.contains("booting") &&
        document.querySelector("#viewport")?.scrollHeight > 1500,
    );
    await page.evaluate(() => document.fonts.ready);
    if (variant === "no-pill-paint")
      await page.addStyleTag({
        content:
          ".section-header-pill{visibility:hidden!important}.vl-sticky-header{display:none!important}",
      });
    if (variant === "no-spinner")
      await page.addStyleTag({
        content:
          ".boundary-spinner{visibility:hidden!important;animation:none!important}",
      });
    if (workload === "rich") {
      await page.evaluate(
        await readFile(
          new URL("./fixtures/rich-chat.js", import.meta.url),
          "utf8",
        ),
      );
      await page.waitForFunction(() =>
        document.querySelector("#window-status")?.textContent.includes("/160"),
      );
    }
    await page.waitForTimeout(2500);
    metadata.geometry = await page.evaluate(() => ({
      screenX,
      screenY,
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      dpr: devicePixelRatio,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
    }));
    if (
      !metadata.geometry.focused ||
      metadata.geometry.visibility !== "visible"
    )
      throw Error("Capture window is not focused and visible; run excluded.");
    console.log(JSON.stringify({ workload, ...metadata }));
    await cdp.send("Tracing.start", {
      categories:
        "devtools.timeline,blink.user_timing,toplevel,v8,gpu,cc,skia,disabled-by-default-gpu.service",
      transferMode: "ReturnAsStream",
    });
    const results = [];
    for (let run = 0; run < count; run++) {
      if (run) {
        await page.evaluate(() =>
          document.querySelector("#scroll-bottom-btn").click(),
        );
        await page.waitForTimeout(2200);
      }
      const result = await page.evaluate(
        async ({ workload, run }) => {
          const v = document.querySelector("#viewport");
          const own = Object.getOwnPropertyDescriptor(v, "scrollTop");
          const descriptor =
            own ??
            Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
          const data = {
            workload,
            run,
            initial: {
              top: v.scrollTop,
              height: v.scrollHeight,
              client: v.clientHeight,
              range: document.querySelector("#window-status").textContent,
            },
            frames: [],
            scrolls: [],
            writes: [],
            ends: [],
            rows: [],
            states: [],
            longTasks: [],
            invalidations: [],
          };
          let top = v.scrollTop,
            frame = 0;
          const start = performance.now();
          const now = () => performance.now() - start;
          const scroll = () => {
            top = v.scrollTop;
            data.scrolls.push([now(), top]);
          };
          const end = () => data.ends.push(now());
          const invalid = (e) => data.invalidations.push([now(), e.type]);
          if (!document.hasFocus() || document.visibilityState !== "visible")
            data.invalidations.push([now(), "initial-focus-or-visibility"]);
          document.addEventListener("visibilitychange", invalid);
          const tick = (t) => {
            data.frames.push([t - start, top]);
            frame = requestAnimationFrame(tick);
          };
          Object.defineProperty(v, "scrollTop", {
            configurable: true,
            get() {
              return descriptor.get.call(this);
            },
            set(value) {
              data.writes.push([now(), value]);
              descriptor.set.call(this, value);
            },
          });
          v.addEventListener("scroll", scroll, {
            capture: true,
            passive: true,
          });
          v.addEventListener("scrollend", end);
          window.addEventListener("blur", invalid);
          window.addEventListener("resize", invalid);
          const longTasks = new PerformanceObserver((list) =>
            data.longTasks.push(
              ...list.getEntries().map((e) => ({
                start: e.startTime - start,
                duration: e.duration,
                name: e.name,
              })),
            ),
          );
          longTasks.observe({ type: "longtask" });
          const rows = new MutationObserver((records) => {
            let added = 0,
              removed = 0;
            for (const r of records) {
              added += r.addedNodes.length;
              removed += r.removedNodes.length;
            }
            data.rows.push([now(), added, removed]);
          });
          rows.observe(v.firstElementChild, { childList: true });
          const status = new MutationObserver(() =>
            data.states.push([
              now(),
              document.querySelector("#window-status").textContent,
              document.querySelector(".boundary-slot-label")?.textContent,
            ]),
          );
          status.observe(document.querySelector("#window-status"), {
            childList: true,
            subtree: true,
            characterData: true,
          });
          frame = requestAnimationFrame(tick);
          performance.mark(`top-probe-${workload}-${run}-start`);
          document.querySelector("#scroll-top-btn").click();
          await new Promise((resolve) => setTimeout(resolve, 4000));
          performance.mark(`top-probe-${workload}-${run}-end`);
          cancelAnimationFrame(frame);
          rows.disconnect();
          status.disconnect();
          longTasks.disconnect();
          v.removeEventListener("scroll", scroll, true);
          v.removeEventListener("scrollend", end);
          document.removeEventListener("visibilitychange", invalid);
          window.removeEventListener("blur", invalid);
          window.removeEventListener("resize", invalid);
          if (own) Object.defineProperty(v, "scrollTop", own);
          else delete v.scrollTop;
          data.final = {
            top: v.scrollTop,
            height: v.scrollHeight,
            range: document.querySelector("#window-status").textContent,
          };
          const gaps = data.frames.slice(1).map((f, i) => ({
            at: f[0],
            ms: f[0] - data.frames[i][0],
            top: f[1],
          }));
          data.summary = {
            maxFrameMs: Math.max(...gaps.map((x) => x.ms)),
            gapsOver50: gaps.filter((x) => x.ms > 50),
            firstZero: data.scrolls.find((x) => x[1] === 0)?.[0],
            lastWrite: data.writes.at(-1),
            longTasks: data.longTasks,
            invalidations: data.invalidations,
          };
          return data;
        },
        { workload, run },
      );
      results.push(result);
      console.log(
        JSON.stringify({
          workload,
          run,
          initial: result.initial,
          final: result.final,
          ...result.summary,
        }),
      );
    }
    const completed = new Promise((resolve) =>
      cdp.once("Tracing.tracingComplete", resolve),
    );
    await cdp.send("Tracing.end");
    const { stream } = await completed;
    const chunks = [];
    for (;;) {
      const part = await cdp.send("IO.read", { handle: stream });
      chunks.push(
        Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8"),
      );
      if (part.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    await writeFile(
      `${outputDir}/${workload}-trace.json.gz`,
      gzipSync(Buffer.concat(chunks)),
    );
    await writeFile(
      `${outputDir}/${workload}-measurements.json`,
      JSON.stringify({ ...metadata, errors, results }, null, 2),
    );
  }
} finally {
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  await browser.close();
}
