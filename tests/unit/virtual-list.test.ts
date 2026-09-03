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

/** Advance 16ms frames until `done()` holds, or the frame budget runs out. */
function advanceFramesUntil(done: () => boolean, maxFrames = 200): void {
  for (let frame = 0; frame < maxFrames && !done(); frame += 1) {
    vi.advanceTimersByTime(16);
  }
}

/** Instance 0 observes rows, instance 1 the viewport (construction order). */
function fireResize(instance: number, target: Element, height: number): void {
  fireResizes(instance, [[target, height]]);
}

/** One delivery carrying several entries, as an engine batches them. */
function fireResizes(
  instance: number,
  sizes: readonly (readonly [Element, number])[],
): void {
  const entries = sizes.map(
    ([target, height]) =>
      ({
        target,
        borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
      }) as unknown as ResizeObserverEntry,
  );
  roInstances[instance]?.callback(entries, null as never);
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
    anchorable?: (m: Msg) => boolean;
    followMode?: VirtualListOptions<Msg>["followMode"];
    followInset?: number;
    /** Runs at the start of every render (probe hook). */
    onRender?: (m: Msg, existing?: HTMLElement) => void;
    /** Reports how many fresh peers share the detached root at each read. */
    onMeasure?: (m: Msg, batchSize: number) => void;
    reach?: boolean | "start-only";
    width?: () => number;
    height?: () => number;
    /** Observes every scrollTop write — where an engine forces layout. */
    onScrollWrite?: () => void;
    /** Lets the position leave the range, as an iOS rubber-band bounce does. */
    overscroll?: boolean;
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
    scrollHeight: { get: () => Math.max(VIEWPORT_H, canvasHeight()) },
    // A shrinking range clamps the position for good, as layout does in an
    // engine: growing the range back later does not restore it.
    scrollTop: {
      get: () => {
        if (hooks.overscroll) return scrollTop;
        scrollTop = Math.max(0, Math.min(maxScrollTop(), scrollTop));
        return scrollTop;
      },
      set: (next: number) => {
        hooks.onScrollWrite?.();
        if (hooks.overscroll) {
          scrollTop = next;
          return;
        }
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
    anchorable: hooks.anchorable,
    followMode: hooks.followMode,
    followInset: hooks.followInset,
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

  it("a command to the end re-engages following even when growth outran its glide", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    expect(h.list.state.following).toBe(false);

    void h.list.scrollTo("end", { behavior: "smooth", duration: 320 });
    // The glide lands on the end as it was; its settle cooldown is still
    // running.
    vi.advanceTimersByTime(330);
    expect(h.viewport.scrollTop).toBe(4400);
    // Fast streaming: the tail grows between the glide's landing and its
    // settle ("live" commits it at once — it is below the anchor), so the
    // viewport is no longer at the end when following is decided.
    h.heights.set(49, 300);
    fireResize(0, h.rowElement("msg 49"), 300);
    expect(h.viewport.scrollTop).toBe(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    vi.advanceTimersByTime(600);
    expect(h.viewport.scrollTop).toBe(4600);

    // Following persists: the next growth is followed too.
    h.heights.set(49, 500);
    const again = [...initial];
    again[49] = message(49, "streamed longer again");
    h.list.setItems(again);
    vi.advanceTimersByTime(600);
    expect(h.viewport.scrollTop).toBe(4800);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a command's takeover of a follow glide never re-arms following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400); // A gesture landing at the end engages following.
    h.settle();
    expect(h.list.state.following).toBe(true);
    // Growth starts a follow glide (a programmatic phase).
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed);
    expect(h.list.state.following).toBe(true);
    // The follow glide lands on the new end; its phase awaits the settle,
    // so the viewport now reads "at the end" inside a live phase.
    advanceFramesUntil(() => h.viewport.scrollTop === 4600);
    expect(h.list.state.atEnd).toBe(true);

    // Scroll-to-top takes over: the settle it forces must not read "was at
    // the end" as follow intent. Were following re-armed, the first live
    // commit after the command lands — before its own settle — would start
    // a follow glide back to the end.
    void h.list.scrollTo("start", { behavior: "smooth" });
    expect(h.list.state.following).toBe(false);
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
    expect(h.viewport.scrollTop).toBe(0);
    // Live growth below the anchor, inside the landed command's settle
    // cooldown (140ms; no frame has passed since the landing).
    h.heights.set(5, 200);
    fireResize(0, h.rowElement("msg 5"), 200);
    vi.advanceTimersByTime(600);
    expect(h.viewport.scrollTop).toBe(0);
    h.settle();
    expect(h.list.state.following).toBe(false);
    h.list.dispose();
  });

  it("a live append during a follow glide leaves following engaged", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed); // A follow glide toward 4600 starts.
    vi.advanceTimersByTime(48);
    // A new message lands mid-glide: below the anchor, committed at once.
    h.list.setItems([...streamed, message(50, "appended")]);
    expect(h.list.state.following).toBe(true);
    advanceFramesUntil(() => h.viewport.scrollTop === 4700);
    expect(h.viewport.scrollTop).toBe(4700);
    // Growth inside the landed glide's cooldown is still followed.
    h.heights.set(50, 200);
    fireResize(0, h.rowElement("appended"), 200);
    vi.advanceTimersByTime(700);
    expect(h.viewport.scrollTop).toBe(4800);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a viewport resize while following keeps following and catches up", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
      height: () => height,
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);

    // The composer grows: the viewport shrinks by 100px and the end is
    // uncovered. Following stays on and the viewport glides to the new end.
    height = 500;
    fireResize(1, h.viewport, 500);
    expect(h.list.state.following).toBe(true);
    advanceFramesUntil(() => h.viewport.scrollTop === 4500);
    expect(h.viewport.scrollTop).toBe(4500);
    h.settle();
    expect(h.list.state.following).toBe(true);

    // And the stream is still followed afterwards.
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed);
    advanceFramesUntil(() => h.viewport.scrollTop === 4700);
    expect(h.viewport.scrollTop).toBe(4700);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("an instant command to the end arms following under smooth follow", () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    h.userScroll(4000);
    h.settle();
    expect(h.list.state.following).toBe(false);
    void h.list.scrollTo("end");
    expect(h.viewport.scrollTop).toBe(4400);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a host's explicit viewport anchor while following resolves as asked and disengages following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    // A bottom page load: a page is not a live message. The viewport keeps
    // its position, and nothing glides it to the new end afterwards.
    h.list.setItems([...initial, message(50, "page")], { anchor: "viewport" });
    expect(h.viewport.scrollTop).toBe(4400);
    expect(h.list.state.following).toBe(false);
    vi.advanceTimersByTime(700);
    expect(h.viewport.scrollTop).toBe(4400);
    expect(h.list.state.following).toBe(false);
    h.list.dispose();
  });

  it("an auto prepend that leaves the viewport at the end keeps following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    // Scrollback lands above: the anchor keeps its place, so the viewport
    // still stands at the end — glued there, it goes on following.
    h.list.setItems([message(-1, "older"), ...initial]);
    expect(h.viewport.scrollTop).toBe(4500);
    expect(h.list.state.atEnd).toBe(true);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a takeover never leaves a follow glide behind: a held end snapshot lands by write", async () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400); // A gesture at the end; its phase is open.
    // Growth whose policy is the end waits for the settle.
    h.list.setItems([...initial, message(50, "appended")], { anchor: "end" });
    expect(h.viewport.scrollTop).toBe(4400);
    // The command's takeover settles the phase: the held snapshot commits
    // by write, and the command owns the viewport from there.
    const landed = h.list.scrollTo("start");
    expect(h.viewport.scrollTop).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(h.viewport.scrollTop).toBe(0); // Never dragged back to the end.
    expect(h.list.state.following).toBe(false);
    await expect(landed).resolves.toBe(true);
    h.list.dispose();
  });

  it("a live append in the gap between two follow legs is followed at once", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed); // A follow glide toward 4600.
    advanceFramesUntil(() => h.viewport.scrollTop === 4600);
    // The leg landed; its settle cooldown is running. A new message lands
    // in that gap: committed at once (below the anchor), and followed.
    h.list.setItems([...streamed, message(50, "appended")]);
    expect(h.list.state.following).toBe(true);
    vi.advanceTimersByTime(700);
    expect(h.viewport.scrollTop).toBe(4700);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a viewport remeasure that shrinks the tail at the end never re-engages following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    // The user collapses the tail: the viewport anchor is asked for and the
    // engine clamps the viewport to the shorter end — standing there is
    // not follow intent.
    const published = h.states.length;
    h.heights.set(49, 50);
    h.list.remeasure("m49", { anchor: "viewport" });
    vi.advanceTimersByTime(20);
    expect(h.viewport.scrollTop).toBe(4350);
    expect(h.list.state.following).toBe(false);
    expect(h.states.slice(published).map((s) => s.following)).not.toContain(
      true,
    );
    h.list.dispose();
  });

  it("a takeover's settle commit never publishes a transient following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.list.setItems([...initial, message(50, "appended")], { anchor: "end" });
    const published = h.states.length;
    void h.list.scrollTo("start");
    expect(h.viewport.scrollTop).toBe(0);
    expect(h.states.slice(published).map((s) => s.following)).not.toContain(
      true,
    );
    h.list.dispose();
  });

  it("boots following when the initial snapshot stands at the end", () => {
    const h = mount(range(0, 50), { followBehavior: "smooth" });
    expect(h.list.state.atEnd).toBe(true);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
    // Instant follow never reports following.
    const plain = mount(range(0, 50));
    expect(plain.list.state.following).toBe(false);
    plain.list.dispose();
  });

  it("a viewport resize during a command glide re-sizes the pin's reserve at the settle", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    expect(h.list.state.totalSize).toBe(5100); // A 100px reserve under m45.
    vi.advanceTimersByTime(48);
    // The composer grows mid-glide: the shorter viewport needs no reserve.
    height = 500;
    fireResize(1, h.viewport, 500);
    advanceFramesUntil(() => h.viewport.scrollTop === 4500);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.list.state.totalSize).toBe(5000);
    expect(h.list.state.atEnd).toBe(true);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("genuine input during a follow glide publishes the lost intent at once", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed); // A follow glide starts.
    vi.advanceTimersByTime(48);
    expect(h.list.state.following).toBe(true);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    expect(h.list.state.following).toBe(false);
    h.list.dispose();
  });

  it("a command's own pin commit never arms following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    // Pinning the row the viewport already stands on at the end changes no
    // geometry: the pin commit resolves at the end, and must not read that
    // as the follow intent the command just cleared.
    const published = h.states.length;
    void h.list.scrollTo("m44", { align: "start", behavior: "smooth" });
    expect(h.list.state.following).toBe(false);
    expect(h.states.slice(published).map((s) => s.following)).not.toContain(
      true,
    );
    h.list.dispose();
  });

  it("a settle whose commit starts a follow glide keeps following through the glide", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "same-height",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed); // Growth waits for the settle.
    expect(h.list.state.held).toBe(true);
    const published = h.states.length;
    h.settle(); // The commit resolves the end and starts a follow glide.
    expect(h.list.state.following).toBe(true);
    expect(h.states.slice(published).map((s) => s.following)).not.toContain(
      false,
    );
    advanceFramesUntil(() => h.viewport.scrollTop === 4600);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a taller viewport during a pinned command glide still lands the row at the top", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    // The composer shrinks mid-glide: the taller viewport shortens the
    // range and the engine clamps the position below the pin. The stance
    // the pre-resize position decided — on the pin — wins at the settle.
    height = 700;
    fireResize(1, h.viewport, 700);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4400);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.list.state.totalSize).toBe(5200); // A 200px reserve under m45.
    expect(h.viewport.scrollTop).toBe(4500);
    expect(h.list.positionOf("m45")?.top).toBe(4500);
    h.list.dispose();
  });

  it("a held resize settling away from the pin keeps the position", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    void h.list.scrollTo("m45", { align: "start" });
    expect(h.viewport.scrollTop).toBe(4500);
    h.userScroll(4000); // The phase is open, off the pin.
    height = 500;
    fireResize(1, h.viewport, 500);
    h.settle();
    expect(h.viewport.scrollTop).toBe(4000);
    expect(h.list.state.totalSize).toBe(5000); // The reserve drained.
    expect(h.list.state.following).toBe(false);
    // Nothing else changed: the next settle commits nothing.
    h.userScroll(3900);
    const published = h.states.length;
    h.settle();
    expect(h.states.length).toBe(published);
    h.list.dispose();
  });

  it("a resize during a follow glide never publishes a transient loss of following", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
      height: () => height,
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed); // A follow glide toward 4600 starts.
    vi.advanceTimersByTime(48);
    const published = h.states.length;
    height = 500;
    fireResize(1, h.viewport, 500);
    advanceFramesUntil(() => h.viewport.scrollTop === 4700);
    h.settle();
    expect(h.viewport.scrollTop).toBe(4700);
    expect(h.list.state.following).toBe(true);
    expect(h.states.slice(published).map((s) => s.following)).not.toContain(
      false,
    );
    h.list.dispose();
  });

  it("genuine input after a held pin resize owns the viewport: the settle never pulls back to the pin", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    // The composer autosizes in the send frame, then the user scrolls up.
    height = 560;
    fireResize(1, h.viewport, 560);
    vi.advanceTimersByTime(48);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    h.userScroll(3000);
    h.settle();
    expect(h.viewport.scrollTop).toBe(3000);
    expect(h.list.state.following).toBe(false);
    await expect(landed).resolves.toBe(false);
    h.list.dispose();
  });

  it("a glide leaving a pin never records the pin as its stance in its first frames", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    void h.list.scrollTo("m40", { align: "start" });
    expect(h.viewport.scrollTop).toBe(4000);
    const landed = h.list.scrollTo("start", { behavior: "smooth" });
    // Frame 0: the viewport still stands within a pixel of the pin.
    height = 560;
    fireResize(1, h.viewport, 560);
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
    h.settle();
    expect(h.viewport.scrollTop).toBe(0);
    await expect(landed).resolves.toBe(true);
    h.list.dispose();
  });

  it("a pin stance holds through later resize deliveries in the same phase", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    height = 560;
    fireResize(1, h.viewport, 560); // Mid-glide: on the pin in intent.
    advanceFramesUntil(() => h.viewport.scrollTop === 4500);
    // An animating composer keeps delivering after the landing; the
    // taller viewport's clamp moves the observed position off the pin.
    height = 700;
    fireResize(1, h.viewport, 700);
    height = 720;
    fireResize(1, h.viewport, 720);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(4500);
    expect(h.list.positionOf("m45")?.top).toBe(4500);
    h.list.dispose();
  });

  it("rows grown under a pinned landing commit on the pin's stance", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    height = 700;
    fireResize(1, h.viewport, 700);
    // The reply below the pinned prompt grows during the phase.
    h.heights.set(47, 200);
    fireResize(0, h.rowElement("msg 47"), 200);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4400);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(4500);
    expect(h.list.state.totalSize).toBe(5200);
    h.list.dispose();
  });

  it("a gesture that leaves the pin after an in-gesture resize is never pulled back", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    void h.list.scrollTo("m45", { align: "start" });
    expect(h.viewport.scrollTop).toBe(4500);
    // The keyboard closes mid-gesture while the viewport stands on the pin,
    // then the finger keeps going.
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    height = 700;
    fireResize(1, h.viewport, 700);
    h.userScroll(3000);
    h.settle();
    expect(h.viewport.scrollTop).toBe(3000);
    // The pin stands: its reserve is sized to the taller viewport.
    expect(h.list.state.totalSize).toBe(5200);
    h.list.dispose();
  });

  it("the engine's clamp off the pin during a gesture keeps the pin stance", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    void h.list.scrollTo("m45", { align: "start" });
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    // The taller viewport's range ends at 4400: the engine clamps the
    // position there and reports it as a scroll before the observer runs
    // — not the user's move. A second growth clamps again, this time with
    // the stance already held.
    height = 700;
    expect(h.viewport.scrollTop).toBe(4400);
    h.viewport.dispatchEvent(new Event("scroll"));
    fireResize(1, h.viewport, 700);
    height = 800;
    expect(h.viewport.scrollTop).toBe(4300);
    h.viewport.dispatchEvent(new Event("scroll"));
    fireResize(1, h.viewport, 800);
    h.settle();
    expect(h.viewport.scrollTop).toBe(4500);
    expect(h.list.positionOf("m45")?.top).toBe(4500);
    h.list.dispose();
  });

  it("a snapshot held under a pinned landing commits on the pin's stance", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "same-height",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    height = 700;
    fireResize(1, h.viewport, 700);
    // Scrollback arrives during the glide and waits for the settle: the
    // pinned row moves down by a page, and the landing follows it.
    h.list.setItems([message(-1, "older"), ...initial]);
    expect(h.list.state.held).toBe(true);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4400);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(4600);
    expect(h.list.positionOf("m45")?.top).toBe(4600);
    h.list.dispose();
  });

  it("a size-neutral viewport observation during a gesture commits nothing at the settle", () => {
    const h = mount(range(0, 50), { followBehavior: "smooth" });
    h.userScroll(4000);
    fireResize(1, h.viewport, VIEWPORT_H);
    const published = h.states.length;
    h.settle();
    expect(h.states.length).toBe(published);
    h.list.dispose();
  });

  it("a held snapshot that removes the pinned key keeps the anchor, not the raw position", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "same-height",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    height = 700;
    fireResize(1, h.viewport, 700);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4400);
    // The pinned prompt and everything after it are deleted while a page
    // lands above: the anchor (m44, now the last row) stays in view at the
    // range's end — never the raw position, a page back.
    h.list.setItems([...range(100, 110), ...initial.slice(0, 45)]);
    h.settle();
    await expect(landed).resolves.toBe(false);
    expect(h.list.positionOf("m44")?.top).toBe(5400);
    expect(h.viewport.scrollTop).toBeGreaterThanOrEqual(4800); // m44 in view.
    expect(h.list.state.atEnd).toBe(true);
    h.list.dispose();
  });

  it("wheel input that cannot move a clamped viewport keeps the pin stance", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    void h.list.scrollTo("m45", { align: "start" });
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    height = 700;
    fireResize(1, h.viewport, 700);
    expect(h.viewport.scrollTop).toBe(4400); // The taller range's clamp.
    // Two more ticks toward the end move nothing: no scroll event follows.
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    h.settle();
    expect(h.viewport.scrollTop).toBe(4500); // I5: the row returns to the top.
    expect(h.list.state.atEnd).toBe(true);
    h.list.dispose();
  });

  it("an input-less scroll away from a parked pinned landing owns the viewport", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    advanceFramesUntil(() => h.viewport.scrollTop === 4500);
    height = 700;
    fireResize(1, h.viewport, 700); // Parked on the pin: a "pin" stance.
    // A scrollbar drag or a host write: scroll events without pointer input.
    h.userScroll(3000);
    h.settle();
    expect(h.viewport.scrollTop).toBe(3000);
    await expect(landed).resolves.toBe(false);
    h.list.dispose();
  });

  it("a glide arriving from afar onto the pin keeps the pin stance through its approach", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    h.userScroll(0);
    h.settle();
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48); // Frames far from the pin and the clamp.
    height = 700;
    fireResize(1, h.viewport, 700);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4400);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(4500);
    h.list.dispose();
  });

  it("a rubber-band bounce past the stale end keeps the pin stance", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
      overscroll: true,
    });
    void h.list.scrollTo("m45", { align: "start" });
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    height = 700;
    fireResize(1, h.viewport, 700);
    // The engine clamps to 4400, overshoots into the bounce, and returns.
    h.userScroll(4400);
    h.userScroll(4450);
    h.userScroll(4400);
    h.settle();
    expect(h.viewport.scrollTop).toBe(4500);
    h.list.dispose();
  });

  it("a follow glide after a pinned landing never inherits the pin stance", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
      height: () => height,
    });
    const landed = h.list.scrollTo("m44", {
      align: "start",
      behavior: "smooth",
    });
    advanceFramesUntil(() => h.viewport.scrollTop === 4400);
    h.settle();
    await expect(landed).resolves.toBe(true);
    expect(h.list.state.following).toBe(true); // Pinned at the end.
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed); // A follow glide toward 4600.
    vi.advanceTimersByTime(48);
    height = 500;
    fireResize(1, h.viewport, 500);
    advanceFramesUntil(() => h.viewport.scrollTop === 4700);
    h.settle();
    expect(h.viewport.scrollTop).toBe(4700); // The new end, not the pin.
    expect(h.list.state.atEnd).toBe(true);
    h.list.dispose();
  });

  it("a host remeasure never cancels a command glide", async () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    const landed = h.list.scrollTo("m10", { behavior: "smooth" });
    vi.advanceTimersByTime(16);
    h.list.remeasure("m44", { anchor: "viewport" });
    vi.advanceTimersByTime(16);
    advanceFramesUntil(() => h.viewport.scrollTop === 1000);
    h.settle();
    await expect(landed).resolves.toBe(true);
    h.list.dispose();
  });

  it("a size-neutral viewport observation while idle commits nothing", () => {
    const h = mount(range(0, 50), { followBehavior: "smooth" });
    const published = h.states.length;
    fireResize(1, h.viewport, VIEWPORT_H);
    expect(h.states.length).toBe(published);
    h.list.dispose();
  });

  it("input that stops a glide onto the pin short owns the viewport where it stopped", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    h.userScroll(0);
    h.settle();
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    height = 700;
    fireResize(1, h.viewport, 700); // In flight: a "pin" stance.
    vi.advanceTimersByTime(48);
    // A tap stops the animation; nothing scrolls afterwards.
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 0 }));
    const stopped = h.viewport.scrollTop;
    expect(stopped).toBeLessThan(4400);
    await expect(landed).resolves.toBe(false);
    h.settle();
    expect(h.viewport.scrollTop).toBe(stopped);
    h.list.dispose();
  });

  it("a hand landing on the stale end from below is the user's, not a clamp", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    // Tall rows below the pin: the range reaches past the pin, so a taller
    // viewport clamps nothing.
    for (const id of [46, 47, 48, 49]) h.heights.set(id, 300);
    h.list.setItems(
      initial.map((m) => (m.id >= 46 ? message(m.id, `tall ${m.id}`) : m)),
    );
    expect(h.list.state.totalSize).toBe(5800);
    void h.list.scrollTo("m45", { align: "start" });
    expect(h.viewport.scrollTop).toBe(4500);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    height = 700;
    fireResize(1, h.viewport, 700);
    // The End key: one scroll event, exactly at the range's end.
    h.userScroll(5100);
    h.settle();
    expect(h.viewport.scrollTop).toBe(5100);
    h.list.dispose();
  });

  it("a resize observed before its clamp's scroll event still keeps the pin stance", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    void h.list.scrollTo("m45", { align: "start" });
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    // An in-page composer resize: the engine clamps in the frame's layout,
    // the observer runs in that frame, and the clamp's scroll event only
    // arrives in the next one.
    height = 700;
    fireResize(1, h.viewport, 700);
    expect(h.viewport.scrollTop).toBe(4400);
    h.viewport.dispatchEvent(new Event("scroll"));
    h.settle();
    expect(h.viewport.scrollTop).toBe(4500);
    expect(h.list.positionOf("m45")?.top).toBe(4500);
    h.list.dispose();
  });

  it("a held snapshot with an explicit viewport anchor overrides the pin stance", async () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "same-height",
      height: () => height,
    });
    const landed = h.list.scrollTo("m45", {
      align: "start",
      behavior: "smooth",
    });
    vi.advanceTimersByTime(48);
    height = 700;
    fireResize(1, h.viewport, 700);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4400);
    // The host asks for the viewport to be kept: its intent wins over the
    // runtime's own pin stance.
    h.list.setItems([...initial, message(50, "page")], { anchor: "viewport" });
    h.settle();
    await expect(landed).resolves.toBe(false);
    expect(h.viewport.scrollTop).toBe(4400);
    h.list.dispose();
  });

  it("a gesture ending within a pixel of the end is following without a glide", () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4399.3);
    h.settle();
    expect(h.list.state.following).toBe(true);
    vi.advanceTimersByTime(700);
    expect(h.viewport.scrollTop).toBe(4399.3); // No phase to move 0.7px.
    h.list.dispose();
  });

  it("a pin removed by a live commit leaves the held stance to the anchor", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
      height: () => height,
    });
    void h.list.scrollTo("m40", { align: "start" });
    expect(h.viewport.scrollTop).toBe(4000);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    height = 700;
    fireResize(1, h.viewport, 700); // On the pin: a "pin" stance.
    // The pinned row is deleted mid-phase: below-the-anchor, so it commits
    // live, and the pin goes with it. m41 now heads the viewport.
    h.list.setItems(initial.filter((m) => m.id !== 40));
    expect(h.list.positionOf("m41")?.top).toBe(4000);
    // A row above grows and waits for the settle: the anchor (m41) keeps
    // its place — a pin stance without a pin must not fall to the raw
    // position and shift the top row.
    h.heights.set(35, 200);
    fireResize(0, h.rowElement("msg 35"), 200);
    h.settle();
    expect(h.list.positionOf("m41")?.top).toBe(4100);
    expect(h.viewport.scrollTop).toBe(4100);
    h.list.dispose();
  });

  it("two idle resizes on the pin without a scroll event between keep the pin", () => {
    const initial = range(0, 50);
    let width = 800;
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      width: () => width,
      height: () => height,
    });
    void h.list.scrollTo("m45", { align: "start" });
    // A rotation: the narrower viewport re-wraps a row above the pin, so
    // the pin's top moves in the resize commit itself, which writes it.
    h.heights.set(40, 200);
    width = 500;
    height = 700;
    fireResize(1, h.viewport, 700);
    expect(h.list.positionOf("m45")?.top).toBe(4600);
    expect(h.viewport.scrollTop).toBe(4600);
    // The next delivery arrives before any scroll event: the viewport
    // stands on the pin where the commit put it.
    height = 800;
    fireResize(1, h.viewport, 800);
    expect(h.viewport.scrollTop).toBe(4600);
    expect(h.list.positionOf("m45")?.top).toBe(4600);
    h.list.dispose();
  });

  it('"keep-start": smooth follow stops once the last row\'s top reaches the viewport top', () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
      followMode: "keep-start",
    });
    expect(h.viewport.scrollTop).toBe(4400); // Boot lands at the end.
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);
    // The tail grows to 300px: its top (4900) is still below the viewport
    // top, so the end (4600) is followed.
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed);
    advanceFramesUntil(() => h.viewport.scrollTop === 4600);
    expect(h.viewport.scrollTop).toBe(4600);
    // It grows past the viewport: the follow stops with its top at the
    // viewport top (4900), never at the new end (5600).
    h.heights.set(49, 1300);
    const longer = [...initial];
    longer[49] = message(49, "streamed much longer");
    h.list.setItems(longer);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4900);
    vi.advanceTimersByTime(700);
    expect(h.viewport.scrollTop).toBe(4900);
    // Further growth moves nothing.
    h.heights.set(49, 1500);
    const longest = [...initial];
    longest[49] = message(49, "streamed longest");
    h.list.setItems(longest);
    vi.advanceTimersByTime(700);
    expect(h.viewport.scrollTop).toBe(4900);
    h.list.dispose();
  });

  it('"keep-start" keeps the inset clear above the row and honours explicit ends', async () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      scrollingUpdates: "live",
      followMode: "keep-start",
      followInset: 44,
    });
    // Instant follow: the write stops 44px above the tail's top.
    h.heights.set(49, 1300);
    const longer = [...initial];
    longer[49] = message(49, "streamed much longer");
    h.list.setItems(longer);
    expect(h.viewport.scrollTop).toBe(4900 - 44);
    // An explicit end anchor and an explicit command still reach the end.
    h.list.setItems([...longer, message(50, "appended")], { anchor: "end" });
    expect(h.viewport.scrollTop).toBe(
      Number.parseFloat(h.canvas().style.height) - VIEWPORT_H,
    );
    h.userScroll(1000);
    h.settle();
    await h.list.scrollTo("end");
    expect(h.viewport.scrollTop).toBe(
      Number.parseFloat(h.canvas().style.height) - VIEWPORT_H,
    );
    h.list.dispose();
  });

  it("setFollowMode widens a stopped follow and catches up at once", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
      scrollingUpdates: "live",
      followMode: "keep-start",
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    h.heights.set(49, 1300);
    const longer = [...initial];
    longer[49] = message(49, "streamed much longer");
    h.list.setItems(longer);
    advanceFramesUntil(() => h.viewport.scrollTop >= 4900);
    h.settle(); // Standing at the limit is following.
    expect(h.viewport.scrollTop).toBe(4900);
    expect(h.list.state.following).toBe(true);
    h.list.setFollowMode("end");
    advanceFramesUntil(() => h.viewport.scrollTop === 5600);
    expect(h.viewport.scrollTop).toBe(5600);
    h.list.dispose();
  });

  it("a commit's scroll write lands on the device-pixel grid at a fractional ratio", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      value: 1.25,
      configurable: true,
    });
    try {
      const h = mount(range(0, 50));
      h.userScroll(2050); // 50px into m20.
      h.settle();
      // A row above grows by 1px: the anchor's coordinate is kept at 2051,
      // which is not a device pixel at 1.25 — the write lands on the
      // nearest one, 2051.2 (2564 device pixels).
      h.heights.set(3, 101);
      const grown = [...range(0, 50)];
      grown[3] = message(3, "one pixel taller");
      h.list.setItems(grown);
      expect(h.viewport.scrollTop).toBe(2051.2);
      h.list.dispose();
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        value: original,
        configurable: true,
      });
    }
  });

  it("a mounted row keeps its committed height against a sub-pixel disagreement of the in-place measurement", () => {
    const h = mount(range(0, 50));
    h.userScroll(2000);
    h.settle();
    // Premeasured at 100 (the harness rounds nothing): the slot reads 99.2
    // in place — a snapping difference, not a change.
    h.heights.set(25, 99.2);
    fireResize(0, h.rowElement("msg 25"), 99.2);
    expect(h.list.positionOf("m25")?.height).toBe(100);
    expect(h.list.positionOf("m26")?.top).toBe(2600);
    // A real change commits: 98.2 is more than the tolerance away.
    h.heights.set(25, 98.2);
    fireResize(0, h.rowElement("msg 25"), 98.2);
    expect(h.list.positionOf("m25")?.height).toBe(99);
    expect(h.list.positionOf("m26")?.top).toBe(2599);
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

    // Even live mode cannot consume the explicit intent mid-gesture — not
    // at the observer delivery, nor at the next scroll event's live commit.
    h.userScroll(4390);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.slotOf(tail).style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.held).toBe(true);
    h.userScroll(4400);
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
    advanceFramesUntil(() => 4400 - h.viewport.scrollTop <= 2, 60);
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

  it("an explicit smooth duration sets the glide's pace", () => {
    const h = mount(range(0, 50));
    void h.list.scrollTo("m40"); // 400px short of the end: one landing leg.
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

  it("a row that is not anchorable hands the anchor to the message under it: a load into its day keeps that message put", () => {
    const initial = [message(100, "header"), ...range(13, 30)];
    const h = mount(initial, {
      scrollingUpdates: "live",
      anchorable: (m) => m.id !== 100,
    });
    h.userScroll(500);
    h.userScroll(0); // Momentum reached the top: the header shows, m13 anchors.
    // The day extends upward: the same header now heads m1.
    h.list.setItems([message(100, "header"), ...range(1, 30)], {
      anchor: "viewport",
    });
    expect(h.list.state.held).toBe(true);
    h.settle();
    // m13 keeps its coordinate: one row below the viewport top, as before.
    expect(h.list.positionOf("m13")?.top).toBe(13 * ROW_H);
    expect(h.viewport.scrollTop).toBe(12 * ROW_H);
    h.list.dispose();
  });

  it("an anchor row that shrinks under the viewport's offset keeps its visible bottom slice, so the rows below hold still", () => {
    const h = mount(range(0, 50));
    h.userScroll(580); // 80px into m5, whose bottom 20px show; m6 at 20px.
    h.settle();
    // m5 collapses to 50px (a panel closing): its top is gone from view.
    h.heights.set(5, 50);
    const collapsed = [...range(0, 50)];
    collapsed[5] = message(5, "collapsed");
    h.list.setItems(collapsed);
    expect(h.list.positionOf("m6")?.top).toBe(550);
    expect(h.viewport.scrollTop).toBe(530); // m6 still 20px below the top.
    h.list.dispose();
  });

  it("an anchor row that shrinks below its visible slice lands at its own top", () => {
    const h = mount(range(0, 50));
    h.userScroll(580);
    h.settle();
    h.heights.set(5, 10); // Shorter than the 20px slice that was visible.
    const collapsed = [...range(0, 50)];
    collapsed[5] = message(5, "tiny");
    h.list.setItems(collapsed);
    expect(h.viewport.scrollTop).toBe(500);
    h.list.dispose();
  });

  it("live: a replaced anchor whose successor moved down waits for the settle, which lands on the successor", () => {
    // A day header keyed by the message it heads: a scrollback load of the
    // same day replaces the header at the top and inserts the older
    // messages under it, above the first loaded message.
    const initial = [message(100, "header:13"), ...range(13, 30)];
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(500);
    h.userScroll(0); // Momentum reached the top: the header is the anchor.
    const loaded = [message(101, "header:1"), ...range(1, 30)];
    h.list.setItems(loaded, { anchor: "viewport" });
    expect(h.list.state.held).toBe(true); // Not a replacement: a prepend.
    expect(h.viewport.scrollTop).toBe(0);
    h.settle();
    // The old header is gone; its successor takes the header's old spot.
    expect(h.list.positionOf("m13")?.top).toBe(13 * ROW_H);
    expect(h.viewport.scrollTop).toBe(13 * ROW_H);
    h.list.dispose();
  });

  it('"live" commits an append at once and settle-gates a change above the anchor', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(3005);
    const before = h.viewport.scrollTop;
    // Below the anchor: no scroll write can be needed — live.
    const appended = [...initial, ...range(50, 62)];
    h.list.setItems(appended);
    expect(h.list.state.count).toBe(62);
    expect(h.list.state.held).toBe(false);
    expect(h.viewport.scrollTop).toBe(before);
    // Above it: the anchor-preserving write waits for the settle.
    h.list.setItems([...range(100, 105), ...appended]);
    expect(h.list.state.count).toBe(62);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.count).toBe(67);
    expect(h.viewport.scrollTop).toBe(before + 5 * ROW_H);
  });

  it('"live" settle-gates a structural change whose policy is the end', () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(3005);
    h.list.setItems([...initial, ...range(50, 62)], { anchor: "end" });
    expect(h.list.state.count).toBe(50);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.count).toBe(62);
    expect(h.list.state.atEnd).toBe(true);
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

  it("a takeover writes the current fractional position back unrounded", () => {
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

  it("dispose attempts every destruction even when a host teardown throws", () => {
    // (Removal at commit is covered by "completes the commit before
    // surfacing a teardown failure".) Every element is destroyed, once.
    const h = mount(range(0, 20), {
      onDestroy: (element) => {
        if (element.dataset.id === "5") throw new Error("teardown 5");
      },
    });
    expect(() => h.list.dispose()).toThrow("teardown 5");
    expect(h.destroyedElements).toHaveLength(20);
    expect(new Set(h.destroyedElements).size).toBe(20);
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
        // Reads as taller than declared: only the runtime's edge-slot
        // rules keep the declared height standing.
        element.getBoundingClientRect = () =>
          ({ height: 300, width: 300 }) as DOMRect;
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
    // The declared height, never the element's own reading.
    expect(h.slotOf(done.built[0] as HTMLElement).style.height).toBe("52px");
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
    const total = h.list.state.totalSize;
    const element = slot.built[0] as HTMLElement;
    element.textContent = "At the top";
    // Its content grew far past the declared height: not observed, not held,
    // and the geometry keeps the declared height.
    fireResize(0, element, 300);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.totalSize).toBe(total);
    expect(h.slotOf(element).style.height).toBe("52px");
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

  it("live: a structural change confined below the anchor commits mid-gesture", () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(2000); // Anchor: m20 at its top; the gesture stays live.
    const before = h.viewport.scrollTop;

    // The tail is replaced (a version switch): everything above m20 keeps
    // its item, key, and height, so no scroll write can be needed.
    const switched = [...initial.slice(0, 30), ...range(100, 115)];
    h.list.setItems(switched);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(45);
    expect(h.rowElement("msg 100")).toBeDefined();
    expect(h.viewport.scrollTop).toBe(before);
    expect(h.list.state.totalSize).toBe(45 * ROW_H);

    // The anchor row itself replaced while the viewport sits on its top:
    // its successor inherits the coordinate — still live.
    const anchorSwapped = [...initial.slice(0, 20), ...range(200, 230)];
    h.list.setItems(anchorSwapped);
    expect(h.list.state.held).toBe(false);
    expect(h.viewport.scrollTop).toBe(before);
    expect(h.rowElement("msg 200")).toBeDefined();

    // A change above the anchor (a prepend) still waits for the settle.
    h.list.setItems([...range(300, 305), ...anchorSwapped]);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.held).toBe(false);
    expect(h.viewport.scrollTop).toBe(before + 5 * ROW_H);
    h.list.dispose();
  });

  it("live: a structural commit during a rubber-band bounce never writes scrollTop", () => {
    const initial = range(0, 50);
    const writes: number[] = [];
    const h = mount(initial, {
      scrollingUpdates: "live",
      overscroll: true,
      onScrollWrite: () => writes.push(1),
    });
    h.userScroll(4000);
    h.userScroll(4440); // Bounced 40px past the end; the gesture is live.
    writes.length = 0;
    // A version switch of the tail (below the anchor) commits at once —
    // the total stays 5000, so the bounce position is outside the range...
    h.list.setItems([...initial.slice(0, 45), ...range(100, 105)]);
    expect(h.list.state.held).toBe(false);
    expect(h.rowElement("msg 100")).toBeDefined();
    // ...and leaves the bounce alone: no clamp write to the range.
    expect(writes).toEqual([]);
    expect(h.viewport.scrollTop).toBe(4440);
    // A second switch during the same bounce works the same way.
    h.list.setItems([...initial.slice(0, 45), ...range(200, 205)]);
    expect(h.list.state.held).toBe(false);
    expect(writes).toEqual([]);
    expect(h.viewport.scrollTop).toBe(4440);
    h.list.dispose();
  });

  it("live: a prepend arriving with the viewport exactly at the top waits for the settle", () => {
    const initial = range(0, 50);
    const h = mount(initial, { scrollingUpdates: "live" });
    h.userScroll(500);
    h.userScroll(0); // Momentum reached the top: anchor m0 at offset 0.
    h.list.setItems([...range(100, 110), ...initial]);
    expect(h.list.state.held).toBe(true); // The anchor moved; a write waits.
    expect(h.viewport.scrollTop).toBe(0);
    h.settle();
    expect(h.viewport.scrollTop).toBe(10 * ROW_H);
    h.list.dispose();
  });

  it("live: replacing the anchor row the viewport is scrolled into commits in place, without a write", () => {
    const initial = range(0, 50);
    const writes: number[] = [];
    const h = mount(initial, {
      scrollingUpdates: "live",
      onScrollWrite: () => writes.push(1),
    });
    h.userScroll(2050); // Anchor: m20, 50px into it — the message being switched.
    writes.length = 0;
    h.list.setItems([...initial.slice(0, 20), ...range(200, 230)]);
    expect(h.list.state.held).toBe(false);
    expect(h.rowElement("msg 200")).toBeDefined();
    expect(h.viewport.scrollTop).toBe(2050); // The new content at the same offset.
    expect(writes).toEqual([]);
    h.list.dispose();
  });

  it("publishes after a commit that moves positions but changes no state field", () => {
    const initial = range(0, 50);
    const states: VirtualListState[] = [];
    const h = mount(initial, { onState: (state) => states.push(state) });
    h.userScroll(2000);
    h.settle();
    const before = states.length;
    // Two opposite changes below the anchor in ONE delivery, hence one
    // commit: m23 moves down 50px while count, window, edges, totalSize and
    // held all stay as they were.
    h.heights.set(22, 150);
    h.heights.set(25, 50);
    fireResizes(0, [
      [h.rowElement("msg 22"), 150],
      [h.rowElement("msg 25"), 50],
    ]);
    expect(h.list.positionOf("m23")?.top).toBe(2350);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(states.length).toBeGreaterThan(before);
    h.list.dispose();
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

    advanceFramesUntil(() => h.viewport.scrollTop <= 5005);
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
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
    await Promise.resolve();
    expect(h.viewport.scrollTop).toBe(0); // Landed...
    expect(resolved).toBe(null); // ...but not yet reported: phase active.
    vi.advanceTimersByTime(200);
    await expect(command).resolves.toBe(true);
  });

  it("resolves a parked landed command false on genuine user input before its settle", async () => {
    const h = mount(range(0, 100));
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
    expect(h.viewport.scrollTop).toBe(0); // Landed, result parked for settle.

    // An outward wheel at the target: the user owns the viewport now.
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    await expect(command).resolves.toBe(false);

    h.settle(); // The user's gesture settling must not re-resolve anything.
  });

  it("a newer command resolves a parked landed command false, never true", async () => {
    const h = mount(range(0, 100));
    const first = h.list.scrollTo("start", { behavior: "smooth" });
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
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
