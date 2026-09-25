import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const retained = new Set([
  "run.json",
  "summary.json",
  "reproduce.json",
  "reproduce.patch",
  "firefox-cpu.json",
  "firefox-attribution.json",
  "firefox-bursts.json",
  "chrome-analysis.json",
  "chrome-metrics.json",
  "cpu.json",
  "bursts.json",
  "attribution.json",
  "reproduce-setup.js",
]);

export async function writeReproduction(
  directory,
  report,
  root = process.cwd(),
) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const relevant = (path) =>
    /^(src\/|demos\/|integrations\/|patches\/|scripts\/|package\.json$|pnpm-(lock|workspace)\.yaml$|vite\.config\.|tsconfig\.)/.test(
      path,
    );
  const tracked = [
    ...new Set([
      ...git(["ls-files", "-z"]).split("\0"),
      ...git(["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0"),
    ]),
  ].filter(relevant);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(relevant);
  const hashes = {};
  for (const path of [...new Set([...tracked, ...untracked])].sort()) {
    const content = await readFile(join(root, path)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hashes[path] =
      content === null
        ? null
        : createHash("sha256").update(content).digest("hex");
  }
  let patch = tracked.length
    ? git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "HEAD",
        "--",
        ...tracked,
      ])
    : "";
  for (const path of untracked) {
    try {
      patch += git([
        "diff",
        "--no-ext-diff",
        "--no-index",
        "--binary",
        "--",
        "/dev/null",
        path,
      ]);
    } catch (error) {
      if (error.status !== 1) throw error;
      patch += error.stdout;
    }
  }
  const o = report.options ?? {};
  const command = report.command ?? ["pnpm", "run", "profile:chat", "--"];
  for (const [name, value] of Object.entries({
    browser: o.browser,
    scenario: o.scenario,
    mode: o.diagnostic ? "diagnostic" : "timing",
    "trace-invalidations": o.traceInvalidations,
    scheduler: o.scheduler,
    "safari-detached": o.safariDetached,
    display: o.display,
    "refresh-hz": o.refreshHz,
    seconds: o.seconds,
    "stream-ms": o.durationMs,
    sections: o.sections,
    history: o.history,
    trail: o.trail,
  }))
    if (!report.command && value !== undefined && value !== false)
      command.push(value === true ? `--${name}` : `--${name}=${value}`);
  await writeFile(join(directory, "reproduce.patch"), patch);
  await writeFile(
    join(directory, "reproduce.json"),
    JSON.stringify(
      {
        schema: 1,
        revision: report.revision,
        command,
        sourceHashes: hashes,
        sourcePatch: "reproduce.patch",
        environment: "run.json",
        instructions: [
          "Check out revision in a separate worktree; apply reproduce.patch there with git apply.",
          "Install the locked dependencies with pnpm install --frozen-lockfile.",
          "If reproduce-setup.js is present, copy that input fixture into the checkout root before running the command.",
          "Match the browser build, display, scaling, refresh rate, and window geometry in run.json.",
          "Run command as an argument array from that checkout. Compare workload hashes and validity before interpreting timing.",
          "This reproduces code, synthetic input, and procedure; OS scheduling and physical gestures cannot be replayed exactly.",
        ],
      },
      null,
      2,
    ),
  );
}

// Only call with the unique, runner-owned directory, after analysis and shutdown.
export async function discardRaw(directory) {
  const removed = [];
  for (const name of await readdir(directory)) {
    if (retained.has(name)) continue;
    await rm(join(directory, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
