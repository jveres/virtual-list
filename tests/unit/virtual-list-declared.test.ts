/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createVirtualList } from "../../src/virtual-list";
import {
  type Harness,
  type Msg,
  message,
  mount,
  ROW_H,
  range,
  useHarness,
} from "../helpers/list-harness";

// Targeted updates of declared-height rows under jsdom. updateItem carries
// the touched keys only, and the commit writes them into the committed
// entries: its work must not depend on the list size, and a failure must
// leave the committed and the held state as they were.

useHarness();

const TALL = 200;
const heightOf = (m: Msg): number => (m.body.startsWith("tall") ? TALL : ROW_H);

/** Map reads, writes and iteration steps made while `run` executes. */
function mapWork(run: () => void): number {
  const stepper = Object.getPrototypeOf(new Map().entries()) as {
    next: () => IteratorResult<unknown>;
  };
  const { get, set } = Map.prototype;
  const { next } = stepper;
  let work = 0;
  Map.prototype.get = function (key) {
    work += 1;
    return get.call(this, key);
  };
  Map.prototype.set = function (key, value) {
    work += 1;
    return set.call(this, key, value);
  };
  stepper.next = function () {
    work += 1;
    return next.call(this);
  };
  try {
    run();
  } finally {
    Map.prototype.get = get;
    Map.prototype.set = set;
    stepper.next = next;
  }
  return work;
}

describe("targeted declared updates", () => {
  it.each(
    ["idle", "mid-phase"].flatMap((phase) =>
      ["a mounted", "an unmounted"].flatMap((row) =>
        ["changed", "tall"].map((body) => ({ phase, row, body })),
      ),
    ),
  )(
    "does the same work at any list size, $phase, for $row row ($body)",
    ({ phase, row, body }) => {
      const work = [100, 10_000].map((count) => {
        const height = vi.fn(heightOf);
        const onKey = vi.fn();
        const h = mount(range(0, count), {
          boot: "start",
          itemHeight: height,
          onKey,
        });
        // Mid-phase, at or below the anchor row: it lands at once.
        if (phase === "mid-phase") h.userScroll(3000);
        const mounted = phase === "mid-phase" ? 33 : 3;
        const id = row === "a mounted" ? mounted : count - 1;
        const update = (next: string): void =>
          h.list.updateItem(`m${id}`, message(id, next));
        // The same update first: jsdom caches the style values it parses.
        update(body);
        update("warm");
        height.mockClear();
        onKey.mockClear();

        const maps = mapWork(() => update(body));

        expect(height).toHaveBeenCalledTimes(1);
        expect(onKey).toHaveBeenCalledTimes(1);
        expect(h.list.state.held).toBe(false);
        const updated = heightOf(message(id, body));
        expect(h.list.positionOf(`m${id}`)?.height).toBe(updated);
        expect(h.list.state.totalSize).toBe((count - 1) * ROW_H + updated);
        h.list.dispose();
        return maps;
      });
      expect(work[1]).toBe(work[0]);
    },
  );

  it.each([
    { held: "held updates", prepend: false },
    { held: "a held prepend", prepend: true },
  ])("does the same work at any list size behind $held", ({ prepend }) => {
    const work = [100, 10_000].map((count) => {
      const height = vi.fn(heightOf);
      const initial = range(0, count);
      const h = mount(initial, { boot: "start", itemHeight: height });
      h.userScroll(3000);
      if (prepend)
        h.list.setItems([...range(-10, 0), ...initial], {
          anchor: "viewport",
        });
      h.list.updateItem("m2", message(2, "tall"));
      expect(h.list.state.held).toBe(true);
      height.mockClear();

      const maps = mapWork(() => h.list.updateItem("m4", message(4, "tall")));

      expect(height).toHaveBeenCalledTimes(1);
      expect(h.list.state.held).toBe(true);
      expect(h.list.state.totalSize).toBe(count * ROW_H);
      h.settle();
      expect(h.list.state.totalSize).toBe(
        (count + (prepend ? 10 : 0)) * ROW_H + 200,
      );
      expect(h.viewport.scrollTop).toBe(3200 + (prepend ? 1000 : 0));
      h.list.dispose();
      return maps;
    });
    expect(work[1]).toBe(work[0]);
  });

  it("commits a height change of a mounted row in place", () => {
    const h = mount(range(0, 100), { boot: "start", itemHeight: heightOf });
    const row = h.rowElement("msg 3");

    h.list.updateItem("m3", message(3, "tall"));

    expect(h.rowElement("tall")).toBe(row);
    expect(h.slotOf(row).style.height).toBe(`${TALL}px`);
    expect(h.list.positionOf("m3")).toEqual({ top: 300, height: TALL });
    expect(h.list.positionOf("m4")?.top).toBe(500);
    expect(h.slotOf(h.rowElement("msg 4")).style.transform).toBe(
      "translateY(500px)",
    );
    expect(h.list.state.totalSize).toBe(99 * ROW_H + TALL);
    // The retained snapshot agrees with the committed entries.
    h.list.setEdgeSlot("start", null);
    expect(h.list.positionOf("m3")).toEqual({ top: 300, height: TALL });
    expect(h.rowElement("tall")).toBe(row);
    h.list.dispose();
  });

  it("commits an update of an unmounted row without rendering it", () => {
    const render = vi.fn();
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: heightOf,
      onRender: render,
    });
    render.mockClear();

    h.list.updateItem("m90", message(90, "tall"));
    h.list.updateItem("m95", message(95, "changed"));

    expect(render).not.toHaveBeenCalled();
    expect(h.list.elementOf("m90")).toBeNull();
    expect(h.list.positionOf("m90")).toEqual({ top: 9000, height: TALL });
    expect(h.list.positionOf("m91")?.top).toBe(9200);
    expect(h.list.state.totalSize).toBe(99 * ROW_H + TALL);
    void h.list.scrollTo("m90");
    expect(h.slotOf(h.rowElement("tall")).style.height).toBe(`${TALL}px`);
    expect(h.rowElement("changed").textContent).toBe("changed");
    h.list.dispose();
  });

  it("merges held updates in submission order", () => {
    const h = mount(range(0, 100), { boot: "start", itemHeight: heightOf });
    h.userScroll(3000);

    h.list.updateItem("m2", message(2, "tall first"));
    h.list.updateItem("m4", message(4, "tall"));
    h.list.updateItem("m2", message(2, "latest"));
    h.list.updateItem("m6", message(6, "tall latest"));

    // Held: the committed geometry stands until the settle.
    expect(h.list.state.held).toBe(true);
    expect(h.list.state.totalSize).toBe(100 * ROW_H);
    expect(h.list.positionOf("m4")?.height).toBe(ROW_H);
    h.settle();
    expect(h.list.state.held).toBe(false);
    expect(h.list.positionOf("m2")?.height).toBe(ROW_H);
    expect(h.list.positionOf("m4")?.height).toBe(TALL);
    expect(h.list.positionOf("m6")?.height).toBe(TALL);
    expect(h.viewport.scrollTop).toBe(3200);
    void h.list.scrollTo("start");
    expect(h.rowElement("latest").textContent).toBe("latest");
    expect(h.rowElement("tall").textContent).toBe("tall");
    expect(h.rowElement("tall latest").textContent).toBe("tall latest");
    h.list.dispose();
  });

  it("leaves the committed state intact when an update fails", () => {
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: heightOf,
      throwOn: "tall boom",
    });

    expect(() => h.list.updateItem("m3", message(3, "tall boom"))).toThrow(
      "render failed: tall boom",
    );

    expect(h.list.positionOf("m3")).toEqual({ top: 300, height: ROW_H });
    expect(h.list.state.totalSize).toBe(100 * ROW_H);
    expect(h.rowElement("msg 3").textContent).toBe("msg 3");
    // Re-entry renders the committed item.
    void h.list.scrollTo("m50");
    expect(h.list.elementOf("m3")).toBeNull();
    void h.list.scrollTo("start");
    expect(h.rowElement("msg 3").textContent).toBe("msg 3");
    h.list.dispose();
  });

  it.each([
    { held: "held updates", prepend: false },
    { held: "a held prepend", prepend: true },
  ])("leaves $held intact when a later update fails", ({ prepend }) => {
    const initial = range(0, 100);
    const h = mount(initial, {
      boot: "start",
      itemHeight: heightOf,
      throwOn: "boom",
    });
    h.userScroll(3000);
    if (prepend)
      h.list.setItems([...range(-10, 0), ...initial], { anchor: "viewport" });
    h.list.updateItem("m2", message(2, "tall"));

    expect(() => h.list.updateItem("m32", message(32, "boom"))).toThrow(
      "render failed: boom",
    );

    expect(h.list.state.held).toBe(true);
    h.settle();
    expect(h.list.state.count).toBe(prepend ? 110 : 100);
    expect(h.list.positionOf("m2")?.height).toBe(TALL);
    expect(h.viewport.scrollTop).toBe(3100 + (prepend ? 1000 : 0));
    expect(h.rowElement("msg 32").textContent).toBe("msg 32");
    void h.list.scrollTo("m2");
    expect(h.list.elementOf("m32")).toBeNull();
    expect(h.rowElement("tall").textContent).toBe("tall");
    void h.list.scrollTo("m32");
    expect(h.rowElement("msg 32").textContent).toBe("msg 32");
    h.list.dispose();
  });

  it("restores the committed entry when a render inside the commit fails", () => {
    let fail = true;
    const h = mount(range(0, 100), {
      boot: "start",
      itemHeight: heightOf,
      onRender: (m) => {
        if (fail && m.body === "tall 27") throw new Error("row render failed");
      },
    });
    h.userScroll(3000);
    // Above the anchor row and mounted: each renders inside the settle commit.
    h.list.updateItem("m27", message(27, "tall 27"));
    h.list.updateItem("m28", message(28, "tall 28"));
    expect(h.list.state.held).toBe(true);
    expect(h.rowElement("msg 27").textContent).toBe("msg 27");

    expect(() => h.settle()).toThrow("row render failed");

    expect(h.list.state.held).toBe(false);
    expect(h.list.positionOf("m27")).toEqual({ top: 2700, height: ROW_H });
    expect(h.list.positionOf("m28")).toEqual({ top: 2800, height: TALL });
    expect(h.list.state.totalSize).toBe(99 * ROW_H + TALL);
    expect(h.rowElement("msg 27").textContent).toBe("msg 27");
    expect(h.rowElement("tall 28").textContent).toBe("tall 28");
    // Re-entry renders the restored item; the next update renders the row.
    void h.list.scrollTo("m90");
    void h.list.scrollTo("m27");
    expect(h.rowElement("msg 27").textContent).toBe("msg 27");
    fail = false;
    h.list.updateItem("m27", message(27, "tall 27"));
    expect(h.list.positionOf("m27")?.height).toBe(TALL);
    expect(h.rowElement("tall 27").textContent).toBe("tall 27");
    h.list.dispose();
  });

  it("applies an update and a later snapshot queued in the same pass", () => {
    const initial = range(0, 100);
    const next = initial
      .slice(0, 99)
      .map((m) => (m.id === 5 ? message(5, "tall 5") : m));
    let queue = false;
    const hooks = {
      boot: "start" as const,
      itemHeight: heightOf,
      onRender: (m: Msg) => {
        if (!queue || m.body !== "trigger") return;
        queue = false;
        h.list.updateItem("m90", message(90, "tall 90"));
        h.list.updateItem("m99", message(99, "tall 99"));
        h.list.setItems(next);
      },
    };
    const h: Harness = mount(initial, hooks);
    queue = true;

    h.list.updateItem("m3", message(3, "trigger"));

    // Each queued call landed in turn; the snapshot has the last word.
    expect(h.states.map((state) => state.totalSize).slice(-3)).toEqual([
      99 * ROW_H + TALL,
      98 * ROW_H + 2 * TALL,
      98 * ROW_H + TALL,
    ]);
    expect(h.list.state.count).toBe(99);
    expect(h.list.positionOf("m99")).toBeNull();
    expect(h.list.positionOf("m90")?.height).toBe(ROW_H);
    expect(h.list.positionOf("m5")?.height).toBe(TALL);
    expect(h.rowElement("tall 5").textContent).toBe("tall 5");
    expect(h.rowElement("msg 3").textContent).toBe("msg 3");
    // A removed key stays removed; the snapshot's map takes later updates.
    h.list.updateItem("m99", message(99, "tall 99"));
    h.list.updateItem("m90", message(90, "tall 90"));
    expect(h.list.state.count).toBe(99);
    expect(h.list.positionOf("m99")).toBeNull();
    expect(h.list.positionOf("m90")?.height).toBe(TALL);
    void h.list.scrollTo("m90");
    expect(h.rowElement("tall 90").textContent).toBe("tall 90");
    h.list.dispose();
  });

  it("lets a held snapshot supersede earlier updates and take later ones", () => {
    const initial = range(0, 100);
    const h = mount(initial, { boot: "start", itemHeight: heightOf });
    h.userScroll(3000);
    h.list.updateItem("m2", message(2, "tall 2"));
    h.list.updateItem("m4", message(4, "tall 4"));

    h.list.setItems(
      initial.slice(1).map((m) => (m.id === 4 ? message(4, "tall final") : m)),
    );
    h.list.updateItem("m6", message(6, "tall 6"));
    h.list.updateItem("m0", message(0, "tall 0"));

    expect(h.list.state.held).toBe(true);
    expect(h.list.state.count).toBe(100);
    expect(h.list.state.totalSize).toBe(100 * ROW_H);
    h.settle();
    expect(h.list.state.count).toBe(99);
    expect(h.list.positionOf("m0")).toBeNull();
    expect(h.list.positionOf("m2")?.height).toBe(ROW_H);
    expect(h.list.positionOf("m4")?.height).toBe(TALL);
    expect(h.list.positionOf("m6")?.height).toBe(TALL);
    expect(h.list.state.totalSize).toBe(97 * ROW_H + 2 * TALL);
    expect(h.viewport.scrollTop).toBe(3100);
    void h.list.scrollTo("start");
    expect(h.rowElement("msg 2").textContent).toBe("msg 2");
    expect(h.rowElement("tall final").textContent).toBe("tall final");
    expect(h.rowElement("tall 6").textContent).toBe("tall 6");
    h.list.dispose();
  });

  it("evaluates positioned callbacks across the snapshot on updateItem for both isolated and cascading masonry edits", () => {
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientHeight: { value: 400 },
      clientWidth: { value: 600 },
    });
    document.body.append(viewport);

    let positionCalls = 0;
    let col0Cursor = 0;
    let col1Cursor = 0;
    let cascade = false;
    const items = range(0, 20);
    const list = createVirtualList(viewport, {
      items,
      key: (m) => `m${m.id}`,
      height: heightOf,
      boot: "start",
      pinning: false,
      position: (m) => {
        positionCalls += 1;
        if (!cascade) {
          return { top: Math.floor(m.id / 2) * 240, lane: m.id % 2 };
        }
        if (m.id === 0) {
          col0Cursor = 0;
          col1Cursor = 0;
        }
        const lane = m.id % 2;
        const top = lane === 0 ? col0Cursor : col1Cursor;
        const h = heightOf(m);
        if (lane === 0) col0Cursor = top + h;
        else col1Cursor = top + h;
        return { top, lane };
      },
      render: (m, existing) => {
        const el = existing ?? document.createElement("div");
        el.textContent = m.body;
        return el;
      },
    });

    positionCalls = 0;
    // Isolated in-place edit within lane bounds (`matchesExcept` + `canUpdateInPlace`).
    list.updateItem("m2", message(2, "tall 2"));
    expect(positionCalls).toBe(20);
    expect(list.positionOf("m2")).toEqual({ top: 240, height: TALL });
    expect(list.positionOf("m4")).toEqual({ top: 480, height: ROW_H });

    // Cascading masonry edit where growing m0 shifts every downstream lane-0 card.
    cascade = true;
    list.setItems(range(0, 20));
    positionCalls = 0;
    list.updateItem("m0", message(0, "tall 0"));
    expect(positionCalls).toBe(20);
    expect(list.positionOf("m0")).toEqual({ top: 0, height: TALL });
    expect(list.positionOf("m2")).toEqual({ top: TALL, height: ROW_H });
    expect(list.positionOf("m1")).toEqual({ top: 0, height: ROW_H });

    list.dispose();
    viewport.remove();
  });
});
