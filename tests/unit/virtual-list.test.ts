/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Geometry } from "../../src/geometry";
import type { VirtualListScrollSettleStrategy } from "../../src/scroll-settle";
import {
  createVirtualList,
  type EdgeSlot,
  type ScrollingUpdates,
  type VirtualList,
  type VirtualListOptions,
  type VirtualListState,
} from "../../src/virtual-list";

// Runtime contract tests under jsdom. jsdom has no layout engine, so every
// measured height comes from a per-element getBoundingClientRect mock the
// test controls, and ResizeObserver deliveries are fired by hand through a
// controllable stub. Gestures are driven through the real settle controller
// ("default" strategy: an unmatched scroll starts a gesture, scrollend plus
// the 140ms cooldown settles it). Real engines, real measurement, and paint
// timing are validated in the browser labs — these tests pin the contract:
// geometry immutable during a scroll phase, off-scroller preparation,
// one atomic settle-time commit, immediate idle commits, and exactly-once
// destruction of retained nodes.

interface Msg {
  id: number;
  body: string;
}

const VIEWPORT_H = 600;
const ROW_H = 100;

function message(id: number, body = `msg ${id}`): Msg {
  return { id, body };
}

function range(from: number, to: number): Msg[] {
  return Array.from({ length: to - from }, (_, i) => message(from + i));
}

// --- Controllable ResizeObserver ---------------------------------------------
type ROCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;
const roInstances: { callback: ROCallback; observed: Set<Element> }[] = [];

class ControlledResizeObserver {
  private readonly record: { callback: ROCallback; observed: Set<Element> };
  constructor(callback: ROCallback) {
    this.record = { callback, observed: new Set() };
    roInstances.push(this.record);
  }
  observe(element: Element): void {
    this.record.observed.add(element);
  }
  unobserve(element: Element): void {
    this.record.observed.delete(element);
  }
  disconnect(): void {
    this.record.observed.clear();
  }
}

/** Instance 0 observes rows, instance 1 the viewport (construction order). */
function fireResize(instance: number, target: Element, height: number): void {
  const entry = {
    target,
    borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
  } as unknown as ResizeObserverEntry;
  roInstances[instance]?.callback([entry], null as never);
}

// --- Harness ---------------------------------------------------------------
interface Harness {
  list: VirtualList<Msg>;
  viewport: HTMLElement;
  canvas: () => HTMLElement;
  heights: Map<number, number>;
  destroyed: number[];
  destroyedElements: HTMLElement[];
  states: VirtualListState[];
  reaches: { edge: "start" | "end"; signal: AbortSignal }[];
  rowElement: (body: string) => HTMLElement;
  slotOf: (element: HTMLElement) => HTMLElement;
  userScroll: (top: number) => void;
  settle: () => void;
}

function mount(
  items: Msg[],
  hooks: {
    replaceOnRerender?: boolean;
    onState?: (state: VirtualListState) => void;
    onDestroy?: (element: HTMLElement) => void;
    scrollingUpdates?: ScrollingUpdates;
    followBehavior?: VirtualListOptions<Msg>["followBehavior"];
    settleStrategy?: VirtualListScrollSettleStrategy;
    edgeSlots?: VirtualListOptions<Msg>["edgeSlots"];
    /** Runs at the start of every render (probe hook). */
    onRender?: (m: Msg, existing?: HTMLElement) => void;
    /** Reports how many fresh peers share the detached root at each read. */
    onMeasure?: (m: Msg, batchSize: number) => void;
    reach?: boolean | "start-only";
    width?: () => number;
    height?: () => number;
    /** Observes every scrollTop write — where an engine forces layout. */
    onScrollWrite?: () => void;
    /** render() throws for items with this body. */
    throwOn?: string;
    /** getBoundingClientRect throws for items with this body (post-build). */
    measureFailOn?: string;
  } = {},
): Harness {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const canvasHeight = (): number => {
    const canvas = viewport.firstElementChild as HTMLElement | null;
    return canvas ? Number.parseFloat(canvas.style.height) || 0 : 0;
  };
  const maxScrollTop = (): number =>
    Math.max(0, canvasHeight() - (hooks.height?.() ?? VIEWPORT_H));
  Object.defineProperties(viewport, {
    clientHeight: { get: () => hooks.height?.() ?? VIEWPORT_H },
    clientWidth: { get: () => hooks.width?.() ?? 300 },
    offsetWidth: { get: () => 315 },
    // Engines report scrollHeight as a whole pixel while scrollTop may be
    // fractional — the mismatch a takeover must not clamp against.
    scrollHeight: {
      get: () => Math.round(Math.max(VIEWPORT_H, canvasHeight())),
    },
    // A shrinking range clamps the position for good, as layout does in an
    // engine: growing the range back later does not restore it.
    scrollTop: {
      get: () => {
        scrollTop = Math.max(0, Math.min(maxScrollTop(), scrollTop));
        return scrollTop;
      },
      set: (next: number) => {
        hooks.onScrollWrite?.();
        scrollTop = Math.max(0, Math.min(maxScrollTop(), next));
      },
    },
  });
  document.body.appendChild(viewport);

  const heights = new Map<number, number>();
  const destroyed: number[] = [];
  const destroyedElements: HTMLElement[] = [];
  const states: VirtualListState[] = [];
  const reaches: { edge: "start" | "end"; signal: AbortSignal }[] = [];

  const stamp = (element: HTMLElement, m: Msg): HTMLElement => {
    element.dataset.id = String(m.id);
    element.getBoundingClientRect = () => {
      hooks.onMeasure?.(m, element.parentElement?.childElementCount ?? 0);
      if (hooks.measureFailOn !== undefined && m.body === hooks.measureFailOn) {
        throw new Error(`measure failed: ${m.body}`);
      }
      return { height: heights.get(m.id) ?? ROW_H } as DOMRect;
    };
    return element;
  };

  const list = createVirtualList<Msg>(viewport, {
    items,
    key: (m) => `m${m.id}`,
    settleStrategy: hooks.settleStrategy ?? "default",
    // The harness pins "same-height" (the mode most tests describe); the
    // runtime's own default is "live" (pinned by its own test).
    scrollingUpdates: hooks.scrollingUpdates ?? "same-height",
    followBehavior: hooks.followBehavior,
    edgeSlots: hooks.edgeSlots,
    render: (m, existing) => {
      hooks.onRender?.(m, existing);
      if (hooks.throwOn !== undefined && m.body === hooks.throwOn) {
        throw new Error(`render failed: ${m.body}`);
      }
      if (existing && !hooks.replaceOnRerender) {
        existing.textContent = m.body;
        return existing;
      }
      const element = document.createElement("div");
      element.textContent = m.body;
      return stamp(element, m);
    },
    onState: (state) => {
      states.push(state);
      hooks.onState?.(state);
    },
    onDestroy: (element) => {
      destroyed.push(Number(element.dataset.id));
      destroyedElements.push(element);
      hooks.onDestroy?.(element);
    },
    onReachStart: hooks.reach
      ? ({ signal }) => reaches.push({ edge: "start", signal })
      : undefined,
    onReachEnd:
      hooks.reach === true
        ? ({ signal }) => reaches.push({ edge: "end", signal })
        : undefined,
  });

  return {
    list,
    viewport,
    canvas: () => viewport.firstElementChild as HTMLElement,
    heights,
    destroyed,
    destroyedElements,
    states,
    reaches,
    rowElement: (body) => {
      const canvas = viewport.firstElementChild as HTMLElement;
      const found = [...canvas.querySelectorAll("div")].find(
        (el) => el.textContent === body && el.dataset.id !== undefined,
      );
      expect(found, `row "${body}" should be mounted`).toBeDefined();
      return found as HTMLElement;
    },
    slotOf: (element) => element.parentElement as HTMLElement,
    // An unmatched scroll event is a user gesture (≥2px off any write).
    userScroll: (top) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
    },
    settle: () => {
      viewport.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(200);
    },
  };
}

beforeEach(() => {
  roInstances.length = 0;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver =
    ControlledResizeObserver;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("v2 runtime — commits and slots", () => {
  it("boots at the end with premeasured heights in fixed-height slots", () => {
    const h = mount(range(0, 50));
    expect(h.list.state.count).toBe(50);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.viewport.scrollTop).toBe(50 * ROW_H - VIEWPORT_H);
    expect(h.list.state.atEnd).toBe(true);

    const row = h.rowElement("msg 49");
    const slot = h.slotOf(row);
    expect(slot.style.height).toBe(`${ROW_H}px`);
    expect(["clip", "hidden"]).toContain(slot.style.overflow);
    expect(slot.style.transform).toBe(`translateY(${49 * ROW_H}px)`);
    expect(h.canvas().children.length).toBeLessThan(20); // Windowed.
  });

  it("premeasures every fresh row in one detached layout batch", () => {
    const reads: { id: number; batchSize: number }[] = [];
    const h = mount(range(0, 50), {
      onMeasure: (m, batchSize) => reads.push({ id: m.id, batchSize }),
    });

    expect(reads).toHaveLength(50);
    expect(reads.map(({ id }) => id)).toEqual(
      Array.from({ length: 50 }, (_, id) => id),
    );
    expect(reads.every(({ batchSize }) => batchSize === 50)).toBe(true);
    h.list.dispose();
  });

  it("computes the visible geometry window once per ordinary scroll event", () => {
    const windowSpy = vi.spyOn(Geometry.prototype, "window");
    const h = mount(range(0, 50));
    windowSpy.mockClear();

    h.userScroll(2000);

    expect(windowSpy).toHaveBeenCalledTimes(1);
    h.list.dispose();
    windowSpy.mockRestore();
  });

  it("smoothly follows end-compatible growth when configured", () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    const before = h.viewport.scrollTop;
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");

    h.list.setItems(streamed);

    expect(h.viewport.scrollTop).toBe(before); // No instant jump.
    expect(h.list.state.following).toBe(true);
    vi.advanceTimersByTime(160);
    expect(h.viewport.scrollTop).toBeGreaterThan(before);
    expect(h.viewport.scrollTop).toBeLessThan(4600);
    vi.advanceTimersByTime(176);
    expect(h.viewport.scrollTop).toBe(4600); // First leg caught the end.

    // More growth during that leg's settle cooldown starts another leg;
    // following is a persistent intent, not one animation per snapshot.
    h.heights.set(49, 500);
    const streamedAgain = [...initial];
    streamedAgain[49] = message(49, "streamed longer again");
    h.list.setItems(streamedAgain);
    expect(h.viewport.scrollTop).toBe(4600);
    vi.advanceTimersByTime(500);
    expect(h.viewport.scrollTop).toBe(4800);
    expect(h.list.state.following).toBe(true);

    h.userScroll(4500);
    expect(h.list.state.following).toBe(false);
    h.list.dispose();
  });

  it("remeasures a user-expanded tail with a viewport anchor and no follow", () => {
    const h = mount(range(0, 50), { followBehavior: "smooth" });
    const before = h.viewport.scrollTop;
    const tail = h.rowElement("msg 49");

    // The host declares intent before <details>' default action changes the
    // row; the next frame observes its post-action height.
    h.list.remeasure("m49", { anchor: "viewport" });
    h.heights.set(49, 300);
    vi.advanceTimersByTime(16);

    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.slotOf(tail).style.height).toBe("300px");
    expect(h.viewport.scrollTop).toBe(before);
    expect(h.list.state.following).toBe(false);

    // The later observer delivery is a no-op, not a second transaction.
    const publications = h.states.length;
    fireResize(0, tail, 300);
    expect(h.states).toHaveLength(publications);
    vi.advanceTimersByTime(500);
    expect(h.viewport.scrollTop).toBe(before);
  });

  it("preserves remeasure intent when a snapshot commits before its frame", () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    const before = h.viewport.scrollTop;

    h.list.remeasure("m49", { anchor: "viewport" });
    h.list.setItems([...initial, message(50)]); // Would normally end-follow.
    expect(h.viewport.scrollTop).toBe(before);
    expect(h.list.state.following).toBe(false);

    h.heights.set(49, 300);
    vi.advanceTimersByTime(16);
    expect(h.list.state.totalSize).toBe(51 * ROW_H + 200);
    expect(h.viewport.scrollTop).toBe(before);
  });

  it("cancels an active automatic glide before a user-driven remeasure", () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed);
    vi.advanceTimersByTime(64);
    const interruptedAt = h.viewport.scrollTop;
    expect(interruptedAt).toBeGreaterThan(50 * ROW_H - VIEWPORT_H);

    h.list.remeasure("m49", { anchor: "viewport" });
    expect(h.list.state.following).toBe(false);
    h.heights.set(49, 500);
    vi.advanceTimersByTime(16);

    expect(h.list.state.totalSize).toBe(50 * ROW_H + 400);
    expect(h.viewport.scrollTop).toBe(interruptedAt);
    vi.advanceTimersByTime(500);
    expect(h.viewport.scrollTop).toBe(interruptedAt);
  });

  it("does not settle native input that takes over before the remeasure frame", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed);
    vi.advanceTimersByTime(64);

    h.list.remeasure("m49", { anchor: "viewport" });
    h.heights.set(49, 500);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    h.userScroll(h.viewport.scrollTop - 100);
    const userTop = h.viewport.scrollTop;
    vi.advanceTimersByTime(16);

    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.list.state.held).toBe(true);
    expect(h.viewport.scrollTop).toBe(userTop);
    h.settle();
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 400);
    expect(h.viewport.scrollTop).toBe(userTop);
  });

  it("carries an explicit remeasure anchor through a native scroll settle", () => {
    const h = mount(range(0, 50), {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4300);
    h.userScroll(4400); // Active gesture, back at the old end.
    const tail = h.rowElement("msg 49");

    h.list.remeasure("m49", { anchor: "viewport" });
    h.heights.set(49, 300);
    vi.advanceTimersByTime(16);
    fireResize(0, tail, 300);

    // Even live mode cannot consume the explicit intent mid-gesture.
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.slotOf(tail).style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.held).toBe(true);
    h.settle();

    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.slotOf(tail).style.height).toBe("300px");
    expect(h.viewport.scrollTop).toBe(4400);
    expect(h.list.state.following).toBe(false);
  });

  it("commits idle updates immediately: append follows the end, prepend keeps the anchor", () => {
    const h = mount(range(10, 60));
    h.list.setItems(range(10, 62));
    expect(h.viewport.scrollTop).toBe(52 * ROW_H - VIEWPORT_H);

    void h.list.scrollTo("m30");
    const anchorTop = h.viewport.scrollTop;
    h.list.setItems(range(0, 62));
    expect(h.viewport.scrollTop).toBe(anchorTop + 10 * ROW_H);
    expect(h.list.state.held).toBe(false);
  });

  it("holds a structural update during a gesture and commits it once at settle", () => {
    const h = mount(range(0, 50));
    h.userScroll(3005);
    const canvasBefore = h.canvas().style.height;
    const slotBefore = h.slotOf(h.rowElement("msg 30")).style.transform;

    h.list.setItems(range(-10, 50)); // Prepend: geometry change → held.
    expect(h.list.state.count).toBe(50);
    expect(h.list.state.held).toBe(true);
    expect(h.canvas().style.height).toBe(canvasBefore); // Nothing moved...
    expect(h.slotOf(h.rowElement("msg 30")).style.transform).toBe(slotBefore);
    expect(h.viewport.scrollTop).toBe(3005); // ...and nothing was written.

    h.settle();
    expect(h.list.state.count).toBe(60);
    expect(h.list.state.held).toBe(false);
    // One anchor-preserving write: the same content stays under the top.
    expect(h.viewport.scrollTop).toBe(3005 + 10 * ROW_H);
  });

  it("freezes a mounted row mid-gesture: the same-key update renders fresh off-scroller and swaps at settle", () => {
    const initial = range(0, 50);
    const existingSeen: (HTMLElement | undefined)[] = [];
    const h = mount(initial, {
      onRender: (m, existing) => {
        if (m.id === 32) existingSeen.push(existing);
      },
    });
    existingSeen.length = 0; // Drop the boot renders.
    h.userScroll(3005);
    const row = h.rowElement("msg 32");
    const slot = h.slotOf(row);

    // First streaming token during the gesture: the mounted element is not
    // offered to render (frozen); a fresh element is built and measured.
    const next = [...initial];
    next[32] = message(32, "streamed body");
    h.heights.set(32, 300);
    h.list.setItems(next);
    expect(existingSeen).toEqual([undefined]);
    expect(row.textContent).toBe("msg 32"); // Untouched on screen...
    expect(row.isConnected).toBe(true);
    expect(slot.style.height).toBe(`${ROW_H}px`); // ...geometry untouched.
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.list.state.held).toBe(true);

    // Second token in the same phase: the off-scroller replacement is
    // advanced in place — one fresh render per phase, not per token.
    const next2 = [...initial];
    next2[32] = message(32, "streamed body more");
    h.list.setItems(next2);
    expect(existingSeen).toHaveLength(2);
    expect(existingSeen[1]).toBeDefined();
    expect(existingSeen[1]).not.toBe(row);
    expect(row.textContent).toBe("msg 32");
    expect(h.viewport.scrollTop).toBe(3005);

    h.settle(); // Content, height, geometry, anchor: one atomic swap.
    const after = h.rowElement("streamed body more");
    expect(after).not.toBe(row);
    expect(row.isConnected).toBe(false);
    expect(h.destroyed).toEqual([32]); // The frozen element, exactly once.
    expect(h.slotOf(after).style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.viewport.scrollTop).toBe(3005); // Growth below the anchor.
    expect(h.list.state.held).toBe(false);
  });

  it("an omitted anchor inherits the pending snapshot's explicit policy", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    // At the very end, scrolling: a bottom page load asks to preserve the
    // viewport (a page is not a live message). The gesture starts off the
    // boot position (which the boot commit recorded as its own write).
    h.userScroll(3005);
    h.userScroll(50 * ROW_H - VIEWPORT_H);
    const atEnd = h.viewport.scrollTop;
    const withPage = [...initial, ...range(50, 62)];
    h.list.setItems(withPage, { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);

    // Before settle, an unrelated same-key update (a decoded image) is
    // handed over with no anchor option — it must not become "auto".
    const withImage = [...withPage];
    withImage[10] = message(10, "image decoded");
    h.list.setItems(withImage);

    h.settle();
    expect(h.list.state.count).toBe(62);
    expect(h.viewport.scrollTop).toBe(atEnd); // Preserved, not end-followed.
    expect(h.list.state.atEnd).toBe(false);
  });

  it("an explicit anchor replaces the pending policy", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3005);
    h.userScroll(50 * ROW_H - VIEWPORT_H);
    h.list.setItems([...initial, ...range(50, 62)], { anchor: "viewport" });
    h.list.setItems([...initial, ...range(50, 62)], { anchor: "end" });
    h.settle();
    expect(h.viewport.scrollTop).toBe(62 * ROW_H - VIEWPORT_H);
  });

  it("promotes an equal-height update at once during a phase: swapped into the slot, no geometry change", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3005);
    const row = h.rowElement("msg 32");
    const slot = h.slotOf(row);

    const next = [...initial];
    next[32] = message(32, "same-height token"); // Measures ROW_H, like m32.
    h.list.setItems(next);
    const promoted = h.rowElement("same-height token");
    expect(promoted).not.toBe(row);
    expect(h.slotOf(promoted)).toBe(slot); // Into the committed slot...
    expect(row.isConnected).toBe(false);
    expect(h.destroyed).toEqual([32]); // ...the displaced element gone once.
    expect(slot.style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.viewport.scrollTop).toBe(3005);
    expect(h.list.state.held).toBe(false); // Nothing waits for settle.

    // The observer follows the promoted element: a later growth is held.
    h.heights.set(32, 300);
    fireResize(0, promoted, 300);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(slot.style.height).toBe("300px");
  });

  it('scrollingUpdates: "freeze" holds even an equal-height update until settle', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "freeze" });
    h.userScroll(3005);
    const row = h.rowElement("msg 32");
    const next = [...initial];
    next[32] = message(32, "same-height token");
    h.list.setItems(next);
    expect(row.textContent).toBe("msg 32"); // Frozen, not promoted.
    expect(row.isConnected).toBe(true);
    expect(h.list.state.held).toBe(true);
    expect(h.destroyed).toEqual([]);
    h.settle();
    expect(h.rowElement("same-height token")).not.toBe(row);
    expect(h.destroyed).toEqual([32]);
  });

  it('scrollingUpdates: "live" commits a row at/below the anchor at once, with no scroll write', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(3005); // Anchor: m30.
    const row = h.rowElement("msg 32");
    const slot = h.slotOf(row);
    const next = [...initial];
    next[32] = message(32, "streamed live");
    h.heights.set(32, 300);
    h.list.setItems(next);
    // In place AND committed: the slot grew with its content, the canvas
    // grew below, nothing above moved, no write.
    expect(row.textContent).toBe("streamed live");
    expect(slot.style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.slotOf(h.rowElement("msg 33")).style.transform).toBe(
      `translateY(${33 * ROW_H + 200}px)`,
    );
    expect(h.viewport.scrollTop).toBe(3005);
    expect(h.list.state.held).toBe(false);
    expect(h.destroyed).toEqual([]);
  });

  it('"live" reconciles at the browser-clamped position after a canvas shrink', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.heights.set(49, 1000);
    fireResize(0, h.rowElement("msg 49"), 1000);
    expect(h.viewport.scrollTop).toBe(5300);

    h.userScroll(5298);
    h.heights.set(49, 100);
    const next = [...initial];
    next[49] = message(49, "shrunk live");
    h.list.setItems(next);

    // Shrinking the canvas clamps the browser's real scrollTop even though
    // the runtime did not write it. Reconciliation must use that clamped
    // position in the same frame, or rows newly exposed above stay absent.
    expect(h.viewport.scrollTop).toBe(4400);
    expect(h.list.state.start).toBe(38);
    expect(h.rowElement("msg 44")).toBeDefined();
  });

  it('"live" keeps a dirty row above the anchor for settle, or for the scroll that reaches it', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(3005); // Anchor: m30; m28 is mounted (overscan), above it.
    const row = h.rowElement("msg 28");
    const slot = h.slotOf(row);
    const next = [...initial];
    next[28] = message(28, "grown above");
    h.heights.set(28, 300);
    h.list.setItems(next);
    // Committing it would need a scroll write: held, off-screen.
    expect(slot.style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.list.state.held).toBe(true);
    expect(h.viewport.scrollTop).toBe(3005);

    // The user scrolls up into it: it is the anchor now and commits in
    // that scroll event, before the frame paints — still no write.
    h.userScroll(2850);
    expect(slot.style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.viewport.scrollTop).toBe(2850);
    expect(h.list.state.held).toBe(false);
  });

  it('the runtime defaults to "live"', () => {
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientHeight: { get: () => VIEWPORT_H },
      clientWidth: { get: () => 300 },
      scrollHeight: { get: () => 50 * ROW_H },
    });
    document.body.appendChild(viewport);
    const seen: (HTMLElement | undefined)[] = [];
    const initial = range(0, 50);
    const list = createVirtualList<Msg>(viewport, {
      items: initial,
      key: (m) => `m${m.id}`,
      settleStrategy: "default",
      render: (m, existing) => {
        if (m.id === 30) seen.push(existing);
        if (existing) {
          existing.textContent = m.body;
          return existing;
        }
        const element = document.createElement("div");
        element.textContent = m.body;
        element.getBoundingClientRect = () => ({ height: ROW_H }) as DOMRect;
        return element;
      },
    });
    seen.length = 0;
    viewport.scrollTop = 3005;
    viewport.dispatchEvent(new Event("scroll")); // A gesture is active.
    const next = [...initial];
    next[30] = message(30, "live by default");
    list.setItems(next);
    // "live": the mounted element itself was offered and updated in place.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.textContent).toBe("live by default");
    list.dispose();
  });

  it("a glide's phase ends only when the glide completes, not at a mid-glide scrollend (Safari)", () => {
    // Safari emits a scrollend after every programmatic write. In "live"
    // mode at the end, streaming growth commits under the glide and moves
    // its target, so the glide keeps chasing; a proximity-judged "reached"
    // at such a scrollend started the settle cooldown mid-chase and let a
    // structural commit land under a still-moving glide.
    const initial = range(0, 50);
    const h = mount(initial, {
      settleStrategy: "safari-wheel",
      scrollingUpdates: "live",
    });
    h.userScroll(3005);
    h.userScroll(4380);
    h.settle();
    vi.advanceTimersByTime(2_000);
    expect(h.list.state.held).toBe(false);

    void h.list.scrollTo("end", { behavior: "smooth" });
    for (
      let frame = 0;
      frame < 60 && 4400 - h.viewport.scrollTop > 2;
      frame++
    ) {
      vi.advanceTimersByTime(16);
    }
    expect(h.viewport.scrollTop).toBeLessThan(4400); // Still gliding, within 2px.
    h.viewport.dispatchEvent(new Event("scrollend")); // Safari: after a write.

    // The end moves under the glide: the last row grows, live.
    const last = h.rowElement("msg 49");
    h.heights.set(49, 300);
    fireResize(0, last, 300);
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);

    vi.advanceTimersByTime(140 + 16); // The old cooldown would have settled here.
    h.list.setItems([...range(-10, 0), ...initial]);
    expect(h.list.state.count).toBe(50); // Held: the glide still owns the phase.
    expect(h.list.state.held).toBe(true);

    vi.advanceTimersByTime(3_000); // The glide lands, the phase settles.
    expect(h.list.state.count).toBe(60);
  });

  it("cancels an in-flight glide when the document is hidden (the command resolves false)", async () => {
    const initial = range(0, 50);
    const h = mount(initial);
    void h.list.scrollTo("m20");
    const command = h.list.scrollTo("end", { behavior: "smooth" });
    vi.advanceTimersByTime(48); // A few frames in.
    const midway = h.viewport.scrollTop;
    expect(midway).toBeGreaterThan(20 * ROW_H);
    expect(midway).toBeLessThan(50 * ROW_H - VIEWPORT_H);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await expect(command).resolves.toBe(false);
    vi.advanceTimersByTime(500);
    expect(h.viewport.scrollTop).toBe(midway); // No frames written after hiding.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("an explicit smooth duration replaces the distance policy", () => {
    const h = mount(range(0, 50));
    void h.list.scrollTo("m40"); // 400px short of the end: the policy's floor is 320ms.
    const start = h.viewport.scrollTop;
    void h.list.scrollTo("end", { behavior: "smooth", duration: 1_000 });
    vi.advanceTimersByTime(500);
    expect(h.viewport.scrollTop).toBeGreaterThan(start);
    expect(h.viewport.scrollTop).toBeLessThan(50 * ROW_H - VIEWPORT_H); // Still gliding.
    vi.advanceTimersByTime(800);
    expect(h.viewport.scrollTop).toBe(50 * ROW_H - VIEWPORT_H);
  });

  it("falls back safely for invalid optional command numbers", async () => {
    const h = mount(range(0, 50));
    await expect(h.list.scrollTo("m20", { offset: Number.NaN })).resolves.toBe(
      true,
    );
    expect(h.viewport.scrollTop).toBe(20 * ROW_H);

    const command = h.list.scrollTo("end", {
      behavior: "smooth",
      duration: Number.POSITIVE_INFINITY,
    });
    vi.advanceTimersByTime(2_000);
    await expect(command).resolves.toBe(true);
  });

  it('"live" still settle-gates structural changes', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(3005);
    h.list.setItems([...initial, ...range(50, 62)]);
    expect(h.list.state.count).toBe(50);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.count).toBe(62);
  });

  it("promotion leaves a pending page load (and its anchor) waiting for settle", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3005);
    h.userScroll(50 * ROW_H - VIEWPORT_H);
    const atEnd = h.viewport.scrollTop;
    const withPage = [...initial, ...range(50, 62)];
    h.list.setItems(withPage, { anchor: "viewport" });

    const withToken = [...withPage];
    withToken[48] = message(48, "same-height token"); // In the window.
    h.list.setItems(withToken);
    expect(h.rowElement("same-height token")).toBeDefined(); // Promoted now.
    expect(h.list.state.held).toBe(true); // The chunk still waits.
    expect(h.list.state.count).toBe(50);

    h.settle();
    expect(h.list.state.count).toBe(62);
    expect(h.viewport.scrollTop).toBe(atEnd); // Its anchor survived too.
  });

  it("commits whole-pixel heights: fractional measurements round up, geometry stays integral", () => {
    const initial = range(0, 10);
    const h = mount(initial);
    void h.list.scrollTo("m2");
    const row = h.rowElement("msg 5");
    h.heights.set(5, 120.3);
    fireResize(0, row, 120.3);
    expect(h.slotOf(row).style.height).toBe("121px");
    expect(h.list.state.totalSize).toBe(9 * ROW_H + 121);
    // The same fractional size again is not a change.
    fireResize(0, row, 120.3);
    expect(h.list.state.held).toBe(false);
    expect(h.slotOf(h.rowElement("msg 6")).style.transform).toBe(
      `translateY(${5 * ROW_H + 121}px)`,
    );

    // Every valid positive measurement remains valid geometry, even below
    // one CSS pixel.
    h.heights.set(5, 0.25);
    fireResize(0, row, 0.25);
    expect(h.slotOf(row).style.height).toBe("1px");
  });

  it("a takeover writes the current position back untouched, never clamped to a rounded scrollHeight", () => {
    const initial = range(0, 50);
    let width = 300;
    const h = mount(initial, { width: () => width });
    for (let id = 0; id < 50; id++) h.heights.set(id, 100.308); // Ceil: 101 each.
    width = 280;
    fireResize(1, h.viewport, VIEWPORT_H); // Re-measures everything (width path).
    expect(h.list.state.totalSize).toBe(50 * 101); // Integral geometry.

    h.userScroll(3005);
    h.userScroll(4449.6); // A fractional native position near the maximum.
    expect(h.viewport.scrollTop).toBeCloseTo(4449.6, 6);
    void h.list.scrollTo("end", { behavior: "smooth" }); // Takes over: interrupts.
    // The takeover writes the current position back untouched.
    expect(h.viewport.scrollTop).toBeCloseTo(4449.6, 6);
  });

  it("freezes committed rows outside the window too: a mid-phase remount shows committed content", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3005); // m5 is committed but unmounted.
    const next = [...initial];
    next[5] = message(5, "changed");
    h.heights.set(5, 300); // A height change: held, not promoted.
    h.list.setItems(next);
    h.userScroll(0); // Still the same gesture: m5 mounts at its committed height.
    const row = h.rowElement("msg 5");
    expect(h.slotOf(row).style.height).toBe(`${ROW_H}px`);
    h.settle();
    expect(h.rowElement("changed")).not.toBe(row);
    expect(row.isConnected).toBe(false);
  });

  it("updates a mounted row in place while idle, committing immediately", () => {
    const initial = range(0, 50);
    const existingSeen: (HTMLElement | undefined)[] = [];
    const h = mount(initial, {
      onRender: (m, existing) => {
        if (m.id === 20) existingSeen.push(existing);
      },
    });
    existingSeen.length = 0; // Drop the boot renders.
    void h.list.scrollTo("m20");
    const row = h.rowElement("msg 20");
    const next = [...initial];
    next[20] = message(20, "edited");
    h.heights.set(20, 160);
    h.list.setItems(next);
    expect(existingSeen).toEqual([row]);
    expect(row.textContent).toBe("edited");
    expect(h.slotOf(row).style.height).toBe("160px");
    expect(h.destroyed).toEqual([]);
  });

  it("keeps geometry immutable for changes made outside setItems, committing their height at settle", () => {
    const h = mount(range(0, 50));
    h.userScroll(3005);
    const row = h.rowElement("msg 32");
    const slot = h.slotOf(row);
    // The safety net: a direct DOM change grows the row; the observer
    // marks it dirty, geometry stays put, the height commits at settle.
    h.heights.set(32, 300);
    fireResize(0, row, 300);
    expect(slot.style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(slot.style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.viewport.scrollTop).toBe(3005);
  });

  it("commits an idle size change in the same delivery as its observation", () => {
    const h = mount(range(0, 50));
    void h.list.scrollTo("m20");
    const row = h.rowElement("msg 15"); // Mounted (overscan), above the viewport.
    h.heights.set(15, 250);
    fireResize(0, row, 250);
    // Synchronous, anchor-preserving: content above grew by 150.
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 150);
    expect(h.slotOf(row).style.height).toBe("250px");
    expect(h.viewport.scrollTop).toBe(20 * ROW_H + 150);
  });

  it("writes a whole-pixel anchor target for fractional settle geometry", () => {
    let width = 300;
    const h = mount(range(0, 50), { width: () => width });
    h.userScroll(3005); // Anchor m30, 5px into the row.
    for (let id = 0; id < 50; id += 1) h.heights.set(id, 100.308);
    width = 280;
    fireResize(1, h.viewport, VIEWPORT_H);
    expect(h.list.state.held).toBe(true);

    h.settle();
    // Heights commit as whole pixels (100.308 → 101), so the anchor target
    // 30 * 101 + 5 = 3035 is integral by construction — nothing for WebKit
    // to floor. (The write itself is rounded as well, as a second guard.)
    expect(h.viewport.scrollTop).toBe(3035);
    expect(Number.isInteger(h.viewport.scrollTop)).toBe(true);
  });

  it("invalidates held measurements after a viewport width change", () => {
    let width = 300;
    const h = mount(range(0, 50), { width: () => width });
    void h.list.scrollTo("m20");
    // Narrower: every row wraps taller. The viewport observer fires.
    width = 200;
    for (let id = 0; id < 50; id++) h.heights.set(id, 150);
    fireResize(1, h.viewport, VIEWPORT_H);
    expect(h.list.state.totalSize).toBe(50 * 150);
    expect(h.slotOf(h.rowElement("msg 20")).style.height).toBe("150px");
    // Anchor preserved: m20 stays under the viewport top.
    expect(h.viewport.scrollTop).toBe(20 * 150);
  });
});

describe("v2 runtime — retained nodes", () => {
  it("premeasures a replacement off-scroller and destroys the old element exactly once", () => {
    const initial = range(0, 20);
    const h = mount(initial, { replaceOnRerender: true });
    void h.list.scrollTo("m5");
    const before = h.rowElement("msg 10");

    const next = [...initial];
    next[10] = message(10, "replaced");
    h.heights.set(10, 180);
    h.list.setItems(next);

    const after = h.rowElement("replaced");
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(h.slotOf(after).style.height).toBe("180px");
    expect(h.destroyed).toEqual([10]);
    // The replacement's height reached GEOMETRY, not just its slot: the
    // canvas grew by the difference and the following row moved down.
    expect(h.list.state.totalSize).toBe(20 * ROW_H + 80);
    expect(h.slotOf(h.rowElement("msg 11")).style.transform).toBe(
      `translateY(${11 * ROW_H + 80}px)`,
    );
  });

  it("never lets a dirty old row overwrite its replacement's geometry", () => {
    const initial = range(0, 20);
    const h = mount(initial, {
      replaceOnRerender: true,
      measureFailOn: "fresh-fail",
    });
    const old = h.rowElement("msg 10");

    const failing = [...initial];
    failing[10] = message(10, "fresh-fail");
    expect(() => h.list.setItems(failing)).toThrow(
      "measure failed: fresh-fail",
    );
    // The failed preparation conservatively leaves the committed row dirty.
    // Give old and replacement elements different measurements so ordering
    // is observable when the next transaction succeeds.
    old.getBoundingClientRect = () => ({ height: ROW_H }) as DOMRect;
    h.heights.set(10, 180);

    const replacement = [...initial];
    replacement[10] = message(10, "replacement");
    h.list.setItems(replacement);

    expect(h.slotOf(h.rowElement("replacement")).style.height).toBe("180px");
    expect(h.list.state.totalSize).toBe(20 * ROW_H + 80);
    expect(h.canvas().style.height).toBe(`${20 * ROW_H + 80}px`);
    expect(h.slotOf(h.rowElement("msg 11")).style.transform).toBe(
      `translateY(${11 * ROW_H + 80}px)`,
    );
  });

  it("restores every retained element when a batched remeasurement fails", () => {
    let width = 300;
    const h = mount(range(0, 50), { width: () => width });
    void h.list.scrollTo("start");
    const row0 = h.rowElement("msg 0");
    const row1 = h.rowElement("msg 1");
    const slot0 = h.slotOf(row0);
    const slot1 = h.slotOf(row1);

    h.userScroll(3005); // Rows 0 and 1 are retained but unmounted.
    expect(slot0.isConnected).toBe(false);
    row0.getBoundingClientRect = () => {
      throw new Error("remeasure failed");
    };
    width = 280;
    fireResize(1, h.viewport, VIEWPORT_H); // Marks every retained row dirty.

    expect(() => h.settle()).toThrow("remeasure failed");
    // measureMany detached all retained elements before one read threw.
    // Failure must not strip any of them from their owning slots.
    expect(slot0.firstElementChild).toBe(row0);
    expect(slot1.firstElementChild).toBe(row1);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
  });

  it("rolls back a failed preparation: built rows destroyed once, held and committed state intact", () => {
    const initial = range(0, 30);
    const h = mount(initial, { throwOn: "boom" });
    h.userScroll(1505);
    h.list.setItems([...initial, message(40, "held")]); // Held: m40 built.
    expect(h.list.state.held).toBe(true);

    // A later snapshot whose render throws part-way: m42 was built before
    // the throw and is destroyed exactly once; the held snapshot (m40) is
    // untouched; nothing committed changed.
    expect(() =>
      h.list.setItems([
        ...initial,
        message(40, "held"),
        message(42, "ok"),
        message(43, "boom"),
      ]),
    ).toThrow("render failed: boom");
    expect(h.destroyed).toEqual([42]);
    expect(h.list.state.count).toBe(30);

    h.settle(); // The intact held snapshot commits.
    expect(h.list.state.count).toBe(31);
    expect(h.destroyed).toEqual([42]);
  });

  it("rolls back in-place DOM mutations made before a later render fails", () => {
    const h = mount(range(0, 30), { throwOn: "boom" });
    void h.list.scrollTo("m25");
    const row = h.rowElement("msg 29");

    // m29 is re-rendered in place (its DOM now says "mutated before
    // failure"), then m40's render throws. The committed item is still the
    // old one — so the DOM must be restored to match it.
    const next = [
      ...range(0, 29),
      message(29, "mutated before failure"),
      message(40, "boom"),
    ];
    expect(() => h.list.setItems(next)).toThrow("render failed: boom");
    expect(row.textContent).toBe("msg 29");
    expect(h.list.state.count).toBe(30);

    // Re-sending the committed snapshot is a no-op and stays correct.
    h.list.setItems(range(0, 30));
    expect(h.rowElement("msg 29").textContent).toBe("msg 29");
  });

  it("rolls back a render that mutates its element and then throws", () => {
    const h = mount(range(0, 30), {
      onRender: (m, existing) => {
        if (m.body === "partial" && existing) {
          existing.textContent = "partial"; // Mutated...
          throw new Error("render failed: partial"); // ...then thrown.
        }
      },
    });
    void h.list.scrollTo("m25");
    const row = h.rowElement("msg 29");

    expect(() =>
      h.list.setItems([...range(0, 29), message(29, "partial")]),
    ).toThrow("render failed: partial");
    expect(row.textContent).toBe("msg 29"); // The throwing render's own row.
  });

  it("destroys a replacement returned by a render that disposed the list", () => {
    let listRef: VirtualList<Msg> | null = null;
    const initial = range(0, 20);
    const h = mount(initial, {
      replaceOnRerender: true,
      onRender: (m, existing) => {
        if (m.body === "fresh" && existing) listRef?.dispose();
      },
    });
    listRef = h.list;

    const next = [...initial];
    next[19] = message(19, "fresh");
    expect(() => h.list.setItems(next)).not.toThrow();
    // 20 committed elements via dispose, plus the fresh element the host
    // returned AFTER disposing — owned and destroyed, not leaked.
    expect(h.destroyedElements).toHaveLength(21);
    expect(h.destroyedElements.some((el) => el.textContent === "fresh")).toBe(
      true,
    );
    expect(new Set(h.destroyedElements).size).toBe(21);
  });

  it("re-renders a row whose rollback render failed, whatever its item identity", () => {
    // m19's re-render returns a replacement whose measurement fails; the
    // rollback render of the OLD element then mutates it and throws. Item
    // identity now says "unchanged" — only an explicit unknown-state flag
    // can make the next preparation repair the DOM.
    let rollbackFailed = false;
    const initial = range(0, 20);
    const h = mount(initial, {
      replaceOnRerender: true,
      measureFailOn: "fresh-fail",
      onRender: (m, existing) => {
        if (m.body === "msg 19" && existing && !rollbackFailed) {
          rollbackFailed = true;
          existing.textContent = "corrupt";
          throw new Error("rollback render failed");
        }
      },
    });
    const next = [...initial.slice(0, 19), message(19, "fresh-fail")];
    expect(() => h.list.setItems(next)).toThrow("measure failed: fresh-fail");
    expect(rollbackFailed).toBe(true);

    // Re-sending the committed snapshot — the IDENTICAL item objects, so
    // identity alone would say "unchanged" — must repair m19, not skip it.
    h.list.setItems(initial);
    expect(h.rowElement("msg 19").textContent).toBe("msg 19");
    const canvas = h.canvas();
    expect(
      [...canvas.querySelectorAll("div")].some(
        (el) => el.textContent === "corrupt",
      ),
    ).toBe(false);
  });

  it("settles a command queued by a callback whose transaction then throws", async () => {
    let listRef: VirtualList<Msg> | null = null;
    let queued: Promise<boolean> | null = null;
    const h = mount(range(0, 20), {
      throwOn: "boom",
      onRender: (m) => {
        if (m.body === "boom") queued = listRef?.scrollTo("start") ?? null;
      },
    });
    listRef = h.list;
    expect(() =>
      h.list.setItems([...range(0, 20), message(30, "boom")]),
    ).toThrow("render failed: boom");
    // The failed transaction discards what it queued — settling the
    // promise (false) instead of leaving it pending forever.
    await expect(queued).resolves.toBe(false);
  });

  it("completes the commit before surfacing a teardown failure — state stays consistent", () => {
    const h = mount(range(0, 20), {
      onDestroy: (element) => {
        if (element.dataset.id === "5") throw new Error("teardown 5");
      },
    });
    expect(() => h.list.setItems(range(10, 20))).toThrow("teardown 5");
    // The error surfaced AFTER the commit reached its terminal state:
    // public state, geometry, canvas, and the mounted window all agree.
    expect(h.list.state.count).toBe(10);
    expect(h.list.state.totalSize).toBe(10 * ROW_H);
    expect(h.canvas().style.height).toBe(`${10 * ROW_H}px`);
    expect(h.rowElement("msg 10")).toBeDefined();
    expect(h.destroyed.sort((a, b) => a - b)).toEqual(
      range(0, 10).map((m) => m.id),
    );
    expect(h.list.state.held).toBe(false);
  });

  it("drains work queued by onState of a committed transaction before surfacing its teardown failure (I4)", async () => {
    let listRef: VirtualList<Msg> | null = null;
    let queued: Promise<boolean> | null = null;
    const h = mount(range(0, 100), {
      onDestroy: (element) => {
        if (element.dataset.id === "0") throw new Error("teardown 0");
      },
      onState: (state) => {
        if (state.count === 99 && queued === null) {
          queued = listRef?.scrollTo("start") ?? null;
        }
      },
    });
    listRef = h.list;

    // The removal commits fully (onState observes count 99) and its
    // teardown throws: a committed transaction with teardown errors, not a
    // failed one — the queued command must run, not be discarded.
    expect(() => h.list.setItems(range(1, 100))).toThrow("teardown 0");
    await expect(queued).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(0);
  });

  it("a failing queued transaction discards only its own scope, not its siblings (I4)", async () => {
    let listRef: VirtualList<Msg> | null = null;
    let queuedCommand: Promise<boolean> | null = null;
    let armed = false;
    const h = mount(range(0, 100), {
      throwOn: "boom",
      onState: (state) => {
        if (state.count !== 99 || armed || !listRef) return;
        armed = true;
        // Two siblings queued by the same committed transaction: a setItems
        // that will fail during render, then a command.
        listRef.setItems([...range(1, 100), message(200, "boom")]);
        queuedCommand = listRef.scrollTo("start");
      },
    });
    listRef = h.list;

    expect(() => h.list.setItems(range(1, 100))).toThrow("render failed: boom");
    // The failing sibling discarded nothing but its own scope: the command
    // still ran, and the committed state is the removal's, not the failed
    // snapshot's.
    await expect(queuedCommand).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(0);
    expect(h.list.state.count).toBe(99);
  });

  it("disposal from a queued child transaction settles the parent's remaining siblings (I4)", async () => {
    let listRef: VirtualList<Msg> | null = null;
    let queuedCommand: Promise<boolean> | null = null;
    let armed = false;
    const h = mount(range(0, 100), {
      onRender: (m) => {
        // The first queued sibling disposes the list mid-render, while the
        // parent scope still holds the command behind it.
        if (m.body === "dispose-me") listRef?.dispose();
      },
      onState: (state) => {
        if (state.count !== 99 || armed || !listRef) return;
        armed = true;
        listRef.setItems([...range(1, 100), message(200, "dispose-me")]);
        queuedCommand = listRef.scrollTo("start");
      },
    });
    listRef = h.list;

    h.list.setItems(range(1, 100));
    // The stranded sibling must settle — false, the list is gone — instead
    // of remaining pending forever.
    await expect(queuedCommand).resolves.toBe(false);
    expect(h.viewport.firstElementChild).toBeNull(); // Disposed for real.
  });

  it("hands off the new snapshot before surfacing a supersession teardown failure", () => {
    const h = mount(range(0, 30), {
      onDestroy: (element) => {
        if (element.dataset.id === "40") throw new Error("teardown 40");
      },
    });
    h.userScroll(1505);
    h.list.setItems([...range(0, 30), message(40, "held")]); // Held: m40 built.

    // B supersedes A: destroying m40 throws — but B (with its locally
    // built m41) must still be handed off as the pending snapshot.
    expect(() =>
      h.list.setItems([...range(0, 30), message(41, "local")]),
    ).toThrow("teardown 40");
    expect(h.list.state.held).toBe(true);

    h.settle();
    expect(h.list.state.count).toBe(31);
    // It is B that committed — its locally built m41 is the live tail row,
    // and A's destroyed m40 is nowhere in the DOM.
    void h.list.scrollTo("end");
    expect(h.rowElement("local")).toBeDefined();
    expect(
      [...h.canvas().querySelectorAll("div")].some(
        (el) => el.textContent === "held",
      ),
    ).toBe(false);
    expect(h.destroyed.filter((id) => id === 40)).toHaveLength(1);
    expect(h.destroyed).not.toContain(41);
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("finishes rollback before combining teardown failures with the original error", () => {
    const h = mount(range(0, 20), {
      throwOn: "boom",
      onDestroy: (element) => {
        if (element.textContent === "built") throw new Error("teardown built");
      },
    });
    let caught: unknown;
    try {
      h.list.setItems([
        ...range(0, 20),
        message(42, "built"),
        message(43, "boom"),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors.map(
      (error) => (error as Error).message,
    );
    expect(messages).toEqual(["render failed: boom", "teardown built"]);
    // Local cleanup finished despite the throwing teardown; state intact.
    expect(h.destroyed).toEqual([42]);
    expect(h.list.state.count).toBe(20);
  });

  it("attempts every destruction even when a host teardown throws", () => {
    const h = mount(range(0, 20), {
      onDestroy: (element) => {
        if (element.dataset.id === "5") throw new Error("teardown 5");
      },
    });
    // Removal at commit: the throw surfaces, the other removals still ran.
    expect(() => h.list.setItems(range(10, 20))).toThrow("teardown 5");
    expect(h.destroyed.sort((a, b) => a - b)).toEqual(
      range(0, 10).map((m) => m.id),
    );

    // Dispose: every remaining element is destroyed, exactly once.
    const h2 = mount(range(0, 20), {
      onDestroy: (element) => {
        if (element.dataset.id === "5") throw new Error("teardown 5");
      },
    });
    expect(() => h2.list.dispose()).toThrow("teardown 5");
    expect(h2.destroyedElements).toHaveLength(20);
    expect(new Set(h2.destroyedElements).size).toBe(20);
  });

  it("destroys locally built rows when a supersession-time onDestroy disposes the list", () => {
    let listRef: VirtualList<Msg> | null = null;
    let disposedOnce = false;
    const initial = range(0, 30);
    const h = mount(initial, {
      onDestroy: () => {
        if (disposedOnce) return;
        disposedOnce = true;
        listRef?.dispose();
      },
    });
    listRef = h.list;
    h.userScroll(1505);
    h.list.setItems([...initial, message(40, "held")]); // Held: m40 built.

    // B drops m40 (destroyed at supersession → the host disposes) and
    // builds m41 locally. m41 exists only inside the preparation at that
    // moment — it must still be destroyed exactly once, not leaked.
    expect(() =>
      h.list.setItems([...initial, message(41, "local")]),
    ).not.toThrow();
    expect(h.destroyed).toContain(40);
    expect(h.destroyed).toContain(41);
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
    expect(h.destroyedElements).toHaveLength(32); // 30 committed + m40 + m41.
  });

  it("destroys an element whose measurement fails after its build", () => {
    const h = mount(range(0, 10), { measureFailOn: "bad" });
    expect(() =>
      h.list.setItems([...range(0, 10), message(50, "bad")]),
    ).toThrow("measure failed: bad");
    expect(h.destroyed).toEqual([50]); // Never returned, torn down once.
    expect(h.list.state.count).toBe(10);
  });

  it("survives dispose() from onDestroy during a replacement commit without double-destroying", () => {
    let listRef: VirtualList<Msg> | null = null;
    let disposedFromCallback = false;
    const initial = range(0, 20);
    const h = mount(initial, {
      replaceOnRerender: true,
      onDestroy: () => {
        if (disposedFromCallback) return;
        disposedFromCallback = true;
        listRef?.dispose();
      },
    });
    listRef = h.list;

    const next = [...initial];
    next[19] = message(19, "replaced");
    expect(() => h.list.setItems(next)).not.toThrow();
    // Every retained ELEMENT destroyed exactly once — the replaced m19's
    // old element first, then the rest (including the new m19 element)
    // via dispose — with no element destroyed twice.
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
    expect(h.destroyed[0]).toBe(19);
    expect(h.destroyedElements).toHaveLength(21);
    expect(h.viewport.children.length).toBe(0);
  });

  it("re-measures pending retained nodes immediately before commit — latest height, one commit", () => {
    const h = mount(range(0, 50));
    h.userScroll(3005);
    h.list.setItems([...range(0, 50), message(60, "late")]); // Held; premeasured 100.
    h.heights.set(60, 400); // An image decoded while detached: no RO event.

    h.settle();
    // The commit carries the fresh height, not the stale premeasure.
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 400);
    expect(h.list.state.held).toBe(false);
  });

  it("a retained row that changed while detached is observed on remount and queued without geometry change", () => {
    const h = mount(range(0, 100));
    void h.list.scrollTo("m20"); // m95 unmounts, retained.
    h.heights.set(95, 300); // It changes while detached.

    h.userScroll(9005); // A gesture brings it back into the window.
    const row = h.rowElement("msg 95");
    const slot = h.slotOf(row);
    expect(slot.style.height).toBe(`${ROW_H}px`); // Mounted at the committed height.
    // The observer's initial delivery for the remounted element (after
    // layout, before the mount's first paint) is the freshness check.
    fireResize(0, row, 300);
    expect(slot.style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.totalSize).toBe(100 * ROW_H); // Geometry untouched...
    expect(h.list.state.held).toBe(true); // ...the difference is queued.

    h.settle();
    expect(slot.style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(100 * ROW_H + 200);
  });
});

describe("v2 runtime — edge slots", () => {
  function loader(
    key = "top",
    height = 52,
  ): EdgeSlot & { built: HTMLElement[] } {
    const built: HTMLElement[] = [];
    return {
      key,
      height,
      built,
      render: () => {
        const element = document.createElement("div");
        element.textContent = "Loading older…";
        element.dataset.id = "slot";
        built.push(element);
        return element;
      },
    };
  }

  it("keeps a leading slot in the flow at its declared height, outside the host-facing counts", () => {
    const slot = loader();
    const h = mount(range(0, 20), { edgeSlots: { start: slot } });
    void h.list.scrollTo("start");
    const element = slot.built[0] as HTMLElement;
    expect(element.isConnected).toBe(true);
    expect(h.slotOf(element).style.height).toBe("52px");
    expect(h.slotOf(element).style.transform).toBe("translateY(0px)");
    expect(h.slotOf(h.rowElement("msg 0")).style.transform).toBe(
      "translateY(52px)",
    );
    expect(h.list.state.count).toBe(20);
    expect(h.list.state.start).toBe(0);
    expect(h.list.state.totalSize).toBe(20 * ROW_H + 52);
    expect(h.list.positionOf("m0")).toEqual({ top: 52, height: ROW_H });
    expect(h.list.elementOf("m0")).toBe(h.rowElement("msg 0"));
    expect(h.list.elementOf("m19")).toBeNull(); // Unmounted.
  });

  it("a prepend replaces the slot's strip with content while the first row keeps its place", () => {
    const initial = range(0, 40);
    const h = mount(initial, { edgeSlots: { start: loader() } });
    void h.list.scrollTo("start");
    h.userScroll(400);
    h.userScroll(20); // The viewport top sits inside the slot.
    const first = h.rowElement("msg 0");
    const topBefore = 52 - 20; // m0's viewport coordinate.
    h.list.setItems([...range(-10, 0), ...initial], { anchor: "viewport" });
    h.settle();
    // m0 stayed put; the strip above it is the prepended content now.
    expect(h.viewport.scrollTop).toBe(52 + 10 * ROW_H - topBefore);
    expect(h.list.state.count).toBe(50);
    expect(h.slotOf(first).style.transform).toBe(
      `translateY(${52 + 10 * ROW_H}px)`,
    );
  });

  it("setEdgeSlot changes are settle-gated, replace the element without onDestroy, and clear cleanly", () => {
    const initial = range(0, 20);
    const slot = loader();
    const h = mount(initial, { edgeSlots: { start: slot } });
    void h.list.scrollTo("start");
    h.userScroll(300);
    const done = loader("top", 52);
    h.list.setEdgeSlot("start", done); // A new slot object: re-rendered at settle.
    expect(h.list.state.held).toBe(true);
    expect((slot.built[0] as HTMLElement).isConnected).toBe(true);
    h.settle();
    expect((slot.built[0] as HTMLElement).isConnected).toBe(false);
    expect((done.built[0] as HTMLElement).isConnected).toBe(true);
    expect(h.destroyed).toEqual([]); // Slot elements get no onDestroy.
    h.list.setEdgeSlot("start", null);
    expect(h.list.state.totalSize).toBe(20 * ROW_H);
    expect((done.built[0] as HTMLElement).isConnected).toBe(false);
    expect(h.destroyed).toEqual([]);
  });

  it("in-place slot content changes are not held: the declared height stands", () => {
    const slot = loader();
    const h = mount(range(0, 20), { edgeSlots: { start: slot } });
    void h.list.scrollTo("start");
    const element = slot.built[0] as HTMLElement;
    element.textContent = "At the top";
    fireResize(0, element, 52);
    expect(h.list.state.held).toBe(false);
  });

  it("rejects invalid slot heights and host keys in the reserved namespace", () => {
    expect(() =>
      mount(range(0, 1), { edgeSlots: { start: loader("bad", 0) } }),
    ).toThrow(/height must be finite and > 0/);
    expect(() =>
      createVirtualList(document.createElement("div"), {
        items: [message(0)],
        key: () => "\u0000edge:start:collision",
        render: () => document.createElement("div"),
      }),
    ).toThrow(/reserved edge-slot prefix/);
  });

  it("discards a reentrant slot change when the transaction that queued it fails", () => {
    const slot = loader();
    let queueSlot = false;
    let h: ReturnType<typeof mount>;
    const hooks = {
      throwOn: "boom" as string | undefined,
      onRender: (item: Msg) => {
        if (queueSlot && item.id === 0) h.list.setEdgeSlot("start", slot);
      },
    };
    h = mount(range(0, 3), hooks);
    queueSlot = true;
    const failing = range(0, 3);
    failing[0] = message(0, "changed");
    failing[1] = message(1, "boom");
    expect(() => h.list.setItems(failing)).toThrow("render failed: boom");
    expect(slot.built).toHaveLength(0);

    queueSlot = false;
    hooks.throwOn = undefined;
    h.list.setItems(range(0, 3));
    expect(slot.built).toHaveLength(0);
  });
});

describe("v2 runtime — commands", () => {
  it("scrolls instantly and resolves; missing targets resolve false", async () => {
    const h = mount(range(0, 100));
    await expect(h.list.scrollTo("start")).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(0);
    await expect(h.list.scrollTo("nope")).resolves.toBe(false);
    expect(h.viewport.scrollTop).toBe(0);
  });

  it("recomputes a pin's reserve when the viewport height changes", () => {
    let height = VIEWPORT_H;
    const h = mount(range(0, 20), { height: () => height });
    void h.list.scrollTo("m18", { align: "start" });
    const seen: number[][] = [[h.list.state.totalSize, h.viewport.scrollTop]];

    // Taller viewport (a rotation, a window resize): the engine clamps the
    // position to the shrunken range and dispatches that scroll BEFORE the
    // resize observer runs. Layout moved the viewport, not the user: the
    // pinned row goes back to the top and the reserve grows to fit.
    height = 900;
    h.viewport.dispatchEvent(new Event("scroll"));
    expect(h.list.state.held).toBe(false); // Not a gesture.
    fireResize(1, h.viewport, 900);
    seen.push([h.list.state.totalSize, h.viewport.scrollTop]);

    // Shorter: the reserve shrinks back.
    height = 500;
    fireResize(1, h.viewport, 500);
    seen.push([h.list.state.totalSize, h.viewport.scrollTop]);
    expect(seen).toEqual([
      [18 * ROW_H + VIEWPORT_H, 18 * ROW_H],
      [18 * ROW_H + 900, 18 * ROW_H],
      [18 * ROW_H + 500, 18 * ROW_H],
    ]);
  });

  it("moves mounted slots to their new offsets before the commit's scroll write", () => {
    // WebKit lays out at a scroll write: every mounted slot must already
    // sit at its committed offset, or the scroll range freezes stale.
    const stale: string[] = [];
    let writes = 0;
    let h: Harness | null = null;
    const list = () => h;
    h = mount(range(0, 40), {
      onScrollWrite: () => {
        const current = list();
        if (!current) return;
        writes += 1;
        for (const slot of current.viewport.firstElementChild?.children ?? []) {
          const id = (slot.firstElementChild as HTMLElement).dataset.id;
          const top = current.list.positionOf(`m${id}`)?.top;
          const transform = (slot as HTMLElement).style.transform;
          if (transform !== `translateY(${top}px)`)
            stale.push(`m${id}: ${transform} vs ${top}`);
        }
      },
    });
    h.userScroll(2000);
    h.settle();
    writes = 0;
    stale.length = 0;

    // A mounted row above the viewport (overscan) grows: everything below
    // it moves down 100px and the anchor-preserving write follows.
    const row = h.rowElement("msg 18");
    h.heights.set(18, 200);
    fireResize(0, row, 200);
    expect(h.viewport.scrollTop).toBe(2100);
    expect(writes).toBeGreaterThan(0);
    expect(stale).toEqual([]);
  });

  it("pins with a reserve for align:start (I5) and absorbs growth beneath it", () => {
    const h = mount(range(0, 20));
    void h.list.scrollTo("m18", { align: "start" });
    expect(h.viewport.scrollTop).toBe(18 * ROW_H);
    expect(h.list.state.totalSize).toBe(18 * ROW_H + VIEWPORT_H);

    // The pinned row's follower grows: the reserve absorbs it, no motion.
    const row = h.rowElement("msg 19");
    h.heights.set(19, 300);
    fireResize(0, row, 300);
    expect(h.viewport.scrollTop).toBe(18 * ROW_H);
    expect(h.list.state.totalSize).toBe(18 * ROW_H + VIEWPORT_H);
  });

  it("an inset pin remains at the end so streaming growth auto-follows", async () => {
    const h = mount(range(0, 20));
    await expect(
      h.list.scrollTo("m18", { align: "start", offset: 44 }),
    ).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(18 * ROW_H - 44);
    expect(h.list.state.atEnd).toBe(true);

    const tail = h.rowElement("msg 19");
    h.heights.set(19, 800);
    fireResize(0, tail, 800);
    expect(h.viewport.scrollTop).toBe(h.list.state.totalSize - VIEWPORT_H);
    expect(h.viewport.scrollTop).toBeGreaterThan(18 * ROW_H - 44);
    expect(h.list.state.atEnd).toBe(true);
  });

  it("a command during a gesture settles held work first, then executes", async () => {
    const h = mount(range(0, 100));
    h.userScroll(9005);
    h.list.setItems(range(-5, 100)); // Held.
    expect(h.list.state.count).toBe(100);

    const command = h.list.scrollTo("start");
    expect(h.list.state.count).toBe(105); // Flushed by the takeover.
    expect(h.viewport.scrollTop).toBe(0);
    await expect(command).resolves.toBe(true);
  });

  it("glides as a programmatic phase: held work commits at the landing settle", async () => {
    const h = mount(range(0, 100));
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    vi.advanceTimersByTime(48);
    h.list.setItems(range(-10, 100)); // Held during the glide phase.
    expect(h.list.state.count).toBe(100);

    vi.advanceTimersByTime(4000);
    // The prepend committed at the landing settle without movement: the
    // same first row still sits under the viewport top — which means the
    // viewport is no longer at "start", and the command says so.
    await expect(command).resolves.toBe(false);
    expect(h.list.state.count).toBe(110);
    expect(h.viewport.scrollTop).toBe(10 * ROW_H);
  });

  it('a glide frame commits a newly reached "live" row before its scroll event', async () => {
    const initial = range(0, 100);
    const h = mount(initial, { scrollingUpdates: "live" });
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    vi.advanceTimersByTime(48);

    const next = [...initial];
    next[50] = message(50, "live on glide");
    h.heights.set(50, 300);
    h.list.setItems(next); // Still above the moving viewport: dirty and held.
    expect(h.list.state.totalSize).toBe(100 * ROW_H);

    for (
      let frame = 0;
      frame < 200 && h.viewport.scrollTop > 5005;
      frame += 1
    ) {
      vi.advanceTimersByTime(16);
    }
    // The harness emits no automatic scroll event for a programmatic write.
    // This can only be committed by the glide frame's pre-paint onScrolled().
    expect(h.list.state.totalSize).toBe(100 * ROW_H + 200);
    expect(h.slotOf(h.rowElement("live on glide")).style.height).toBe("300px");

    vi.advanceTimersByTime(4000);
    await expect(command).resolves.toBe(true);
  });

  it("resolves a landed glide only after its phase settles, revalidated", async () => {
    const h = mount(range(0, 100));
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    let resolved: boolean | null = null;
    void command.then((value) => {
      resolved = value;
    });
    // Step to the landing frame (the ease-out snaps within 1px early); the
    // phase then still needs the 140ms cooldown before it settles.
    for (let t = 0; t < 3000 && h.viewport.scrollTop !== 0; t += 16) {
      vi.advanceTimersByTime(16);
    }
    await Promise.resolve();
    expect(h.viewport.scrollTop).toBe(0); // Landed...
    expect(resolved).toBe(null); // ...but not yet reported: phase active.
    vi.advanceTimersByTime(200);
    await expect(command).resolves.toBe(true);
  });

  it("resolves a parked landed command false on genuine user input before its settle", async () => {
    const h = mount(range(0, 100));
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    for (let t = 0; t < 3000 && h.viewport.scrollTop !== 0; t += 16) {
      vi.advanceTimersByTime(16);
    }
    expect(h.viewport.scrollTop).toBe(0); // Landed, result parked for settle.

    // An outward wheel at the target: the user owns the viewport now.
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    await expect(command).resolves.toBe(false);

    h.settle(); // The user's gesture settling must not re-resolve anything.
  });

  it("a newer command resolves a parked landed command false, never true", async () => {
    const h = mount(range(0, 100));
    const first = h.list.scrollTo("start", { behavior: "smooth" });
    for (let t = 0; t < 3000 && h.viewport.scrollTop !== 0; t += 16) {
      vi.advanceTimersByTime(16);
    }
    expect(h.viewport.scrollTop).toBe(0); // Landed, parked for its settle.

    const second = h.list.scrollTo("m20"); // Supersedes before the settle.
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(20 * ROW_H);
  });

  it("resolves false when the settle-time snapshot removed a keyed glide target", async () => {
    const h = mount(range(0, 100));
    const command = h.list.scrollTo("m2", { behavior: "smooth" });
    vi.advanceTimersByTime(48);
    h.list.setItems(range(3, 100)); // Removes m2; held for the landing settle.
    vi.advanceTimersByTime(4000);
    await expect(command).resolves.toBe(false);
    expect(h.list.state.count).toBe(97);
  });

  it("a user gesture cancels an in-flight glide", async () => {
    const h = mount(range(0, 100));
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    vi.advanceTimersByTime(48);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    await expect(command).resolves.toBe(false);
  });
});

describe("v2 runtime — reach signals", () => {
  it("fires on entering an edge zone and aborts the opposite edge's signal", () => {
    const h = mount(range(0, 100), { reach: true });
    expect(h.reaches.map((r) => r.edge)).toEqual(["end"]); // Booted at the end.

    void h.list.scrollTo("start");
    expect(h.reaches.map((r) => r.edge)).toEqual(["end", "start"]);
    expect(h.reaches[0]?.signal.aborted).toBe(true); // Opposite edge reached.
    expect(h.reaches[1]?.signal.aborted).toBe(false);

    h.list.dispose();
    expect(h.reaches[1]?.signal.aborted).toBe(true);
  });

  it("keeps every signal of an edge alive across re-entries and aborts them all together", () => {
    const h = mount(range(0, 100), { reach: true });
    void h.list.scrollTo("start"); // s1
    void h.list.scrollTo("m30"); // Past the exit zone: re-armed.
    void h.list.scrollTo("start"); // s2 — s1 must survive, not be overwritten.
    const starts = h.reaches.filter((r) => r.edge === "start");
    expect(starts).toHaveLength(2);
    expect(starts.every((r) => !r.signal.aborted)).toBe(true);

    void h.list.scrollTo("end"); // Opposite edge: every start signal aborts.
    expect(starts.every((r) => r.signal.aborted)).toBe(true);
  });

  it("aborts the opposite edge's work even when this edge has no callback", () => {
    const h = mount(range(0, 100), { reach: "start-only" });
    void h.list.scrollTo("start");
    const start = h.reaches[0];
    expect(start?.edge).toBe("start");
    void h.list.scrollTo("end"); // No onReachEnd — the abort still happens.
    expect(start?.signal.aborted).toBe(true);
  });
});
