/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStickyHeaders } from "../../demos/shared/sticky-headers";

describe("sticky headers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("refresh retires a scroll frame sampled against pre-commit geometry", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    container.appendChild(viewport);
    document.body.appendChild(container);
    let positions = new Map([
      ["day:0", { top: 0, height: 44 }],
      ["day:1", { top: 100, height: 44 }],
    ]);
    const sticky = createStickyHeaders({
      container,
      viewport,
      headerKeys: () => ["day:0", "day:1"],
      positionOf: (key) => positions.get(key) ?? null,
      renderHeader: (slot, ordinal) => {
        slot.textContent = `day ${ordinal}`;
      },
    });

    viewport.scrollTop = 90;
    viewport.dispatchEvent(new Event("scroll")); // Queues a frame at 90.
    positions = new Map([
      ["day:0", { top: 0, height: 44 }],
      ["day:1", { top: 80, height: 44 }],
    ]);
    viewport.scrollTop = 110;
    sticky.refresh(); // Commit authority: day 1 is active now.
    vi.advanceTimersByTime(20);

    expect(container.querySelector(".sticky-group")?.textContent).toBe("day 1");
    sticky.destroy();
  });
});
