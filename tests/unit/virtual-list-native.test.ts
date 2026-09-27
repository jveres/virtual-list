/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createVirtualList } from "../../src/virtual-list";
import {
  flowHeight,
  type MountHooks,
  type Msg,
  message,
  mount as mountList,
  ROW_H,
  range,
  useHarness,
} from "../helpers/list-harness";

// F5: native CSS scroll anchoring. jsdom lays nothing out and never anchors,
// so these tests pin the structure (rows in flow between spacers whose
// heights reproduce committed geometry) and the commit rule (no scroll write
// mid-gesture away from the edges). Browsers verify the anchoring itself.

useHarness();

/** A list in native anchoring. */
const mount = (items: Msg[], hooks: MountHooks = {}) =>
  mountList(items, { anchoring: "native", ...hooks });

/** Mounted rows in DOM order, by id. */
function flowIds(canvas: HTMLElement): number[] {
  return [...canvas.children]
    .filter((child) => (child as HTMLElement).style.position === "relative")
    .map((slot) => Number(slot.firstElementChild?.textContent?.slice(4)));
}

describe("native anchoring surface", () => {
  it.each([true, false])(
    "preserves bounded flow-row layers across recycling (WebKit: %s)",
    (webkit) => {
      vi.stubGlobal("CSS", {
        supports: (property: string) =>
          property === "overflow-anchor" ||
          (webkit && property === "-webkit-nbsp-mode"),
      });
      const h = mount(range(0, 80), { boot: "start" });
      try {
        const first = h.list.elementOf("m0");
        for (const top of [0, 3000, 0]) {
          h.userScroll(top);
          const slots = Array.from(h.canvas().children) as HTMLElement[];
          const rows = slots.filter(
            (slot) => slot.style.position === "relative",
          );
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.length).toBeLessThan(80);
          for (const slot of rows) {
            expect(slot.style.willChange).toBe(webkit ? "transform" : "");
            expect(slot.style.transform).toBe("");
          }
          expect(slots[0]?.style.willChange).toBe("");
          expect(slots.at(-1)?.style.willChange).toBe("");
          expect(flowHeight(h.canvas())).toBe(h.list.state.totalSize);
          expect(first?.isConnected).toBe(top === 0);
        }
        expect(h.list.elementOf("m0")).toBe(first);
      } finally {
        h.list.dispose();
      }
    },
  );

  it("restores the flow before follow reads layout after replacing the tail", () => {
    let checking = false;
    const h = mount(range(0, 50), {
      followBehavior: "smooth",
      replaceOnRerender: true,
      height: () => {
        if (checking)
          expect(flowHeight(h.canvas())).toBeGreaterThanOrEqual(5000);
        return 600;
      },
    });
    try {
      h.heights.set(49, 1500);
      checking = true;
      h.list.updateItem("m49", message(49, "streaming reply"));
      expect(flowHeight(h.canvas())).toBe(6400);
    } finally {
      checking = false;
      h.list.dispose();
    }
  });

  it("lays rows out in flow between spacers that reproduce committed geometry", () => {
    const h = mount(range(0, 50), { boot: "start" });
    expect(h.canvas().dataset.anchoring).toBe("native");
    expect(h.canvas().style.overflowAnchor).toBe("");
    expect(h.viewport.style.overflowAnchor).toBe("auto");
    const children = [...h.canvas().children] as HTMLElement[];
    const top = children[0] as HTMLElement;
    const bottom = children.at(-1) as HTMLElement;
    expect(top.style.overflowAnchor).toBe("none");
    expect(bottom.style.overflowAnchor).toBe("none");

    h.userScroll(2000);
    const ids = flowIds(h.canvas());
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(Number.parseFloat(top.style.height)).toBe(
      h.list.positionOf(`m${ids[0]}`)?.top,
    );
    expect(flowHeight(h.canvas())).toBe(h.list.state.totalSize);
    for (const slot of h
      .canvas()
      .querySelectorAll<HTMLElement>(":scope > [style*='relative']")) {
      expect(slot.style.transform).toBe("");
      expect(slot.style.height).toBe(`${ROW_H}px`);
    }
    h.list.dispose();
  });

  it("lands a prepend mid-gesture without writing the scroll position", () => {
    const items = range(0, 50);
    const writes: number[] = [];
    const h = mount(items, {
      boot: "start",
      onScrollWrite: (top) => writes.push(top),
    });
    h.userScroll(1000);
    const before = writes.length;
    h.list.setItems([message(-1), ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(51);
    // The engine moves the viewport; the runtime never writes mid-gesture.
    expect(writes.length).toBe(before);
    expect(h.list.positionOf("m0")?.top).toBe(ROW_H);
    expect(flowHeight(h.canvas())).toBe(h.list.state.totalSize);
    h.list.dispose();
  });

  it("holds a prepend at the top edge until the settle, then writes", () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(500);
    h.userScroll(1); // A gesture at the edge: a bounce may be running.
    h.list.setItems([message(-1), ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(50);
    h.settle();
    expect(h.list.state.count).toBe(51);
    expect(h.viewport.scrollTop).toBe(101);
    h.list.dispose();
  });

  it.each(["setItems", "updateWindow"] as const)(
    "preserves a near-top reading position after WebKit touch momentum using %s",
    async (method) => {
      const items = range(24, 50);
      const h = mount(items, { boot: "end", settleStrategy: "safari-wheel" });
      try {
        h.viewport.dispatchEvent(new Event("touchstart"));
        h.userScroll(30);
        const next = [...range(0, 24), ...items];
        const update =
          method === "updateWindow"
            ? h.list.updateWindow(() => ({ items: next, anchor: "viewport" }))
            : h.list.setItems(next, { anchor: "viewport" });
        vi.advanceTimersByTime(400);
        expect(h.list.state.count).toBe(items.length);
        expect(h.viewport.scrollTop).toBe(30);

        const release = new Event("touchend");
        Object.defineProperty(release, "touches", { value: [] });
        h.viewport.dispatchEvent(release);
        // A lifted finger is not a settled gesture: momentum still owns it.
        for (const top of [28, 26, 24, 22, 20]) {
          h.userScroll(top);
          vi.advanceTimersByTime(50);
          expect(h.list.state.count).toBe(items.length);
        }
        h.viewport.dispatchEvent(new Event("scrollend"));
        await vi.advanceTimersByTimeAsync(800);
        if (method === "updateWindow") await expect(update).resolves.toBe(true);
        expect(h.list.state.count).toBe(next.length);
        expect(h.viewport.scrollTop).toBe(24 * ROW_H + 20);
        expect(h.list.positionOf("m24")?.top).toBe(24 * ROW_H);
      } finally {
        h.list.dispose();
      }
    },
  );

  it("holds a prepend during a glide until it lands", async () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(2000);
    h.settle();
    void h.list.scrollTo("start", { behavior: "smooth" });
    await Promise.resolve();
    // Away from the edges, but a glide heads for the committed start.
    h.list.setItems([message(-1), ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(50);
    h.list.dispose();
  });

  it("keeps runtime anchoring for positioned layouts", () => {
    const h = mount(range(0, 20), {
      boot: "start",
      itemHeight: () => ROW_H,
      position: (m) => ({ top: m.id * ROW_H, lane: 0 }),
    });
    expect(h.canvas().dataset.anchoring).toBe("runtime");
    expect(h.viewport.style.overflowAnchor).toBe("");
    h.list.dispose();
  });

  it("keeps runtime anchoring where the host turned native anchoring off", () => {
    const viewport = document.createElement("div");
    viewport.style.overflowAnchor = "none";
    document.body.appendChild(viewport);
    const list = createVirtualList<Msg>(viewport, {
      items: range(0, 5),
      key: (m) => `m${m.id}`,
      anchoring: "auto",
      render: () => document.createElement("div"),
    });
    const canvas = viewport.firstElementChild as HTMLElement;
    expect(canvas.dataset.anchoring).toBe("runtime");
    expect(viewport.style.overflowAnchor).toBe("none");
    list.dispose();
  });

  it("restores the scroller's own overflow-anchor on dispose", () => {
    const viewport = document.createElement("div");
    viewport.style.overflowAnchor = "none";
    document.body.appendChild(viewport);
    const list = createVirtualList<Msg>(viewport, {
      items: range(0, 5),
      key: (m) => `m${m.id}`,
      anchoring: "native",
      render: () => document.createElement("div"),
    });
    expect(viewport.style.overflowAnchor).toBe("auto");
    list.dispose();
    expect(viewport.style.overflowAnchor).toBe("none");
  });
});
