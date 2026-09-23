/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  createVirtualList,
  type VirtualListOptions,
} from "../../src/virtual-list";
import {
  flowHeight,
  type Msg,
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
const mount = (items: Msg[], options: Partial<VirtualListOptions<Msg>> = {}) =>
  mountList(items, { anchoring: "native", ...options });

/** Mounted rows in DOM order, by id. */
function flowIds(canvas: HTMLElement): number[] {
  return [...canvas.children]
    .filter((child) => (child as HTMLElement).style.position === "relative")
    .map((slot) => Number(slot.firstElementChild?.textContent?.slice(4)));
}

describe("native anchoring surface", () => {
  it("lays rows out in flow between spacers that reproduce committed geometry", () => {
    const h = mount(range(0, 50), { boot: "start" });
    expect(h.canvas.dataset.anchoring).toBe("native");
    expect(h.canvas.style.overflowAnchor).toBe("");
    expect(h.viewport.style.overflowAnchor).toBe("auto");
    const children = [...h.canvas.children] as HTMLElement[];
    const top = children[0] as HTMLElement;
    const bottom = children.at(-1) as HTMLElement;
    expect(top.style.overflowAnchor).toBe("none");
    expect(bottom.style.overflowAnchor).toBe("none");

    h.userScroll(2000);
    const ids = flowIds(h.canvas);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(Number.parseFloat(top.style.height)).toBe(
      h.list.positionOf(`m${ids[0]}`)?.top,
    );
    expect(flowHeight(h.canvas)).toBe(h.list.state.totalSize);
    for (const slot of h.canvas.querySelectorAll<HTMLElement>(
      ":scope > [style*='relative']",
    )) {
      expect(slot.style.transform).toBe("");
      expect(slot.style.height).toBe(`${ROW_H}px`);
    }
    h.list.dispose();
  });

  it("lands a prepend mid-gesture without writing the scroll position", () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(1000);
    const writes = h.writes.length;
    h.list.setItems([{ id: -1 }, ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(false);
    expect(h.list.state.count).toBe(51);
    // The engine moves the viewport; the runtime never writes mid-gesture.
    expect(h.writes.length).toBe(writes);
    expect(h.list.positionOf("m0")?.top).toBe(ROW_H);
    expect(flowHeight(h.canvas)).toBe(h.list.state.totalSize);
    h.list.dispose();
  });

  it("holds a prepend at the top edge until the settle, then writes", () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(500);
    h.userScroll(1); // A gesture at the edge: a bounce may be running.
    h.list.setItems([{ id: -1 }, ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(50);
    h.settle();
    expect(h.list.state.count).toBe(51);
    expect(h.viewport.scrollTop).toBe(101);
    h.list.dispose();
  });

  it("holds a prepend during a glide until it lands", async () => {
    const items = range(0, 50);
    const h = mount(items, { boot: "start" });
    h.userScroll(2000);
    h.settle();
    void h.list.scrollTo("start", { behavior: "smooth" });
    await Promise.resolve();
    // Away from the edges, but a glide heads for the committed start.
    h.list.setItems([{ id: -1 }, ...items], { anchor: "viewport" });
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(50);
    h.list.dispose();
  });

  it("keeps runtime anchoring for positioned layouts", () => {
    const h = mount(range(0, 20), {
      boot: "start",
      height: () => ROW_H,
      position: (m) => ({ top: m.id * ROW_H, lane: 0 }),
    });
    expect(h.canvas.dataset.anchoring).toBe("runtime");
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
