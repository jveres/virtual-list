/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createPagedWindow, type Page } from "../../src/paging";
import type { VirtualList } from "../../src/virtual-list";
import {
  type Msg,
  message,
  mount,
  range,
  useHarness,
} from "../helpers/list-harness";

// Beyond the contract suite: rows are measured where they mount, the
// desired state lands under one commit rule, and host calls made from
// callbacks queue behind the pass.

useHarness();

describe("window jobs", () => {
  it("lands a page mid-stream, adopting the rows it staged", async () => {
    const page = (start: number): Page<Msg, number> => ({
      items: range(start, start + 20),
      start:
        start > 0
          ? { available: true, cursor: start - 20 }
          : { available: false },
      end: { available: true, cursor: start + 20 },
    });
    const renders = new Map<number, number>();
    const initial = page(0);
    const h = mount([...initial.items], {
      boot: "start",
      onRender: (m) => renders.set(m.id, (renders.get(m.id) ?? 0) + 1),
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
    let landed = false;
    const load = paging.load("end").then((applied) => {
      landed = applied;
      return applied;
    });
    // A token every frame: each changes the source the page was built on.
    for (let token = 1; token <= 20 && !landed; token++) {
      await paging.updateItemLive("m19", (m) => ({
        ...m,
        body: `token ${token}`,
      }));
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(landed).toBe(true); // Mid-stream, not after it.
    await expect(load).resolves.toBe(true);
    expect(h.list.state.count).toBe(40);
    // Asked again at the commit, the updater's rows were adopted, never re-rendered.
    for (let id = 20; id < 40; id++) expect(renders.get(id)).toBe(1);
    paging.dispose();
    h.list.dispose();
  });
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

    const row = h.rowElement("msg -1");
    const slot = h.slotOf(row);
    expect(slot.parentElement).toBe(h.canvas());
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
    const row = h.rowElement("offscreen token 1");
    const slot = h.slotOf(row);
    expect(slot.parentElement).toBe(h.canvas());
    h.list.updateItem("m45", message(45, "offscreen token 2"));
    expect(row.parentElement).toBe(slot);
    expect(slot.parentElement).toBe(h.canvas());

    h.list.updateItem("m30", message(30, "another offscreen row"));
    expect(slot.parentElement).toBeNull();
    expect(h.slotOf(h.rowElement("another offscreen row")).parentElement).toBe(
      h.canvas(),
    );
    h.list.dispose();
  });

  it("detaches staged rows the committed window does not reveal", () => {
    const h = mount(range(0, 10), { boot: "start" });
    h.list.setItems(range(0, 60), { anchor: "viewport" });
    const hidden = [...h.canvas().children].filter(
      (slot) => (slot as HTMLElement).style.visibility === "hidden",
    );
    expect(hidden).toHaveLength(0);
    expect(h.canvas().childElementCount).toBe(h.list.state.end);
    h.list.dispose();
  });
});

describe("DOM order", () => {
  it("keeps mounted slots in list order in both scroll directions", () => {
    const h = mount(range(0, 60), { boot: "start" });
    const order = (): number[] =>
      [...h.canvas().children].map((slot) =>
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
