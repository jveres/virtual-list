/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createVirtualList } from "../../src/virtual-list";
import { advanceFramesUntil, useHarness } from "../helpers/list-harness";

useHarness();

type Item = { id: string; height: number; start: number | null };

function setup() {
  const viewport = document.createElement("div");
  document.body.append(viewport);
  viewport.scrollTo = (optionsOrX?: ScrollToOptions | number, y?: number) => {
    const top = typeof optionsOrX === "number" ? y : optionsOrX?.top;
    viewport.scrollTop = top ?? viewport.scrollTop;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("scrollend"));
  };
  Object.defineProperties(viewport, {
    clientHeight: { value: 600 },
    clientWidth: { value: 800 },
    scrollHeight: {
      get: () =>
        Number.parseFloat(
          (viewport.firstElementChild as HTMLElement | null)?.style.height ??
            "0",
        ),
    },
  });
  const reads = vi.fn();
  const select = vi.fn((item: Item, row: HTMLElement) =>
    item.start === null ? null : (row.firstElementChild as HTMLElement),
  );
  const history: Item = { id: "history", height: 1400, start: 0 };
  const list = createVirtualList(viewport, {
    items: [history, { id: "reply", height: 100, start: null }],
    key: (item) => item.id,
    anchoring: "runtime",
    followBehavior: "smooth",
    followMode: "keep-content",
    followInset: 40,
    followStart: select,
    render(item, existing) {
      const row = existing ?? document.createElement("div");
      row.replaceChildren(document.createElement("div"));
      row.getBoundingClientRect = () =>
        ({ top: 200, height: item.height }) as DOMRect;
      (row.firstElementChild as HTMLElement).getBoundingClientRect = () => {
        reads();
        return { top: 200 + (item.start ?? 0) } as DOMRect;
      };
      return row;
    },
  });
  return {
    viewport,
    list,
    reads,
    select,
    update: (height: number, start: number | null) =>
      list.updateItem("reply", { id: "reply", height, start }),
    rowMode: () => {
      list.setFollowMode("keep-start", 40);
    },
    answerMode: () => {
      list.setFollowMode("keep-content", 40);
    },
    settle: () => {
      vi.advanceTimersByTime(1200);
    },
    dispose: () => {
      list.dispose();
      viewport.remove();
    },
  };
}

describe("measured follow start", () => {
  it("follows tools until text exists, then stops at the text inset without sampling layout", () => {
    const h = setup();
    try {
      h.update(1100, null);
      advanceFramesUntil(() => h.viewport.scrollTop === 1900);
      h.settle();
      expect(h.list.state.following).toBe(true);

      h.update(2300, 800);
      advanceFramesUntil(() => h.viewport.scrollTop === 2160);
      h.settle();
      expect(h.viewport.scrollTop).toBe(2160);

      h.update(2600, 800);
      h.settle();
      expect(h.viewport.scrollTop).toBe(2160);
      expect(h.list.state.following).toBe(true);

      h.update(2800, 950);
      const reads = h.reads.mock.calls.length;
      const selections = h.select.mock.calls.length;
      advanceFramesUntil(() => h.viewport.scrollTop === 2310);
      h.settle();
      expect(h.viewport.scrollTop).toBe(2310);
      expect(h.reads).toHaveBeenCalledTimes(reads);
      expect(h.select).toHaveBeenCalledTimes(selections);

      // A shrinking leading panel never drags the reader backwards.
      h.update(2300, 450);
      h.settle();
      expect(h.viewport.scrollTop).toBe(2310);
    } finally {
      h.dispose();
    }
  });

  it("switches between row and content starts without measuring again", () => {
    const h = setup();
    try {
      h.rowMode();
      h.update(2300, 800);
      advanceFramesUntil(() => h.viewport.scrollTop === 1360);
      h.settle();
      expect(h.list.state.following).toBe(true);
      const reads = h.reads.mock.calls.length;
      h.answerMode();
      advanceFramesUntil(() => h.viewport.scrollTop === 2160);
      h.settle();
      expect(h.viewport.scrollTop).toBe(2160);
      expect(h.reads).toHaveBeenCalledTimes(reads);
      h.rowMode();
      h.settle();
      expect(h.viewport.scrollTop).toBe(2160);
    } finally {
      h.dispose();
    }
  });

  it("lets explicit bottom navigation override the selected start", async () => {
    const h = setup();
    try {
      h.update(2300, 800);
      advanceFramesUntil(() => h.viewport.scrollTop === 2160);
      h.settle();
      await h.list.scrollTo("end");
      expect(h.viewport.scrollTop).toBe(3100);
      h.update(2600, 800);
      advanceFramesUntil(() => h.viewport.scrollTop === 3400);
      h.settle();
      expect(h.viewport.scrollTop).toBe(3400);
      h.list.setItems([
        { id: "history", height: 1400, start: 0 },
        { id: "reply", height: 2600, start: 800 },
        { id: "next", height: 100, start: null },
      ]);
      h.settle();
      h.list.updateItem("next", { id: "next", height: 1300, start: 200 });
      advanceFramesUntil(() => h.viewport.scrollTop === 4160);
      h.settle();
      expect(h.viewport.scrollTop).toBe(4160);
    } finally {
      h.dispose();
    }
  });

  it("rejects a DOM start selector for declared-height rows", () => {
    const viewport = document.createElement("div");
    expect(() =>
      createVirtualList(viewport, {
        items: ["reply"],
        key: (item) => item,
        render: () => document.createElement("div"),
        height: () => 100,
        followStart: (_item, row) => row,
      }),
    ).toThrow("followStart requires measured rows");
  });
});
