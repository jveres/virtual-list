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
  "parser.patch",
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
    /^(src\/|demos\/|integrations\/|patches\/|scripts\/|vendor\/|bench\/|\.cargo\/|Cargo\.(toml|lock)$|build\.rs$|rust-toolchain(\.toml)?$|index\.js$|types\.d\.ts$|package\.json$|pnpm-(lock|workspace)\.yaml$|vite\.config\.|tsconfig\.)/.test(
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

// Record the bytes served by a preview without retaining generated binaries.
async function buildHashes(root, directory) {
  const hashes = {};
  const visit = async (path) => {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile() && /\.(?:js|css|wasm)$/.test(entry.name))
        hashes[relative] = createHash("sha256")
          .update(await readFile(join(root, relative)))
          .digest("hex");
    }
  };
  await visit(directory);
  if (Object.keys(hashes).length === 0)
    throw new Error(`No built preview artifacts in ${directory}`);
  return hashes;
}

function toolVersion(command, root) {
  try {
    const version = execFileSync(command, ["--version"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 3000,
      maxBuffer: 64 * 1024,
    }).trim();
    return { available: true, version };
  } catch (error) {
    return {
      available: false,
      reason: String(error.code ?? `exit ${error.status ?? "unknown"}`),
    };
  }
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
    "pointer-x": o.pointerX,
    seconds: o.seconds,
    "stream-ms": o.durationMs,
    sections: o.sections,
    history: o.history,
    "history-content": o.historyContent,
    content: o.content,
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
  let parser;
  const previewEnvironment = [];
  if (o.rendererPreview) {
    const rendererRoot = join(root, "../markdown-viewer");
    const snapshot = await sourceSnapshot(rendererRoot);
    await writeFile(join(directory, "upstream.patch"), snapshot.patch);
    renderer = {
      checkout: "../markdown-viewer",
      revision: snapshot.revision,
      sourceHashes: snapshot.hashes,
      buildHashes: await buildHashes(rendererRoot, "dist"),
      sourcePatch: "upstream.patch",
      build: ["pnpm", "run", "build"],
    };
    previewEnvironment.push("MARKDOWN_VIEWER_LOCAL=1");
  }
  if (o.parserPreview) {
    const parserRoot = join(root, "../comrak-wasm");
    const snapshot = await sourceSnapshot(parserRoot);
    await writeFile(join(directory, "parser.patch"), snapshot.patch);
    parser = {
      checkout: "../comrak-wasm",
      revision: snapshot.revision,
      sourceHashes: snapshot.hashes,
      buildHashes: await buildHashes(parserRoot, "pkg"),
      toolchain: Object.fromEntries(
        ["rustc", "wasm-bindgen", "wasm-opt"].map((command) => [
          command,
          toolVersion(command, parserRoot),
        ]),
      ),
      sourcePatch: "parser.patch",
      build: ["pnpm", "run", "build"],
    };
    previewEnvironment.push("COMRAK_WASM_LOCAL=1");
  }
  if (previewEnvironment.length)
    command = ["env", ...previewEnvironment, ...command];
  await writeFile(join(directory, "reproduce.patch"), patch);
  await writeFile(
    join(directory, "reproduce.json"),
    JSON.stringify(
      {
        schema: 1,
        revision: report.revision,
        command,
        renderer,
        parser,
        cpuContention: report.cpuContention,
        sourceHashes: hashes,
        sourcePatch: "reproduce.patch",
        environment: report.environment ?? "run.json",
        instructions: [
          "Check out revision in a separate worktree; apply reproduce.patch there with git apply.",
          "Install the locked dependencies with pnpm install --frozen-lockfile.",
          ...(parser
            ? [
                "For parser preview, check out parser.revision in the sibling comrak-wasm repository, apply parser.patch, install its locked dependencies, and run parser.build with the recorded parser.toolchain versions when available.",
                "Compare regenerated parser.buildHashes before capturing. A mismatch means the served build differs; unavailable tool versions are recorded explicitly and do not prove build equivalence.",
              ]
            : []),
          ...(renderer
            ? [
                "For renderer preview, check out renderer.revision in the sibling markdown-viewer repository, apply upstream.patch, install its locked dependencies, and run renderer.build there. Compare regenerated renderer.buildHashes before capturing.",
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
