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
  it("should prefer the visible reply when its prompt is clipped", () => {
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
    ).toEqual({ key: "new-reply", offset: 150 });
  });
  it("should place a clipped replacement below the inset", () => {
    expect(
      replacementAnchor(list, viewport, [{ from: "prompt", to: "new" }], 40),
    ).toEqual({ key: "new", offset: 40 });
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
    ).toEqual({ key: "new", offset: 40 });
  });
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
