import { describe, expect, it } from "vitest";
import {
  type Card,
  justify,
  masonry,
  type Photo,
  slice,
} from "../../demos/gallery/layout";

const ASPECTS = [0.67, 0.75, 1, 1.33, 1.5, 1.78];
const photos = (n: number): Photo[] =>
  Array.from({ length: n }, (_, id) => ({
    id,
    aspect: ASPECTS[(id * 7) % ASPECTS.length] as number,
  }));

describe("justified rows", () => {
  it("fills the width exactly and holds back the incomplete tail while pages remain", () => {
    const rows = justify(photos(50), 900, 200, 6, false);
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      const filled =
        row.photos.reduce((sum, p) => sum + p.width, 0) +
        6 * (row.photos.length - 1);
      expect(filled).toBe(900);
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

  it("should return no bands for an empty grid", () => {
    expect(slice([], 0, 400)).toEqual([]);
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

  it("should preserve boundary intersections, part numbers, and stable top order", () => {
    const card = (id: number, top: number, height: number): Card => ({
      id,
      top,
      height,
      left: 0,
      width: 100,
      aspect: 100 / height,
    });
    const cards = [
      card(3, 800, 50),
      card(1, 0, 400),
      card(2, 0, 850),
      card(4, 400, 400),
    ];
    const original = cards.map((c) => ({ ...c }));

    const bands = slice(cards, 850, 400);

    expect(bands).toEqual([
      {
        kind: "band",
        key: "b0",
        start: 0,
        height: 400,
        cards: [
          { ...cards[1], part: 0 },
          { ...cards[2], part: 0 },
        ],
      },
      {
        kind: "band",
        key: "b400",
        start: 400,
        height: 400,
        cards: [
          { ...cards[2], part: 1 },
          { ...cards[3], part: 0 },
        ],
      },
      {
        kind: "band",
        key: "b800",
        start: 800,
        height: 50,
        cards: [
          { ...cards[2], part: 2 },
          { ...cards[0], part: 0 },
        ],
      },
    ]);
    expect(cards).toEqual(original);
  });

  it("should match geometric intersections across gallery sizes and columns", () => {
    for (const count of [1, 120, 3000]) {
      for (const columns of [2, 4, 6]) {
        const { cards, height } = masonry(photos(count), 1080, columns, 6);
        const bands = slice(cards, height, 480);
        const parts = new Map<number, number>();

        expect(bands).toHaveLength(Math.ceil(height / 480));
        for (const band of bands) {
          const expected = cards
            .filter(
              (card) =>
                card.top < band.start + band.height &&
                card.top + card.height > band.start,
            )
            .sort((a, b) => a.top - b.top)
            .map((card) => {
              const part = parts.get(card.id) ?? 0;
              parts.set(card.id, part + 1);
              return { ...card, part };
            });
          expect(band.cards).toEqual(expected);
        }
      }
    }
  });

  it("should preserve completed bands behind all column tails on append", () => {
    const before = masonry(photos(120), 1080, 5, 6);
    const after = masonry(photos(240), 1080, 5, 6);
    const firstNewTop = after.cards[120]?.top as number;
    const stable = slice(before.cards, before.height, 480).filter(
      (band) => band.start + band.height <= firstNewTop,
    );

    const bands = slice(after.cards, after.height, 480);

    expect(stable.length).toBeGreaterThan(0);
    expect(bands.slice(0, stable.length)).toEqual(stable);
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

  it("slices into bands that cover the grid, each card in every band it crosses", () => {
    const { cards, height } = masonry(photos(60), 900, 4, 6);
    const bands = slice(cards, height, 400);
    expect(bands[0]?.start).toBe(0);
    let y = 0;
    for (const band of bands) {
      expect(band.start).toBe(y);
      y += band.height;
      for (const card of band.cards) {
        expect(card.top).toBeLessThan(band.start + band.height);
        expect(card.top + card.height).toBeGreaterThan(band.start);
      }
    }
    expect(y).toBe(height);
    for (const card of cards) {
      const drawings = bands.flatMap((b) =>
        b.cards.filter((c) => c.id === card.id),
      );
      const crossed = Math.max(
        1,
        Math.ceil((card.top + card.height) / 400) - Math.floor(card.top / 400),
      );
      expect(drawings.length).toBeGreaterThanOrEqual(1);
      expect(drawings.length).toBeLessThanOrEqual(crossed);
      // Each drawing of a card is its own part, counted from its top band.
      expect(drawings.map((d) => d.part)).toEqual(drawings.map((_, i) => i));
    }
  });
});
