/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGestureSensor } from "../../src/gesture";

// The sensor's classification core: scrolls landing on announced writes are
// self-inflicted; anything else is the user, until scrollend or idle settle.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeSensor() {
  const viewport = document.createElement("div");
  const events: string[] = [];
  const sensor = createGestureSensor(viewport, {
    onStart: () => events.push("start"),
    onSettle: () => events.push("settle"),
  });
  return { viewport, sensor, events };
}

describe("gesture sensor", () => {
  it("does not classify announced writes as gestures", () => {
    const { sensor, events } = makeSensor();
    sensor.expectWrite(500);
    expect(sensor.handleScroll(500)).toBe(false);
    expect(sensor.active).toBe(false);
    expect(events).toEqual([]);
  });

  it("consumes superseded writes in order", () => {
    const { sensor } = makeSensor();
    sensor.expectWrite(100);
    sensor.expectWrite(200);
    // A coalesced scroll event lands only on the latest write.
    expect(sensor.handleScroll(200)).toBe(false);
    expect(sensor.active).toBe(false);
  });

  it("classifies unmatched scrolls as a user gesture and settles on idle", () => {
    const { sensor, events } = makeSensor();
    expect(sensor.handleScroll(123)).toBe(true);
    expect(sensor.active).toBe(true);
    expect(events).toEqual(["start"]);

    sensor.handleScroll(150);
    vi.advanceTimersByTime(200);
    expect(sensor.active).toBe(false);
    expect(events).toEqual(["start", "settle"]);
  });

  it("an unmatched scroll drops stale write expectations", () => {
    const { sensor } = makeSensor();
    sensor.expectWrite(100);
    expect(sensor.handleScroll(999)).toBe(true);
    // The stale expectation must not shadow later user scrolls.
    expect(sensor.handleScroll(100)).toBe(true);
  });

  it("scrollend settles immediately", () => {
    const { viewport, sensor, events } = makeSensor();
    sensor.handleScroll(50);
    expect(sensor.active).toBe(true);
    viewport.dispatchEvent(new Event("scrollend"));
    expect(sensor.active).toBe(false);
    expect(events).toEqual(["start", "settle"]);
  });

  it("dispose silences the sensor", () => {
    const { sensor, events } = makeSensor();
    sensor.handleScroll(10);
    sensor.dispose();
    vi.advanceTimersByTime(500);
    expect(events).toEqual(["start"]);
  });
});
