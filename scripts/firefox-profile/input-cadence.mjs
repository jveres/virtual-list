// Compare scroll-input delivery with the display's frames in a Firefox
// capture. APZ applies the pan events that reach it before each composite;
// a frame that receives none does not move and the next moves twice.
//
//   node scripts/firefox-profile/input-cadence.mjs RUN_DIR
//
// Pan events are the parent process's APZ input IPC; vsync is the parent
// compositor's marker; presented frames are WebRender's OS compositor frames.
// It does not require the runner's start/end marks, so it also reads manual
// captures whose profiler buffer wrapped. Timestamps are when Firefox's parent
// process handled each event, not when macOS generated it.
import { runAnalysisCli } from "./capture.mjs";

const PAN = "PAPZInputBridge::Msg_ReceivePanGestureInputEvent";
const GESTURE_GAP_MS = 100;
const GESTURE_MIN_EVENTS = 20;
const LATE_FACTOR = 1.12;

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) =>
    sorted.length
      ? Number(
          sorted[
            Math.min(sorted.length - 1, Math.floor(sorted.length * q))
          ].toFixed(2),
        )
      : null;
  return {
    count: sorted.length,
    p5: at(0.05),
    p50: at(0.5),
    p95: at(0.95),
    max: at(1),
  };
}

function collect(profile) {
  const base = profile.meta.startTime;
  const vsync = [];
  const presented = [];
  const pan = [];
  const ipc = [];
  for (const process of [profile, ...(profile.processes ?? [])]) {
    const offset = process.meta.startTime - base;
    for (const thread of process.threads) {
      const schema = thread.markers.schema;
      let open = null;
      for (const row of thread.markers.data) {
        const name = thread.stringTable[row[schema.name]];
        const start = row[schema.startTime] + offset;
        const end = row[schema.endTime] + offset;
        const phase = row[schema.phase];
        if (name === "VsyncTimestamp" && thread.name === "Compositor")
          vsync.push(start);
        else if (name === "WR OS Compositor frame") presented.push(end);
        else if (name === PAN) {
          if (phase === 2) {
            open = start;
            pan.push(start);
          } else if (phase === 3 && open !== null) {
            ipc.push(end - open);
            open = null;
          } else if (phase === 1) {
            pan.push(start);
            ipc.push(end - start);
          }
        }
      }
    }
  }
  const byTime = (a, b) => a - b;
  return {
    base,
    vsync: vsync.sort(byTime),
    presented: presented.sort(byTime),
    pan: [...new Set(pan)].sort(byTime),
    ipc,
  };
}

/** Average period over runs of consecutive timestamps (gaps below `maxGap`). */
function runPeriod(times, maxGap) {
  let intervals = 0;
  let span = 0;
  let first = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && times[i] - times[i - 1] < maxGap) continue;
    if (i - 1 - first >= 30) {
      intervals += i - 1 - first;
      span += times[i - 1] - times[first];
    }
    first = i;
  }
  return intervals ? Number((span / intervals).toFixed(4)) : null;
}

function gestures(pan) {
  const groups = [];
  for (const time of pan) {
    const last = groups.at(-1);
    if (last && time - last.at(-1) < GESTURE_GAP_MS) last.push(time);
    else groups.push([time]);
  }
  return groups.filter((group) => group.length >= GESTURE_MIN_EVENTS);
}

/** Pan events per vsync interval, and 0↔2+ alternations, inside one gesture. */
function perVsync(gesture, vsync) {
  const counts = [];
  const flips = [];
  let cursor = 0;
  let previous = null;
  for (let i = 1; i < vsync.length; i++) {
    if (vsync[i] < gesture[0] || vsync[i - 1] > gesture.at(-1)) continue;
    while (cursor < gesture.length && gesture[cursor] <= vsync[i - 1]) cursor++;
    let count = 0;
    while (
      cursor + count < gesture.length &&
      gesture[cursor + count] <= vsync[i]
    )
      count++;
    counts.push(count);
    if (
      previous !== null &&
      ((previous === 0 && count >= 2) || (previous >= 2 && count === 0))
    )
      flips.push(vsync[i]);
    previous = count;
  }
  return { counts, flips };
}

/** Circular mean of each event's position within its vsync interval. */
function meanPhase(gesture, vsync) {
  let sin = 0;
  let cos = 0;
  let j = 0;
  for (const time of gesture) {
    while (j + 1 < vsync.length && vsync[j + 1] <= time) j++;
    if (j + 1 >= vsync.length || vsync[j] > time) continue;
    const angle = (2 * Math.PI * (time - vsync[j])) / (vsync[j + 1] - vsync[j]);
    sin += Math.sin(angle);
    cos += Math.cos(angle);
  }
  return (Math.atan2(sin, cos) / (2 * Math.PI) + 1) % 1;
}

export function analyzeInputCadence(profile, recording) {
  const { base, vsync, presented, pan, ipc } = collect(profile);
  if (vsync.length < 2 || pan.length < 2)
    throw new Error("Expected vsync and pan-gesture markers");
  const retainedFrom = Math.max(vsync[0], pan[0]);
  const vsyncPeriod = runPeriod(vsync, 25);
  const inputGaps = [];
  for (let i = 1; i < pan.length; i++)
    if (pan[i] - pan[i - 1] < 40) inputGaps.push(pan[i] - pan[i - 1]);
  const late = vsyncPeriod * LATE_FACTOR;

  const toProfile = (time) => time + recording.timeOrigin - base;
  const marks = (recording.marks ?? [])
    .map((mark) => toProfile(mark.time))
    .filter((time) => time >= retainedFrom);
  const flipTimes = [];
  let scrollingMs = 0;
  const countTotals = {};
  const rows = gestures(pan)
    .filter((gesture) => gesture[0] >= vsync[0])
    .map((gesture) => {
      const { counts, flips } = perVsync(gesture, vsync);
      for (const count of counts)
        countTotals[count] = (countTotals[count] ?? 0) + 1;
      flipTimes.push(...flips);
      scrollingMs += gesture.at(-1) - gesture[0];
      const phase = meanPhase(gesture, vsync);
      return {
        start: Number(gesture[0].toFixed(0)),
        seconds: Number(((gesture.at(-1) - gesture[0]) / 1000).toFixed(2)),
        events: gesture.length,
        meanPhase: Number(phase.toFixed(2)),
        flipRate: Number(
          (flips.length / Math.max(1, counts.length)).toFixed(3),
        ),
        marks: marks.filter(
          (m) => m >= gesture[0] && m <= gesture.at(-1) + 1500,
        ).length,
      };
    });
  const flipsPerSecond = (from, to) => {
    let covered = 0;
    for (const gesture of gestures(pan)) {
      const a = Math.max(gesture[0], from);
      const b = Math.min(gesture.at(-1), to);
      if (b > a) covered += b - a;
    }
    const n = flipTimes.filter((t) => t > from && t <= to).length;
    return covered > 200 ? Number((n / (covered / 1000)).toFixed(2)) : null;
  };

  let cursor = 0;
  const scrolling = (time) => {
    while (cursor < pan.length && pan[cursor] < time - GESTURE_GAP_MS) cursor++;
    return cursor < pan.length && pan[cursor] <= time + GESTURE_GAP_MS;
  };
  const presentedGaps = [];
  for (let i = 1; i < presented.length; i++) {
    const gap = presented[i] - presented[i - 1];
    if (gap < 200 && scrolling(presented[i]) && scrolling(presented[i - 1]))
      presentedGaps.push(gap);
  }

  return {
    retainedFrom: Number(retainedFrom.toFixed(0)),
    vsyncPeriodMs: vsyncPeriod,
    inputPeriodMs: quantiles(inputGaps).p50,
    inputGapsMs: quantiles(inputGaps),
    lateInputShare: Number(
      (inputGaps.filter((gap) => gap > late).length / inputGaps.length).toFixed(
        3,
      ),
    ),
    ipcMs: quantiles(ipc),
    eventsPerVsync: countTotals,
    flipsPerSecond: Number(
      (flipTimes.length / Math.max(0.001, scrollingMs / 1000)).toFixed(2),
    ),
    presentedWhileScrollingMs: {
      ...quantiles(presentedGaps),
      over25: presentedGaps.filter((gap) => gap > 25).length,
    },
    gestures: rows,
    marks: marks.map((time) => ({
      profileTime: Number(time.toFixed(0)),
      flipsPerSecondBefore: flipsPerSecond(time - 1500, time),
    })),
    limitations: [
      "Pan timestamps are parent-process handling times, not OS event times.",
      "APZ samples at composite time, slightly after the vsync marker.",
      "A 0↔2 alternation is a proxy for uneven motion, not measured pixels.",
    ],
  };
}

await runAnalysisCli(import.meta.url, analyzeInputCadence);
