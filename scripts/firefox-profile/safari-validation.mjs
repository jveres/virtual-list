import assert from "node:assert/strict";

export function selectDisplay(screens, name = "external") {
  assert.ok(["builtin", "external"].includes(name), "Invalid SAFARI_DISPLAY");
  const screen = screens.find((item) => item.builtin === (name === "builtin"));
  assert.ok(screen, "Requested display not found");
  return screen;
}

export function validateDisplay(screen, window) {
  const { x, y, outerWidth, outerHeight, innerWidth, innerHeight, dpr } =
    window;
  assert.ok(
    [x, y, outerWidth, outerHeight, innerWidth, innerHeight, dpr].every(
      Number.isFinite,
    ),
    "Invalid browser geometry",
  );
  assert.equal(dpr, screen.scale, "Browser scaling does not match display");
  assert.ok(
    innerWidth > 0 &&
      innerHeight > 0 &&
      outerWidth >= innerWidth &&
      outerHeight >= innerHeight &&
      x >= screen.x - 1 &&
      y >= screen.y - 1 &&
      x + outerWidth <= screen.x + screen.width + 1 &&
      y + outerHeight <= screen.y + screen.height + 1,
    "Browser window is not contained by the requested display",
  );
}

export function validateCapture(summary, interrupted) {
  assert.equal(interrupted, false, "Invalid: interrupted capture");
  assert.ok(summary.movingFrames > 30, "Invalid: insufficient movement");
  assert.ok(summary.wheels > 30, "Invalid: no native input");
  assert.ok(summary.ends > 0, "Invalid: no scroll-end events");
  assert.deepEqual(summary.errors, [], "Invalid: page errors");
  assert.deepEqual(
    summary.invalidations,
    [],
    "Invalid: capture lost focus or changed geometry",
  );
}

// Every owned resource gets a cleanup attempt, even if an earlier one fails.
export async function cleanupCapture(report, actions) {
  const errors = [];
  for (const [name, action] of Object.entries(actions)) {
    try {
      await action();
    } catch (error) {
      errors.push(`${name}: ${error}`);
    }
  }
  if (errors.length) {
    report.cleanupErrors = errors;
    report.status = "failed";
  }
  return errors.length === 0;
}
