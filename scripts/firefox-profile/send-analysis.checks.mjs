import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSend } from "./send-analysis.mjs";

function recording() {
  return {
    phases: [
      { name: "send-glide", time: 180 },
      { name: "send-landed", time: 900 },
    ],
    frames: Array.from({ length: 40 }, (_, i) => [
      200 + i * 16,
      1000 + i * 100,
    ]),
    initial: { top: 1000, window: { width: 1900 } },
    final: { window: { width: 1900 } },
    errors: [],
    invalidations: [],
    dropped: {},
    operations: [],
    entries: [],
  };
}
const setup = {
  beforeStart: 25,
  afterStart: 1,
  distanceFromEnd: 10000,
  viewportHeight: 800,
  refreshHz: 60,
};
test("send analysis includes blocked preparation even when later callbacks are regular", () => {
  const result = analyzeSend(recording(), setup);
  assert.equal(result.valid, true);
  assert.equal(result.prepareMs, 180);
  assert.equal(result.firstMovementMs, 216);
  assert.equal(result.frameIntervalsMs.max, 16);
});
test("send evidence requires loaded history, movement, landing and stable capture", () => {
  for (const mutate of [
    (r) => r.phases.pop(),
    (r) => (r.frames = []),
    (r) => r.errors.push("error"),
    (r) => r.invalidations.push("blur"),
    (r) => (r.dropped.frames = 1),
    (r) => (r.final.window.width = 1000),
  ]) {
    const input = recording();
    mutate(input);
    assert.equal(analyzeSend(input, setup).valid, false);
  }
  assert.equal(
    analyzeSend(recording(), { ...setup, afterStart: 25 }).valid,
    false,
  );
  assert.equal(
    analyzeSend(recording(), { ...setup, distanceFromEnd: 100 }).valid,
    false,
  );
});
