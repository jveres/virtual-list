/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVirtualList,
  type VirtualList,
  type VirtualListOptions,
  type VirtualListState,
} from "../src/virtual-list";

// What virtual-list-next adds on top of the shared contract suite: rows are
// measured where they mount, the desired state lands under one commit rule,
// and host calls made from callbacks queue behind the pass. jsdom has no
// layout: heights come from a per-row getBoundingClientRect stub.

interface Msg {
  id: number;
  body: string;
}

const VIEWPORT_H = 600;
const ROW_H = 100;

const message = (id: number, body = `msg ${id}`): Msg => ({ id, body });
const range = (from: number, to: number): Msg[] =>
  Array.from({ length: to - from }, (_, i) => message(from + i));

class ControlledResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface Harness {
  list: VirtualList<Msg>;
  viewport: HTMLElement;
  canvas: HTMLElement;
  heights: Map<number, number>;
  states: VirtualListState[];
  element: (id: number) => HTMLElement | undefined;
  userScroll: (top: number) => void;
  settle: () => void;
}

function mount(
  items: Msg[],
  options: Partial<VirtualListOptions<Msg>> = {},
): Harness {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const canvasHeight = (): number =>
    Number.parseFloat(
      (viewport.firstElementChild as HTMLElement | null)?.style.height ?? "",
    ) || 0;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_H },
    clientWidth: { get: () => 300 },
    scrollHeight: { get: () => Math.max(VIEWPORT_H, canvasHeight()) },
    scrollTop: {
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.max(
          0,
          Math.min(Math.max(0, canvasHeight() - VIEWPORT_H), next),
        );
      },
    },
  });
  document.body.appendChild(viewport);
  const heights = new Map<number, number>();
  const states: VirtualListState[] = [];
  const elements = new Map<number, HTMLElement>();
  const list = createVirtualList<Msg>(viewport, {
    items,
    key: (m) => `m${m.id}`,
    settleStrategy: "default",
    anchoring: "runtime",
    render: (m, existing) => {
      const element = existing ?? document.createElement("div");
      element.textContent = m.body;
      element.getBoundingClientRect = () =>
        ({ height: heights.get(m.id) ?? ROW_H }) as DOMRect;
      elements.set(m.id, element);
      return element;
    },
    onState: (state) => states.push(state),
    ...options,
  });
  return {
    list,
    viewport,
    canvas: viewport.firstElementChild as HTMLElement,
    heights,
    states,
    element: (id) => elements.get(id),
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
  (globalThis as { ResizeObserver: unknown }).ResizeObserver =
    ControlledResizeObserver;
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("rows measured where they mount", () => {
  it("adds no measurement root outside the scroller", () => {
    const before = document.body.childElementCount;
    const h = mount(range(0, 20));
    expect(document.body.childElementCount).toBe(before + 1);
    h.list.dispose();
  });

  it("stages a held row hidden in the canvas and reveals the same slot", () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(1000); // A gesture: the prepend waits for the settle.
    h.heights.set(-1, 140);
    h.list.setItems([message(-1), ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);

    const row = h.element(-1) as HTMLElement;
    const slot = row.parentElement as HTMLElement;
    expect(slot.parentElement).toBe(h.canvas);
    expect(slot.inert).toBe(true);
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.style.visibility).toBe("hidden");
    expect(slot.style.maxHeight).toBe("0px");
    expect(slot.style.top).toBe("-100000px"); // Never under the viewport.
    expect(slot.style.transform).toBe("");

    h.settle();
    expect(h.list.state.held).toBe(false);
    expect(h.viewport.scrollTop).toBe(1140);
    void h.list.scrollTo("m-1");
    expect(h.list.elementOf("m-1")).toBe(row);
    // Revealed in place: the same slot, never re-parented.
    expect(row.parentElement).toBe(slot);
    expect(slot.inert).toBe(false);
    expect(slot.hasAttribute("aria-hidden")).toBe(false);
    expect(slot.style.height).toBe("140px");
    expect(slot.style.top).toBe("0px");
    expect(slot.style.transform).toBe("translateY(0px)");
    h.list.dispose();
  });

  it("keeps a lone offscreen update laid out, then detaches it once another takes its place", () => {
    const h = mount(range(0, 50), { boot: "start" });
    expect(h.list.elementOf("m45")).toBeNull(); // Offscreen: boot at the start.
    h.list.updateItem("m45", message(45, "offscreen token 1"));
    const row = h.element(45) as HTMLElement;
    const slot = row.parentElement as HTMLElement;
    expect(slot.parentElement).toBe(h.canvas);
    h.list.updateItem("m45", message(45, "offscreen token 2"));
    expect(row.parentElement).toBe(slot);
    expect(slot.parentElement).toBe(h.canvas);

    h.list.updateItem("m30", message(30, "another offscreen row"));
    expect(slot.parentElement).toBeNull();
    expect(h.element(30)?.parentElement?.parentElement).toBe(h.canvas);
    h.list.dispose();
  });

  it("detaches staged rows the committed window does not reveal", () => {
    const h = mount(range(0, 10), { boot: "start" });
    h.list.setItems(range(0, 60), { anchor: "viewport" });
    const hidden = [...h.canvas.children].filter(
      (slot) => (slot as HTMLElement).style.visibility === "hidden",
    );
    expect(hidden).toHaveLength(0);
    expect(h.canvas.childElementCount).toBe(h.list.state.end);
    h.list.dispose();
  });
});

describe("DOM order", () => {
  it("keeps mounted slots in list order in both scroll directions", () => {
    const h = mount(range(0, 60), { boot: "start" });
    const order = (): number[] =>
      [...h.canvas.children].map((slot) =>
        Number((slot.firstElementChild as HTMLElement).textContent?.slice(4)),
      );
    for (const top of [2000, 1200, 400, 3000, 0]) {
      h.userScroll(top);
      const ids = order();
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
    h.list.dispose();
  });
});

describe("one commit rule", () => {
  it("lands an append below the anchor mid-gesture and holds a prepend", () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(1000);
    const appended = [...items, message(50)];
    h.list.setItems(appended, { anchor: "viewport" });
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(51);
    expect(h.viewport.scrollTop).toBe(1000);

    h.list.setItems([message(-1), ...appended], { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(51);
    h.settle();
    expect(h.list.state.count).toBe(52);
    expect(h.viewport.scrollTop).toBe(1100);
    h.list.dispose();
  });

  it("ignores the removed update modes", () => {
    const items = range(0, 50);
    const h = mount(items, {
      boot: "start",
      ...({ scrollingUpdates: "freeze" } as object),
    });
    h.userScroll(1000);
    h.list.setItems([...items, message(50)]);
    expect(h.list.state.count).toBe(51);
    h.list.dispose();
  });
});

describe("the pass", () => {
  it("queues a host call made from onState behind the commit", () => {
    const order: string[] = [];
    let list: VirtualList<Msg> | null = null;
    const h = mount(range(0, 10), {
      boot: "start",
      onState: (state) => {
        order.push(`state ${state.count}`);
        if (state.count === 11 && list) {
          list.setItems(range(0, 12));
          order.push("queued");
        }
      },
    });
    list = h.list;
    h.list.setItems(range(0, 11));
    expect(order.slice(-3)).toEqual(["state 11", "queued", "state 12"]);
    h.list.dispose();
  });

  it("surfaces a host callback failure after the commit completes", () => {
    const h = mount(range(0, 10), {
      boot: "start",
      onMount: (_, m) => {
        if (m.id === 10) throw new Error("mount hook failed");
      },
    });
    expect(() => h.list.setItems(range(0, 11))).toThrow("mount hook failed");
    expect(h.list.state.count).toBe(11);
    expect(h.list.positionOf("m10")).toEqual({ top: 1000, height: 100 });
    h.list.dispose();
  });
});
