import { describe, expect, it } from "vitest";
import {
  type Card,
  createGalleryLayouts,
  justify,
  masonry,
  type Photo,
  sameGalleryItem,
} from "../../demos/gallery/layout";
import { createLayoutHistory } from "../../demos/gallery/layout-history";

const ASPECTS = [0.67, 0.75, 1, 1.33, 1.5, 1.78];
const photos = (n: number): Photo[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    aspect: ASPECTS[(id * 7) % ASPECTS.length] as number,
  }));

describe("retained gallery layout continuity", () => {
  it("should preserve global column offsets after prefix eviction", () => {
    const all = photos(600);
    const layouts = createGalleryLayouts(
      createLayoutHistory((id) => all[id] as Photo, 8),
    );
    const full = layouts.masonry(all, 981, 240, 6, false);
    const retained = layouts.masonry(all.slice(240), 981, 240, 6, false);
    expect(retained).toEqual(
      full
        .slice(240)
        .map((card) => ({ ...card, top: expect.closeTo(card.top, 7) })),
    );
    expect(Math.min(...retained.map((card) => card.top))).toBeGreaterThan(0);
  });
  it("should preserve row membership through trimming, resize and restoration", () => {
    const all = photos(720);
    const layouts = createGalleryLayouts(
      createLayoutHistory((id) => all[id] as Photo, 8),
    );
    for (const width of [1080, 981, 800, 600, 400]) {
      const full = layouts.rows(all, width, 210, 6, true);
      const retained = layouts.rows(all.slice(240), width, 210, 6, true);
      expect(retained.length).toBeGreaterThan(0);
      expect(retained).toEqual(
        full.filter((row) => (row.photos[0]?.id ?? 0) >= 240),
      );
      expect(layouts.rows(all, width, 210, 6, true)).toEqual(full);
    }
  });

  it("should preserve whole cards after prefix eviction at every density", () => {
    const all = photos(720);
    const layouts = createGalleryLayouts(
      createLayoutHistory((id) => all[id] as Photo, 8),
    );
    for (const width of [1080, 981, 800, 600, 400]) {
      const full = layouts.masonry(all, width, 240, 6, true);
      const retained = layouts.masonry(all.slice(240), width, 240, 6, true);
      expect(retained).toEqual(
        full
          .slice(240)
          .map((card) => ({ ...card, top: expect.closeTo(card.top, 7) })),
      );
      expect(retained.map((card) => card.key)).toEqual(
        all.slice(240).map((photo) => `p${photo.id}`),
      );
      expect(layouts.masonry(all, width, 240, 6, true)).toEqual(full);
    }
  });
});

describe("layout equality", () => {
  it("should compare every rendered row field without depending on object identity", () => {
    const row = justify(photos(10), 900, 210, 6, false)[0];
    if (!row) throw new Error("missing row");
    expect(sameGalleryItem(row, structuredClone(row))).toBe(true);
    expect(sameGalleryItem(row, { ...row, key: "other" })).toBe(false);
    expect(sameGalleryItem(row, { ...row, height: row.height + 1 })).toBe(
      false,
    );
    expect(sameGalleryItem(row, { ...row, photos: row.photos.slice(1) })).toBe(
      false,
    );
    for (const field of ["id", "aspect", "width"] as const) {
      const changed = structuredClone(row);
      const photo = changed.photos[0];
      if (!photo) throw new Error("missing photo");
      photo[field] += 1;
      expect(sameGalleryItem(row, changed)).toBe(false);
    }
  });

  it("should compare every rendered card field", () => {
    const card = masonry(photos(10), 900, 4, 6).cards[0];
    if (!card) throw new Error("missing card");
    expect(sameGalleryItem(card, structuredClone(card))).toBe(true);
    expect(sameGalleryItem(card, { ...card, key: "other" })).toBe(false);
    for (const field of [
      "id",
      "aspect",
      "lane",
      "left",
      "top",
      "width",
      "height",
    ] as const) {
      expect(sameGalleryItem(card, { ...card, [field]: card[field] + 1 })).toBe(
        false,
      );
    }
    const row = justify(photos(10), 900, 210, 6, false)[0];
    if (!row) throw new Error("missing row");
    expect(
      sameGalleryItem(card, { ...row, key: card.key, height: card.height }),
    ).toBe(false);
  });
});

describe("justified rows", () => {
  it("should preserve row membership and scale smoothly within a density", () => {
    const input = photos(240);
    const layouts = createGalleryLayouts();
    const wide = layouts.rows(input, 1000, 210, 6, false);
    const narrow = layouts.rows(input, 980, 210, 6, false);
    const middle = layouts.rows(input, 990, 210, 6, false);

    expect(narrow.map((r) => r.photos.map((p) => p.id))).toEqual(
      wide.map((r) => r.photos.map((p) => p.id)),
    );
    for (const [i, row] of middle.entries()) {
      const a = wide[i];
      const b = narrow[i];
      if (!a || !b) throw new Error("row disappeared within a density");
      expect(row.height).toBeCloseTo((a.height + b.height) / 2, 8);
      expect(
        row.photos.reduce((sum, p) => sum + p.width, 0) +
          6 * (row.photos.length - 1),
      ).toBeCloseTo(990, 8);
      for (const p of row.photos)
        expect(p.width / row.height).toBeCloseTo(p.aspect, 8);
    }
    expect(
      layouts.rows(input, 944, 210, 6, false).map((r) => r.key),
    ).not.toEqual(wide.map((r) => r.key));
  });

  it("should keep a completed ragged row inside a narrow viewport", () => {
    const rows = justify([{ id: 1, aspect: 2 }], 150, 210, 6, true);

    expect(rows).toEqual([
      {
        kind: "row",
        key: "r1",
        height: 75,
        photos: [{ id: 1, aspect: 2, width: 150 }],
      },
    ]);
  });

  it("fills the width exactly and holds back the incomplete tail while pages remain", () => {
    const rows = justify(photos(50), 900, 200, 6, false);
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      const filled =
        row.photos.reduce((sum, p) => sum + p.width, 0) +
        6 * (row.photos.length - 1);
      expect(filled).toBeCloseTo(900, 8);
      expect(row.height).toBeLessThanOrEqual(200);
    }
    // A count whose last row is ragged: pending, that row is held back.
    const n = [50, 51, 52, 53, 54, 55].find((count) => {
      const done = justify(photos(count), 900, 200, 6, true);
      return done[done.length - 1]?.height === 200;
    }) as number;
    const pending = justify(photos(n), 900, 200, 6, false);
    const complete = justify(photos(n), 900, 200, 6, true);
    expect(pending.reduce((c, row) => c + row.photos.length, 0)).toBeLessThan(
      n,
    );
    expect(complete.reduce((c, row) => c + row.photos.length, 0)).toBe(n);
    expect(complete.length).toBe(pending.length + 1);
  });

  it("appending a page leaves earlier rows identical", () => {
    const a = justify(photos(40), 900, 200, 6, false);
    const b = justify(photos(80), 900, 200, 6, false);
    for (const [i, row] of a.entries()) expect(b[i]).toEqual(row);
  });
});

describe("masonry", () => {
  it("should keep column ownership and order stable across width changes", () => {
    const aspects = [0.67, 0.75, 0.8, 1, 1.33, 1.5, 1.5, 1.78, 2];
    const input = Array.from({ length: 240 }, (_, id) => ({
      id,
      aspect: aspects[((id * 2654435761) >>> 0) % aspects.length] as number,
    }));
    const ownership = (cards: Card[], columns: number): number[][] => {
      const lefts = cards.slice(0, columns).map((card) => card.left);
      return lefts.map((left) =>
        cards.filter((card) => card.left === left).map((card) => card.id),
      );
    };

    for (const columns of [2, 3, 4, 5, 6]) {
      const before = ownership(masonry(input, 1080, columns, 6).cards, columns);
      for (const width of [1079, 1000, 999, 900, 899, 800, 799, 600]) {
        const after = masonry(input, width, columns, 6);

        expect(ownership(after.cards, columns)).toEqual(before);
        // A new page must not reshuffle those stable columns either.
        expect(masonry(input.slice(0, 120), width, columns, 6).cards).toEqual(
          after.cards.slice(0, 120),
        );
      }
    }
  });

  it("should return no cards for an empty grid", () => {
    expect(masonry([], 900, 4, 6)).toEqual({ cards: [], height: 0 });
    expect(createGalleryLayouts().masonry([], 900, 240, 6, true)).toEqual([]);
  });
  it("should scale every column continuously between column-count changes", () => {
    const input = photos(240);
    const wide = masonry(input, 1000, 4, 6).cards;
    const narrow = masonry(input, 998, 4, 6).cards;

    const middle = masonry(input, 999, 4, 6).cards;

    for (const [i, card] of middle.entries()) {
      const a = wide[i] as Card;
      const b = narrow[i] as Card;
      expect(card.width).toBeCloseTo((a.width + b.width) / 2, 8);
      expect(card.height).toBeCloseTo((a.height + b.height) / 2, 8);
      expect(card.top).toBeCloseTo((a.top + b.top) / 2, 8);
      expect(card.left).toBeCloseTo((a.left + b.left) / 2, 8);
      expect(card.top).toBeLessThanOrEqual(a.top);
      expect(card.top).toBeGreaterThanOrEqual(b.top);
    }
  });

  it("places every photo in a column without overlap and never moves a card on append", () => {
    const { cards, height } = masonry(photos(60), 900, 4, 6);
    expect(cards).toHaveLength(60);
    const columns = new Map<number, typeof cards>();
    for (const card of cards) {
      expect(card.left + card.width).toBeLessThanOrEqual(900);
      expect(card.top + card.height).toBeLessThanOrEqual(height);
      const column = columns.get(card.left) ?? [];
      column.push(card);
      columns.set(card.left, column);
    }
    expect(columns.size).toBe(4);
    for (const column of columns.values()) {
      column.sort((a, b) => a.top - b.top);
      for (let i = 1; i < column.length; i++) {
        const prev = column[i - 1];
        const next = column[i];
        expect(
          next && prev ? next.top - (prev.top + prev.height) : 0,
        ).toBeCloseTo(6, 8);
      }
    }
    const more = masonry(photos(120), 900, 4, 6);
    for (const [i, card] of cards.entries())
      expect(more.cards[i]).toEqual(card);
  });
});
