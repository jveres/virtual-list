/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTraceLog } from "../../demos/shared/lab";

describe("diagnostic trace log", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("should retain input immediately and render ordered trace entries next frame", () => {
    const element = document.createElement("pre");
    const trace = createTraceLog(element);

    trace.log("wheel", "mark");
    trace.log("scroll");

    expect(trace.ring).toHaveLength(2);
    expect(trace.ring[0]).toMatch(/wheel$/);
    expect(trace.ring[1]).toMatch(/scroll$/);
    expect(element.childNodes.length).toBe(0);
    vi.advanceTimersByTime(20);
    expect(element.textContent).toBe(`${trace.ring.join("\n")}\n`);
    expect(element.firstElementChild?.className).toBe("mark");
    trace.clear();
  });

  it("should clear queued entries without letting an obsolete frame restore them", () => {
    const element = document.createElement("pre");
    const trace = createTraceLog(element);
    trace.log("old event");

    trace.clear();
    trace.log("new event");
    vi.advanceTimersByTime(20);

    expect(trace.ring).toHaveLength(1);
    expect(element.textContent).toBe(`${trace.ring[0]}\n`);
    expect(element.textContent).toMatch(/new event\n$/);
    trace.clear();
  });

  it("should bound both the full trace and pending visible history", () => {
    const element = document.createElement("pre");
    const trace = createTraceLog(element);

    for (let index = 0; index < 4005; index++) trace.log(`event ${index}`);
    vi.advanceTimersByTime(20);

    expect(trace.ring).toHaveLength(4000);
    expect(trace.ring[0]).toMatch(/event 5$/);
    expect(element.childNodes.length).toBe(350);
    expect(element.firstChild?.textContent).toMatch(/event 3655\n$/);
    expect(element.lastChild?.textContent).toMatch(/event 4004\n$/);
    trace.clear();
  });
});
