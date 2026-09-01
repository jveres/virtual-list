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
    /** Runs at the start of every render (probe hook). */
    onRender?: (m: Msg, existing?: HTMLElement) => void;
    reach?: boolean | "start-only";
    width?: () => number;
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
  const destroyedElements: HTMLElement[] = [];
  const states: VirtualListState[] = [];
  const reaches: { edge: "start" | "end"; signal: AbortSignal }[] = [];

  const stamp = (element: HTMLElement, m: Msg): HTMLElement => {
    element.dataset.id = String(m.id);
    element.getBoundingClientRect = () => {
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
    settleStrategy: "default",
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

  it("rolls back a failed preparation: built rows destroyed once, held and committed state intact", () => {
    const h = mount(range(0, 30), { throwOn: "boom" });
    h.userScroll(1505);
    h.list.setItems([...range(0, 30), message(40, "held")]); // Held: m40 built.
    expect(h.list.state.held).toBe(true);

    // A later snapshot whose render throws part-way: m42 was built before
    // the throw and is destroyed exactly once; the held snapshot (m40) is
    // untouched; nothing committed changed.
    expect(() =>
      h.list.setItems([
        ...range(0, 30),
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
    const h = mount(range(0, 30), {
      onDestroy: () => {
        if (disposedOnce) return;
        disposedOnce = true;
        listRef?.dispose();
      },
    });
    listRef = h.list;
    h.userScroll(1505);
    h.list.setItems([...range(0, 30), message(40, "held")]); // Held: m40 built.

    // B drops m40 (destroyed at supersession → the host disposes) and
    // builds m41 locally. m41 exists only inside the preparation at that
    // moment — it must still be destroyed exactly once, not leaked.
    expect(() =>
      h.list.setItems([...range(0, 30), message(41, "local")]),
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

  it("freshness-checks a retained committed row before remount, queuing without geometry change", () => {
    const h = mount(range(0, 100));
    void h.list.scrollTo("m20"); // m95 unmounts, retained.
    h.heights.set(95, 300); // It changes while detached.

    h.userScroll(9005); // A gesture brings it back into the window.
    const slot = h.slotOf(h.rowElement("msg 95"));
    expect(slot.style.height).toBe(`${ROW_H}px`); // Mounted at the committed height.
    expect(h.list.state.totalSize).toBe(100 * ROW_H); // Geometry untouched...
    expect(h.list.state.held).toBe(true); // ...the difference is queued.

    h.settle();
    expect(slot.style.height).toBe("300px");
    expect(h.list.state.totalSize).toBe(100 * ROW_H + 200);
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
    // The prepend committed at the landing settle without movement: the
    // same first row still sits under the viewport top — which means the
    // viewport is no longer at "start", and the command says so.
    await expect(command).resolves.toBe(false);
    expect(h.list.state.count).toBe(110);
    expect(h.viewport.scrollTop).toBe(10 * ROW_H);
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
