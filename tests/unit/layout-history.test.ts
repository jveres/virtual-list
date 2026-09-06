import { describe, expect, it } from "vitest";
import {
  createGalleryLayouts,
  justify,
  masonry,
  type Photo,
} from "../../demos/gallery/layout";
import { createLayoutHistory } from "../../demos/gallery/layout-history";

const photo = (id: number): Photo => ({
  id,
  aspect: [0.67, 1, 1.5, 1.78][id % 4] as number,
});
const window = (from: number, count = 120): Photo[] =>
  Array.from({ length: count }, (_, i) => photo(from + i));

describe("gallery layout checkpoints", () => {
  it("should visit only newly discarded photos across forward paging and density changes", () => {
    let reads = 0;
    const history = createLayoutHistory((id) => {
      reads++;
      return photo(id);
    }, 7);
    for (let from = 0; from <= 12000; from += 120) {
      const retained = window(from);
      for (let density = 1; density <= 7; density++) history(retained, density);
      expect(reads).toBe(from);
    }
    for (const from of [11880, 11760, 11640, 12000]) {
      for (let density = 1; density <= 7; density++)
        history(window(from), density);
    }
    expect(reads).toBe(12000);
  });

  it("should preserve full-history row and column ownership after a checkpoint cache miss", () => {
    const history = createLayoutHistory(photo, 7, 120, 2);
    const layouts = createGalleryLayouts(history);
    history(window(1200), 2);
    const retained = window(240, 480);
    const all = window(0, 720);
    for (let density = 2; density <= 7; density++) {
      const width = density * 150;
      expect(layouts.rows(retained, width, 150, 6, true)).toEqual(
        justify(all, width, 150, 6, true).filter(
          (row) => (row.photos[0]?.id ?? 0) >= 240,
        ),
      );
      const cards = layouts.masonry(retained, width, 150, 6, true);
      const expected = masonry(all, width, density, 6).cards.filter(
        (card) => card.id >= 240,
      );
      expect(cards.map((card) => card.id).sort((a, b) => a - b)).toEqual(
        expected.map((card) => card.id),
      );
      for (const actual of cards) {
        const original = expected.find((card) => card.id === actual.id);
        expect(actual.left).toBe(original?.left);
        expect(actual.top).toBeCloseTo(original?.top ?? -1, 7);
      }
    }
  });

  it("should reject unsupported densities and invalid cache limits", () => {
    expect(() => createLayoutHistory(photo, 0)).toThrow(
      "positive safe integers",
    );
    expect(() => createLayoutHistory(photo, 7, 0)).toThrow(
      "positive safe integers",
    );
    expect(() => createLayoutHistory(photo, 7, 120, 0)).toThrow(
      "positive safe integers",
    );
    expect(() => createLayoutHistory(photo, 7)(window(0), 8)).toThrow(
      "density exceeds",
    );
  });
});
