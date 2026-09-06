import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySource, projectHistory } from "../../demos/chat-history/source";

const signal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe("history source", () => {
  it("should fetch only a centered page around message 853", async () => {
    const source = new HistorySource(10_000, 0);

    const page = await source.around(853, signal());

    expect(page.items.map((item) => item.index)).toEqual(
      Array.from({ length: 64 }, (_, i) => 816 + i),
    );
    expect(page.start).toEqual({ available: true, cursor: 816 });
    expect(page.end).toEqual({ available: true, cursor: 880 });
    expect(page.items.find((item) => item.index === 853)?.key).toBe(
      "message:853",
    );
  });

  it.each([
    [10_000, 0, 0, 64],
    [10_000, 9_999, 9_936, 64],
    [10_100, 10_099, 10_036, 64],
    [7, 6, 0, 7],
    [1, 0, 0, 1],
  ])(
    "should keep target %i/%i within a bounded endpoint page",
    async (total, target, first, count) => {
      const source = new HistorySource(total, 0);

      const page = await source.around(target, signal());

      expect(page.items).toHaveLength(count);
      expect(page.items[0]?.index).toBe(first);
      expect(page.items.some((item) => item.index === target)).toBe(true);
      expect(page.start.available).toBe(first > 0);
      expect(page.end.available).toBe(first + count < total);
    },
  );

  it("should continue both ways without missing or repeating messages", async () => {
    const source = new HistorySource(10_000, 0);
    const page = await source.around(853, signal());
    if (!page.start.available || !page.end.available)
      throw new Error("expected two continuations");

    const before = await source.load({
      edge: "start",
      cursor: page.start.cursor,
      signal: signal(),
    });
    const after = await source.load({
      edge: "end",
      cursor: page.end.cursor,
      signal: signal(),
    });

    const indices = [...before.items, ...page.items, ...after.items].map(
      (item) => item.index,
    );
    expect(indices).toEqual(Array.from({ length: 192 }, (_, i) => 752 + i));
    const restored = await source.load({
      edge: "start",
      cursor: after.items[0]?.index ?? -1,
      signal: signal(),
    });
    expect(restored).toEqual(page);
  });

  it("should retain a partial first day and deduplicate headers across page joins", async () => {
    const source = new HistorySource(10_100, 0);
    const end = await source.around(10_099, signal());
    const before = await source.load({
      edge: "start",
      cursor: 10_036,
      signal: signal(),
    });

    const initial = projectHistory(end.items);
    const joined = projectHistory([...before.items, ...end.items], initial);

    expect(initial[0]).toEqual({
      kind: "header",
      key: "day:1254",
      group: 1254,
    });
    expect(initial[1]).toEqual(end.items[0]);
    expect(joined.filter((row) => row.key === "day:1254")).toEqual([
      initial[0],
    ]);
    expect(joined.find((row) => row.key === "day:1254")).toBe(initial[0]);
    expect(joined.filter((row) => row.kind === "message")).toEqual([
      ...before.items,
      ...end.items,
    ]);
  });

  it("should expose appended messages without allocating the archive", async () => {
    const source = new HistorySource(10_000, 0);
    source.append(100);

    const page = await source.around(10_099, signal());

    expect(source.total).toBe(10_100);
    expect(page.items).toHaveLength(64);
    expect(page.items.at(-1)?.index).toBe(10_099);
    expect(page.end).toEqual({ available: false });
  });

  it("should cancel an in-flight around fetch without delivering a stale page", async () => {
    vi.useFakeTimers();
    const source = new HistorySource();
    const controller = new AbortController();
    const result = source.around(853, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });

    controller.abort();
    await vi.runAllTimersAsync();

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should reject a request that was already cancelled", async () => {
    const source = new HistorySource(10_000, 0);
    const controller = new AbortController();
    controller.abort();

    await expect(source.around(853, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      source.load({ edge: "end", cursor: 880, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("should cancel a zero-latency request before its queued continuation", async () => {
    const source = new HistorySource(10_000, 0);
    const controller = new AbortController();
    const pending = source.around(853, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([-1, 10_000, 8.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "should reject invalid target %s",
    async (index) => {
      const source = new HistorySource(10_000, 0);
      await expect(source.around(index, signal())).rejects.toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])(
    "should reject invalid append count %s without changing the archive",
    (count) => {
      const source = new HistorySource(10_000, 0);
      expect(() => source.append(count)).toThrow(RangeError);
      expect(source.total).toBe(10_000);
    },
  );
});
