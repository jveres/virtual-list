/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireResize,
  flowHeight,
  type Harness,
  type MountHooks,
  message,
  mount,
  ROW_H,
  range,
  useHarness,
  VIEWPORT_H,
} from "../helpers/list-harness";

// A viewport width change reads in two tiers. Rows connected to the canvas
// (the window) are read in the delivery: the engine has laid them out. Rows
// detached at that moment keep their old-width height until the width has
// been quiet for 150ms, until they mount, or until a settle, a command, or a
// window job needs exact geometry. `state.held` reports the wait.

useHarness();

const QUIET_MS = 150;
const COUNT = 50;

interface Resizable extends Harness {
  /** Ids in the order their heights were read. */
  measured: number[];
  /** Every row now lays out at `height`; the viewport reports `width`. */
  resize: (width: number, height: number) => void;
  /** Ids of the mounted rows, in list order. */
  mountedIds: () => number[];
}

/** Fifty 100px rows, the viewport at m20: rows 14 to 31 are mounted. */
function mountAt20(hooks: MountHooks = {}): Resizable {
  let width = 300;
  const measured: number[] = [];
  const h = mount(range(0, COUNT), {
    width: () => width,
    onMeasure: (m) => measured.push(m.id),
    ...hooks,
  });
  void h.list.scrollTo("m20");
  measured.length = 0;
  return Object.assign(h, {
    measured,
    resize: (next: number, height: number) => {
      width = next;
      for (let id = 0; id < COUNT + 30; id++) h.heights.set(id, height);
      fireResize(1, h.viewport, VIEWPORT_H);
    },
    mountedIds: () =>
      [...h.canvas().querySelectorAll<HTMLElement>("[data-id]")]
        .filter((row) => h.list.elementOf(`m${row.dataset.id}`) === row)
        .map((row) => Number(row.dataset.id)),
  });
}

const once = (ids: readonly number[]): number[] =>
  [...ids].sort((a, b) => a - b);
const all = range(0, COUNT).map((m) => m.id);

describe("viewport width change: two tiers", () => {
  it("should read only connected rows in the delivery and the rest once the width is quiet", () => {
    const h = mountAt20();
    const window = h.mountedIds();
    expect(window).toEqual(range(14, 32).map((m) => m.id));
    const inserted = vi.spyOn(Node.prototype, "insertBefore");

    h.resize(200, 150);

    // The window is exact in the delivery: no row connects to be read.
    expect(once(h.measured)).toEqual(window);
    expect(inserted).not.toHaveBeenCalled();
    expect(h.slotOf(h.rowElement("msg 20")).style.height).toBe("150px");
    // Rows out of the window keep their old-width height for now.
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.totalSize).toBe(32 * ROW_H + 18 * 150);
    expect(h.list.positionOf("m5")).toEqual({ top: 500, height: ROW_H });
    // The anchor holds: m20 stays under the viewport top.
    expect(h.viewport.scrollTop).toBe(h.list.positionOf("m20")?.top);

    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(h.list.state.held).toBe(true);
    vi.advanceTimersByTime(1);

    // One pass read every other row, once.
    expect(once(h.measured)).toEqual(all);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    expect(h.list.positionOf("m5")).toEqual({ top: 750, height: 150 });
    expect(h.viewport.scrollTop).toBe(20 * 150);
    expect(h.slotOf(h.rowElement("msg 20")).style.transform).toBe(
      `translateY(${20 * 150}px)`,
    );
    // The rows it connected are detached again.
    expect(h.canvas().querySelectorAll("[data-id]")).toHaveLength(
      h.mountedIds().length,
    );
    h.list.dispose();
  });

  it("should restart the wait when the width changes again", () => {
    const h = mountAt20();
    h.resize(280, 120);
    vi.advanceTimersByTime(100);
    h.resize(200, 150);
    vi.advanceTimersByTime(QUIET_MS - 1);

    // Two deliveries, and no detached row has been read yet.
    expect(h.list.state.held).toBe(true);
    expect(h.measured).not.toContain(0);
    expect(h.measured).not.toContain(49);

    vi.advanceTimersByTime(1);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    expect(h.measured.filter((id) => id === 0)).toHaveLength(1);
    expect(h.measured.filter((id) => id === 49)).toHaveLength(1);
    h.list.dispose();
  });

  it("should read a stale row that enters the window in the same delivery", () => {
    const h = mountAt20();

    // Wider: rows wrap shorter, so the window takes in more of them.
    h.resize(500, 50);

    const mounted = h.mountedIds();
    expect(mounted.length).toBeGreaterThan(18);
    expect(mounted.length).toBeLessThan(COUNT);
    // The window never keeps a height of the old width.
    expect(once(h.measured)).toEqual(mounted);
    for (const id of mounted) {
      const slot = h.slotOf(h.rowElement(`msg ${id}`));
      expect(slot.style.height).toBe("50px");
      expect(slot.style.transform).toBe(
        `translateY(${h.list.positionOf(`m${id}`)?.top}px)`,
      );
    }
    // It covers the viewport and its overscan on both sides.
    const top = h.viewport.scrollTop;
    const first = h.list.positionOf(`m${mounted[0]}`);
    const last = h.list.positionOf(`m${mounted.at(-1)}`);
    expect(first?.top).toBeLessThanOrEqual(top - VIEWPORT_H);
    expect((last?.top ?? 0) + 50).toBeGreaterThanOrEqual(top + 2 * VIEWPORT_H);
    expect(top).toBe(h.list.positionOf("m20")?.top);
    expect(h.list.state.held).toBe(true);

    vi.advanceTimersByTime(QUIET_MS);
    expect(once(h.measured)).toEqual(all);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 50);
    expect(h.viewport.scrollTop).toBe(20 * 50);
    h.list.dispose();
  });

  it("should read a stale row at or below the anchor when a gesture mounts it", () => {
    const h = mountAt20();
    h.resize(200, 150);
    h.measured.length = 0;

    // A gesture starts during the wait and scrolls down.
    h.userScroll(h.viewport.scrollTop + 900);

    expect(h.measured).toContain(32);
    expect(h.slotOf(h.rowElement("msg 32")).style.height).toBe("150px");
    // Only the rows it mounted were read: the pass waits for the settle.
    expect(h.measured.length).toBeLessThan(6);
    vi.advanceTimersByTime(QUIET_MS);
    expect(h.measured.length).toBeLessThan(6);
    expect(h.list.state.held).toBe(true);

    h.settle();
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    expect(h.list.positionOf("m49")).toEqual({ top: 49 * 150, height: 150 });
    h.list.dispose();
  });

  it("should hold a stale row above the anchor until the settle under runtime anchoring", () => {
    const h = mountAt20();
    h.resize(200, 150);
    const before = h.list.state.totalSize;

    // Scrolling up mounts rows above the anchor: a scroll write would be
    // needed, so their heights wait for the settle (the one commit rule).
    h.userScroll(h.viewport.scrollTop - 600);
    const top = h.viewport.scrollTop;
    expect(h.mountedIds()).toContain(13);
    expect(h.list.state.totalSize).toBe(before);
    expect(h.viewport.scrollTop).toBe(top);

    h.settle();
    expect(h.slotOf(h.rowElement("msg 13")).style.height).toBe("150px");
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    h.list.dispose();
  });

  it("should commit stale rows above the reader mid-gesture under native anchoring", () => {
    const h = mountAt20({ anchoring: "native" });
    h.resize(200, 150);
    expect(h.list.state.held).toBe(true);
    expect(flowHeight(h.canvas())).toBe(h.list.state.totalSize);

    h.userScroll(h.viewport.scrollTop - 600);
    expect(h.slotOf(h.rowElement("msg 13")).style.height).toBe("150px");

    h.settle();
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    expect(flowHeight(h.canvas())).toBe(COUNT * 150);
    h.list.dispose();
  });

  it("should resolve a command against geometry read at the new width", async () => {
    const h = mountAt20();
    h.resize(200, 150);

    const landed = h.list.scrollTo("m40", { align: "start" });

    expect(once(h.measured)).toEqual(all);
    expect(h.list.state.held).toBe(false);
    expect(h.list.positionOf("m40")).toEqual({ top: 40 * 150, height: 150 });
    expect(h.viewport.scrollTop).toBe(40 * 150);
    await expect(landed).resolves.toBe(true);
    // The wait that was pending finds nothing left to read.
    vi.advanceTimersByTime(QUIET_MS);
    expect(once(h.measured)).toEqual(all);
    h.list.dispose();
  });

  it("should land a window job in geometry read at the new width", async () => {
    const h = mountAt20();
    h.resize(200, 150);

    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, message(COUNT)],
      anchor: "viewport",
    }));

    await expect(applied).resolves.toBe(true);
    expect(h.list.state.count).toBe(COUNT + 1);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe((COUNT + 1) * 150);
    expect(h.viewport.scrollTop).toBe(20 * 150);
    h.list.dispose();
  });

  it("should finish the pass after a window job is aborted during the wait", async () => {
    const h = mountAt20();
    h.resize(200, 150);
    const abort = new AbortController();
    const applied = h.list.updateWindow(
      ({ items }) => ({ items: [...items, ...range(COUNT, COUNT + 24)] }),
      abort.signal,
    );
    vi.advanceTimersByTime(16);
    abort.abort();
    await expect(applied).resolves.toBe(false);
    expect(h.list.state.held).toBe(true);

    vi.advanceTimersByTime(QUIET_MS);
    expect(h.list.state.count).toBe(COUNT);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    h.list.dispose();
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("should read nothing after a disposal during the wait", () => {
    const h = mountAt20();
    h.resize(200, 150);
    h.measured.length = 0;

    h.list.dispose();
    vi.advanceTimersByTime(10 * QUIET_MS);

    expect(h.measured).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(once(h.destroyed)).toEqual(all);
  });

  it("should finish the pass in a hidden document", () => {
    const h = mountAt20();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    try {
      h.resize(200, 150);
      expect(h.list.state.held).toBe(true);
      vi.advanceTimersByTime(QUIET_MS);
      expect(h.list.state.held).toBe(false);
      expect(h.list.state.totalSize).toBe(COUNT * 150);
      expect(h.viewport.scrollTop).toBe(20 * 150);
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    }
    h.list.dispose();
  });

  it("should wait for a phase that outlasts the quiet window, then finish", () => {
    const h = mountAt20();
    h.resize(200, 150);
    h.userScroll(h.viewport.scrollTop + 40);
    h.measured.length = 0;

    // The gesture is still going when the width has been quiet: nothing
    // is read under it.
    vi.advanceTimersByTime(4 * QUIET_MS);
    expect(h.measured).toEqual([]);
    expect(h.list.state.held).toBe(true);

    h.settle();
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    // m20 was 40px into the viewport's top row and still is.
    expect(h.viewport.scrollTop).toBe(20 * 150 + 40);
    h.list.dispose();
  });

  it("should let a pending remeasure commit before the pass", () => {
    const h = mountAt20();
    h.resize(200, 150);
    vi.advanceTimersByTime(QUIET_MS - 1);
    h.measured.length = 0;

    // A host interaction owns the next commit and its anchor policy.
    h.heights.set(20, 400);
    h.list.remeasure("m20", { anchor: "viewport" });
    vi.advanceTimersByTime(1);
    expect(h.measured).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(h.measured).toEqual([20]);
    expect(h.slotOf(h.rowElement("msg 20")).style.height).toBe("400px");
    expect(h.list.state.held).toBe(true);

    vi.advanceTimersByTime(QUIET_MS);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150 + 250);
    expect(h.viewport.scrollTop).toBe(20 * 150);
    h.list.dispose();
  });

  it("should drop a stale row removed during the wait", () => {
    const h = mountAt20();
    h.resize(200, 150);
    h.measured.length = 0;

    h.list.setItems(range(10, COUNT), { anchor: "viewport" });
    vi.advanceTimersByTime(QUIET_MS);

    expect(h.measured.filter((id) => id < 10)).toEqual([]);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe((COUNT - 10) * 150);
    expect(h.viewport.scrollTop).toBe(10 * 150);
    h.list.dispose();
  });

  it("should read a stale row updated during the wait once, at the new width", () => {
    const h = mountAt20();
    h.resize(200, 150);

    h.heights.set(2, 170);
    h.list.updateItem("m2", message(2, "edited"));
    expect(h.list.positionOf("m2")).toEqual({ top: 200, height: 170 });

    vi.advanceTimersByTime(QUIET_MS);
    expect(h.measured.filter((id) => id === 2)).toHaveLength(1);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150 + 20);
    h.list.dispose();
  });

  it("should still read every row at once when the change ends a scroll phase", () => {
    const h = mountAt20();
    h.userScroll(2005);

    h.resize(200, 150);

    expect(once(h.measured)).toEqual(all);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(COUNT * 150);
    expect(h.viewport.scrollTop).toBe(20 * 150 + 5);
    h.list.dispose();
  });

  it("should leave declared heights alone", () => {
    let width = 300;
    const h = mount(range(0, COUNT), {
      width: () => width,
      itemHeight: () => ROW_H,
    });
    void h.list.scrollTo("m20");
    const timers = vi.getTimerCount();

    width = 200;
    fireResize(1, h.viewport, VIEWPORT_H);

    expect(h.list.state.held).toBe(false);
    expect(vi.getTimerCount()).toBe(timers);
    h.list.dispose();
  });
});
