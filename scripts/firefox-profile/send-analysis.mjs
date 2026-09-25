import { isDeepStrictEqual } from "node:util";
import { distribution } from "./chat-analysis.mjs";

// A send transition ends at landing. Simulated reply timing is deliberately
// excluded: its random token delays are not a reproducible streaming workload.
export function analyzeSend(recording, setup) {
  const glide = recording.phases.find((p) => p.name === "send-glide");
  const landed = recording.phases.find((p) => p.name === "send-landed");
  const reasons = [];
  if (!glide || !landed || landed.time <= glide.time)
    reasons.push("Send did not reach its landing");
  if (!(setup.beforeStart > setup.afterStart))
    reasons.push("No older history was loaded");
  if (!(setup.distanceFromEnd > setup.viewportHeight))
    reasons.push("Send did not start in scrollback");
  if (recording.errors.length) reasons.push("Page errors occurred");
  if (recording.invalidations.length)
    reasons.push("Focus, visibility, or geometry changed");
  if (Object.values(recording.dropped).some((n) => n > 0))
    reasons.push("Telemetry overflow");
  if (!isDeepStrictEqual(recording.initial.window, recording.final.window))
    reasons.push("Window geometry changed");
  const frames = recording.frames.filter(
    (f) => f[0] >= 0 && f[0] <= (landed?.time ?? 0),
  );
  const intervals = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
  const steps = frames.slice(1).map((f, i) => f[1] - frames[i][1]);
  if (steps.filter((n) => n > 0).length < 5)
    reasons.push("Insufficient glide movement");
  const firstMovement = frames.find((f) => f[1] > recording.initial.top + 2);
  return {
    scope: "send-after-history-load",
    valid: reasons.length === 0,
    invalidReasons: reasons,
    setup,
    prepareMs: glide?.time ?? null,
    landedMs: landed?.time ?? null,
    firstMovementMs: firstMovement?.[0] ?? null,
    frameIntervalsMs: distribution(intervals),
    stepsPx: distribution(steps),
    longIntervals: intervals.filter((n) => n > 1500 / setup.refreshHz).length,
    expensive: recording.operations
      .filter((o) => o.phase === "follow" || o.phase === "send-glide")
      .sort((a, b) => b.selfMs - a.selfMs),
    longTasks: recording.entries.filter(
      (e) => e.type === "longtask" && e.time < (landed?.time ?? 0),
    ),
    limitations: [
      "Animation callbacks and cached scroll offsets do not prove smooth physical presentation.",
      "Scrollback preparation does not test trackpad momentum; see run metadata for its input method.",
      "Only send preparation and the glide are compared; simulated streaming after landing is excluded.",
      "The first callback can follow a blocked send task. Prepare and first-movement times include that delay even when frame intervals do not.",
    ],
  };
}
