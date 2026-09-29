import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const retained = new Set([
  "run.json",
  "summary.json",
  "reproduce.json",
  "reproduce.patch",
  "upstream.patch",
  "firefox-cpu.json",
  "firefox-attribution.json",
  "firefox-bursts.json",
  "chrome-analysis.json",
  "chrome-metrics.json",
  "safari-sample-summary.json",
  "cpu.json",
  "bursts.json",
  "attribution.json",
  "reproduce-setup.js",
]);

async function sourceSnapshot(root) {
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
  return { patch, hashes, revision: git(["rev-parse", "HEAD"]).trim() };
}

export async function writeReproduction(
  directory,
  report,
  root = process.cwd(),
) {
  const { patch, hashes } = await sourceSnapshot(root);
  const o = report.options ?? {};
  let command = report.command ?? ["pnpm", "run", "profile:chat", "--"];
  for (const [name, value] of Object.entries({
    browser: o.browser,
    scenario: o.scenario,
    mode: o.diagnostic ? "diagnostic" : "timing",
    "trace-invalidations": o.traceInvalidations,
    scheduler: o.scheduler,
    "safari-detached": o.safariDetached,
    "safari-snapshots": o.safariSnapshots,
    "safari-sample": o.safariSample
      ? [
          o.safariSample.atSeconds,
          o.safariSample.durationSeconds,
          o.safariSample.intervalMs,
        ].join(":")
      : undefined,
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
  if (report.cpuContention)
    command = [
      "node",
      "scripts/firefox-profile/cpu-contention.mjs",
      "--",
      ...command,
    ];
  let renderer;
  if (o.rendererPreview) {
    const snapshot = await sourceSnapshot(join(root, "../markdown-viewer"));
    await writeFile(join(directory, "upstream.patch"), snapshot.patch);
    renderer = {
      checkout: "../markdown-viewer",
      revision: snapshot.revision,
      sourceHashes: snapshot.hashes,
      sourcePatch: "upstream.patch",
      build: ["pnpm", "run", "build"],
    };
    command = ["env", "MARKDOWN_VIEWER_LOCAL=1", ...command];
  }
  await writeFile(join(directory, "reproduce.patch"), patch);
  await writeFile(
    join(directory, "reproduce.json"),
    JSON.stringify(
      {
        schema: 1,
        revision: report.revision,
        command,
        renderer,
        cpuContention: report.cpuContention,
        sourceHashes: hashes,
        sourcePatch: "reproduce.patch",
        environment: report.environment ?? "run.json",
        instructions: [
          "Check out revision in a separate worktree; apply reproduce.patch there with git apply.",
          "Install the locked dependencies with pnpm install --frozen-lockfile.",
          ...(renderer
            ? [
                "For renderer preview, check out renderer.revision in the sibling markdown-viewer repository, install its locked dependencies, apply upstream.patch, and run renderer.build there.",
              ]
            : []),
          "If reproduce-setup.js is present, copy that input fixture into the checkout root before running the command.",
          `Match the browser build, display, scaling, refresh rate, and window geometry in ${report.environment ?? "run.json"}.`,
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
