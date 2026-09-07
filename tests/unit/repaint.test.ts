/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { repaintAfterReplacement } from "../../demos/streaming/repaint";

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
      repaintAfterReplacement(viewport, () => true);
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
    repaintAfterReplacement(viewport, () => current);
    current = false;
    paint();
    expect(measuredOverflow).toEqual([]);
  });

  it("should ignore a detached viewport", () => {
    const { viewport, measuredOverflow, paint } = setup();
    repaintAfterReplacement(viewport, () => true);
    viewport.remove();
    paint();
    expect(measuredOverflow).toEqual([]);
  });
});
