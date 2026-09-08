/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleReplacementRepaint } from "../../src/viewport-repaint";

afterEach(() => document.body.replaceChildren());

function setup(overflow = "") {
  const viewport = document.createElement("div");
  viewport.style.overflowY = overflow;
  viewport.scrollTop = 3270;
  document.body.appendChild(viewport);
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    frame = undefined;
  });
  const measuredOverflow: string[] = [];
  vi.spyOn(viewport, "offsetHeight", "get").mockImplementation(() => {
    measuredOverflow.push(viewport.style.overflowY);
    return 844;
  });
  const scrollWrite = vi.spyOn(viewport, "scrollTop", "set");
  return { viewport, measuredOverflow, scrollWrite, paint: () => frame?.(16) };
}

describe("replacement repaint", () => {
  it.each(["", "auto", "scroll"])(
    "should restore overflow %j without writing scrollTop",
    (overflow) => {
      const { viewport, measuredOverflow, scrollWrite, paint } =
        setup(overflow);
      scheduleReplacementRepaint(viewport, () => true);
      expect(measuredOverflow).toEqual([]);
      paint();
      expect(measuredOverflow).toEqual(["hidden"]);
      expect(viewport.style.overflowY).toBe(overflow);
      expect(viewport.scrollTop).toBe(3270);
      expect(scrollWrite).not.toHaveBeenCalled();
    },
  );

  it("should ignore work belonging to a superseded conversation", () => {
    const { viewport, measuredOverflow, paint } = setup();
    let current = true;
    scheduleReplacementRepaint(viewport, () => current);
    current = false;
    paint();
    expect(measuredOverflow).toEqual([]);
  });

  it("should ignore a detached viewport", () => {
    const { viewport, measuredOverflow, paint } = setup();
    scheduleReplacementRepaint(viewport, () => true);
    viewport.remove();
    paint();
    expect(measuredOverflow).toEqual([]);
  });

  it("should cancel pending work when its owner is disposed", () => {
    const { viewport, measuredOverflow, paint } = setup();
    const cancel = scheduleReplacementRepaint(viewport, () => true);

    cancel();
    paint();

    expect(measuredOverflow).toEqual([]);
  });

  it("should preserve an important overflow declaration", () => {
    const { viewport, paint } = setup();
    viewport.style.setProperty("overflow-y", "scroll", "important");

    scheduleReplacementRepaint(viewport, () => true);
    paint();

    expect(viewport.style.getPropertyValue("overflow-y")).toBe("scroll");
    expect(viewport.style.getPropertyPriority("overflow-y")).toBe("important");
  });
});
