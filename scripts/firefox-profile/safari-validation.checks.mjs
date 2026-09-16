import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanupCapture,
  selectDisplay,
  validateCapture,
  validateDisplay,
} from "./safari-validation.mjs";

const external = {
  builtin: false,
  x: 1440,
  y: 0,
  width: 1920,
  height: 1080,
  scale: 2,
};
const builtin = { ...external, builtin: true, x: 0, width: 1440 };
const window = {
  x: 1440,
  y: 31,
  outerWidth: 1920,
  outerHeight: 1049,
  innerWidth: 1920,
  innerHeight: 997,
  dpr: 2,
};
const summary = {
  movingFrames: 500,
  wheels: 540,
  ends: 6,
  errors: [],
  invalidations: [],
};

test("selects the requested display and rejects typos or missing displays", () => {
  assert.equal(selectDisplay([builtin, external]), external);
  assert.equal(selectDisplay([builtin, external], "builtin"), builtin);
  assert.throws(
    () => selectDisplay([builtin, external], "externl"),
    /Invalid SAFARI_DISPLAY/,
  );
  assert.throws(() => selectDisplay([builtin]), /not found/);
});

test("accepts a window contained by the display, including negative display origins", () => {
  validateDisplay(external, window);
  validateDisplay(
    { ...external, x: -1920, y: -1080 },
    { ...window, x: -1920, y: -1049 },
  );
});

for (const [name, change] of [
  ["wrong monitor on the right", { x: 4000 }],
  ["wrong monitor below", { y: 1080 }],
  ["straddling left edge", { x: 1430 }],
  ["straddling right edge", { x: 1450 }],
  ["wrong scaling", { dpr: 1 }],
  ["missing outer width", { outerWidth: undefined }],
  ["nonfinite coordinate", { x: Number.NaN }],
  ["empty viewport", { innerHeight: 0 }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateDisplay(external, { ...window, ...change }));
  });
}

test("accepts a moving capture with native input and completed gestures", () => {
  validateCapture(summary, false);
});

for (const [name, change, interrupted] of [
  ["interruption after the result arrives", {}, true],
  ["stationary capture", { movingFrames: 0 }, false],
  ["missing native input", { wheels: 0 }, false],
  ["missing scroll-end events", { ends: 0 }, false],
  ["page error", { errors: ["render failed"] }, false],
  ["lost focus", { invalidations: ["blur"] }, false],
  ["resize during capture", { invalidations: ["resize"] }, false],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() =>
      validateCapture({ ...summary, ...change }, interrupted),
    );
  });
}

test("attempts every cleanup and fails the report when cleanup fails", async () => {
  const report = { status: "captured" };
  const closed = [];

  const clean = await cleanupCapture(report, {
    window: async () => {
      throw new Error("window unavailable");
    },
    channel: () => {
      closed.push("channel");
    },
    server: async () => {
      closed.push("server");
      throw new Error("server failed");
    },
  });

  assert.equal(clean, false);
  assert.deepEqual(closed, ["channel", "server"]);
  assert.deepEqual(report, {
    status: "failed",
    cleanupErrors: [
      "window: Error: window unavailable",
      "server: Error: server failed",
    ],
  });
});

test("keeps the capture status when all cleanup succeeds", async () => {
  const report = { status: "captured" };
  assert.equal(await cleanupCapture(report, { window: async () => {} }), true);
  assert.deepEqual(report, { status: "captured" });
});
