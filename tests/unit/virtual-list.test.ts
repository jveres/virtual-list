/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVirtualList,
  type VirtualList,
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
    reach?: boolean;
    width?: () => number;
  } = {},
): Harness {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const canvasHeight = (): number => {
    const canvas = viewport.firstElementChild as HTMLElement | null;
    return canvas ? Number.parseFloat(canvas.style.height) || 0 : 0;
  };
  const maxScrollTop = (): number => Math.max(0, canvasHeight() - VIEWPORT_H);
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_H },
    clientWidth: { get: () => hooks.width?.() ?? 300 },
    offsetWidth: { get: () => 315 },
    scrollHeight: { get: () => Math.max(VIEWPORT_H, canvasHeight()) },
    scrollTop: {
      get: () => Math.max(0, Math.min(maxScrollTop(), scrollTop)),
      set: (next: number) => {
        scrollTop = Math.max(0, Math.min(maxScrollTop(), next));
      },
    },
  });
  document.body.appendChild(viewport);

  const heights = new Map<number, number>();
  const destroyed: number[] = [];
  const states: VirtualListState[] = [];
  const reaches: { edge: "start" | "end"; signal: AbortSignal }[] = [];

  const stamp = (element: HTMLElement, id: number): HTMLElement => {
    element.dataset.id = String(id);
    element.getBoundingClientRect = () =>
      ({ height: heights.get(id) ?? ROW_H }) as DOMRect;
    return element;
  };

  const list = createVirtualList<Msg>(viewport, {
    items,
    key: (m) => `m${m.id}`,
    settleStrategy: "default",
    render: (m, existing) => {
      if (existing && !hooks.replaceOnRerender) {
        existing.textContent = m.body;
        return existing;
      }
      const element = document.createElement("div");
      element.textContent = m.body;
      return stamp(element, m.id);
    },
    onState: (state) => {
      states.push(state);
      hooks.onState?.(state);
    },
    onDestroy: (element) => {
      destroyed.push(Number(element.dataset.id));
    },
    onReachStart: hooks.reach
      ? ({ signal }) => reaches.push({ edge: "start", signal })
      : undefined,
    onReachEnd: hooks.reach
      ? ({ signal }) => reaches.push({ edge: "end", signal })
      : undefined,
  });

  return {
    list,
    viewport,
    canvas: () => viewport.firstElementChild as HTMLElement,
    heights,
    destroyed,
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
    expect(slot.style.overflow).toBe("hidden");
    expect(slot.style.transform).toBe(`translateY(${49 * ROW_H}px)`);
    expect(h.canvas().children.length).toBeLessThan(20); // Windowed.
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

  it("lets same-key content change inside its slot mid-gesture, committing the height at settle", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3005);
    const row = h.rowElement("msg 32");
    const slot = h.slotOf(row);

    // The streaming update: render mutates in place inside the fixed slot.
    const next = [...initial];
    next[32] = message(32, "streamed body");
    h.list.setItems(next);
    expect(row.textContent).toBe("streamed body"); // Visible (clipped)...
    expect(slot.style.height).toBe(`${ROW_H}px`); // ...geometry untouched.
    expect(h.list.state.totalSize).toBe(50 * ROW_H);

    // Its real height grew; the observer marks it dirty — still no change.
    h.heights.set(32, 300);
    fireResize(0, row, 300);
    expect(slot.style.height).toBe(`${ROW_H}px`);
    expect(h.list.state.totalSize).toBe(50 * ROW_H);
    expect(h.viewport.scrollTop).toBe(3005);
    expect(h.list.state.held).toBe(true);

    h.settle(); // The latest height commits, once, anchored.
    expect(slot.style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(50 * ROW_H + 200);
    expect(h.viewport.scrollTop).toBe(3005); // Growth below the anchor.
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
    const before = h.rowElement("msg 19");

    const next = [...initial];
    next[19] = message(19, "replaced");
    h.heights.set(19, 180);
    h.list.setItems(next);

    const after = h.rowElement("replaced");
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(h.slotOf(after).style.height).toBe("180px");
    expect(h.destroyed).toEqual([19]);
  });

  it("destroys rows of a superseded pending snapshot exactly once, never mounting them", () => {
    const h = mount(range(0, 50));
    h.userScroll(3005);
    h.list.setItems([...range(0, 50), message(99, "never")]); // Held: builds m99.
    h.list.setItems(range(0, 50)); // Supersedes: m99 is dropped.
    expect(h.destroyed).toEqual([99]);

    h.settle();
    expect(h.list.state.count).toBe(50);
    expect(h.destroyed).toEqual([99]);
  });

  it("destroys removed keys at commit and everything else once on dispose", () => {
    const h = mount(range(0, 30));
    h.list.setItems(range(1, 30)); // m0 removed.
    expect(h.destroyed).toEqual([0]);

    h.list.dispose();
    const rest = h.destroyed.slice(1).sort((a, b) => a - b);
    expect(rest).toEqual(range(1, 30).map((m) => m.id));
    expect(new Set(h.destroyed).size).toBe(h.destroyed.length);
    expect(h.viewport.children.length).toBe(0);
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
    await expect(command).resolves.toBe(true);
    expect(h.list.state.count).toBe(110);
    // Landed at the committed top, then the prepend appeared without
    // movement: the same first row still sits under the viewport top.
    expect(h.viewport.scrollTop).toBe(10 * ROW_H);
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
});
