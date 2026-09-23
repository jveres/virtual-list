/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Geometry } from "../../src/geometry";
import { createPagedWindow, type Page } from "../../src/paging";
import type { VirtualListScrollSettleStrategy } from "../../src/scroll-settle";
import {
  createVirtualList,
  type EdgeSlot,
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
    onState?: VirtualListOptions<Msg>["onState"];
    onViewport?: VirtualListOptions<Msg>["onViewport"];
    onDestroy?: (element: HTMLElement) => void;
    followBehavior?: VirtualListOptions<Msg>["followBehavior"];
    settleStrategy?: VirtualListScrollSettleStrategy;
    edgeSlots?: VirtualListOptions<Msg>["edgeSlots"];
    anchorable?: (m: Msg) => boolean;
    followMode?: VirtualListOptions<Msg>["followMode"];
    followInset?: number;
    overscanPx?: number;
    itemHeight?: (m: Msg) => number;
    position?: VirtualListOptions<Msg>["position"];
    boot?: "start" | "end";
    pinning?: VirtualListOptions<Msg>["pinning"];
    onMount?: (element: HTMLElement, m: Msg) => void;
    onUnmount?: (element: HTMLElement, m: Msg) => void;
    /** Runs at the start of every render (probe hook). */
    onRender?: (m: Msg, existing?: HTMLElement) => void;
    onKey?: (m: Msg) => void;
    /** Reports how many fresh peers share the detached root at each read. */
    onMeasure?: (m: Msg, batchSize: number) => void;
    reach?: boolean | "start-only";
    width?: () => number;
    height?: () => number;
    /** Observes every scrollTop write — where an engine forces layout. */
    onScrollWrite?: (top: number) => void;
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
        hooks.onScrollWrite?.(next);
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
    key: (m) => {
      hooks.onKey?.(m);
      return `m${m.id}`;
    },
    settleStrategy: hooks.settleStrategy ?? "default",
    // The suite describes runtime anchoring; jsdom claims native support.
    anchoring: "runtime",
    followBehavior: hooks.followBehavior,
    edgeSlots: hooks.edgeSlots,
    anchorable: hooks.anchorable,
    followMode: hooks.followMode,
    followInset: hooks.followInset,
    overscanPx: hooks.overscanPx,
    height: hooks.itemHeight,
    position: hooks.position,
    boot: hooks.boot,
    pinning: hooks.pinning,
    onMount: hooks.onMount,
    onUnmount: hooks.onUnmount,
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
    onState: (state, viewport) => {
      states.push(state);
      hooks.onState?.(state, viewport);
    },
    onViewport: hooks.onViewport,
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

describe("canvas compositing", () => {
  it.each([
    {
      environment: "WebKit",
      css: {
        supports: (property: string, value: string) =>
          property === "-webkit-nbsp-mode" && value === "space",
      },
      expected: "preserve-3d",
    },
    {
      environment: "other engines",
      css: { supports: () => false },
      expected: "",
    },
    { environment: "missing supports API", css: {}, expected: "" },
    { environment: "missing CSS API", css: undefined, expected: "" },
  ])(
    "should limit 3D preservation while retaining row layers in $environment",
    ({ css, expected }) => {
      vi.stubGlobal("CSS", css);
      const h = mount(range(0, 40), { boot: "start" });
      try {
        expect(h.canvas().style.transformStyle).toBe(expected);
        expect(h.canvas().style.transform).toBe("translateZ(0)");

        h.userScroll(2000);

        const row = h.list.elementOf("m20");
        expect(row?.isConnected).toBe(true);
        expect(row?.parentElement?.style.willChange).toBe("transform");
        expect(h.canvas().style.transformStyle).toBe(expected);
      } finally {
        h.list.dispose();
      }
    },
  );
});

describe("settle-time window updates", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "should use default overscan for invalid configuration (%s)",
    (overscanPx) => {
      const h = mount(range(0, 50), { boot: "start", overscanPx });

      expect(h.list.state.start).toBe(0);
      expect(h.list.state.end).toBe(12);
      expect(h.list.elementOf("m11")?.textContent).toBe("msg 11");
      h.list.dispose();
    },
  );

  it("should preserve an explicit zero overscan", () => {
    const h = mount(range(0, 50), { boot: "start", overscanPx: 0 });

    expect(h.list.state.start).toBe(0);
    expect(h.list.state.end).toBe(6);
    expect(h.list.elementOf("m6")).toBeNull();
    h.list.dispose();
  });

  it("should retain rows within a stacked window and reconcile its boundaries", () => {
    const positions: number[] = [];
    const h = mount(range(0, 50), {
      boot: "start",
      onViewport: (vp) => positions.push(vp.scrollTop),
    });
    positions.length = 0;
    h.userScroll(2001);
    const retained = h.list.elementOf("m20");

    for (const top of [2002, 2099, 2100, 2101, 2002]) {
      h.userScroll(top);
      const start = Math.floor((top - 600) / 100);
      const end = Math.ceil((top + 1200) / 100);
      expect(h.list.state.start).toBe(start);
      expect(h.list.state.end).toBe(end);
      expect(h.canvas().childElementCount).toBe(end - start);
      expect(h.list.elementOf("m20")).toBe(retained);
      expect(h.list.elementOf(`m${start - 1}`)).toBeNull();
      expect(h.list.elementOf(`m${end}`)).toBeNull();
    }
    expect(positions).toEqual([2001, 2002, 2099, 2100, 2101, 2002]);
    h.list.dispose();
  });

  it.each([
    { declared: false, overscanPx: 0 },
    { declared: true, overscanPx: 0 },
    { declared: false, overscanPx: 200 },
    { declared: true, overscanPx: 200 },
  ])(
    "should preserve stacked coverage and lifecycle order through reversals (declared=$declared, overscan=$overscanPx)",
    ({ declared, overscanPx }) => {
      const mounted: number[] = [];
      const unmounted: number[] = [];
      const h = mount(range(0, 60), {
        boot: "start",
        overscanPx,
        itemHeight: declared ? () => ROW_H : undefined,
        onMount: (_element, m) => mounted.push(m.id),
        onUnmount: (_element, m) => unmounted.push(m.id),
      });
      try {
        for (const top of [1000, 1100, 900, 901, 4000, 100, 0, 1500]) {
          const before = new Map(
            [...h.canvas().querySelectorAll<HTMLElement>("[data-id]")].map(
              (element) => [Number(element.dataset.id), element],
            ),
          );
          mounted.length = 0;
          unmounted.length = 0;
          const expected = range(
            Math.floor(Math.max(0, top - overscanPx) / ROW_H),
            Math.ceil((top + VIEWPORT_H + overscanPx) / ROW_H),
          ).map((m) => m.id);

          h.userScroll(top);

          expect(
            [...h.canvas().querySelectorAll<HTMLElement>("[data-id]")]
              .map((element) => Number(element.dataset.id))
              .sort((a, b) => a - b),
          ).toEqual(expected);
          expect(mounted).toEqual(expected.filter((id) => !before.has(id)));
          expect(unmounted).toEqual(
            [...before.keys()].filter((id) => !expected.includes(id)),
          );
          for (const id of expected) {
            const retained = before.get(id);
            if (retained) expect(h.list.elementOf(`m${id}`)).toBe(retained);
          }
        }
      } finally {
        h.list.dispose();
      }
      expect(new Set(h.destroyedElements).size).toBe(
        h.destroyedElements.length,
      );
    },
  );

  it("should reconcile both stacked entrance spans and empty windows before resize delivery", () => {
    let height = VIEWPORT_H;
    const mounted: number[] = [];
    const h = mount(range(0, 50), {
      boot: "start",
      overscanPx: 0,
      itemHeight: () => ROW_H,
      height: () => height,
      onMount: (_element, m) => mounted.push(m.id),
    });
    h.userScroll(1000);
    const retained = h.list.elementOf("m12");
    mounted.length = 0;

    // A scroll event can observe the resized box before ResizeObserver does.
    height = 1000;
    h.userScroll(800);

    expect(mounted).toEqual([8, 9, 16, 17]);
    expect(h.list.elementOf("m12")).toBe(retained);
    expect(h.canvas().childElementCount).toBe(10);

    mounted.length = 0;
    height = 200;
    h.userScroll(1200);
    expect(mounted).toEqual([]);
    expect(h.canvas().childElementCount).toBe(2);

    height = 0;
    h.userScroll(1200);
    expect(h.canvas().childElementCount).toBe(0);

    height = VIEWPORT_H;
    h.userScroll(1200);
    expect(mounted).toEqual([12, 13, 14, 15, 16, 17]);
    expect(h.canvas().childElementCount).toBe(6);
    h.list.dispose();
  });

  it("should mount replacement keys after a commit preserves stacked index bounds", () => {
    const items = range(0, 50);
    const h = mount(items, {
      boot: "start",
      overscanPx: 0,
      itemHeight: () => ROW_H,
    });
    h.userScroll(1000);
    h.settle();
    const retained = h.list.elementOf("m10");
    items[12] = message(112);

    h.list.setItems(items, { anchor: "viewport" });

    expect(h.list.state.start).toBe(10);
    expect(h.list.state.end).toBe(16);
    expect(h.list.elementOf("m12")).toBeNull();
    expect(h.list.elementOf("m112")?.textContent).toBe("msg 112");
    expect(h.list.elementOf("m10")).toBe(retained);
    expect(h.canvas().childElementCount).toBe(6);
    h.list.dispose();
  });

  it("should stop mounting stacked entrants when a mount callback disposes the list", () => {
    let disposing = false;
    const mounted: number[] = [];
    const h = mount(range(0, 50), {
      boot: "start",
      overscanPx: 0,
      itemHeight: () => ROW_H,
      onMount: (_element, m) => {
        mounted.push(m.id);
        if (disposing) h.list.dispose();
      },
    });
    mounted.length = 0;
    disposing = true;

    h.userScroll(100);

    expect(mounted).toEqual([6]);
    expect(h.viewport.childElementCount).toBe(0);
    expect(h.destroyed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("should retry a failed stacked entry without a range change", () => {
    let fail = true;
    const failures: string[] = [];
    const onError = (event: ErrorEvent): void => {
      failures.push(event.message);
      event.preventDefault();
    };
    const h = mount(range(0, 50), {
      boot: "start",
      itemHeight: () => ROW_H,
      onRender: (m) => {
        if (fail && m.id === 30) throw new Error("stacked entry failed");
      },
    });
    window.addEventListener("error", onError);
    try {
      h.userScroll(1500);
      h.userScroll(2001);
      expect(h.list.elementOf("m30")).toBeNull();
      fail = false;
      h.userScroll(2002);

      expect(h.list.elementOf("m30")?.textContent).toBe("msg 30");
      expect(failures).toEqual(["stacked entry failed"]);
    } finally {
      window.removeEventListener("error", onError);
      h.list.dispose();
    }
  });

  it("should position surviving rows after a live commit with unchanged window bounds", () => {
    const h = mount(range(0, 50), { boot: "start" });
    h.userScroll(2001);
    const before = h.list.state;
    const survivor = h.rowElement("msg 21");
    h.heights.set(20, 150);
    h.heights.set(23, 50);

    fireResizes(0, [
      [h.rowElement("msg 20"), 150],
      [h.rowElement("msg 23"), 50],
    ]);

    expect(h.list.state.start).toBe(before.start);
    expect(h.list.state.end).toBe(before.end);
    expect(h.list.state.totalSize).toBe(before.totalSize);
    expect(h.viewport.scrollTop).toBe(2001);
    expect(h.list.elementOf("m21")).toBe(survivor);
    expect(h.slotOf(survivor).style.transform).toBe("translateY(2150px)");
    expect(h.slotOf(h.rowElement("msg 24")).style.transform).toBe(
      "translateY(2400px)",
    );
    h.list.dispose();
  });

  it("should reconcile the old viewport again after a lazy render fails elsewhere", () => {
    const failures: string[] = [];
    const onError = (event: ErrorEvent): void => {
      failures.push(event.message);
      event.preventDefault();
    };
    const h = mount(range(0, 60), {
      boot: "start",
      itemHeight: () => ROW_H,
      onRender: (m) => {
        if (m.id === 30) throw new Error("lazy render failed");
      },
    });
    window.addEventListener("error", onError);
    try {
      h.userScroll(100);
      h.userScroll(3000);
      h.userScroll(100);
      expect(failures).toEqual(["lazy render failed"]);
      expect(h.rowElement("msg 1").isConnected).toBe(true);
      expect(h.list.state.start).toBeLessThanOrEqual(1);
      expect(h.list.state.end).toBeLessThan(20);
    } finally {
      window.removeEventListener("error", onError);
      h.list.dispose();
    }
  });
  it("should discard a held job if publishing its held state fails", async () => {
    let fail = false;
    const h = mount(range(0, 40), {
      onState: () => {
        if (fail) {
          fail = false;
          throw new Error("held observer failed");
        }
      },
    });
    h.userScroll(1000);
    fail = true;
    await expect(
      h.list.updateWindow(() => ({ items: range(0, 80) })),
    ).rejects.toThrow("held observer failed");
    h.settle();
    expect(h.list.state.count).toBe(40);
    expect(h.list.state.held).toBe(false);
    h.list.dispose();
  });
  it("should finish committed bookkeeping and queued work before reporting an observer failure", async () => {
    let fail = false;
    let committed = false;
    const h = mount(range(0, 20), {
      boot: "start",
      itemHeight: () => ROW_H,
      onState: () => {
        if (!fail) return;
        fail = false;
        h.list.updateItem("m0", message(0, "queued edit"));
        throw new Error("observer failed");
      },
    });
    fail = true;
    await expect(
      h.list.updateWindow(() => ({
        items: range(0, 40),
        edgeSlots: {
          end: {
            key: "loader",
            height: 50,
            render: () => document.createElement("div"),
          },
        },
        onCommit: () => {
          committed = true;
        },
      })),
    ).rejects.toThrow("observer failed");
    expect(committed).toBe(true);
    expect(h.list.state.count).toBe(40);
    expect(h.rowElement("queued edit").textContent).toBe("queued edit");
    h.list.setItems(range(0, 40));
    expect(h.list.state.totalSize).toBe(4050);
    h.list.dispose();
  });
  it("should publish the viewport snapshot for geometry-based companions", () => {
    const viewports: { scrollTop: number; height: number }[] = [];
    const h = mount(range(0, 40), {
      boot: "start",
      onState: (_state, viewport) => {
        viewports.push({ ...viewport });
      },
    });
    expect(viewports[0]).toEqual({ scrollTop: 0, height: VIEWPORT_H });
    h.userScroll(2000);
    expect(viewports.at(-1)).toEqual({ scrollTop: 2000, height: VIEWPORT_H });
    h.list.dispose();
  });
  it("should publish each glide position before its native scroll event", async () => {
    let snapshot = { scrollTop: -1, height: -1 };
    const h = mount(range(0, 40), {
      boot: "start",
      onViewport: (viewport) => {
        snapshot = { ...viewport };
      },
    });
    const landing = h.list.scrollTo("m10", { behavior: "smooth" });

    for (let frame = 0; frame < 45; frame++) {
      vi.advanceTimersByTime(16);
      expect(snapshot).toEqual({
        scrollTop: h.viewport.scrollTop,
        height: VIEWPORT_H,
      });
    }
    h.settle();

    await expect(landing).resolves.toBe(true);
    expect(snapshot.scrollTop).toBe(1000);
    h.list.dispose();
  });
  it("should settle a failed glide and release its queued window update", async () => {
    let fail = false;
    const h = mount(range(0, 40), {
      boot: "start",
      onViewport: () => {
        if (fail) {
          fail = false;
          throw new Error("scroll observer failed");
        }
      },
    });
    const moving = h.list.scrollTo("m20", { behavior: "smooth" });
    const update = h.list.updateWindow(() => ({ items: range(0, 60) }));
    fail = true;

    expect(() => vi.advanceTimersByTime(16)).toThrow("scroll observer failed");
    await vi.advanceTimersByTimeAsync(500);

    await expect(moving).resolves.toBe(false);
    await expect(update).resolves.toBe(true);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(60);
    h.list.dispose();
  });
  it("should settle an update queued by a render that subsequently fails", async () => {
    let queued: Promise<boolean> | undefined;
    const h = mount(range(0, 20), {
      throwOn: "fail",
      onRender: (m) => {
        if (m.body === "fail")
          queued = h.list.updateWindow(() => ({ items: [] }));
      },
    });
    expect(() => h.list.setItems([message(80, "fail")])).toThrow(
      "render failed",
    );
    await expect(queued).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    h.list.dispose();
  });

  it("should choose the protected window at commit, including overscan", async () => {
    const h = mount(range(0, 80), { boot: "start", itemHeight: () => ROW_H });
    h.userScroll(2000);
    let protectedIds: number[] = [];
    const applied = h.list.updateWindow(({ items, protectedItems }) => {
      protectedIds = protectedItems.map((m) => m.id);
      return {
        items: items.slice(10),
        onCommit: () => {
          expect(h.list.positionOf("m10")).toEqual({ top: 0, height: ROW_H });
        },
      };
    });
    expect(protectedIds).toEqual([]);
    expect(h.list.state.held).toBe(true);
    h.userScroll(4000);
    const { start, end } = h.list.state;
    h.settle();
    await expect(applied).resolves.toBe(true);
    expect(protectedIds).toEqual(range(start, end).map((m) => m.id));
    expect(start).toBeLessThan(40);
    expect(end).toBeGreaterThan(46);
    expect(h.viewport.scrollTop).toBe(3000);
    h.list.dispose();
  });

  describe("idle page preparation", () => {
    // Measured rows only: declared heights render lazily and never stage.
    // Deterministic idle callbacks on the fake clock, with a generous budget.
    beforeEach(() => {
      vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) =>
        setTimeout(
          () => callback({ didTimeout: false, timeRemaining: () => 50 }),
          1,
        ),
      );
      vi.stubGlobal("cancelIdleCallback", (handle: number) =>
        clearTimeout(handle),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should prepare a held page mid-phase", async () => {
      const renderedBeforeSettle = 40;
      let rendered = 0;
      const h = mount(range(40, 80), {
        boot: "start",
        onRender: (m) => {
          if (m.id < 40) rendered += 1;
        },
      });
      h.userScroll(500);
      const applied = h.list.updateWindow(({ items }) => ({
        items: [...range(0, 40), ...items],
      }));
      vi.advanceTimersByTime(200);
      expect(rendered).toBe(renderedBeforeSettle);
      // Preparation never commits under an active phase.
      expect(h.list.state.count).toBe(40);
      expect(h.list.state.held).toBe(true);
      h.settle();
      advanceFramesUntil(() => h.list.state.count === 80);
      await expect(applied).resolves.toBe(true);
      expect(rendered).toBe(40);
      expect(h.list.positionOf("m40")?.top).toBe(40 * ROW_H);
      h.list.dispose();
    });

    it("should tear down rows prepared mid-phase when the update aborts", async () => {
      const h = mount(range(40, 80), {
        boot: "start",
      });
      h.userScroll(500);
      const abort = new AbortController();
      const applied = h.list.updateWindow(
        ({ items }) => ({ items: [...range(0, 40), ...items] }),
        abort.signal,
      );
      vi.advanceTimersByTime(200);
      abort.abort();
      await expect(applied).resolves.toBe(false);
      expect(h.destroyed.filter((id) => id < 40).sort((a, b) => a - b)).toEqual(
        range(0, 40).map((m) => m.id),
      );
      h.settle();
      expect(h.list.state.count).toBe(40);
      expect(h.list.state.held).toBe(false);
      h.list.dispose();
    });
  });

  it("should cancel fetched work before it runs and clear held state", async () => {
    const h = mount(range(0, 40));
    h.userScroll(1000);
    const abort = new AbortController();
    const update = vi.fn(() => ({ items: range(0, 80) }));
    const applied = h.list.updateWindow(update, abort.signal);
    abort.abort();
    await expect(applied).resolves.toBe(false);
    expect(h.list.state.held).toBe(false);
    h.settle();
    expect(update).not.toHaveBeenCalled();
    expect(h.list.state.count).toBe(40);
    h.list.dispose();
  });

  it.each([undefined, true, false])(
    "should apply offscreen pin protection policy %s and restore a declarative pin without following",
    async (protectPin) => {
      const initial = range(0, 40);
      const h = mount(initial, {
        boot: "start",
        overscanPx: 0,
        itemHeight: () => ROW_H,
        pinning: { match: (m) => m.id === 39 },
      });
      h.userScroll(500);
      h.settle();
      let protectedIds: number[] = [];
      await expect(
        h.list.updateWindow(
          ({ items, protectedItems }) => {
            protectedIds = protectedItems.map((m) => m.id);
            return {
              items: items.filter(
                (m) => m.id !== 39 || protectedIds.includes(39),
              ),
            };
          },
          undefined,
          { protectPin },
        ),
      ).resolves.toBe(true);

      expect(protectedIds.includes(39)).toBe(protectPin !== false);
      expect(h.list.state.count).toBe(protectPin === false ? 39 : 40);
      expect(h.viewport.scrollTop).toBe(500);
      expect(h.list.state.following).toBe(false);
      expect(h.list.state.totalSize).toBe(protectPin === false ? 3900 : 4500);

      await expect(
        h.list.updateWindow(() => ({ items: initial }), undefined, {
          protectPin: false,
        }),
      ).resolves.toBe(true);
      expect(h.list.state.totalSize).toBe(4500);
      expect(h.viewport.scrollTop).toBe(500);
      expect(h.list.state.following).toBe(false);
      h.list.dispose();
    },
  );

  it.each([
    { pin: 0, overscan: 0, remove: 0 },
    { pin: 6, overscan: 200, remove: 6 },
    { pin: 39, overscan: 0, remove: 2 },
  ])(
    "should reject trimming protected row $remove with pin $pin",
    async ({ pin, overscan, remove }) => {
      const h = mount(range(0, 40), {
        boot: "start",
        overscanPx: overscan,
        itemHeight: () => ROW_H,
        pinning: { match: (m) => m.id === pin },
      });
      const committed = vi.fn();
      await expect(
        h.list.updateWindow(
          ({ items }) => ({
            items: items.filter((m) => m.id !== remove),
            onCommit: committed,
          }),
          undefined,
          { protectPin: false },
        ),
      ).resolves.toBe(false);
      expect(h.list.state.count).toBe(40);
      expect(h.list.positionOf(`m${remove}`)?.height).toBe(ROW_H);
      expect(committed).not.toHaveBeenCalled();
      h.list.dispose();
    },
  );

  it("should reject an evicted explicit target without touching the committed window", async () => {
    const h = mount(range(0, 40), { boot: "start", overscanPx: 0 });
    await expect(
      h.list.updateWindow(
        ({ items }) => ({
          items: items.slice(0, 20),
          anchor: { key: "m39", offset: 0 },
        }),
        undefined,
        { protectPin: false },
      ),
    ).resolves.toBe(false);
    expect(h.list.state.count).toBe(40);
    expect(h.viewport.scrollTop).toBe(0);
    h.list.dispose();
  });

  it("should cancel pin eviction when a gesture exposes it during preparation", async () => {
    const h = mount(range(0, 80), {
      boot: "start",
      overscanPx: 0,
      pinning: { match: (m) => m.id === 79 },
    });
    const committed = vi.fn();
    const applied = h.list.updateWindow(
      ({ items }) => ({
        items: [...range(-24, 0), ...items.slice(0, 20)],
        onCommit: committed,
      }),
      undefined,
      { protectPin: false },
    );
    vi.advanceTimersByTime(16);
    h.userScroll(7900);
    h.settle();
    await vi.advanceTimersByTimeAsync(500);

    await expect(applied).resolves.toBe(false);
    expect(h.list.state.count).toBe(80);
    expect(h.list.elementOf("m79")?.textContent).toBe("msg 79");
    expect(h.viewport.scrollTop).toBe(7900);
    expect(committed).not.toHaveBeenCalled();
    h.list.dispose();
  });

  it("should settle cancelled jobs on disposal", async () => {
    const h = mount(range(0, 40));
    h.userScroll(1000);
    const applied = h.list.updateWindow(() => ({ items: [] }));
    h.list.dispose();
    await expect(applied).resolves.toBe(false);
  });

  it("should reject failed preparation without changing the committed window", async () => {
    const h = mount(range(0, 40), { throwOn: "fail" });
    await expect(
      h.list.updateWindow(() => ({ items: [message(80, "fail")] })),
    ).rejects.toThrow("render failed");
    expect(h.list.state.count).toBe(40);
    h.list.dispose();
  });
});

describe("incremental window preparation", () => {
  it("should commit small measured additions without staging", async () => {
    const h = mount(range(0, 20));

    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, ...range(20, 28)],
    }));

    expect(h.list.state.count).toBe(28);
    expect(h.list.state.held).toBe(false);
    await expect(applied).resolves.toBe(true);
    h.list.dispose();
  });

  it("should commit declared-height pages without measurement staging", async () => {
    const h = mount(range(0, 20), { itemHeight: () => ROW_H });

    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, ...range(20, 60)],
    }));

    expect(h.list.state.count).toBe(60);
    expect(h.list.state.held).toBe(false);
    await expect(applied).resolves.toBe(true);
    h.list.dispose();
  });

  it.each([1, 2])(
    "should not attach a stage after disposal in key pass %s",
    async (pass) => {
      let armed = false;
      let visits = 0;
      const h = mount(range(0, 20), {
        boot: "start",
        onKey: (item) => {
          if (armed && item.id === 0 && ++visits === pass) h.list.dispose();
        },
      });
      armed = true;

      const applied = h.list.updateWindow(({ items }) => ({
        items: [...items, ...range(20, 44)],
      }));
      vi.advanceTimersByTime(100);

      await expect(applied).resolves.toBe(false);
      expect(document.body.childElementCount).toBe(1);
      expect(h.destroyed).toEqual(range(0, 20).map((item) => item.id));
    },
  );

  it("should keep the old window until all rows have exact current heights", async () => {
    const h = mount(range(0, 20));
    const committed: number[] = [];
    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, ...range(20, 44)],
      onCommit: () => committed.push(h.list.state.count),
    }));

    vi.advanceTimersByTime(16);
    expect(h.list.state.count).toBe(20);
    expect(h.list.state.held).toBe(true);
    expect(h.list.elementOf("m20")).toBeNull();
    expect(committed).toEqual([]);
    // Growth after the first batch must be included by the final read.
    h.heights.set(20, 180);
    advanceFramesUntil(() => h.list.state.count === 44);

    await expect(applied).resolves.toBe(true);
    expect(committed).toEqual([44]);
    expect(h.list.positionOf("m20")).toEqual({ top: 2000, height: 180 });
    expect(h.list.state.totalSize).toBe(4480);
    expect(h.list.state.held).toBe(false);
    expect(h.destroyed).toEqual([]);
    h.list.dispose();
    expect(h.destroyed.sort((a, b) => a - b)).toEqual(
      range(0, 44).map((item) => item.id),
    );
  });

  it("should measure staged rows after existing-row render callbacks", async () => {
    const initial = range(0, 20);
    const h = mount(initial, {
      onRender: (item) => {
        if (item.body === "new shared style") h.heights.set(20, 240);
      },
    });
    const applied = h.list.updateWindow(() => ({
      items: [
        message(0, "new shared style"),
        ...initial.slice(1),
        ...range(20, 44),
      ],
    }));

    advanceFramesUntil(() => h.list.state.count === 44);

    await expect(applied).resolves.toBe(true);
    expect(h.list.positionOf("m20")).toEqual({ top: 2000, height: 240 });
    expect(h.list.state.totalSize).toBe(4540);
    h.list.dispose();
  });

  it("should discard an aborted partial batch without mounting or leaking it", async () => {
    const h = mount(range(0, 20));
    const abort = new AbortController();
    const bodyChildren = document.body.childElementCount;
    const applied = h.list.updateWindow(
      ({ items }) => ({ items: [...items, ...range(20, 44)] }),
      abort.signal,
    );
    vi.advanceTimersByTime(16);

    abort.abort();
    vi.advanceTimersByTime(300);

    await expect(applied).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    expect(h.list.state.held).toBe(false);
    expect(h.destroyed).toEqual(range(20, 28).map((item) => item.id));
    expect(h.destroyedElements.every((element) => !element.isConnected)).toBe(
      true,
    );
    expect(document.body.childElementCount).toBe(bodyChildren);
    h.list.dispose();
  });

  it.each(["abort", "dispose"] as const)(
    "should release a row returned after a render-time %s",
    async (action) => {
      const abort = new AbortController();
      const h = mount(range(0, 20), {
        onRender: (item) => {
          if (item.id !== 22) return;
          if (action === "abort") abort.abort();
          else h.list.dispose();
        },
      });
      const applied = h.list.updateWindow(
        ({ items }) => ({ items: [...items, ...range(20, 44)] }),
        abort.signal,
      );

      vi.advanceTimersByTime(100);

      await expect(applied).resolves.toBe(false);
      expect(
        h.destroyed.filter((id) => id >= 20).sort((a, b) => a - b),
      ).toEqual([20, 21, 22]);
      expect(h.destroyedElements.every((element) => !element.isConnected)).toBe(
        true,
      );
      h.list.dispose();
      expect(document.body.childElementCount).toBe(1);
    },
  );

  it.each(["render", "measure"] as const)(
    "should reject a staged %s failure and leave the committed page intact",
    async (failure) => {
      const h = mount(range(0, 20), {
        throwOn: failure === "render" ? "fail" : undefined,
        measureFailOn: failure === "measure" ? "fail" : undefined,
      });
      const bodyChildren = document.body.childElementCount;
      const next = range(20, 44);
      // This row is not a batch's last row: its measurement failure is in
      // the final authoritative pass, after every batch was staged.
      next[9] = message(29, "fail");
      const applied = h.list.updateWindow(({ items }) => ({
        items: [...items, ...next],
      }));
      const rejected = expect(applied).rejects.toThrow(`${failure} failed`);

      await vi.advanceTimersByTimeAsync(300);

      await rejected;
      expect(h.list.state.count).toBe(20);
      expect(h.list.state.totalSize).toBe(2000);
      expect(h.list.state.held).toBe(false);
      expect(h.destroyed.sort((a, b) => a - b)).toEqual(
        range(20, failure === "render" ? 29 : 44).map((item) => item.id),
      );
      expect(document.body.childElementCount).toBe(bodyChildren);
      h.list.dispose();
    },
  );

  it("should cancel a stale preparation after a newer snapshot", async () => {
    const h = mount(range(0, 20));
    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, ...range(20, 44)],
    }));
    vi.advanceTimersByTime(16);

    h.list.setItems(range(100, 120));
    vi.advanceTimersByTime(100);

    await expect(applied).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    expect(h.list.positionOf("m100")).toEqual({ top: 0, height: 100 });
    expect(h.list.positionOf("m20")).toBeNull();
    expect(h.destroyed.filter((id) => id >= 20)).toEqual(
      range(20, 28).map((item) => item.id),
    );
    h.list.dispose();
  });

  it.each(["snapshot", "same item", "restored item"] as const)(
    "should preserve staged work after an identity-equivalent %s submission",
    async (submission) => {
      const initial = range(0, 20);
      const first = initial[0] as Msg;
      const h = mount(initial, { boot: "start" });
      const applied = h.list.updateWindow(({ items }) => ({
        items: [...items, ...range(20, 44)],
      }));
      vi.advanceTimersByTime(16);

      if (submission === "snapshot") h.list.setItems([...initial]);
      else {
        if (submission === "restored item")
          h.list.updateItem("m0", message(0, "temporary change"));
        h.list.updateItem("m0", first);
      }
      advanceFramesUntil(() => h.list.state.count === 44);

      await expect(applied).resolves.toBe(true);
      expect(h.list.state.count).toBe(44);
      expect(h.list.elementOf("m0")?.textContent).toBe(first.body);
      expect(h.list.positionOf("m43")).toEqual({ top: 4300, height: 100 });
      h.list.dispose();
      expect(h.destroyed.sort((a, b) => a - b)).toEqual(
        range(0, 44).map((item) => item.id),
      );
    },
  );

  it("should cancel width-stale work and leave no hidden measurement root", async () => {
    let width = 300;
    const h = mount(range(0, 20), {
      width: () => width,
    });
    const bodyChildren = document.body.childElementCount;
    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, ...range(20, 44)],
    }));
    vi.advanceTimersByTime(16);

    width = 500;
    fireResize(1, h.viewport, VIEWPORT_H);
    vi.advanceTimersByTime(100);

    await expect(applied).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    expect(h.list.state.held).toBe(false);
    expect(document.body.childElementCount).toBe(bodyChildren);
    h.list.dispose();
  });

  it("should pause batches during a new gesture and commit at the new reading position", async () => {
    const h = mount(range(0, 80), {
      boot: "start",
    });
    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items, ...range(80, 104)],
    }));
    vi.advanceTimersByTime(16);

    h.userScroll(2000);
    vi.advanceTimersByTime(64);
    expect(h.list.state.count).toBe(80);
    h.settle();
    advanceFramesUntil(() => h.list.state.count === 104);

    await expect(applied).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(2000);
    expect(h.list.state.held).toBe(false);
    h.list.dispose();
  });

  it("should not evict a reading window exposed while a batch was preparing", async () => {
    const h = mount(range(0, 80), {
      boot: "start",
    });
    const applied = h.list.updateWindow(({ items }) => ({
      items: [...items.slice(0, 20), ...range(80, 104)],
    }));
    vi.advanceTimersByTime(16);

    h.userScroll(5000);
    h.settle();
    vi.advanceTimersByTime(300);

    await expect(applied).resolves.toBe(false);
    expect(h.list.state.count).toBe(80);
    expect(h.viewport.scrollTop).toBe(5000);
    expect(h.list.elementOf("m50")?.textContent).toBe("msg 50");
    h.list.dispose();
  });

  it("should cancel an interrupting page command when the user takes over", async () => {
    const h = mount(range(0, 20));
    const applied = h.list.updateWindow(
      () => ({ items: range(40, 64) }),
      undefined,
      { interrupt: true },
    );
    vi.advanceTimersByTime(16);

    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    vi.advanceTimersByTime(100);

    await expect(applied).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    expect(h.list.positionOf("m40")).toBeNull();
    h.list.dispose();
  });
});

describe("positioned declared items", () => {
  it.each([
    ["", "transform"],
    ["auto", "transform"],
    ["initial", "transform"],
    ["opacity", "opacity, transform"],
    ["contents, opacity", "contents, opacity, transform"],
    ["opacity, transform", "opacity, transform"],
  ])(
    "should preserve direct-card hints when promoting %s",
    (hint, expected) => {
      const h = mount([]);
      h.list.dispose();
      const element = document.createElement("div");
      element.style.setProperty("will-change", hint, "important");
      element.style.transform = "scale(0.9)";
      const priority = element.style.getPropertyPriority("will-change");
      const list = createVirtualList(h.viewport, {
        items: [message(0)],
        key: (item) => String(item.id),
        height: () => ROW_H,
        position: () => ({ top: 0, lane: 0 }),
        render: () => element,
      });
      try {
        expect(element.style.willChange).toBe(expected);
        expect(element.style.getPropertyPriority("will-change")).toBe(priority);
        expect(element.style.transform).toBe("scale(0.9)");
      } finally {
        list.dispose();
      }
    },
  );

  it("should fully reconcile after protected-window queries advance past the last mounted window", async () => {
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: () => 100,
      position: (m) => ({ top: Math.floor(m.id / 2) * 100, lane: m.id % 2 }),
    });
    try {
      for (const top of [700, 1300]) {
        // A caller can query protection before the engine delivers scroll.
        h.viewport.scrollTop = top;
        await expect(h.list.updateWindow(() => null)).resolves.toBe(false);
      }

      h.userScroll(1900);

      expect(
        [...h.canvas().children]
          .map((el) => Number((el as HTMLElement).dataset.id))
          .sort((a, b) => a - b),
      ).toEqual(range(24, 72).map((m) => m.id));
    } finally {
      h.list.dispose();
    }
  });

  it("should preserve exact buffered coverage and retained elements across scroll reversals", () => {
    const items = range(0, 200);
    const topOf = (id: number) => Math.floor(id / 5) * 120 + (id % 5) * 10;
    const h = mount(items, {
      boot: "start",
      itemHeight: () => 100,
      position: (m) => ({ top: topOf(m.id), lane: m.id % 5 }),
    });
    try {
      for (const top of [100, 700, 1300, 1900, 1300, 700, 710, 3000, 3100, 0]) {
        const before = new Map(
          items.map((m) => [m.id, h.list.elementOf(`m${m.id}`)]),
        );
        h.userScroll(top);
        const lower = Math.floor(Math.max(0, top - 600) / 600) * 600;
        const upper =
          Math.ceil(Math.min(h.list.state.totalSize, top + 1200) / 600) * 600;
        const expected = items.filter(
          (m) => topOf(m.id) < upper && topOf(m.id) + 100 > lower,
        );
        expect(
          [...h.canvas().children]
            .map((el) => Number((el as HTMLElement).dataset.id))
            .sort((a, b) => a - b),
        ).toEqual(expected.map((m) => m.id));
        for (const item of expected) {
          const retained = before.get(item.id);
          if (retained) expect(h.list.elementOf(`m${item.id}`)).toBe(retained);
        }
      }
    } finally {
      h.list.dispose();
    }
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("should retry a failed incremental entry even when the next scroll has the same buffered window", () => {
    let fail = true;
    const failures: string[] = [];
    const onError = (event: ErrorEvent): void => {
      failures.push(event.message);
      event.preventDefault();
    };
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: () => 100,
      position: (m) => ({ top: Math.floor(m.id / 2) * 100, lane: m.id % 2 }),
      onRender: (m) => {
        if (fail && m.id === 40) throw new Error("incremental entry failed");
      },
    });
    window.addEventListener("error", onError);
    try {
      h.userScroll(100);
      h.userScroll(700);
      expect(failures).toEqual(["incremental entry failed"]);
      expect(h.list.elementOf("m40")).toBeNull();
      expect(h.list.elementOf("m41")?.textContent).toBe("msg 41");
      fail = false;
      h.userScroll(710);
      expect(h.list.elementOf("m40")?.textContent).toBe("msg 40");
      expect(failures).toEqual(["incremental entry failed"]);
    } finally {
      window.removeEventListener("error", onError);
      h.list.dispose();
    }
  });

  it("should mount whole cards directly and protect only the sparse visible set", async () => {
    const h = mount(range(0, 61), {
      boot: "start",
      itemHeight: (m) => (m.id === 0 ? 5000 : 100),
      position: (m) => ({
        top: Math.max(0, m.id - 1) * 100,
        lane: m.id === 0 ? 0 : 1,
      }),
      onMeasure: () => {
        throw new Error("declared cards must not be measured");
      },
    });
    h.userScroll(2000);
    h.settle();
    const expected = [0, ...range(13, 37).map((m) => m.id)];
    let protectedIds: number[] = [];

    await h.list.updateWindow(({ protectedItems }) => {
      protectedIds = protectedItems.map((m) => m.id);
      return null;
    });

    expect(protectedIds).toEqual(expected);
    expect(
      [...h.canvas().children]
        .map((node) => Number((node as HTMLElement).dataset.id))
        .sort((a, b) => a - b),
    ).toEqual(expected);
    expect(h.list.elementOf("m0")?.parentElement).toBe(h.canvas());
    expect(h.list.elementOf("m10")).toBeNull();
    expect(h.list.positionOf("m0")).toEqual({ top: 0, height: 5000 });
    expect(h.list.state.totalSize).toBe(6000);
    h.list.dispose();
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("should publish sparse mount changes even when source-index bounds stay unchanged", () => {
    const h = mount(range(0, 3), {
      boot: "start",
      itemHeight: (m) => (m.id === 1 ? 100 : 5000),
      position: (m) => ({ top: m.id === 1 ? 700 : 0, lane: m.id }),
    });
    const published = h.states.length;
    expect(h.list.elementOf("m1")?.textContent).toBe("msg 1");

    h.userScroll(1800);

    expect(h.list.elementOf("m1")).toBeNull();
    expect(h.list.state.start).toBe(0);
    expect(h.list.state.end).toBe(3);
    expect(h.states.length).toBeGreaterThan(published);
    h.list.dispose();
  });

  it("should freeze copied positions and commit a reflow with its photo anchor", () => {
    let shift = 0;
    const initial = range(0, 60);
    const h = mount(initial, {
      boot: "start",
      itemHeight: () => 100,
      position: (m) => ({
        top: Math.floor(m.id / 2) * 100 + (m.id >= 10 ? shift : 0),
        lane: m.id % 2,
      }),
    });
    h.userScroll(1000);
    const tile = h.list.elementOf("m20");
    shift = 500;

    h.list.setItems(
      initial.map((m) => ({ ...m, body: "reflowed" })),
      { anchor: { key: "m20", offset: 0 } },
    );
    shift = 1000;
    expect(h.list.positionOf("m20")?.top).toBe(1000);
    expect(tile?.textContent).toBe("msg 20");
    h.settle();

    expect(h.list.positionOf("m20")?.top).toBe(1500);
    expect(h.viewport.scrollTop).toBe(1500);
    expect(h.list.elementOf("m20")).toBe(tile);
    expect(tile?.style.translate).toBe("0 1500px");
    expect(tile?.textContent).toBe("reflowed");
    h.list.dispose();
  });

  it("should rebase evicted cards without overwriting their interaction transform", () => {
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: () => 100,
      position: (m) => ({ top: Math.floor(m.id / 2) * 100, lane: m.id % 2 }),
    });
    h.userScroll(3000);
    h.settle();
    const tile = h.list.elementOf("m60");
    if (!tile) throw new Error("missing visible card");
    tile.style.transform = "scale(0.975)";
    tile.style.transition = "transform 150ms";

    h.list.setItems(range(20, 120), { anchor: "viewport" });

    expect(h.viewport.scrollTop).toBe(2000);
    expect(h.list.elementOf("m60")).toBe(tile);
    expect(tile.style.translate).toBe("0 2000px");
    expect(tile.style.transform).toBe("scale(0.975)");
    expect(tile.style.transition).toBe("transform 150ms");
    expect(h.list.positionOf("m60")?.top).toBe(h.viewport.scrollTop);
    h.list.dispose();
  });

  it.each([1, 1.25, 1.5, 2])(
    "should preserve every column's pixel alignment across eviction and restoration at DPR %s",
    (ratio) => {
      const original = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", {
        value: ratio,
        configurable: true,
      });
      try {
        const h = mount(range(0, 100), {
          boot: "start",
          itemHeight: () => 99.3,
          position: (m) => ({
            top: Math.floor(m.id / 3) * 105.37 + (m.id % 3) * 17.73,
            lane: m.id % 3,
          }),
        });
        h.userScroll(1600);
        h.settle();
        const visible = range(48, 63).map((m) => {
          const top = h.list.positionOf(`m${m.id}`)?.top;
          if (top === undefined) throw new Error("missing card position");
          expect(top * ratio).toBeCloseTo(Math.round(top * ratio), 8);
          return { key: `m${m.id}`, screenTop: top - h.viewport.scrollTop };
        });

        for (const next of [range(20, 120), range(0, 100)]) {
          const before = h.viewport.scrollTop;
          h.list.setItems(next, { anchor: "viewport" });
          const correction = h.viewport.scrollTop - before;
          expect(correction).toBeCloseTo(Math.round(correction), 8);
          expect(correction * ratio).toBeCloseTo(
            Math.round(correction * ratio),
            8,
          );
          for (const card of visible) {
            const top = h.list.positionOf(card.key)?.top;
            if (top === undefined) throw new Error("lost visible card");
            expect(top - h.viewport.scrollTop).toBeCloseTo(card.screenTop, 8);
            expect(top * ratio).toBeCloseTo(Math.round(top * ratio), 8);
          }
        }
        h.list.dispose();
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: original,
          configurable: true,
        });
      }
    },
  );

  it("should normalize retained columns together and put edge slots outside them", async () => {
    const loader = (key: string): EdgeSlot => ({
      key,
      height: 50,
      render: () => document.createElement("div"),
    });
    const h = mount(range(0, 20), {
      boot: "start",
      itemHeight: () => 100,
      position: (m) => ({
        top: 1000 + Math.floor(m.id / 2) * 100 + (m.id % 2) * 20,
        lane: m.id % 2,
      }),
      edgeSlots: { start: loader("before"), end: loader("after") },
    });

    expect(h.list.positionOf("m0")?.top).toBe(50);
    expect(h.list.positionOf("m1")?.top).toBe(70);
    expect(h.list.state.totalSize).toBe(1120);
    await expect(h.list.scrollTo("m8")).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(450);
    h.list.dispose();
  });

  it("should keep a positioned commit consistent after a deferred render failure and retry", () => {
    const initial = range(0, 40);
    let fail = true;
    const h = mount(initial, {
      boot: "start",
      itemHeight: (m) => (m.body === "changed" ? 150 : 100),
      position: (m) => ({ top: Math.floor(m.id / 2) * 100, lane: m.id % 2 }),
      onRender: (m) => {
        if (fail && m.body === "changed") throw new Error("card render failed");
      },
    });
    h.userScroll(500);
    const changed = initial.map((m) =>
      m.id === 10 ? { ...m, body: "changed" } : m,
    );
    h.list.setItems(changed, { anchor: "viewport" });

    expect(() => h.settle()).toThrow("card render failed");

    expect(h.list.state.held).toBe(false);
    expect(h.list.positionOf("m10")).toEqual({ top: 500, height: 150 });
    expect(h.list.elementOf("m10")?.style.height).toBe("150px");
    expect(h.list.elementOf("m10")?.textContent).toBe("msg 10");
    fail = false;
    h.list.setItems(changed, { anchor: "viewport" });
    expect(h.list.elementOf("m10")?.textContent).toBe("changed");
    h.list.dispose();
  });

  it("should replace direct cards and switch to stacked rows with the same keys", () => {
    let positioned = true;
    const initial = range(0, 40);
    const h = mount(initial, {
      boot: "start",
      itemHeight: () => 100,
      position: (m) =>
        positioned ? { top: Math.floor(m.id / 2) * 100, lane: m.id % 2 } : null,
      replaceOnRerender: true,
    });
    const old = h.list.elementOf("m0");

    h.list.updateItem("m0", message(0, "replacement"));

    const next = h.list.elementOf("m0");
    expect(next).not.toBe(old);
    expect(next?.parentElement).toBe(h.canvas());
    expect(next?.textContent).toBe("replacement");
    expect(
      h.destroyedElements.filter((element) => element === old),
    ).toHaveLength(1);
    positioned = false;
    h.list.setItems(initial);
    expect(h.list.positionOf("m10")?.top).toBe(1000);
    expect(h.list.state.totalSize).toBe(4000);
    positioned = true;
    h.list.setItems(initial);
    expect(h.list.positionOf("m10")?.top).toBe(500);
    expect(h.list.state.totalSize).toBe(2000);
    h.list.dispose();
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("should reject invalid or mixed placement before changing committed DOM", () => {
    const initial = range(0, 20);
    let mode: "valid" | "invalid" | "mixed" = "valid";
    const h = mount(initial, {
      boot: "start",
      itemHeight: () => 100,
      position: (m) =>
        mode === "mixed" && m.id === 1
          ? null
          : { top: m.id * 100, lane: mode === "invalid" ? -1 : 0 },
    });
    const tile = h.list.elementOf("m0");
    mode = "invalid";
    expect(() => h.list.setItems(initial)).toThrow("positioned items need");
    mode = "mixed";
    expect(() => h.list.setItems(initial)).toThrow("place every item or none");
    expect(h.list.elementOf("m0")).toBe(tile);
    expect(h.list.positionOf("m10")?.top).toBe(1000);
    expect(h.list.state.totalSize).toBe(2000);
    h.list.dispose();
  });
});

describe("bounded paging on the runtime", () => {
  it.each([
    { trim: undefined, expected: 80 },
    { trim: false as const, expected: 80 },
    { trim: {}, expected: 80 },
    { trim: { offscreenPin: "retain" as const }, expected: 80 },
    { trim: { offscreenPin: "evict" as const }, expected: 20 },
  ])(
    "should honor optional trimming policy $trim while traversing pinned history",
    async ({ trim, expected }) => {
      const initial = page(60);
      const h = mount([...initial.items], {
        boot: "start",
        overscanPx: 0,
        itemHeight: () => ROW_H,
        pinning: { match: (m) => m.id === 79 },
      });
      const evicted: number[] = [];
      const paging = createPagedWindow({
        list: h.list,
        initial,
        maxItems: 20,
        trim,
        key: (m) => `m${m.id}`,
        keysOf: (m) => [`m${m.id}`],
        project: (items) => items,
        load: async ({ cursor }) => page(cursor),
        onEvict: (items) => evicted.push(...items.map((m) => m.id)),
      });
      for (let step = 0; step < 3; step++) {
        await expect(paging.load("start")).resolves.toBe(true);
        await h.list.scrollTo("start");
        await paging.reconcile();
      }
      expect(paging.items).toHaveLength(expected);
      expect(h.list.state.count).toBe(expected);
      expect(paging.items[0]?.id).toBe(0);
      expect(evicted.length).toBe(80 - expected);
      if (trim === false) expect(paging.reconcile()).toBeNull();
      paging.dispose();
      h.list.dispose();
    },
  );

  it("should disable trimming in both directions without suppressing paging or live updates", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const evict = vi.fn();
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 1,
      trim: false,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      live: { project: (m) => m, key: (m) => `m${m.id}` },
      load: async ({ cursor }) => page(cursor),
      onEvict: evict,
    });
    await paging.load("start");
    await h.list.scrollTo("end");
    await paging.load("end");
    await paging.updateItemLive("m25", (m) => ({ ...m, body: "latest token" }));
    expect(paging.items).toHaveLength(60);
    expect(paging.items.find((m) => m.id === 25)?.body).toBe("latest token");
    expect(paging.reconcile()).toBeNull();
    expect(evict).not.toHaveBeenCalled();
    paging.dispose();
    h.list.dispose();
  });

  it("should evict an offscreen leading pin and restore source-owned text on reverse paging", async () => {
    let first = message(0);
    const sourcePage = (start: number): Page<Msg, number> => ({
      ...page(start),
      items: page(start).items.map((m) => (m.id === 0 ? first : m)),
    });
    const initial = sourcePage(0);
    const h = mount([...initial.items], {
      boot: "start",
      overscanPx: 0,
      itemHeight: () => ROW_H,
      pinning: { match: (m) => m.id === 0 },
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 20,
      trim: { offscreenPin: "evict" },
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      live: { project: (m) => m, key: (m) => `m${m.id}` },
      load: async ({ cursor }) => sourcePage(cursor),
    });
    await paging.load("end");
    await h.list.scrollTo("end");
    await paging.reconcile();
    expect(paging.items).toEqual(range(20, 40));
    expect(h.list.positionOf("m0")).toBeNull();
    first = message(0, "text received after eviction");
    await expect(paging.updateItemLive("m0", () => first)).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    await paging.load("start");
    await h.list.scrollTo("start");
    await paging.reconcile();
    expect(paging.items).toEqual([first, ...range(1, 20)]);
    expect(h.list.elementOf("m0")?.textContent).toBe(first.body);
    paging.dispose();
    h.list.dispose();
  });

  it.each(["start", "end"] as const)(
    "should keep repeated overlapping %s loads bounded and contiguous",
    async (edge) => {
      const initial = page(200);
      const h = mount([...initial.items], {
        boot: edge,
        itemHeight: () => ROW_H,
      });
      const evicted: number[] = [];
      const paging = createPagedWindow({
        list: h.list,
        initial,
        maxItems: 30,
        key: (m) => `m${m.id}`,
        keysOf: (m) => [`m${m.id}`],
        project: (items) => items,
        load: async ({ edge, cursor }) =>
          page(cursor + (edge === "end" ? -10 : 10)),
        onEvict: (removed) => {
          const retainedKeys = new Set(paging.items.map((m) => m.id));
          expect(removed.some((m) => retainedKeys.has(m.id))).toBe(false);
          evicted.push(...removed.map((m) => m.id));
        },
      });

      for (let step = 0; step < 10; step++) {
        await expect(paging.load(edge)).resolves.toBe(true);
        await h.list.scrollTo(edge);
        await paging.reconcile();
        const ids = paging.items.map((m) => m.id);
        expect(ids).toEqual(
          range(ids[0] ?? 0, (ids.at(-1) ?? -1) + 1).map((m) => m.id),
        );
        expect(ids.length).toBeLessThanOrEqual(30);
      }
      expect(evicted.length).toBeGreaterThan(0);
      expect(
        paging.items.some((m) => m.id === (edge === "end" ? 319 : 100)),
      ).toBe(true);
      paging.dispose();
      h.list.dispose();
    },
  );

  it("should preserve a single shared edit when its original page is evicted", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 30,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor - 10),
    });
    await paging.updateItem("m35", (m) => ({ ...m, body: "edited" }));
    await paging.load("end");
    let edits = 0;
    await paging.updateItem("m35", (m) => {
      edits++;
      return { ...m, body: `${m.body} again` };
    });
    await h.list.scrollTo("end");
    await paging.load("end");
    await paging.reconcile();

    expect(paging.items[0]?.id).toBe(30);
    expect(paging.items.find((m) => m.id === 35)).toEqual(
      message(35, "edited again"),
    );
    expect(edits).toBe(1);
    paging.dispose();
    h.list.dispose();
  });

  it("should restore an overlapping continuation without skipping its shared boundary", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 30,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ edge, cursor }) =>
        page(edge === "end" ? cursor - 10 : cursor),
    });
    await paging.load("end");
    await h.list.scrollTo("m45");
    await paging.load("end");
    await h.list.scrollTo("m55");
    await paging.reconcile();
    await paging.load("start");

    const ids = paging.items.map((m) => m.id);
    expect(ids).toEqual(
      range(ids[0] ?? 0, (ids.at(-1) ?? -1) + 1).map((m) => m.id),
    );
    paging.dispose();
    h.list.dispose();
  });

  it("should preserve contiguous cursors after trimming a refreshed partial page", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 50,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    await paging.load("end");
    await paging.refreshHead(page(10));
    await h.list.scrollTo("m55");
    await paging.load("end");
    await paging.load("start");

    const ids = paging.items.map((m) => m.id);
    expect(ids).toEqual(
      range(ids[0] ?? 0, (ids.at(-1) ?? -1) + 1).map((m) => m.id),
    );
    paging.dispose();
    h.list.dispose();
  });

  it("should merge an overlapping fresh head without losing edits or the older cursor", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    await paging.updateItem("m20", (m) => ({ ...m, body: "expanded" }));
    const refreshed = { ...page(10), start: { available: false } as const };

    await expect(paging.refreshHead(refreshed)).resolves.toBe(true);

    expect(paging.items.map((m) => m.id)).toEqual(
      range(10, 40).map((m) => m.id),
    );
    expect(paging.items.find((m) => m.id === 20)?.body).toBe("expanded");
    expect(h.viewport.scrollTop).toBe(1000);
    await paging.load("end");
    expect(paging.items.map((m) => m.id)).toEqual(
      range(10, 60).map((m) => m.id),
    );
    paging.dispose();
    h.list.dispose();
  });

  it("should refuse a disconnected fresh head without altering retained posts", async () => {
    const initial = page(40);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 20,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });

    await expect(paging.refreshHead(page(0))).resolves.toBe(false);

    expect(paging.items).toEqual(initial.items);
    expect(h.viewport.scrollTop).toBe(0);
    paging.dispose();
    h.list.dispose();
  });

  it("should cancel a head waiting for settle when disposed with an external signal", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    h.userScroll(100);
    const pending = paging.refreshHead(page(10), new AbortController().signal);

    paging.dispose();

    await expect(pending).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    h.list.dispose();
  });

  it("should evaluate an interrupting layout update after the held page commits", async () => {
    const initial = page(0);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    h.userScroll(100);
    const load = paging.load("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list.state.held).toBe(true);
    let sourceCount = 0;
    const reflow = h.list.updateWindow(
      () => {
        sourceCount = paging.items.length;
        return {
          items: paging.items.map((m) => ({ ...m, body: `reflow ${m.id}` })),
        };
      },
      undefined,
      { interrupt: true },
    );
    expect(sourceCount).toBe(40);
    expect(h.list.state.count).toBe(40);
    expect(h.list.positionOf("m39")).toEqual({ top: 3900, height: ROW_H });
    await expect(reflow).resolves.toBe(true);
    await expect(load).resolves.toBe(true);
    paging.dispose();
    h.list.dispose();
  });

  it("should keep a lazy-render failure committed and retry its row on reconciliation", async () => {
    const initial = { ...page(0), items: range(0, 2) };
    let fail = true;
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
      onRender: (m) => {
        if (m.id === 2 && fail) throw new Error("lazy render failed");
      },
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async () => ({
        ...page(0),
        items: range(2, 20),
        end: { available: false as const },
      }),
    });
    await expect(paging.load("end")).rejects.toThrow("lazy render failed");
    expect(paging.items).toEqual(range(0, 20));
    expect(paging.canLoad("end")).toBe(false);
    expect(h.list.state.count).toBe(20);
    expect(h.list.state.totalSize).toBe(2000);
    expect(h.list.positionOf("m2")).toEqual({ top: 200, height: ROW_H });
    expect(h.rowElement("msg 3").textContent).toBe("msg 3");
    fail = false;
    h.userScroll(100);
    expect(h.rowElement("msg 2").textContent).toBe("msg 2");
    paging.dispose();
    h.list.dispose();
  });
  function page(start: number): Page<Msg, number> {
    return {
      items: range(start, start + 20),
      start:
        start > 0
          ? { available: true, cursor: start - 20 }
          : { available: false },
      end: { available: true, cursor: start + 20 },
    };
  }

  it("should load during a held trim without restoring evicted data", async () => {
    const initial = page(0);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 20,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    await paging.load("end");
    h.userScroll(3400);
    const trim = paging.reconcile();
    const complete = vi.fn();
    const load = paging.load("end", {
      signal: new AbortController().signal,
      complete,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).not.toHaveBeenCalled();
    h.settle();
    await expect(trim).resolves.toBe(false);
    await expect(load).resolves.toBe(true);
    expect(paging.items).toEqual(range(20, 60));
    expect(h.list.positionOf("m0")).toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
    paging.dispose();
    h.list.dispose();
  });

  it("should render pager-owned tokens during a gesture and retain them after paging", async () => {
    const initial = page(0);
    const h = mount([...initial.items], {
      boot: "start",
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      live: { project: (item) => item, key: (m) => `m${m.id}` },
      load: async ({ cursor }) => page(cursor),
    });
    h.userScroll(100);
    const load = paging.load("end");
    await expect(
      paging.updateItemLive("m1", (m) => ({ ...m, body: "live token" })),
    ).resolves.toBe(true);
    expect(h.rowElement("live token").textContent).toBe("live token");
    expect(paging.items.find((m) => m.id === 1)?.body).toBe("live token");
    h.settle();
    for (let frame = 0; frame < 30; frame++)
      await vi.advanceTimersByTimeAsync(16);
    await expect(load).resolves.toBe(true);
    expect(paging.items.find((m) => m.id === 1)?.body).toBe("live token");
    expect(h.rowElement("live token").textContent).toBe("live token");
    paging.dispose();
    h.list.dispose();
  });

  it.each(["updateItem", "updateItemLive"] as const)(
    "should retry detached page preparation after %s without fetching again",
    async (method) => {
      const initial = page(0);
      const fetched: number[] = [];
      const h = mount([...initial.items], {
        boot: "start",
      });
      const paging = createPagedWindow({
        list: h.list,
        initial,
        maxItems: 60,
        key: (m) => `m${m.id}`,
        keysOf: (m) => [`m${m.id}`],
        project: (items) => items,
        live: { project: (item) => item, key: (m) => `m${m.id}` },
        load: async ({ cursor }) => {
          fetched.push(cursor);
          return page(cursor);
        },
      });
      try {
        const load = paging.load("end");
        await vi.advanceTimersByTimeAsync(16);
        await expect(
          paging[method]("m1", (m) => ({
            ...m,
            body: "newer than the staged page",
          })),
        ).resolves.toBe(true);
        for (let frame = 0; frame < 30; frame++)
          await vi.advanceTimersByTimeAsync(16);
        await expect(load).resolves.toBe(true);
        expect(fetched).toEqual([20]);
        expect(paging.items).toHaveLength(40);
        expect(paging.items.find((m) => m.id === 1)?.body).toBe(
          "newer than the staged page",
        );
        expect(h.rowElement("newer than the staged page").textContent).toBe(
          "newer than the staged page",
        );
      } finally {
        paging.dispose();
        h.list.dispose();
      }
    },
  );

  it("should reject live key changes and cancel a failed live publisher", async () => {
    const initial = page(0);
    const h = mount([...initial.items], { boot: "start", throwOn: "broken" });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      live: { project: (item) => item, key: (m) => `m${m.id}` },
      load: async ({ cursor }) => page(cursor),
    });
    await expect(
      paging.updateItemLive("m1", (m) => ({ ...m, id: 2 })),
    ).rejects.toThrow("keep its key");
    await expect(paging.updateItemLive("missing", (m) => m)).resolves.toBe(
      false,
    );
    expect(paging.items).toEqual(initial.items);
    await expect(
      paging.updateItemLive("m1", (m) => ({ ...m, body: "broken" })),
    ).rejects.toThrow("render failed: broken");
    expect(paging.canLoad("end")).toBe(false);
    expect(paging.items.find((m) => m.id === 1)?.body).toBe("broken");
    await expect(
      paging.updateItemLive("m1", (m) => ({ ...m, body: "ignored" })),
    ).resolves.toBe(false);
    paging.dispose();
    h.list.dispose();
  });

  it("should retain source edits across queued paging commits", async () => {
    const initial = page(0);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    h.userScroll(100);
    const edit = paging.updateItem("m1", (m) => ({ ...m, body: "edited" }));
    const load = paging.load("end");
    await vi.advanceTimersByTimeAsync(0);
    const secondEdit = paging.updateItem("m1", (m) => ({
      ...m,
      body: `${m.body} again`,
    }));
    h.settle();
    await expect(edit).resolves.toBe(true);
    await expect(load).resolves.toBe(true);
    await expect(secondEdit).resolves.toBe(true);
    await paging.load("end");
    expect(paging.items.find((m) => m.id === 1)).toEqual(
      message(1, "edited again"),
    );
    expect(h.rowElement("edited again").textContent).toBe("edited again");
    await expect(paging.updateItem("missing", (m) => m)).resolves.toBe(false);
    await expect(
      paging.updateItem("m1", (m) => ({ ...m, id: 2 })),
    ).rejects.toThrow("keep its key");
    paging.dispose();
    h.list.dispose();
  });

  it("should not evict the fetching boundary when a reverse load supersedes trimming", async () => {
    const initial = page(20);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const cursors: number[] = [];
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 20,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => {
        cursors.push(cursor);
        return page(cursor);
      },
    });
    await paging.load("start");
    h.userScroll(100);
    const trim = paging.reconcile();
    const load = paging.load("end");
    await vi.advanceTimersByTimeAsync(0);
    h.settle();
    await expect(trim).resolves.toBe(false);
    await expect(load).resolves.toBe(true);
    expect(cursors).toEqual([0, 40]);
    expect(paging.items).toEqual(range(0, 60));
    paging.dispose();
    h.list.dispose();
  });

  it("should cancel a load started during trimming before it can commit", async () => {
    const initial = page(0);
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
    });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 20,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    await paging.load("end");
    h.userScroll(3400);
    const trim = paging.reconcile();
    const abort = new AbortController();
    const complete = vi.fn();
    const load = paging.load("end", { signal: abort.signal, complete });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(load).resolves.toBe(false);
    h.settle();
    await expect(trim).resolves.toBe(true);
    expect(paging.items).toEqual(range(20, 40));
    expect(complete).toHaveBeenCalledTimes(1);
    paging.dispose();
    h.list.dispose();
  });

  it("should keep paging cursors in sync when an observer throws after commit", async () => {
    const initial = page(0);
    let fail = false;
    const h = mount([...initial.items], {
      boot: "start",
      itemHeight: () => ROW_H,
      onState: () => {
        if (fail) {
          fail = false;
          throw new Error("observer failed");
        }
      },
    });
    const cursors: number[] = [];
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 60,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => {
        cursors.push(cursor);
        return page(cursor);
      },
    });
    fail = true;
    await expect(paging.load("end")).rejects.toThrow("observer failed");
    expect(paging.items).toEqual(range(0, 40));
    await paging.load("end");
    expect(cursors).toEqual([20, 40]);
    expect(paging.items).toEqual(range(0, 60));
    paging.dispose();
    h.list.dispose();
  });

  it("should append and trim atomically, then restore the previous page", async () => {
    const initial = page(0);
    const h = mount([...initial.items], {
      itemHeight: () => ROW_H,
      boot: "start",
    });
    const evicted: number[][] = [];
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 40,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
      onEvict: (items) => {
        evicted.push(items.map((m) => m.id));
      },
    });
    expect(paging.reconcile()).toBeNull();
    await paging.load("end");
    expect(paging.reconcile()).toBeNull();
    h.userScroll(3400);
    h.settle();
    const published = h.states.length;
    await paging.load("end");
    expect(paging.items.map((m) => m.id)).toEqual(
      range(20, 60).map((m) => m.id),
    );
    expect(h.states.slice(published).map((state) => state.count)).toEqual([40]);
    expect(h.viewport.scrollTop).toBe(1400);
    expect(evicted).toEqual([range(0, 20).map((m) => m.id)]);
    expect(h.list.positionOf("m0")).toBeNull();

    h.userScroll(0);
    h.settle();
    await paging.load("start");
    expect(paging.items.map((m) => m.id)).toEqual(
      range(0, 40).map((m) => m.id),
    );
    expect(h.viewport.scrollTop).toBe(2000);
    expect(paging.canLoad("start")).toBe(false);
    paging.dispose();
    h.list.dispose();
  });

  it("should temporarily exceed the budget and retry after protected content moves away", async () => {
    const initial = page(0);
    const h = mount([...initial.items], { boot: "start" });
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 20,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    const loaded = paging.load("end");
    await vi.advanceTimersByTimeAsync(300);
    await expect(loaded).resolves.toBe(true);
    expect(paging.items).toHaveLength(40);
    h.userScroll(3400);
    const trim = paging.reconcile();
    expect(h.list.state.count).toBe(40);
    h.settle();
    await expect(trim).resolves.toBe(true);
    expect(paging.items).toHaveLength(20);
    expect(h.list.positionOf("m0")).toBeNull();
    expect(h.destroyed).toEqual(
      expect.arrayContaining(range(0, 20).map((m) => m.id)),
    );
    paging.dispose();
    h.list.dispose();
  });

  it("should discard a loaded page when the source is disposed before settle", async () => {
    const initial = page(0);
    const h = mount([...initial.items]);
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 40,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => page(cursor),
    });
    h.userScroll(1000);
    const loaded = paging.load("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list.state.held).toBe(true);
    paging.dispose();
    h.settle();
    await expect(loaded).resolves.toBe(false);
    expect(h.list.state.count).toBe(20);
    h.list.dispose();
  });

  it("should advance opaque cursors through empty and overlapping pages without inferring exhaustion", async () => {
    const initial: Page<Msg, string> = {
      items: range(0, 20),
      start: { available: false },
      end: { available: true, cursor: "empty" },
    };
    const h = mount([...initial.items], { boot: "start" });
    const cursors: string[] = [];
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 100,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }): Promise<Page<Msg, string>> => {
        cursors.push(cursor);
        return cursor === "empty"
          ? {
              items: [],
              start: { available: false },
              end: { available: true, cursor: "overlap" },
            }
          : {
              items: [...range(10, 30), message(29)],
              start: { available: false },
              end: { available: false },
            };
      },
    });
    await paging.load("end");
    expect(paging.canLoad("end")).toBe(true);
    expect(paging.items).toHaveLength(20);
    const loaded = paging.load("end");
    await vi.advanceTimersByTimeAsync(300);
    await expect(loaded).resolves.toBe(true);
    expect(paging.items.map((m) => m.id)).toEqual(
      range(0, 30).map((m) => m.id),
    );
    expect(cursors).toEqual(["empty", "overlap"]);
    expect(paging.canLoad("end")).toBe(false);
    expect(paging.canLoad("start")).toBe(false);
    paging.dispose();
    h.list.dispose();
  });

  it("should cancel an uncooperative source promptly and accept an opposite load", async () => {
    const initial = page(20);
    const h = mount([...initial.items], { boot: "start" });
    let finish: (result: Page<Msg, number>) => void = () => {
      throw new Error("fetch not started");
    };
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 40,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: ({ edge, cursor }) =>
        edge === "start"
          ? Promise.resolve(page(cursor))
          : new Promise((resolve) => {
              finish = resolve;
            }),
    });
    const abort = new AbortController();
    const complete = vi.fn();
    const stale = paging.load("end", { signal: abort.signal, complete });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    const opposite = paging.load("start");
    await expect(stale).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await expect(opposite).resolves.toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    finish(page(40));
    await vi.advanceTimersByTimeAsync(0);
    expect(paging.items.map((m) => m.id)).toEqual(
      range(0, 40).map((m) => m.id),
    );
    paging.dispose();
    h.list.dispose();
  });

  it("should leave cursors and data unchanged after a failed fetch and allow retry", async () => {
    const initial = page(0);
    const h = mount([...initial.items]);
    let fail = true;
    const paging = createPagedWindow({
      list: h.list,
      initial,
      maxItems: 40,
      key: (m) => `m${m.id}`,
      keysOf: (m) => [`m${m.id}`],
      project: (items) => items,
      load: async ({ cursor }) => {
        if (fail) throw new Error("offline");
        return page(cursor);
      },
    });
    await expect(paging.load("end")).rejects.toThrow("offline");
    expect(paging.loading).toBe(false);
    expect(paging.items).toEqual(initial.items);
    fail = false;
    const loaded = paging.load("end");
    await vi.advanceTimersByTimeAsync(300);
    await expect(loaded).resolves.toBe(true);
    expect(paging.items).toHaveLength(40);
    paging.dispose();
    h.list.dispose();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("runtime — replacement paint lifecycle", () => {
  function replacement(viewport: HTMLElement): VirtualList<Msg> {
    return createVirtualList(viewport, {
      items: range(0, 20),
      key: (item) => `m${item.id}`,
      height: () => ROW_H,
      settleStrategy: "default",
      render: (item) => {
        const element = document.createElement("div");
        element.textContent = item.body;
        return element;
      },
    });
  }

  it.each([
    {
      userAgent: "AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      repairs: 1,
    },
    { userAgent: "AppleWebKit/605.1.15 Mobile/15E148", repairs: 1 },
    { userAgent: "Firefox/142.0", repairs: 0 },
    {
      userAgent: "AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      repairs: 0,
    },
  ])(
    "should repair only a replacement WebKit viewport ($userAgent)",
    ({ userAgent, repairs }) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
      const h = mount(range(0, 20));
      const observed: string[] = [];
      vi.spyOn(h.viewport, "offsetHeight", "get").mockImplementation(() => {
        observed.push(h.viewport.style.overflowY);
        return VIEWPORT_H;
      });
      vi.advanceTimersByTime(32);
      h.list.updateItem("m19", message(19, "ordinary update"));
      vi.advanceTimersByTime(32);
      expect(observed).toEqual([]);

      h.list.dispose();
      const next = replacement(h.viewport);
      const top = h.viewport.scrollTop;
      vi.advanceTimersByTime(32);

      expect(observed).toEqual(Array.from({ length: repairs }, () => "hidden"));
      expect(h.viewport.style.overflowY).toBe("");
      expect(h.viewport.scrollTop).toBe(top);
      next.dispose();
    },
  );

  it("should cancel a disposed replacement's repaint before another list mounts", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "AppleWebKit/605.1.15",
    );
    const h = mount(range(0, 20));
    h.list.dispose();
    const observed: string[] = [];
    vi.spyOn(h.viewport, "offsetHeight", "get").mockImplementation(() => {
      observed.push(h.viewport.style.overflowY);
      return VIEWPORT_H;
    });

    replacement(h.viewport).dispose();
    const next = replacement(h.viewport);
    vi.advanceTimersByTime(32);

    expect(observed).toEqual(["hidden"]);
    next.dispose();
  });

  it("should not rebuild the scrolling layer after new user input", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "AppleWebKit/605.1.15",
    );
    const h = mount(range(0, 20));
    h.list.dispose();
    const observed: string[] = [];
    vi.spyOn(h.viewport, "offsetHeight", "get").mockImplementation(() => {
      observed.push(h.viewport.style.overflowY);
      return VIEWPORT_H;
    });

    const next = replacement(h.viewport);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    vi.advanceTimersByTime(32);

    expect(observed).toEqual([]);
    next.dispose();
  });
});

describe("runtime — commits and slots", () => {
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

    // Start a real new gesture even if the preceding glide is still in its
    // scroll-end cooldown; do not depend on a particular easing duration.
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    h.userScroll(4500);
    expect(h.list.state.following).toBe(false);
    h.list.dispose();
  });

  it("a command to the end re-engages following even when growth outran its glide", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
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

  it("should follow viewport resizes instantly while keeping streamed growth smooth", () => {
    const initial = range(0, 50);
    let height = VIEWPORT_H;
    const h = mount(initial, {
      followBehavior: "smooth",
      height: () => height,
    });
    h.userScroll(4000);
    h.settle();
    h.userScroll(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);

    // The composer grows: the viewport shrinks by 100px and the end is
    // uncovered. Following stays on and the viewport adopts the new end
    // in the resize delivery itself, without starting an animation.
    height = 500;
    fireResize(1, h.viewport, 500);
    expect(h.list.state.following).toBe(true);
    expect(h.viewport.scrollTop).toBe(4500);
    height = 600;
    fireResize(1, h.viewport, 600);
    expect(h.viewport.scrollTop).toBe(4400);
    h.settle();
    expect(h.list.state.following).toBe(true);

    // And the stream is still followed afterwards.
    h.heights.set(49, 300);
    const streamed = [...initial];
    streamed[49] = message(49, "streamed longer");
    h.list.setItems(streamed);
    expect(h.viewport.scrollTop).toBe(4400);
    advanceFramesUntil(() => h.viewport.scrollTop === 4600);
    expect(h.viewport.scrollTop).toBe(4600);
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

  it("should retain following when streaming grows in the final glide write", () => {
    let grew = false;
    const h = mount(range(0, 50), {
      followBehavior: "smooth",
      onViewport: (snapshot) => {
        if (!grew && snapshot.scrollTop === 4500) {
          grew = true;
          h.heights.set(49, 400);
          h.list.updateItem("m49", message(49, "growth on landing"));
        }
      },
    });
    h.heights.set(49, 200);

    h.list.updateItem("m49", message(49, "start following"));
    vi.advanceTimersByTime(1800);

    expect(grew).toBe(true);
    expect(h.viewport.scrollTop).toBe(4700);
    expect(h.list.state.following).toBe(true);
    h.heights.set(49, 500);
    h.list.updateItem("m49", message(49, "next streaming burst"));
    vi.advanceTimersByTime(1000);
    expect(h.viewport.scrollTop).toBe(4800);
    expect(h.list.state.following).toBe(true);
    h.list.dispose();
  });

  it("a command's own pin commit never arms following", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
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

  it("should tie the pin's canvas floor to the viewport and clear it when unpinned", () => {
    const h = mount(range(0, 50));

    void h.list.scrollTo("m45", { align: "start", offset: 44 });

    expect(h.canvas().style.minHeight).toBe("calc(100% + 4456px)");
    expect(h.list.state.totalSize).toBe(5056);
    void h.list.scrollTo("m0", { align: "start" });
    expect(h.canvas().style.minHeight).toBe("");
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

  it("should preserve a sticky-inset pin when row resize arrives before viewport resize", () => {
    let width = 800;
    const h = mount(range(0, 50), { width: () => width });
    void h.list.scrollTo("m40", { align: "start", offset: 44 });
    expect(h.viewport.scrollTop).toBe(3956);

    width = 390;
    h.heights.set(39, 124);
    fireResize(0, h.rowElement("msg 39"), 124);
    fireResize(1, h.viewport, VIEWPORT_H);

    expect(h.list.positionOf("m40")?.top).toBe(4024);
    expect(h.viewport.scrollTop).toBe(3980);
    h.list.dispose();
  });

  it.each([-200, -400])(
    "should smoothly align a tall row with a signed offset of %i",
    async (offset) => {
      const h = mount(range(0, 20));
      h.heights.set(18, 1000);
      h.list.updateItem("m18", message(18, "tall message"));
      h.userScroll(1000);
      h.settle();

      const landed = h.list.scrollTo("m18", {
        align: "start",
        offset,
        behavior: "smooth",
      });
      vi.advanceTimersByTime(48);
      expect(h.viewport.scrollTop).toBeGreaterThan(1000);
      expect(h.viewport.scrollTop).toBeLessThan(1800 - offset);
      advanceFramesUntil(() => h.viewport.scrollTop === 1800 - offset);
      h.settle();

      await expect(landed).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(1800 - offset);
      h.list.dispose();
    },
  );

  it('"keep-start": smooth follow stops once the last row\'s top reaches the viewport top', () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
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

  it.each(["auto", "smooth"] as const)(
    "should keep following resumed growth after a %s end command in keep-start mode",
    async (behavior) => {
      const h = mount(range(0, 50), {
        followBehavior: "smooth",
        followMode: "keep-start",
        followInset: 44,
      });
      try {
        h.heights.set(49, 1300);
        h.list.updateItem("m49", message(49, "reply reaches its start limit"));
        advanceFramesUntil(() => h.viewport.scrollTop === 4856);
        h.settle();
        expect(h.viewport.scrollTop).toBe(4856);

        const landed = h.list.scrollTo("end", { behavior });
        advanceFramesUntil(() => h.viewport.scrollTop === 5600);
        h.settle();
        await expect(landed).resolves.toBe(true);
        expect(h.list.state.following).toBe(true);

        // Each pause lets the command/follow glide fully settle before
        // more content arrives; a still-running command hides this bug.
        for (const height of [1500, 1800]) {
          h.heights.set(49, height);
          h.list.updateItem("m49", message(49, `reply grows to ${height}`));
          advanceFramesUntil(() => h.viewport.scrollTop === 4300 + height);
          h.settle();
          expect(h.viewport.scrollTop).toBe(4300 + height);
          expect(h.list.state.following).toBe(true);
        }

        // A new tail gets the configured keep-start policy again.
        h.list.setItems([
          ...range(0, 49),
          message(49, "finished reply"),
          message(50),
        ]);
        advanceFramesUntil(() => h.viewport.scrollTop === 6200);
        h.settle();
        h.heights.set(50, 1300);
        h.list.updateItem("m50", message(50, "the next reply grows"));
        advanceFramesUntil(() => h.viewport.scrollTop === 6656);
        h.settle();
        expect(h.viewport.scrollTop).toBe(6656);
      } finally {
        h.list.dispose();
      }
    },
  );

  it("setFollowMode widens a stopped follow and catches up at once", () => {
    const initial = range(0, 50);
    const h = mount(initial, {
      followBehavior: "smooth",
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

  it.each([1, 2, 3])(
    "should preserve the reading anchor with whole-CSS-pixel scroll writes at %sx",
    (ratio) => {
      const original = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", {
        value: ratio,
        configurable: true,
      });
      try {
        const h = mount(range(0, 50));
        h.userScroll(2050);
        h.settle();
        const before = (h.list.positionOf("m20")?.top ?? 0) - 2050;
        h.heights.set(-1, 100.25);

        h.list.setItems([message(-1), ...range(0, 50)], {
          anchor: "viewport",
        });

        const top = h.viewport.scrollTop;
        // Some engines accept only whole CSS pixels, even when DPR is 2/3.
        // Both floor and nearest rounding must preserve the same coordinate.
        expect((h.list.positionOf("m20")?.top ?? 0) - Math.floor(top)).toBe(
          before,
        );
        expect((h.list.positionOf("m20")?.top ?? 0) - Math.round(top)).toBe(
          before,
        );
        expect(h.list.positionOf("m-1")?.height).toBeGreaterThanOrEqual(100.25);
        h.list.dispose();
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: original,
          configurable: true,
        });
      }
    },
  );

  it.each([2, 3])(
    "should preserve the host-positioned height grid at %sx",
    (ratio) => {
      const original = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", {
        value: ratio,
        configurable: true,
      });
      try {
        const height = Math.ceil(100.1 * ratio) / ratio;
        const h = mount(range(0, 50), {
          itemHeight: () => 100.1,
          position: (item) => ({ top: item.id * height, lane: 0 }),
        });
        expect(h.list.positionOf("m20")?.height).toBeCloseTo(height, 8);
        expect(h.list.positionOf("m21")?.top).toBeCloseTo(21 * height, 8);
        h.list.dispose();
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: original,
          configurable: true,
        });
      }
    },
  );

  it("heights quantize to the device grid at a fractional ratio, so offsets never sit on half device pixels", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      value: 1.5,
      configurable: true,
    });
    try {
      const h = mount(range(0, 50));
      // 100px is 150 device pixels: unchanged. 41.2px is 61.8 device pixels:
      // rounded up to 62, which is 41.333 CSS px — not 42.
      h.heights.set(3, 41.2);
      const grown = [...range(0, 50)];
      grown[3] = message(3, "fractional");
      h.list.setItems(grown);
      expect(h.list.positionOf("m3")?.height).toBeCloseTo(62 / 1.5, 6);
      expect(h.list.positionOf("m4")?.top).toBeCloseTo(300 + 62 / 1.5, 6);
      h.list.dispose();
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        value: original,
        configurable: true,
      });
    }
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
      // A row above grows to 101px — 101.6 on the device grid (127 device
      // pixels): the anchor's coordinate moves to 2051.6, and the write
      // lands on the nearest device pixel, 2052 (2565 device pixels).
      h.heights.set(3, 101);
      const grown = [...range(0, 50)];
      grown[3] = message(3, "one pixel taller");
      h.list.setItems(grown);
      expect(h.viewport.scrollTop).toBe(2052);
      h.list.dispose();
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        value: original,
        configurable: true,
      });
    }
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

  it("should cancel an active smooth command when an interrupting snapshot arrives", async () => {
    const initial = range(0, 50);
    const h = mount(initial, { boot: "start" });
    const glide = h.list.scrollTo("end", { behavior: "smooth" });
    vi.advanceTimersByTime(32);

    h.list.setItems(initial, {
      anchor: { key: "m10", offset: -5 },
      interrupt: true,
    });

    await expect(glide).resolves.toBe(false);
    expect(h.viewport.scrollTop).toBe(1005);
    expect(h.list.state.held).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(h.viewport.scrollTop).toBe(1005);
  });

  it("commits a row at/below the anchor at once, with no scroll write", () => {
    const initial = range(0, 50);
    const h = mount(initial);
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
    const h = mount(initial);
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

  it("should commit a dirty row exposed by a live shrink without writing scrollTop", () => {
    const writes: number[] = [];
    const h = mount(range(0, 50), {
      onScrollWrite: (top) => writes.push(top),
    });
    try {
      const tail = h.rowElement("msg 49");
      h.heights.set(49, 1000);
      fireResize(0, tail, 1000);
      h.userScroll(5298); // The tall tail owns the viewport's top.
      h.heights.set(44, 200);
      h.list.updateItem("m44", message(44, "grown above"));
      expect(h.list.positionOf("m44")).toEqual({ top: 4400, height: 100 });
      expect(h.list.state.held).toBe(true);
      writes.length = 0;

      // A late size change clamps the viewport up to m44, whose dirty
      // content must fit its slot now, without another scroll/RO delivery.
      h.heights.set(49, 100);
      fireResize(0, tail, 100);

      expect(writes).toEqual([]);
      expect(h.viewport.scrollTop).toBe(4400);
      expect(h.list.positionOf("m44")).toEqual({ top: 4400, height: 200 });
      const exposed = h.rowElement("grown above");
      expect(exposed.isConnected).toBe(true);
      expect(h.slotOf(exposed).style.height).toBe("200px");
      expect(h.list.state.totalSize).toBe(5100);
      expect(h.list.state.held).toBe(false);
    } finally {
      h.list.dispose();
    }
  });

  it("should finish successive live clamps that expose more dirty rows without writing scrollTop", () => {
    const writes: number[] = [];
    const h = mount(range(0, 50), {
      onScrollWrite: (top) => writes.push(top),
    });
    try {
      const tail = h.rowElement("msg 49");
      h.heights.set(49, 1000);
      fireResize(0, tail, 1000);
      h.userScroll(5298);
      h.heights.set(44, 20);
      h.list.updateItem("m44", message(44, "shorter m44"));
      h.heights.set(43, 30);
      h.list.updateItem("m43", message(43, "shorter m43"));
      h.heights.set(42, 200);
      h.list.updateItem("m42", message(42, "grown m42"));
      h.heights.set(41, 200);
      h.list.updateItem("m41", message(41, "still above the final anchor"));
      expect(h.list.state.held).toBe(true);
      expect(h.viewport.scrollTop).toBe(5298);
      writes.length = 0;
      const published = h.states.length;

      // The tail exposes m44; its shrink exposes m43; that shrink exposes
      // m42. All must finish in this delivery, not on later scroll events.
      h.heights.set(49, 100);
      fireResize(0, tail, 100);

      expect(writes).toEqual([]);
      expect(h.viewport.scrollTop).toBe(4250);
      expect(h.list.positionOf("m42")).toEqual({ top: 4200, height: 200 });
      expect(h.list.positionOf("m43")).toEqual({ top: 4400, height: 30 });
      expect(h.list.positionOf("m44")).toEqual({ top: 4430, height: 20 });
      expect(h.list.positionOf("m41")).toEqual({ top: 4100, height: 100 });
      const exposed = h.rowElement("grown m42");
      expect(exposed.isConnected).toBe(true);
      expect(h.slotOf(exposed).style.height).toBe("200px");
      expect(h.list.state.totalSize).toBe(4950);
      expect(h.list.state.held).toBe(true);
      expect(h.states.slice(published)).toEqual([h.list.state]);
    } finally {
      h.list.dispose();
    }
  });

  it.each(["measurement", "anchor"] as const)(
    "should publish committed geometry and recover after a later live-clamp %s failure",
    (failure) => {
      let fail = false;
      const writes: number[] = [];
      const h = mount(range(0, 50), {
        onScrollWrite: (top) => writes.push(top),
        onMeasure: (item) => {
          if (fail && failure === "measurement" && item.id === 44)
            throw new Error("late measurement failed");
        },
        anchorable: (item) => {
          if (fail && failure === "anchor" && item.id === 44)
            throw new Error("late anchor failed");
          return true;
        },
      });
      try {
        const tail = h.rowElement("msg 49");
        h.heights.set(49, 1000);
        fireResize(0, tail, 1000);
        h.userScroll(5298);
        h.heights.set(44, 200);
        h.list.updateItem("m44", message(44, "grown above"));
        writes.length = 0;
        const published = h.states.length;
        fail = true;

        h.heights.set(49, 100);
        expect(() => fireResize(0, tail, 100)).toThrow(
          `late ${failure} failed`,
        );

        // The first pass already shrank the canvas. An error in the next
        // pass must still leave its real viewport reconciled and published.
        expect(writes).toEqual([]);
        expect(h.viewport.scrollTop).toBe(4400);
        expect(h.list.state.totalSize).toBe(5000);
        expect(h.list.state.start).toBe(38);
        expect(h.list.state.held).toBe(true);
        expect(h.states.slice(published)).toEqual([h.list.state]);
        const exposed = h.rowElement("grown above");
        expect(exposed.isConnected).toBe(true);
        expect(h.slotOf(exposed).style.height).toBe("100px");

        fail = false;
        fireResize(0, exposed, 200);

        expect(writes).toEqual([]);
        expect(h.viewport.scrollTop).toBe(4400);
        expect(h.list.positionOf("m44")).toEqual({ top: 4400, height: 200 });
        expect(h.slotOf(exposed).style.height).toBe("200px");
        expect(h.list.state.totalSize).toBe(5100);
        expect(h.list.state.held).toBe(false);
      } finally {
        h.list.dispose();
      }
    },
  );

  it('"live" keeps a dirty row above the anchor for settle, or for the scroll that reaches it', () => {
    const initial = range(0, 50);
    const h = mount(initial);
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

  it("growth landing right after the document becomes visible again follows by write, not by glide", () => {
    const initial = range(0, 50);
    const h = mount(initial, { followBehavior: "smooth" });
    void h.list.scrollTo("end");
    const last = h.rowElement("msg 49");

    // Control: watched growth at the end glides.
    h.heights.set(49, 300);
    fireResize(0, last, 300);
    expect(h.viewport.scrollTop).toBeLessThan(50 * ROW_H + 200 - VIEWPORT_H);
    vi.advanceTimersByTime(2_000);
    expect(h.viewport.scrollTop).toBe(50 * ROW_H + 200 - VIEWPORT_H);

    // Hidden: growth lands at once — a glide started now would only play
    // on return, the whole background growth as one slide.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    h.heights.set(49, 600);
    fireResize(0, last, 600);
    expect(h.viewport.scrollTop).toBe(50 * ROW_H + 500 - VIEWPORT_H);
    // Visible again: the growth that arrives in the first frames back was
    // not watched either — it lands at once.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(48);
    h.heights.set(49, 900);
    fireResize(0, last, 900);
    expect(h.viewport.scrollTop).toBe(50 * ROW_H + 800 - VIEWPORT_H);

    // The window closes: later growth glides again.
    vi.advanceTimersByTime(400);
    h.heights.set(49, 1_500);
    fireResize(0, last, 1_500);
    expect(h.viewport.scrollTop).toBeLessThan(50 * ROW_H + 1_400 - VIEWPORT_H);
    vi.advanceTimersByTime(2_000);
    expect(h.viewport.scrollTop).toBe(50 * ROW_H + 1_400 - VIEWPORT_H);
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
    const h = mount(initial);
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
    const h = mount(initial);
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
    const h = mount(initial);
    h.userScroll(3005);
    h.list.setItems([...initial, ...range(50, 62)], { anchor: "end" });
    expect(h.list.state.count).toBe(50);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.count).toBe(62);
    expect(h.list.state.atEnd).toBe(true);
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
    // A width change ends the phase and commits at once, at the new width.
    fireResize(1, h.viewport, VIEWPORT_H);
    expect(h.list.state.held).toBe(false);
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

describe("runtime — retained nodes", () => {
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

  it("should reject a queued scroll command when that command fails", async () => {
    let listRef: VirtualList<Msg> | null = null;
    let queued: Promise<boolean> | null = null;
    let failScroll = false;
    const h = mount(range(0, 20), {
      onRender: (item) => {
        if (item.body === "queue command")
          queued = listRef?.scrollTo("m0", { align: "start" }) ?? null;
      },
      onState: (state) => {
        if (state.count === 21) failScroll = true;
      },
      anchorable: () => {
        if (failScroll) throw new Error("command anchor failed");
        return true;
      },
    });
    listRef = h.list;

    h.list.setItems([...range(0, 20), message(20, "queue command")]);

    await expect(queued).rejects.toThrow("command anchor failed");
    failScroll = false;
    await expect(h.list.scrollTo("end")).resolves.toBe(true);
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
});

describe("runtime — edge slots", () => {
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

  it("should keep item indices independent of edge-slot changes and repeated snapshots", () => {
    const initial = range(0, 10);
    const h = mount(initial, {
      edgeSlots: { start: loader(), end: loader("end") },
    });
    h.list.setItems(initial);
    h.list.updateItem("m3", message(3, "with slots"));
    h.list.setEdgeSlot("start", null);
    h.list.updateItem("m4", message(4, "without start"));
    h.list.setEdgeSlot("start", loader("replacement", 80));
    h.list.updateItem("m5", message(5, "new start"));
    h.list.setEdgeSlot("end", null);

    expect(h.list.state.count).toBe(10);
    for (const [id, body] of [
      [3, "with slots"],
      [4, "without start"],
      [5, "new start"],
    ] as const) {
      void h.list.scrollTo(`m${id}`);
      expect(h.rowElement(body).textContent).toBe(body);
      expect(h.list.positionOf(`m${id}`)?.top).toBe(80 + id * ROW_H);
    }
    h.list.dispose();
  });

  it("should atomically remove the loader slot when a staged jump loads the beginning", async () => {
    const slot = loader();
    const h = mount(range(20, 40), { edgeSlots: { start: slot } });
    // The first row represents the chat's day header; the reading target
    // belongs directly below it, with no empty loader strip above either.
    h.heights.set(0, 40);
    let committed = false;
    expect(h.list.positionOf("m20")?.top).toBe(52);

    const applied = h.list.updateWindow(
      () => ({
        items: range(0, 40),
        edgeSlots: { start: null },
        anchor: { key: "m1", offset: 40 },
        onCommit: () => {
          committed = true;
        },
      }),
      undefined,
      { interrupt: true },
    );
    advanceFramesUntil(() => committed);
    await expect(applied).resolves.toBe(true);
    h.userScroll(0);
    h.settle();

    expect(h.viewport.scrollTop).toBe(0);
    expect(h.list.positionOf("m0")).toEqual({ top: 0, height: 40 });
    expect(h.list.positionOf("m1")).toEqual({ top: 40, height: ROW_H });
    expect(h.list.state.totalSize).toBe(39 * ROW_H + 40);
    expect(h.viewport.querySelector('[data-id="slot"]')).toBeNull();
    h.list.dispose();
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

  it("should retain the previous edge slot after a replacement fails to render", () => {
    const initial = range(0, 20);
    const slot = loader();
    const h = mount(initial, { edgeSlots: { start: slot } });
    const broken: EdgeSlot = {
      key: "broken",
      height: 80,
      render: () => {
        throw new Error("slot render failed");
      },
    };

    expect(() => h.list.setEdgeSlot("start", broken)).toThrow(
      "slot render failed",
    );
    h.list.setItems([...initial, message(20)]);

    expect(h.list.state.count).toBe(21);
    expect(h.list.state.totalSize).toBe(21 * ROW_H + slot.height);
    expect(h.list.positionOf("m0")).toEqual({
      top: slot.height,
      height: ROW_H,
    });
  });

  it("should retain adopted window slots when a post-commit callback throws", async () => {
    const initial = range(0, 20);
    let failNotification = false;
    const h = mount(initial, {
      edgeSlots: { start: loader() },
      onState: () => {
        if (failNotification) throw new Error("notification failed");
      },
    });
    const replacement = loader("replacement", 80);
    failNotification = true;

    await expect(
      h.list.updateWindow(() => ({
        items: initial,
        edgeSlots: { start: replacement },
      })),
    ).rejects.toThrow("notification failed");
    failNotification = false;
    h.list.setItems([...initial, message(20)]);

    expect(h.list.state.count).toBe(21);
    expect(h.list.positionOf("m0")).toEqual({
      top: replacement.height,
      height: ROW_H,
    });
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

describe("runtime — commands", () => {
  it.each([
    "default",
    "firefox-wheel",
    "safari-wheel",
    "chromium-wheel",
  ] as const)(
    "should resolve a stationary smooth command without new input (%s)",
    async (settleStrategy) => {
      const h = mount(range(0, 20), { settleStrategy });
      await h.list.scrollTo("m18", { align: "start", offset: 44 });
      const top = h.viewport.scrollTop;

      const command = h.list.scrollTo("m18", {
        align: "start",
        offset: 44,
        behavior: "smooth",
      });
      vi.advanceTimersByTime(32);
      h.viewport.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(1000);

      await expect(command).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(top);
    },
  );

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
    const h = mount(initial);
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
    const h = mount(initial);
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

  it.each(["auto", "smooth"] as const)(
    "should retire the previous top pin reserve after %s realignment",
    async (behavior) => {
      const h = mount(range(0, 20));
      await h.list.scrollTo("m19", { align: "start" });
      expect(h.list.state.totalSize).toBe(2500);

      const centered = h.list.scrollTo("m19", {
        align: "start",
        offset: (VIEWPORT_H - ROW_H) / 2,
        behavior,
      });
      advanceFramesUntil(() => h.viewport.scrollTop === 1650);
      h.settle();

      await expect(centered).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(1650);
      expect(h.list.state.totalSize).toBe(2250);
      h.userScroll(1900);
      expect(h.viewport.scrollTop).toBe(1650);
      h.settle();
      await h.list.scrollTo("m19", { align: "start", offset: 500 });
      expect(h.list.state.totalSize).toBe(2000);
      expect(h.viewport.scrollTop).toBe(1400);
      h.list.dispose();
    },
  );

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

  it.each([
    { replyHeight: 100, landing: 1756, totalSize: 2356 },
    { replyHeight: 800, landing: 2100, totalSize: 2700 },
  ])(
    "should pin and land at the end without an intermediate scroll for a $replyHeight px tail",
    async ({ replyHeight, landing, totalSize }) => {
      const writes: number[] = [];
      const h = mount(range(0, 20), {
        onScrollWrite: (top) => writes.push(top),
      });
      h.heights.set(19, replyHeight);
      fireResize(0, h.rowElement("msg 19"), replyHeight);
      await h.list.scrollTo("start");
      writes.length = 0;

      const command = h.list.scrollTo("end", {
        pin: { key: "m18", offset: 44 },
      });

      await expect(command).resolves.toBe(true);
      expect(writes).toEqual([landing]);
      expect(h.viewport.scrollTop).toBe(landing);
      expect(h.list.state.totalSize).toBe(totalSize);
      expect(h.list.state.atEnd).toBe(true);
      h.list.dispose();
    },
  );

  it.each(["auto", "smooth"] as const)(
    "should retire an older pin's reserve after a %s atomic end landing",
    async (behavior) => {
      const h = mount(range(0, 20));
      await h.list.scrollTo("m19", { align: "start" });
      expect(h.viewport.scrollTop).toBe(1900);
      expect(h.list.state.totalSize).toBe(2500);

      const command = h.list.scrollTo("end", {
        pin: { key: "m15", offset: 44 },
        behavior,
      });
      if (behavior === "smooth") {
        expect(h.list.state.totalSize).toBe(2500);
        advanceFramesUntil(() => h.viewport.scrollTop === 1456);
        h.settle();
      }

      await expect(command).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(1456);
      expect(h.list.state.totalSize).toBe(2056);
      expect(h.list.state.atEnd).toBe(true);
      h.list.dispose();
    },
  );

  it.each([100, 900])(
    "should naturally clamp a keyed jump without requesting a pin for a %i pixel last row",
    async (lastHeight) => {
      const h = mount(range(0, 20), {
        boot: "start",
        itemHeight: (item) => (item.id === 19 ? lastHeight : ROW_H),
      });
      const totalBefore = h.list.state.totalSize;

      await expect(
        h.list.scrollTo("m19", { behavior: "auto", offset: 40 }),
      ).resolves.toBe(true);

      expect(h.viewport.scrollTop).toBe(
        Math.min(1900 - 40, totalBefore - VIEWPORT_H),
      );
      expect(h.list.state.totalSize).toBe(totalBefore);
      h.list.dispose();
    },
  );

  it.each(["auto", "smooth"] as const)(
    "should clamp %s start alignment without pinning or growing a reserve",
    async (behavior) => {
      let height = VIEWPORT_H;
      const h = mount(range(0, 20), {
        boot: "start",
        pinning: false,
        height: () => height,
      });

      const command = h.list.scrollTo("m19", { align: "start", behavior });
      if (behavior === "smooth") {
        advanceFramesUntil(() => h.viewport.scrollTop === 1400);
        h.settle();
      }

      await expect(command).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(1400);
      expect(h.list.state.totalSize).toBe(2000);
      expect(h.list.state.atEnd).toBe(true);
      expect(h.canvas().style.minHeight).toBe("");

      // No pin can regrow space when the viewport gets taller.
      height = 800;
      fireResize(1, h.viewport, height);
      expect(h.viewport.scrollTop).toBe(1200);
      expect(h.list.state.totalSize).toBe(2000);
      expect(h.list.state.atEnd).toBe(true);
      h.list.dispose();
    },
  );

  it.each(["auto", "smooth"] as const)(
    "should ignore explicit end pins when pinning is disabled (%s)",
    async (behavior) => {
      const h = mount(range(0, 20), { boot: "start", pinning: false });

      const command = h.list.scrollTo("end", {
        pin: { key: "m18", offset: 44 },
        behavior,
      });
      if (behavior === "smooth") {
        advanceFramesUntil(() => h.viewport.scrollTop === 1400);
        h.settle();
      }

      await expect(command).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(1400);
      expect(h.list.state.totalSize).toBe(2000);
      expect(h.canvas().style.minHeight).toBe("");
      h.list.dispose();
    },
  );

  it.each([
    { target: "end", behavior: "auto" },
    { target: "end", behavior: "smooth" },
    { target: "m19", behavior: "auto" },
    { target: "m19", behavior: "smooth" },
  ] as const)(
    "should drain temporary anchor space after $behavior navigation to $target with pinning off",
    async ({ target, behavior }) => {
      const h = mount(range(0, 20), { pinning: false });
      h.list.setItems(range(0, 20), { anchor: { key: "m19", offset: 0 } });
      expect(h.viewport.scrollTop).toBe(1900);
      expect(h.list.state.totalSize).toBe(2500);

      const command = h.list.scrollTo(target, { align: "start", behavior });
      if (behavior === "smooth") {
        // Safety space stays under the viewport until the glide lands.
        expect(h.viewport.scrollTop).toBe(1900);
        expect(h.list.state.totalSize).toBe(2500);
        advanceFramesUntil(() => h.viewport.scrollTop === 1400);
        h.settle();
      }

      await expect(command).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(1400);
      expect(h.list.state.totalSize).toBe(2000);
      expect(h.list.state.atEnd).toBe(true);
      expect(h.canvas().style.minHeight).toBe("");
      h.list.dispose();
    },
  );

  it("should retain an existing pin when an end command omits pin", async () => {
    const h = mount(range(0, 20));
    await h.list.scrollTo("end", { pin: { key: "m18", offset: 44 } });
    await h.list.scrollTo("m10");

    await expect(h.list.scrollTo("end")).resolves.toBe(true);

    expect(h.viewport.scrollTop).toBe(1756);
    expect(h.list.state.totalSize).toBe(2356);
    expect(h.list.state.atEnd).toBe(true);
    h.list.dispose();
  });

  it.each(["start", "end"] as const)(
    "should reserve the last matching item at %s boot without a scroll command",
    (boot) => {
      const h = mount(range(0, 20), {
        boot,
        pinning: { match: (item) => item.id % 2 === 0, offset: 40 },
      });

      expect(h.list.state.totalSize).toBe(2360);
      expect(h.viewport.scrollTop).toBe(boot === "start" ? 0 : 1760);
      h.list.dispose();
    },
  );

  it("should restore a branch pin before manual scrolling from an earlier item", async () => {
    const items = range(0, 20);
    const h = mount(items, {
      pinning: { match: (item) => item.id % 2 === 0, offset: 40 },
    });
    await h.list.scrollTo("m10");
    h.list.setItems(range(0, 16), { anchor: "viewport" });
    h.list.setItems(items, { anchor: "viewport" });
    await h.list.scrollTo("m17", { offset: 40 });

    h.userScroll(h.list.state.totalSize - VIEWPORT_H);
    h.settle();

    expect(h.list.positionOf("m18")?.top).toBe(1800);
    expect(h.viewport.scrollTop).toBe(1760);
    expect(h.list.state.totalSize).toBe(2360);
    h.list.dispose();
  });

  it("should keep the declarative pin when commands align another item", async () => {
    const h = mount(range(0, 20), {
      pinning: { match: (item) => item.id === 18, offset: 40 },
    });

    await h.list.scrollTo("m10", { align: "start" });
    await h.list.scrollTo("end", { pin: { key: "m19" } });

    expect(h.viewport.scrollTop).toBe(1760);
    expect(h.list.state.totalSize).toBe(2360);
    h.list.dispose();
  });

  it("should refresh a declarative inset without changing its target or rows", async () => {
    const items = range(0, 20);
    let offset = 40;
    const h = mount(items, {
      pinning: {
        match: (item) => item.id === 18,
        get offset() {
          return offset;
        },
      },
    });
    await h.list.scrollTo("m10");

    offset = 0;
    h.list.setItems(items, { anchor: "viewport" });

    expect(h.list.state.totalSize).toBe(2400);
    expect(h.viewport.scrollTop).toBe(1000);
    await h.list.scrollTo("end");
    expect(h.viewport.scrollTop).toBe(1800);
    h.list.dispose();
  });

  it("should retain the prepared inset while a snapshot is held", () => {
    let offset = 40;
    const h = mount(range(0, 20), {
      pinning: {
        match: (item) => item.id === 18,
        get offset() {
          return offset;
        },
      },
    });
    h.userScroll(1000);

    offset = 0;
    h.list.updateItem("m19", message(19, "Changed reply"));
    offset = 80;
    h.settle();

    expect(h.list.state.totalSize).toBe(2400);
    expect(h.viewport.scrollTop).toBe(1000);
    h.list.dispose();
  });

  it("should recompute a declarative pin after targeted item changes", async () => {
    const h = mount(range(0, 20), {
      pinning: { match: (item) => item.body === "prompt", offset: 40 },
    });
    await h.list.scrollTo("m10");

    h.list.updateItem("m18", message(18, "prompt"));

    expect(h.viewport.scrollTop).toBe(1000);
    expect(h.list.state.totalSize).toBe(2360);
    h.list.updateItem("m19", message(19, "new response"));
    expect(h.list.state.totalSize).toBe(2360);
    h.list.updateItem("m18", message(18));
    expect(h.list.state.totalSize).toBe(2000);
    h.list.dispose();
  });

  it("should preserve a pin change when a live update needs no new row", () => {
    const h = mount(range(0, 20), {
      pinning: { match: (item) => item.body === "prompt", offset: 40 },
    });
    h.userScroll(1000);

    h.list.updateItem("m18", message(18, "prompt"));
    h.settle();

    expect(h.list.state.totalSize).toBe(2360);
    expect(h.viewport.scrollTop).toBe(1000);
    h.list.dispose();
  });

  it("should keep the declarative pin through response growth and shrinkage", async () => {
    const h = mount(range(0, 20), {
      pinning: { match: (item) => item.id === 18, offset: 40 },
    });
    await h.list.scrollTo("m17");
    const tail = h.rowElement("msg 19");

    h.heights.set(19, 900);
    fireResize(0, tail, 900);
    expect(h.list.state.totalSize).toBe(2800);
    h.heights.set(19, 100);
    fireResize(0, tail, 100);

    expect(h.viewport.scrollTop).toBe(1700);
    expect(h.list.state.totalSize).toBe(2360);
    h.list.dispose();
  });

  it("should leave the committed pin intact when its predicate throws", async () => {
    const h = mount(range(0, 20), {
      pinning: {
        match: (item) => {
          if (item.body === "invalid") throw new Error("invalid pin item");
          return item.id === 18;
        },
        offset: 40,
      },
    });
    await h.list.scrollTo("m10");

    expect(() => h.list.updateItem("m19", message(19, "invalid"))).toThrow(
      "invalid pin item",
    );

    expect(h.viewport.scrollTop).toBe(1000);
    expect(h.list.state.totalSize).toBe(2360);
    expect(h.list.positionOf("m18")).toEqual({ top: 1800, height: 100 });
    h.list.dispose();
  });

  it("should absorb growth under an atomic pin and follow once the tail outgrows it", async () => {
    const h = mount(range(0, 20));
    await h.list.scrollTo("end", { pin: { key: "m18", offset: 44 } });
    const tail = h.rowElement("msg 19");

    h.heights.set(19, 300);
    fireResize(0, tail, 300);
    expect(h.viewport.scrollTop).toBe(1756);
    h.heights.set(19, 800);
    fireResize(0, tail, 800);

    expect(h.viewport.scrollTop).toBe(2100);
    expect(h.list.state.atEnd).toBe(true);
    h.list.dispose();
  });

  it.each(["instant", "smooth"] as const)(
    "should not undo a rounded pin landing during %s streaming commits",
    async (followBehavior) => {
      const original = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", {
        value: 3,
        configurable: true,
      });
      const h = mount(range(0, 20), { overscroll: true, followBehavior });
      try {
        h.heights.set(0, 100.1);
        h.list.updateItem("m0", message(0, "fractional prefix"));
        await h.list.scrollTo("end", { pin: { key: "m18", offset: 44 } });
        const landed = h.viewport.scrollTop;
        expect(landed).toBe(1757);

        h.heights.set(19, 300);
        h.list.updateItem("m19", message(19, "streamed text"));
        vi.advanceTimersByTime(1000);
        h.settle();

        expect(h.viewport.scrollTop).toBe(landed);
        expect(h.list.state.atEnd).toBe(true);
      } finally {
        h.list.dispose();
        Object.defineProperty(window, "devicePixelRatio", {
          value: original,
          configurable: true,
        });
      }
    },
  );

  it("should leave geometry and position untouched when an end pin is missing", async () => {
    const h = mount(range(0, 20));
    const before = h.viewport.scrollTop;
    const totalSize = h.list.state.totalSize;

    await expect(
      h.list.scrollTo("end", { pin: { key: "missing" } }),
    ).resolves.toBe(false);

    expect(h.viewport.scrollTop).toBe(before);
    expect(h.list.state.totalSize).toBe(totalSize);
    expect(h.canvas().style.minHeight).toBe("");
    h.list.dispose();
  });

  it("should reject a pin on a non-end target without scrolling", async () => {
    const h = mount(range(0, 20));
    const before = h.viewport.scrollTop;

    await expect(
      h.list.scrollTo("m18", { pin: { key: "m18" } }),
    ).rejects.toThrow("pin requires an end target");

    expect(h.viewport.scrollTop).toBe(before);
    expect(h.canvas().style.minHeight).toBe("");
    h.list.dispose();
  });

  it("should own a reentrant end pin before the caller mutates it", async () => {
    let current: Harness | undefined;
    let command: Promise<boolean> | undefined;
    const h = mount(range(0, 20), {
      onState: () => {
        if (!current || command) return;
        const pin = { key: "m18", offset: 44 };
        command = current.list.scrollTo("end", { pin });
        pin.key = "m0";
        pin.offset = 1000;
      },
    });
    current = h;

    h.list.updateItem("m19", message(19, "changed"));

    await expect(command).resolves.toBe(true);
    expect(h.viewport.scrollTop).toBe(1756);
    expect(h.list.state.totalSize).toBe(2356);
    h.list.dispose();
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

  it("should retain only landing departures until the measured glide settles", async () => {
    const unmounted: HTMLElement[] = [];
    const h = mount(range(0, 100), {
      overscanPx: 0,
      onUnmount: (element) => unmounted.push(element),
    });
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    advanceFramesUntil(() => h.viewport.scrollTop <= 500);
    const departing = h.rowElement("msg 9");
    expect(h.list.elementOf("m99")).toBe(null);

    advanceFramesUntil(() => h.viewport.scrollTop === 0);

    expect(h.viewport.scrollTop).toBe(0);
    expect(departing.isConnected).toBe(true);
    expect(unmounted).not.toContain(departing);
    expect(h.canvas().childElementCount).toBeLessThanOrEqual(13);
    h.settle();
    await expect(command).resolves.toBe(true);
    expect(departing.isConnected).toBe(false);
    expect(unmounted.filter((element) => element === departing)).toHaveLength(
      1,
    );
    expect(h.canvas().childElementCount).toBe(6);
  });

  it.each(["wheel", "command", "dispose"] as const)(
    "should release landing rows on %s interruption",
    async (interruption) => {
      const unmounted: HTMLElement[] = [];
      const h = mount(range(0, 100), {
        overscanPx: 0,
        onUnmount: (element) => unmounted.push(element),
      });
      const command = h.list.scrollTo("start", { behavior: "smooth" });
      advanceFramesUntil(() => h.viewport.scrollTop <= 500);
      const departing = h.rowElement("msg 9");
      advanceFramesUntil(() => h.viewport.scrollTop === 0);
      expect(departing.isConnected).toBe(true);

      if (interruption === "wheel") {
        h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
        h.userScroll(2000);
        h.settle();
      } else if (interruption === "command") {
        await expect(h.list.scrollTo("m20")).resolves.toBe(true);
      } else {
        h.list.dispose();
      }

      await expect(command).resolves.toBe(false);
      expect(departing.isConnected).toBe(false);
      expect(unmounted.filter((element) => element === departing)).toHaveLength(
        1,
      );
      if (interruption === "dispose")
        expect(
          h.destroyedElements.filter((element) => element === departing),
        ).toHaveLength(1);
      else expect(h.canvas().childElementCount).toBe(6);
    },
  );

  it("should keep declared-height glide windows strictly virtualized", async () => {
    const h = mount(range(0, 100), { overscanPx: 0, itemHeight: () => ROW_H });
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    advanceFramesUntil(() => h.viewport.scrollTop <= 500);
    const departing = h.rowElement("msg 9");

    advanceFramesUntil(() => h.viewport.scrollTop === 0);

    expect(departing.isConnected).toBe(false);
    expect(h.canvas().childElementCount).toBe(6);
    h.settle();
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
    const h = mount(initial);
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

  it("should resolve a landed command even when a settle-time observer throws", async () => {
    let fail = false;
    const h = mount(range(0, 100), {
      onState: () => {
        if (fail) throw new Error("settle observer failed");
      },
    });
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    let result: boolean | null = null;
    void command.then((value) => {
      result = value;
    });
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
    h.list.setItems(range(-10, 100));
    fail = true;

    expect(() => vi.advanceTimersByTime(200)).toThrow("settle observer failed");
    await Promise.resolve();

    expect(h.list.state.count).toBe(110);
    expect(result).toBe(false);
    fail = false;
    h.list.dispose();
  });

  it("should interrupt a landed command when its settle-time measurement fails", async () => {
    let fail = false;
    const h = mount(range(0, 100), {
      onMeasure: () => {
        if (fail) throw new Error("settle measurement failed");
      },
    });
    const command = h.list.scrollTo("start", { behavior: "smooth" });
    let result: boolean | null = null;
    void command.then((value) => {
      result = value;
    });
    advanceFramesUntil(() => h.viewport.scrollTop === 0);
    h.list.setItems(range(-10, 100));
    fail = true;

    expect(() => vi.advanceTimersByTime(200)).toThrow(
      "settle measurement failed",
    );
    await Promise.resolve();

    expect(result).toBe(false);
    fail = false;
    h.list.dispose();
  });

  it("should finish settling before starting commands queued by a window commit", async () => {
    const h = mount(range(0, 100));
    h.userScroll(5000);
    let command: Promise<boolean> | undefined;
    const update = h.list.updateWindow(({ items }) => ({
      items,
      onCommit: () => {
        command = h.list.scrollTo("start", { behavior: "smooth" });
        h.list.setItems(range(-10, 100));
      },
    }));

    h.settle();
    await expect(update).resolves.toBe(true);

    expect(h.list.state.count).toBe(100);
    expect(h.list.state.held).toBe(true);
    vi.advanceTimersByTime(4000);
    await expect(command).resolves.toBe(false);
    expect(h.list.state.count).toBe(110);
    h.list.dispose();
  });

  it.each([false, true])(
    "should isolate a failed held window job (interrupted=%s)",
    async (interrupted) => {
      const h = mount(range(0, 100));
      h.userScroll(5000);
      let failedCommand: Promise<boolean> | undefined;
      const failed = h.list.updateWindow(() => {
        failedCommand = h.list.scrollTo("start");
        throw new Error("window job failed");
      });
      const succeeded = h.list.updateWindow(({ items }) => ({ items }));
      const failure = expect(failed).rejects.toThrow("window job failed");

      if (interrupted) await expect(h.list.scrollTo("m50")).resolves.toBe(true);
      else h.settle();

      await failure;
      await expect(failedCommand).resolves.toBe(false);
      await expect(succeeded).resolves.toBe(true);
      expect(h.viewport.scrollTop).toBe(5000);
      h.list.dispose();
    },
  );

  it.each([false, true])(
    "should reject a committed window job without discarding its callbacks (interrupted=%s)",
    async (interrupted) => {
      const h = mount(range(0, 40), { itemHeight: () => ROW_H });
      h.userScroll(1000);
      const update = h.list.updateWindow(({ items }) => ({
        items,
        onCommit: () => {
          h.list.updateItem("m10", message(10, "committed edit"));
          throw new Error("window observer failed");
        },
      }));
      const failure = expect(update).rejects.toThrow("window observer failed");

      if (interrupted) await expect(h.list.scrollTo("m10")).resolves.toBe(true);
      else h.settle();

      await failure;
      expect(h.rowElement("committed edit").textContent).toBe("committed edit");
      expect(h.list.state.count).toBe(40);
      h.list.dispose();
    },
  );

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

describe("runtime — reach signals", () => {
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

describe("host-named anchor", () => {
  it("should honor a tail replacement anchor after a gesture settles", () => {
    const h = mount(range(0, 20), {
      itemHeight: (item) => (item.id === 19 ? 2000 : 100),
    });
    void h.list.scrollTo("m18", { align: "start", offset: 44 });
    h.userScroll(1740);

    h.list.setItems([...range(0, 19), message(30), message(31)], {
      anchor: { key: "m31", offset: 144 },
    });

    expect(h.viewport.scrollTop).toBe(1740);
    expect(h.list.positionOf("m31")).toBeNull();
    h.settle();
    expect(h.list.positionOf("m31")?.top).toBe(2000);
    expect(h.viewport.scrollTop).toBe(1856);
    expect(h.list.state.totalSize).toBe(2456);
  });

  it("should honor an explicit anchor on an unchanged snapshot after a gesture", () => {
    const initial = range(0, 20);
    const h = mount(initial);
    h.userScroll(1200);

    h.list.setItems(initial, { anchor: { key: "m19", offset: 44 } });

    expect(h.viewport.scrollTop).toBe(1200);
    h.settle();
    expect(h.viewport.scrollTop).toBe(1856);
    expect(h.list.state.totalSize).toBe(2456);
  });

  it("should atomically interrupt a gesture and preserve a shorter branch at its reading offset", () => {
    const h = mount(range(0, 23), {
      itemHeight: (item) => (item.id === 22 ? 2000 : 100),
    });
    void h.list.scrollTo("m21", { align: "start", offset: 44 });
    h.userScroll(1756);

    h.list.setItems([...range(0, 19), message(30), message(31)], {
      anchor: { key: "m30", offset: 144 },
      interrupt: true,
    });

    expect(h.viewport.scrollTop).toBe(1756);
    expect(h.list.positionOf("m30")?.top).toBe(1900);
    // The reading anchor is 144, but the new prompt can still scroll to 44.
    expect(h.list.state.totalSize).toBe(2456);
    h.userScroll(1856);
    h.settle();
    expect(h.viewport.scrollTop).toBe(1856);
  });

  it("should preserve a held anchor when its caller reuses the object", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(2000);
    const anchor = { key: "m23", offset: 30 };

    h.list.setItems([...range(-5, 0), ...initial], { anchor });
    anchor.key = "m40";
    anchor.offset = 900;
    h.list.updateItem("m30", message(30, "updated"));
    h.settle();

    expect(h.viewport.scrollTop).toBe(2770);
    expect(h.list.elementOf("m30")?.textContent).toBe("updated");
    h.list.dispose();
  });

  it.each(["setItems", "updateItem"] as const)(
    "should own an anchor before a reentrant %s is queued",
    (method) => {
      let current: Harness | null = null;
      let queued = false;
      const initial = range(0, 50);
      const queueUpdate = {
        setItems: (
          list: VirtualList<Msg>,
          anchor: { key: string; offset: number },
        ) => list.setItems(initial, { anchor }),
        updateItem: (
          list: VirtualList<Msg>,
          anchor: { key: string; offset: number },
        ) => list.updateItem("m20", message(20, "queued"), { anchor }),
      };
      const h = mount(initial, {
        onState: () => {
          if (!current || queued) return;
          queued = true;
          const anchor = { key: "m20", offset: 25 };
          queueUpdate[method](current.list, anchor);
          anchor.key = "m30";
          anchor.offset = 900;
        },
      });
      current = h;

      h.list.updateItem("m21", message(21, "trigger"));

      expect(queued).toBe(true);
      expect(h.viewport.scrollTop).toBe(1975);
      h.list.dispose();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "should reject an invalid anchor without replacing held work (%s)",
    (offset) => {
      const initial = range(0, 50);
      const h = mount(initial);
      h.userScroll(2000);
      h.list.setItems([...range(-5, 0), ...initial], { anchor: "viewport" });

      expect(() =>
        h.list.setItems([], { anchor: { key: "m20", offset } }),
      ).toThrow(new RangeError("anchor offset must be finite"));
      h.settle();

      expect(h.list.state.count).toBe(55);
      expect(h.viewport.scrollTop).toBe(2500);
      h.list.dispose();
    },
  );

  it("lands the named key at the named offset, and falls back when the key is gone", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    void h.list.scrollTo("m20");
    // A re-flow: every key changes; the host names where the old point went.
    const reflowed = initial.map((m) => ({ ...m, id: m.id + 1000 }));
    h.list.setItems(reflowed, { anchor: { key: "m1023", offset: -30 } });
    expect(h.viewport.scrollTop).toBe(23 * ROW_H + 30);
    // The named key does not exist: the captured viewport anchor applies.
    const before = h.viewport.scrollTop;
    h.list.setItems([...range(-5, 0), ...reflowed], {
      anchor: { key: "nope", offset: 0 },
    });
    expect(h.viewport.scrollTop).toBe(before + 5 * ROW_H);
  });
});

describe("mount hooks", () => {
  it.each(["measured", "declared", "positioned"] as const)(
    "should expose final placement to mount hooks for %s rows",
    (mode) => {
      const observed: { id: number; connected: boolean; placement: string }[] =
        [];
      const h = mount(range(0, 40), {
        boot: "start",
        overscanPx: 0,
        itemHeight: mode === "measured" ? undefined : () => ROW_H,
        position:
          mode === "positioned"
            ? (item) => ({ top: item.id * ROW_H, lane: 0 })
            : undefined,
        onMount: (element, item) => {
          observed.push({
            id: item.id,
            connected: element.isConnected,
            placement:
              mode === "positioned"
                ? element.style.translate
                : (element.parentElement as HTMLElement).style.transform,
          });
        },
      });
      try {
        for (const top of [0, 2000, 0]) {
          if (top !== 0 || observed.length === 0) h.userScroll(top);
          expect(observed.length).toBeGreaterThan(0);
          expect(observed).toEqual(
            observed.map(({ id }) => ({
              id,
              connected: true,
              placement:
                mode === "positioned"
                  ? `0 ${id * ROW_H}px`
                  : `translateY(${id * ROW_H}px)`,
            })),
          );
          observed.length = 0;
        }
      } finally {
        h.list.dispose();
      }
    },
  );

  it("cleans up a failed initial render", () => {
    const disconnect = vi.spyOn(
      ControlledResizeObserver.prototype,
      "disconnect",
    );
    const before = document.body.childElementCount;
    expect(() => mount(range(0, 3), { throwOn: "msg 1" })).toThrow(
      "render failed",
    );
    // Only the caller-owned viewport remains; the canvas and measurer are gone.
    expect(document.body.childElementCount).toBe(before + 1);
    expect(document.body.lastElementChild?.childElementCount).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(roInstances.every((record) => record.observed.size === 0)).toBe(
      true,
    );
    disconnect.mockRestore();
  });
  it("report each element entering and leaving the scroller, unmount before destroy", () => {
    const events: string[] = [];
    const h = mount(range(0, 50), {
      onMount: (_el, m) => events.push(`mount m${m.id}`),
      onUnmount: (_el, m) => events.push(`unmount m${m.id}`),
      onDestroy: (el) => events.push(`destroy ${el.textContent}`),
    });
    expect(events.filter((e) => e.startsWith("mount")).length).toBe(
      h.list.state.end - h.list.state.start,
    );
    // The boot lands at the end: a jump to the start unmounts the tail and
    // mounts the head.
    events.length = 0;
    void h.list.scrollTo("m5");
    expect(
      events.some((e) => e === "unmount m49"),
      events.join(","),
    ).toBe(true);
    expect(events.some((e) => e === "mount m5")).toBe(true);
    events.length = 0;
    h.list.setItems(range(0, 8)); // m8.. removed while mounted
    const unmountAt = events.indexOf("unmount m9");
    const destroyAt = events.indexOf("destroy msg 9");
    expect(unmountAt).toBeGreaterThanOrEqual(0);
    expect(destroyAt).toBeGreaterThan(unmountAt);
  });
});

describe("targeted item updates", () => {
  it.each([false, true])(
    "should index repeated accepted snapshots independently of held geometry (declared=%s)",
    (declared) => {
      const h = mount(range(0, 50), {
        itemHeight: declared ? () => ROW_H : undefined,
      });
      h.userScroll(3000);
      const reordered = [...range(-5, 0), ...range(0, 50).reverse()];
      h.list.setItems(reordered);
      h.list.setItems(
        reordered.map((item) => message(item.id, `new ${item.id}`)),
      );
      h.list.updateItem("m-3", message(-3, "pending edit"));
      h.list.updateItem("m32", message(32, "reordered edit"));

      expect(h.list.state.count).toBe(50);
      expect(h.list.state.held).toBe(true);
      h.settle();
      // Re-adopt the internally retained snapshot to expose a stale item
      // index, even if the targeted row itself initially rendered correctly.
      h.list.setEdgeSlot("start", null);

      expect(h.list.state.count).toBe(55);
      void h.list.scrollTo("m-3");
      expect(h.rowElement("pending edit").textContent).toBe("pending edit");
      void h.list.scrollTo("m32");
      expect(h.rowElement("reordered edit").textContent).toBe("reordered edit");
      expect(h.list.positionOf("m32")?.top).toBe(2200);
      h.list.dispose();
    },
  );

  it("should retain accepted input indexing after a rejected reordered snapshot", () => {
    const h = mount(range(0, 10), { throwOn: "invalid" });
    const accepted = range(0, 10).reverse();
    h.list.setItems(accepted);
    h.list.setItems(accepted.map((item) => message(item.id, `new ${item.id}`)));
    expect(() =>
      h.list.setItems([message(20, "invalid"), ...range(0, 10)]),
    ).toThrow("render failed: invalid");

    h.list.updateItem("m3", message(3, "accepted edit"));
    h.list.setEdgeSlot("start", null);

    expect(h.list.state.count).toBe(10);
    expect(h.list.positionOf("m3")?.top).toBe(600);
    expect(h.rowElement("accepted edit").textContent).toBe("accepted edit");
    h.list.dispose();
  });

  it("evaluates only the changed declaration while a large prepend is held", () => {
    const height = vi.fn(() => ROW_H);
    const initial = range(0, 10_000);
    const h = mount(initial, {
      boot: "start",
      itemHeight: height,
    });
    h.userScroll(3000);
    h.list.setItems([...range(-10, 0), ...initial], { anchor: "viewport" });
    height.mockClear();

    h.list.updateItem("m32", message(32, "first"));
    h.list.updateItem("m32", message(32, "latest"));
    h.list.updateItem("m-5", message(-5, "new pending row"));

    expect(height).toHaveBeenCalledTimes(3);
    expect(h.list.state.count).toBe(10_000);
    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.count).toBe(10_010);
    expect(h.viewport.scrollTop).toBe(4000);
    expect(h.rowElement("latest").textContent).toBe("latest");
    void h.list.scrollTo("m-5");
    expect(h.rowElement("new pending row").textContent).toBe("new pending row");
    h.list.dispose();
  });

  it.each([false, true])(
    "preserves untouched pending rows when an update fails (replacement=%s)",
    (replaceOnRerender) => {
      const initial = range(0, 50);
      const h = mount(initial, {
        replaceOnRerender,
        throwOn: "invalid",
      });
      h.userScroll(3000);
      h.list.setItems([...range(-5, 0), ...initial], { anchor: "viewport" });
      h.list.updateItem("m-3", message(-3, "first"));

      expect(() => h.list.updateItem("m-3", message(-3, "invalid"))).toThrow(
        "render failed: invalid",
      );
      h.list.updateItem("m-3", message(-3, "latest"));
      h.settle();

      expect(h.list.state.count).toBe(55);
      expect(h.viewport.scrollTop).toBe(3500);
      void h.list.scrollTo("m-3");
      expect(h.rowElement("latest").textContent).toBe("latest");
      expect(h.rowElement("msg -4").textContent).toBe("msg -4");
      h.list.dispose();
      expect(new Set(h.destroyedElements).size).toBe(
        h.destroyedElements.length,
      );
    },
  );

  it("evaluates only the changed declared item and preserves the latest snapshot", () => {
    const height = vi.fn(() => ROW_H);
    const h = mount(range(0, 10_000), { boot: "start", itemHeight: height });
    height.mockClear();
    h.list.updateItem("m5000", message(5000, "changed"));
    expect(height).toHaveBeenCalledTimes(1);
    expect(h.list.elementOf("m5000")).toBeNull();
    h.list.setEdgeSlot("start", null);
    void h.list.scrollTo("m5000");
    expect(h.rowElement("changed").textContent).toBe("changed");
    h.list.dispose();
  });

  it.each([false, true] as const)(
    "merges multiple updates with a held prepend (declared=%s)",
    (declared) => {
      const initial = range(0, 50);
      const h = mount(initial, {
        itemHeight: declared ? () => ROW_H : undefined,
      });
      h.userScroll(3000);
      h.list.setItems([...range(-5, 0), ...initial], { anchor: "viewport" });
      h.list.updateItem("m32", message(32, "first"));
      h.list.updateItem("m33", message(33, "second"));
      h.settle();
      expect(h.list.state.count).toBe(55);
      expect(h.viewport.scrollTop).toBe(3500);
      expect(h.rowElement("first").textContent).toBe("first");
      expect(h.rowElement("second").textContent).toBe("second");
      h.list.dispose();
    },
  );

  it("allows an explicit anchor to override the held snapshot", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3000);
    h.list.setItems([...range(-5, 0), ...initial], { anchor: "viewport" });

    h.list.updateItem("m32", message(32, "changed"), { anchor: "end" });
    h.settle();

    expect(h.list.state.count).toBe(55);
    expect(h.viewport.scrollTop).toBe(4900);
    h.list.dispose();
  });

  it("supersedes a patched snapshot without resurrecting its removed rows", () => {
    const initial = range(0, 50);
    const h = mount(initial);
    h.userScroll(3000);
    h.list.setItems([...range(-5, 0), ...initial]);
    h.list.updateItem("m-3", message(-3, "discarded"));

    h.list.setItems(initial);
    h.list.updateItem("m-3", message(-3, "must stay removed"));
    h.list.updateItem("m32", message(32, "kept"));
    h.settle();

    expect(h.list.state.count).toBe(50);
    expect(h.list.positionOf("m-3")).toBeNull();
    expect(h.rowElement("kept").textContent).toBe("kept");
    h.list.dispose();
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it("ignores unknown keys and rejects identity changes", () => {
    const h = mount(range(0, 10));
    h.list.updateItem("missing", message(20));
    expect(() => h.list.updateItem("m5", message(6))).toThrow(/cannot change/);
    expect(h.list.state.count).toBe(10);
    h.list.dispose();
  });

  it("preserves the viewport for a measured update above it", () => {
    const h = mount(range(0, 50));
    void h.list.scrollTo("m20");
    h.heights.set(3, 200);
    h.list.updateItem("m3", message(3, "tall"), { anchor: "viewport" });
    expect(h.viewport.scrollTop).toBe(2100);
    expect(h.list.positionOf("m3")?.height).toBe(200);
    h.list.dispose();
  });
});

describe("declared heights", () => {
  it("keeps mounted slots synchronized when declarations change without new item identities", () => {
    let height = ROW_H;
    const initial = range(0, 20);
    const h = mount(initial, { boot: "start", itemHeight: () => height });
    const row = h.rowElement("msg 0");
    height = 150;
    h.list.setItems(initial);
    expect(h.list.positionOf("m0")?.height).toBe(150);
    expect(h.slotOf(row).style.height).toBe("150px");
    h.list.dispose();
  });
  it("renders only the window and releases declared DOM outside it", () => {
    const renders: number[] = [];
    const h = mount(range(0, 10_000), {
      boot: "start",
      itemHeight: () => ROW_H,
      onRender: (m) => renders.push(m.id),
    });
    expect(renders.length).toBe(h.list.state.end - h.list.state.start);
    expect(renders.length).toBeLessThan(20);
    expect(h.list.positionOf("m9999")).toEqual({ top: 999900, height: ROW_H });
    const first = h.rowElement("msg 0");
    void h.list.scrollTo("m5000");
    expect(h.destroyedElements).toContain(first);
    expect(h.list.elementOf("m0")).toBeNull();
    void h.list.scrollTo("start");
    expect(h.rowElement("msg 0")).not.toBe(first);
    h.list.dispose();
    expect(new Set(h.destroyedElements).size).toBe(h.destroyedElements.length);
  });

  it.each([NaN, Infinity, 0, -1])(
    "rejects declared height %s before rendering",
    (height) => {
      const render = vi.fn();
      expect(() =>
        mount(range(0, 3), { itemHeight: () => height, onRender: render }),
      ).toThrow(/height must be finite/);
      expect(render).not.toHaveBeenCalled();
    },
  );

  it("preserves geometry and data after an invalid declared update", () => {
    const initial = range(0, 30);
    const h = mount(initial, {
      itemHeight: (m) => (m.body === "invalid" ? NaN : ROW_H),
    });
    expect(() => h.list.updateItem("m29", message(29, "invalid"))).toThrow(
      /height must be finite/,
    );
    expect(h.list.positionOf("m29")?.height).toBe(ROW_H);
    expect(h.rowElement("msg 29").textContent).toBe("msg 29");
    h.list.setEdgeSlot("start", null);
    expect(h.list.positionOf("m29")?.height).toBe(ROW_H);
    h.list.dispose();
  });

  it("commits a held update after its declared row leaves the window", () => {
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: (m) => (m.body === "tall" ? 200 : ROW_H),
    });
    h.userScroll(200);
    h.list.updateItem("m5", message(5, "tall"));
    h.userScroll(5000);
    h.settle();
    expect(h.list.positionOf("m5")?.height).toBe(200);
    void h.list.scrollTo("m5");
    expect(h.rowElement("tall").textContent).toBe("tall");
    h.list.dispose();
  });
});

describe("boot position", () => {
  it("boots at the end by default and at the start on request, mounting only that window", () => {
    const atEnd = mount(range(0, 50));
    expect(atEnd.viewport.scrollTop).toBe(50 * ROW_H - VIEWPORT_H);
    expect(atEnd.list.state.atEnd).toBe(true);

    const mounts: number[] = [];
    const atStart = mount(range(0, 50), {
      boot: "start",
      onMount: (_el, m) => mounts.push(m.id),
    });
    expect(atStart.viewport.scrollTop).toBe(0);
    expect(atStart.list.state.atStart).toBe(true);
    expect(atStart.list.state.start).toBe(0);
    expect(Math.max(...mounts)).toBeLessThan(20);
  });
});

describe("viewport width change", () => {
  it("should preserve end-follow intent when a width change interrupts its glide", () => {
    let width = 300;
    const h = mount(range(0, 50), {
      followBehavior: "smooth",
      width: () => width,
    });
    const row = h.rowElement("msg 49");
    h.heights.set(49, 700);
    fireResize(0, row, 700);
    vi.advanceTimersByTime(48);
    expect(h.viewport.scrollTop).toBeLessThan(5000);
    const published = h.states.length;

    width = 500;
    fireResize(1, h.viewport, VIEWPORT_H);
    vi.advanceTimersByTime(2000);
    h.settle();

    expect(
      h.states.slice(published).map((state) => state.following),
    ).not.toContain(false);
    expect(h.list.state.following).toBe(true);
    expect(h.list.state.atEnd).toBe(true);
    expect(h.viewport.scrollTop).toBe(5000);
    h.list.dispose();
  });

  it("should cancel a command glide before committing resized geometry", async () => {
    const initial = range(0, 50);
    let width = 300;
    const h = mount(initial, { boot: "start", width: () => width });
    const landed = h.list.scrollTo("end", { behavior: "smooth" });
    vi.advanceTimersByTime(48);
    expect(h.viewport.scrollTop).toBeGreaterThan(0);
    expect(h.viewport.scrollTop).toBeLessThan(4400);
    h.list.setItems([...range(-10, 0), ...initial]);
    expect(h.list.state.held).toBe(true);

    width = 500;
    fireResize(1, h.viewport, VIEWPORT_H);
    const resizedTop = h.viewport.scrollTop;
    vi.advanceTimersByTime(2000);
    h.settle();

    expect(h.viewport.scrollTop).toBe(resizedTop);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(60);
    await expect(landed).resolves.toBe(false);
    h.list.dispose();
  });

  it("ends a scroll phase in flight: held work commits at once, at the new width", () => {
    const initial = range(0, 50);
    let width = 300;
    const h = mount(initial, { width: () => width });
    void h.list.scrollTo("m20");
    h.userScroll(2000);
    h.userScroll(2200);
    // A structural change lands mid-gesture: held.
    h.list.setItems([...range(-10, 0), ...initial]);
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(50);
    // The rotation: the width changes while the gesture is still going.
    width = 500;
    fireResize(1, h.viewport, VIEWPORT_H);
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(60);
    // The reading position survived the commit.
    expect(h.viewport.scrollTop).toBe(2200 + 10 * ROW_H);
  });
});
