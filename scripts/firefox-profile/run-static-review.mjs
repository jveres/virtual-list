// Sequential native captures; the runner owns browser/helper cleanup per run.
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const experiment = process.argv[2];
const mode = process.argv[3] ?? "chat";
if (!/^static-review-[a-zA-Z0-9]+$/.test(experiment ?? ""))
  throw new Error("Pass a prepared experiment directory name");
if (!["chat", "components", "current"].includes(mode))
  throw new Error(
    "Expected chat, components, or current (baseline versus working tree)",
  );
await access(resolve(root, "browser-artifacts", experiment, "experiment.json"));
let active;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    active?.kill(signal);
  });
const variants =
  mode === "components"
    ? ["components", "components", "components"]
    : mode === "current"
      ? ["baseline", "current", "current", "baseline", "baseline", "current"]
      : [
          "baseline",
          "resident",
          "paging",
          "paging",
          "resident",
          "baseline",
          "resident",
          "baseline",
          "paging",
        ];
for (const variant of variants) {
  if (interrupted) break;
  const base = `http://127.0.0.1:4193/browser-artifacts/${experiment}`;
  const url =
    mode === "components"
      ? `http://127.0.0.1:4193/scripts/firefox-profile/fixtures/static-review.html?root=/browser-artifacts/${experiment}`
      : variant === "current"
        ? "http://127.0.0.1:4193/demos/streaming/"
        : `${base}/${variant}/demos/streaming/`;
  const args = [
    "run",
    "profile:firefox",
    "--",
    "--display=LU28R55",
    `--url=${url}`,
    "--layout=none",
    `--down=${mode === "components" ? 6 : 0}`,
    `--up=${mode === "components" ? 6 : 12}`,
    "--ticks=90",
    "--delta=60",
    "--warmup-ms=2000",
    "--live",
  ];
  if (mode !== "components")
    args.push(
      "--setup=scripts/firefox-profile/fixtures/static-review-stream.js",
    );
  const code = await new Promise((resolveCode, reject) => {
    active = spawn("pnpm", args, { cwd: root, stdio: "inherit" });
    active.once("error", reject);
    active.once("exit", (code) => resolveCode(code));
  });
  active = undefined;
  if (code !== 0) {
    process.exitCode = 1;
    break;
  }
}
