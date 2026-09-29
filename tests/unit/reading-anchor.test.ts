import { describe, expect, it } from "vitest";
import {
  captureItemPlacement,
  replacementAnchor,
} from "../../src/companions/index";

const viewport = { scrollTop: 100, clientHeight: 600 };
const list = {
  positionOf: (key: string) =>
    ({
      prompt: { top: 50, height: 200 },
      reply: { top: 250, height: 700 },
      before: { top: 0, height: 100 },
      after: { top: 800, height: 100 },
      pinned: { top: 140, height: 100 },
    })[key] ?? null,
};

describe("reading anchors", () => {
  it.each([0, 15, 30, 39])(
    "should retain a replacement whose top is at %s px under the sticky inset",
    (offset) => {
      expect(
        replacementAnchor(
          list,
          { ...viewport, scrollTop: 140 - offset },
          [
            { from: "pinned", to: "new-prompt" },
            { from: "reply", to: "new-reply" },
          ],
          40,
        ),
      ).toEqual({ key: "new-prompt", offset, visibilityInset: 40 });
    },
  );
  it.each([0.5, 1, 20])(
    "should exclude %s px of boundary overscroll when replacing the reply",
    (overscroll) => {
      const bounded = { ...list, state: { totalSize: 700 } };
      expect(
        replacementAnchor(
          bounded,
          { ...viewport, scrollTop: viewport.scrollTop + overscroll },
          [{ from: "reply", to: "new-reply" }],
          40,
        ),
      ).toEqual({ key: "new-reply", offset: 150, visibilityInset: 40 });
    },
  );
  it("should preserve a partially clipped prompt rather than its reply", () => {
    expect(
      replacementAnchor(
        list,
        viewport,
        [
          { from: "prompt", to: "new-prompt" },
          { from: "reply", to: "new-reply" },
        ],
        40,
      ),
    ).toEqual({ key: "new-prompt", offset: -50, visibilityInset: 40 });
  });
  it("should defer revealing a clipped replacement until its new height is known", () => {
    expect(
      replacementAnchor(list, viewport, [{ from: "prompt", to: "new" }], 40),
    ).toEqual({ key: "new", offset: -50, visibilityInset: 40 });
  });
  it("should retain the first fully visible candidate", () => {
    expect(
      replacementAnchor(
        list,
        viewport,
        [
          { from: "pinned", to: "new" },
          { from: "reply", to: "other" },
        ],
        40,
      ),
    ).toEqual({ key: "new", offset: 40, visibilityInset: 40 });
  });
  it.each([0.25, 0.5, 0.75])(
    "should retain a pinned prompt after a fractional boundary landing of %s px",
    (rounding) => {
      expect(
        replacementAnchor(
          list,
          { ...viewport, scrollTop: viewport.scrollTop + rounding },
          [
            { from: "pinned", to: "new-prompt" },
            { from: "reply", to: "new-reply" },
          ],
          40,
        ),
      ).toEqual({ key: "new-prompt", offset: 40, visibilityInset: 40 });
    },
  );
  it("should not invent an anchor for missing or offscreen rows", () => {
    expect(
      replacementAnchor(list, viewport, [
        { from: "missing", to: "a" },
        { from: "before", to: "b" },
        { from: "after", to: "c" },
      ]),
    ).toBeUndefined();
  });
  it("should capture edit placement without changing the viewport", () => {
    expect(captureItemPlacement(list, viewport, "pinned", 40)).toEqual({
      offset: 40,
      pinned: true,
      visible: true,
      above: false,
    });
    expect(captureItemPlacement(list, viewport, "before", 40)).toEqual({
      offset: -100,
      pinned: false,
      visible: false,
      above: true,
    });
    expect(captureItemPlacement(list, viewport, "missing")).toBeNull();
    expect(viewport).toEqual({ scrollTop: 100, clientHeight: 600 });
  });
});
