import { describe, expect, it } from "vitest";
import {
  createGalleryLayouts,
  justify,
  masonry,
  type Photo,
} from "../../demos/gallery/layout";
import { createLayoutManager } from "../../demos/gallery/layout-manager";

describe("layout manager", () => {
  it("should reuse the plan but place at every width and reset at structural changes", () => {
    const photos: readonly Photo[] = [{ id: 0, aspect: 1 }];
    const layout = createLayoutManager({
      minimumDensity: 2,
      plan: (photos, density, complete) => ({ photos, density, complete }),
      place: (plan, width, target, gap) => ({ plan, width, target, gap }),
    });
    const before = layout(photos, 1000, 240, 6, false);

    const resized = layout(photos, 999, 240, 6, false);

    expect(resized.plan).toBe(before.plan);
    expect(resized.width).toBe(999);
    expect(layout(photos, 999, 241, 8, false)).toEqual({
      plan: before.plan,
      width: 999,
      target: 241,
      gap: 8,
    });
    expect(layout(photos, 800, 240, 6, false).plan).toEqual({
      photos,
      density: 3,
      complete: false,
    });
    expect(layout(photos, 800, 240, 6, true).plan).toEqual({
      photos,
      density: 3,
      complete: true,
    });
    const next = [...photos, { id: 1, aspect: 2 }];
    expect(layout(next, 800, 240, 6, true).plan).toEqual({
      photos: next,
      density: 3,
      complete: true,
    });
    expect(layout(next, 100, 240, 6, true).plan).toEqual({
      photos: next,
      density: 2,
      complete: true,
    });
  });

  it("should match both pure layouts after resizing, appending, and completing", () => {
    const layouts = createGalleryLayouts();
    for (const count of [120, 240]) {
      const photos = Array.from({ length: count }, (_, id) => ({
        id,
        aspect: 0.7 + (id % 7) / 5,
      }));
      for (const complete of [false, true]) {
        for (const width of [1000, 999, 800, 1080]) {
          expect(layouts.rows(photos, width, 210, 6, complete)).toEqual(
            justify(photos, width, 210, 6, complete),
          );
          const grid = masonry(
            photos,
            width,
            Math.max(2, Math.round(width / 240)),
            6,
          );
          expect(layouts.masonry(photos, width, 240, 6, complete)).toEqual(
            grid.cards,
          );
        }
      }
    }
  });
});
