// Opt-in real-engine gate: the dynamic-height lab (contract violations
// counted from outside the runtime) and the streaming chat's product-level
// invariants (scripts/chat-invariants.mjs), plus refresh anchoring transitions.
//
// Usage:
//   pnpm run test:browser                       (lab and chat, every engine)
//   pnpm run test:browser -- --suite=chat --engine=webkit
//   pnpm run test:browser -- --suite=refresh-anchors --engine=firefox
//   pnpm run test:browser -- --suite=generated-files --engine=firefox
//   pnpm run test:browser -- --quick --engine=webkit --mode=live
//   pnpm run test:browser -- --chaos=300 --engine=webkit   (seconds of chaos)
//   --seed=<n> makes the chaos wheel input reproducible; --headed shows the browser
//
// Install engines once with:
//   pnpm exec playwright install chromium firefox webkit

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium, firefox, webkit } from "playwright";
import { runChatCase } from "./chat-invariants.mjs";

const HOST = "127.0.0.1";
const PORT = 4173;
const DEFAULT_URL = `http://${HOST}:${PORT}`;
const LAB_PATH = "/demos/dynamic-height/index.html";
const ALL_ENGINES = ["chromium", "firefox", "webkit"];
const ALL_MODES = ["same-height", "freeze", "live"];
const KNOWN_WARNINGS = ["scroll-linked positioning effect"];
const EXPECTED_STRATEGY = {
  chromium: "chromium-wheel",
  firefox: "firefox-wheel",
  webkit: "safari-wheel",
};

function option(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function selected(value, choices, label) {
  if (value === undefined) return choices;
  if (!choices.includes(value)) {
    throw new Error(`unknown ${label} "${value}"`);
  }
  return [value];
}

const engines = selected(option("engine"), ALL_ENGINES, "engine");
const ALL_SUITES = ["lab", "chat", "refresh-anchors", "generated-files"];
const suites =
  option("suite") === undefined || option("suite") === "all"
    ? ALL_SUITES
    : selected(option("suite"), ALL_SUITES, "suite");
const modes = selected(option("mode"), ALL_MODES, "mode");
const quick = process.argv.includes("--quick");
const chaosSeconds = Number(option("chaos") ?? 0);
const seed = Number(option("seed") ?? Date.now() % 1_000_000);
if (!Number.isFinite(chaosSeconds) || chaosSeconds < 0) {
  throw new Error("--chaos must be a non-negative number of seconds");
}
if (!Number.isFinite(seed)) throw new Error("--seed must be a finite number");
const headed = process.argv.includes("--headed");
const externalUrl = process.env.BROWSER_MATRIX_URL;
const baseUrl = externalUrl ?? DEFAULT_URL;
const artifactRoot = resolve(
  process.env.BROWSER_MATRIX_ARTIFACTS ?? "browser-artifacts",
);

function viteExecutable() {
  return resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vite.cmd" : "vite",
  );
}

async function waitForServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

async function startServer() {
  if (externalUrl) return null;
  const output = [];
  const child = spawn(
    viteExecutable(),
    ["--host", HOST, "--port", String(PORT), "--strictPort"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForServer(baseUrl);
    return child;
  } catch (error) {
    child.kill("SIGTERM");
    process.stderr.write(output.join(""));
    throw error;
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

function browserType(engine) {
  if (engine === "chromium") return chromium;
  if (engine === "firefox") return firefox;
  return webkit;
}

async function wheel(page, deltaY, steps, gapMs = 16) {
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(gapMs);
  }
}

// Scenario delimiters go into the trace ring (what artifacts and results
// are read from) as well as the on-screen log.
async function mark(page, message) {
  await page.evaluate((text) => {
    const line = `=== ${text}`;
    window.labTrace?.push(line);
    const span = document.createElement("span");
    span.className = "mark";
    span.textContent = `${line}\n`;
    document.getElementById("log")?.appendChild(span);
  }, message);
}

async function runQuickScenario(page) {
  await mark(page, "quick: flick up");
  await wheel(page, -120, 30);
  await page.waitForTimeout(2_000);
  await mark(page, "quick: flick down");
  await wheel(page, 120, 60);
  await page.waitForTimeout(2_000);
}

async function runFullScenario(page) {
  // Start from the deterministic mid-list boot while the first bottom edge
  // is still armed. This is the physical Safari race: a page is held at the
  // bottom, then fresh upward input arrives before the bottom release settles.
  await mark(page, "bottom load: reverse before settle");
  await wheel(page, 200, 60);
  await page.waitForFunction(
    () => document.getElementById("s-held-t")?.textContent === "yes",
    undefined,
    { timeout: 1_000 },
  );
  await page.waitForTimeout(90);
  await wheel(page, -90, 18, 20);
  await page.waitForTimeout(2_500);

  await mark(page, "flick up toward top (load)");
  await wheel(page, -120, 25);
  await page.waitForTimeout(1_800);
  await mark(page, "flick up again");
  await wheel(page, -160, 40);
  await page.waitForTimeout(2_200);
  await mark(page, "flick down to bottom");
  await wheel(page, 160, 90);
  await page.waitForTimeout(2_200);
  await mark(page, "width button");
  await page.click("#width");
  await page.waitForTimeout(1_000);
  await mark(page, "burst");
  await page.click("#burst");
  await page.waitForTimeout(800);
  await mark(page, "delete anchor");
  await page.click("#delete-anchor");
  await page.waitForTimeout(800);
  await mark(page, "delete random");
  await page.click("#delete-random");
  await page.waitForTimeout(800);
  await mark(page, "glide top");
  await page.click("#glide-top");
  await page.waitForTimeout(3_500);
  await mark(page, "width change during glide bottom");
  await page.click("#glide-bottom");
  await page.waitForTimeout(200);
  // Change layout without a pointer event that could cancel the glide first.
  await page.locator("#width").evaluate((button) => button.click());
  await page.waitForTimeout(1_000);
  await mark(page, "glide bottom");
  await page.click("#glide-bottom");
  await page.waitForTimeout(3_500);
  await mark(page, "slow scroll up while streaming");
  await wheel(page, -40, 80, 40);
  await page.waitForTimeout(2_200);
  await mark(page, "scroll down, interrupt with reversal");
  await wheel(page, 100, 20);
  await wheel(page, -100, 20);
  await page.waitForTimeout(2_200);
  await mark(page, "width jitter while scrolling");
  await page.check("#width-jitter");
  await wheel(page, 60, 70, 45);
  await page.waitForTimeout(3_000);
  await page.uncheck("#width-jitter");
  await mark(page, "replace mode scroll");
  await page.check("#replace");
  await wheel(page, -90, 40, 30);
  await page.waitForTimeout(2_200);
  await page.uncheck("#replace");
  await mark(page, "glide top then grab");
  await page.click("#glide-top");
  await page.waitForTimeout(300);
  await wheel(page, 120, 10);
  await page.waitForTimeout(2_500);
}

function mulberry32(seedValue) {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Chaos: the lab's in-page adversary runs (bursts, throwing renders,
 * inserts, reorders, deletions, commands, mode switches) while this loop
 * feeds random wheel input — flicks, slow drags, reversals, pauses — and
 * stops at the first violation its periodic check sees (within a few
 * seconds) so the trace around it stays short.
 */
async function runChaosScenario(page, seconds) {
  const random = mulberry32(seed);
  const pickInt = (min, max) => min + Math.floor(random() * (max - min + 1));
  await mark(page, `chaos start (seed ${seed}, ${seconds}s)`);
  await page.check("#chaos");
  const deadline = Date.now() + seconds * 1_000;
  let lastCheck = Date.now();
  while (Date.now() < deadline) {
    const roll = random();
    const direction = random() < 0.5 ? -1 : 1;
    if (roll < 0.35) {
      await wheel(
        page,
        direction * pickInt(60, 220),
        pickInt(4, 40),
        pickInt(8, 30),
      );
    } else if (roll < 0.55) {
      await wheel(
        page,
        direction * pickInt(15, 60),
        pickInt(20, 80),
        pickInt(30, 70),
      );
    } else if (roll < 0.7) {
      const delta = pickInt(60, 160);
      await wheel(page, direction * delta, pickInt(5, 20));
      await page.waitForTimeout(pickInt(0, 120));
      await wheel(page, -direction * delta, pickInt(5, 20));
    } else if (roll < 0.8) {
      for (let count = 0; count < pickInt(3, 8); count += 1) {
        await wheel(page, (count % 2 === 0 ? 1 : -1) * pickInt(40, 120), 2, 16);
      }
    } else {
      await page.waitForTimeout(pickInt(300, 2_600));
    }
    if (Date.now() - lastCheck > 3_000) {
      lastCheck = Date.now();
      const violations = await page.evaluate(
        () => document.getElementById("s-violations")?.textContent ?? "",
      );
      if (violations !== "0") {
        await mark(page, `chaos stopped at first violation (${violations})`);
        break;
      }
    }
  }
  await page.uncheck("#chaos");
  await page.waitForTimeout(2_500);
}

async function readResult(page) {
  return page.evaluate(() => {
    const cell = (id) => document.getElementById(id)?.textContent ?? "";
    return {
      violations: cell("s-violations"),
      paints: cell("s-paints"),
      commits: cell("s-commits"),
      nodes: cell("s-nodes"),
      clipped: cell("s-clipped"),
      strategy: cell("s-strategy"),
      // From the full ring, not the trimmed DOM log.
      bad: window.labTrace.filter((line) => line.includes("VIOLATION")),
    };
  });
}

async function runCase(engine, mode) {
  const launchOptions = { headless: !headed };
  if (engine === "chromium" && process.env.BROWSER_MATRIX_CHROMIUM_CHANNEL) {
    launchOptions.channel = process.env.BROWSER_MATRIX_CHROMIUM_CHANNEL;
  }
  const browser = await browserType(engine).launch(launchOptions);
  // Headless Chromium's own user agent routes to chromium-wheel (the
  // detector matches HeadlessChrome/), so no override is needed.
  const page = await browser.newPage({
    viewport: { width: 1200, height: 820 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`PAGEERROR ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`CONSOLE error ${message.text()}`);
      return;
    }
    if (
      message.type() === "warning" &&
      !KNOWN_WARNINGS.some((known) => message.text().includes(known))
    ) {
      errors.push(`CONSOLE warning ${message.text()}`);
    }
  });

  let result;
  let afterReset;
  try {
    await page.goto(`${baseUrl}${LAB_PATH}`);
    await page.waitForSelector("#viewport > div");
    await page.check("#verbose");
    await page.selectOption("#scrolling-updates", mode);
    await page.waitForTimeout(600);
    const box = await page.locator("#viewport").boundingBox();
    if (!box) throw new Error("dynamic-height viewport has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    if (chaosSeconds > 0) await runChaosScenario(page, chaosSeconds);
    else if (quick) await runQuickScenario(page);
    else await runFullScenario(page);
    result = await readResult(page);

    await mark(page, "reset (leak check)");
    await page.click("#reset");
    await page.waitForTimeout(800);
    // The lab zeroes its violation count before the dispose, so a leak at
    // reset lands here; the ring is re-read so its line reaches the
    // artifact.
    afterReset = await page.evaluate(() => ({
      violations: document.getElementById("s-violations")?.textContent ?? "",
      log: window.labTrace.join("\n"),
    }));
  } finally {
    if (!result || !afterReset) {
      await mkdir(artifactRoot, { recursive: true });
      const trace = await page
        .evaluate(() => window.labTrace?.join("\n") ?? "")
        .catch(() => "trace unavailable");
      await writeFile(
        resolve(artifactRoot, `${engine}-${mode}.log`),
        `${errors.join("\n")}\n${trace}`,
      );
      await page
        .screenshot({
          path: resolve(artifactRoot, `${engine}-${mode}.png`),
          fullPage: true,
        })
        .catch(() => {});
    }
    await browser.close();
  }

  const failed =
    result.strategy !== EXPECTED_STRATEGY[engine] ||
    result.violations !== "0" ||
    afterReset.violations !== "0" ||
    result.bad.length > 0 ||
    errors.length > 0;
  const summary = {
    engine,
    mode,
    strategy: result.strategy,
    violations: result.violations,
    resetViolations: afterReset.violations,
    paints: result.paints,
    commits: result.commits,
    nodes: result.nodes,
    clipped: result.clipped,
    errors,
    bad: result.bad,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failed) {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      resolve(artifactRoot, `${engine}-${mode}.log`),
      `${errors.join("\n")}\n${afterReset.log}`,
    );
    throw new Error(`${engine}/${mode} failed; see ${artifactRoot}`);
  }
}

async function runChat(engine) {
  const launchOptions = { headless: !headed };
  if (engine === "chromium" && process.env.BROWSER_MATRIX_CHROMIUM_CHANNEL) {
    launchOptions.channel = process.env.BROWSER_MATRIX_CHROMIUM_CHANNEL;
  }
  const browser = await browserType(engine).launch(launchOptions);
  let summary;
  try {
    summary = await runChatCase(engine, browser, baseUrl, {
      seed,
      chaosSeconds,
    });
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.violations.length > 0 || summary.errors.length > 0) {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      resolve(artifactRoot, `${engine}-chat.log`),
      [...summary.violations, ...summary.errors].join("\n"),
    );
    throw new Error(`${engine}/chat failed; see ${artifactRoot}`);
  }
}

async function runChatRegression(engine, suite) {
  const script =
    suite === "refresh-anchors"
      ? "scripts/regressions/chat-storage/chat-refresh-anchor-regression.mjs"
      : "scripts/regressions/chat-content/chat-generated-files-regression.mjs";
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(script)], {
      stdio: "inherit",
      env: {
        ...process.env,
        BROWSER_ENGINE: engine,
        BROWSER_MATRIX_URL: baseUrl,
        BROWSER_MATRIX_HEADED: headed ? "1" : "",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        reject(new Error(`${engine}/${suite} exited with ${signal ?? code}`));
    });
  });
}

let server;
try {
  server = await startServer();
  for (const engine of engines) {
    if (suites.includes("lab")) {
      for (const mode of modes) await runCase(engine, mode);
    }
    if (suites.includes("chat")) await runChat(engine);
    for (const suite of ["refresh-anchors", "generated-files"]) {
      if (suites.includes(suite)) await runChatRegression(engine, suite);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (/executable|browser.*not found/i.test(message)) {
    process.stderr.write(
      "Install engines with: pnpm exec playwright install chromium firefox webkit\n",
    );
  }
  process.exitCode = 1;
} finally {
  await stopServer(server);
}
