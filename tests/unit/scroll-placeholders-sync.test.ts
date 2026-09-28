/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import {
  fireResize,
  type Harness,
  type Msg,
  message,
  mount,
  range,
  useHarness,
} from "../helpers/list-harness";

// The skeleton layer syncs what a commit changed, not every loaded key. The
// first tests pin that cost; the rest pin that every source of change still
// reaches the layer: after each commit it must equal the committed geometry.

useHarness();

const surfaceOf = (h: Harness): HTMLElement | null =>
  h.viewport.querySelector<HTMLElement>("[data-scroll-skeletons]");
const skeletonOf = (h: Harness, key: string): HTMLElement | null =>
  h.viewport.querySelector<HTMLElement>(`[data-scroll-placeholder="${key}"]`);

/** One skeleton per anchorable item, each on its row's committed box. */
function expectSynced(
  h: Harness,
  items: readonly Msg[],
  anchorable: (m: Msg) => boolean = () => true,
): void {
  const surface = surfaceOf(h);
  expect(surface).not.toBeNull();
  const found = [
    ...(surface?.querySelectorAll<HTMLElement>("[data-scroll-placeholder]") ??
      []),
  ];
  expect(
    found.map((element) => element.dataset.scrollPlaceholder).sort(),
  ).toEqual(
    items
      .filter(anchorable)
      .map((m) => `m${m.id}`)
      .sort(),
  );
  for (const element of found) {
    const position = h.list.positionOf(
      element.dataset.scrollPlaceholder as string,
    );
    expect(element.parentElement).toBe(surface);
    expect(element.style.top).toBe(`${position?.top}px`);
    expect(element.style.height).toBe(`${position?.height}px`);
    expect(element.childElementCount).toBe(1);
  }
  expect(surface?.style.height).toBe(`${h.list.state.totalSize}px`);
}

/** Host calls the skeleton layer causes for one update of `key`. */
function updateCost(
  count: number,
  boot: "start" | "end",
  key: number,
  height: number,
  anchoring: "runtime" | "native" = "runtime",
): { anchorable: number; renders: number } {
  let anchorable = 0;
  let renders = 0;
  const items = range(0, count);
  const h = mount(items, {
    boot,
    anchoring,
    anchorable: () => {
      anchorable += 1;
      return true;
    },
    renderScrollPlaceholder: (_item, existing) => {
      renders += 1;
      return existing ?? document.createElement("div");
    },
  });
  try {
    h.list.setScrollPlaceholders(true);
    expect(renders).toBe(count);
    anchorable = 0;
    renders = 0;
    h.heights.set(key, height);
    items[key] = message(key, "token");
    h.list.updateItem(`m${key}`, items[key]);
    expect(h.list.positionOf(`m${key}`)?.height).toBe(height);
    expectSynced(h, items);
    return { anchorable, renders };
  } finally {
    h.list.dispose();
  }
}

it.each([
  ["start", 100, "runtime"],
  ["start", 140, "runtime"],
  ["end", 100, "runtime"],
  ["end", 140, "runtime"],
  ["end", 100, "native"],
  ["end", 140, "native"],
] as const)(
  "syncs one skeleton for a token into the last row, whatever the loaded count (boot %s, height %s, %s anchoring)",
  (boot, height, anchoring) => {
    const small = updateCost(60, boot, 59, height, anchoring);
    const large = updateCost(480, boot, 479, height, anchoring);
    expect(large).toEqual(small);
    expect(large.renders).toBe(1);
    expect(large.anchorable).toBeLessThan(8);
  },
);

it("moves the skeletons below a grown row without asking the host about them", () => {
  const small = updateCost(60, "start", 3, 150);
  const large = updateCost(480, "start", 3, 150);
  expect(large).toEqual(small);
  expect(large.renders).toBe(1);
  expect(large.anchorable).toBeLessThan(8);
});

it("leaves the layer untouched by a commit that changes no row", () => {
  let anchorable = 0;
  const items = range(0, 100);
  const h = mount(items, {
    boot: "start",
    anchorable: () => {
      anchorable += 1;
      return true;
    },
  });
  try {
    h.list.setScrollPlaceholders(true);
    const surface = surfaceOf(h) as HTMLElement;
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(surface, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    anchorable = 0;
    // Same keys, same items: a commit with nothing to land.
    h.list.setItems([...items]);
    h.list.setScrollPlaceholders(true);
    writes.push(...observer.takeRecords());
    observer.disconnect();
    expect(writes).toEqual([]);
    expect(anchorable).toBeLessThan(8);
  } finally {
    h.list.dispose();
  }
});

it("parses the built-in skeleton's declaration once for the whole list", () => {
  const cssText = Object.getOwnPropertyDescriptor(
    CSSStyleDeclaration.prototype,
    "cssText",
  ) as PropertyDescriptor;
  const parsed: string[] = [];
  Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", {
    ...cssText,
    set(value: string) {
      if (value.includes("data:image/svg+xml")) parsed.push(value);
      cssText.set?.call(this, value);
    },
  });
  const items = range(0, 20);
  const h = mount(items, { boot: "start" });
  try {
    h.list.setScrollPlaceholders(true);
    h.list.setItems([...items, ...range(20, 30)]);
    h.list.setScrollPlaceholders(false);
    h.list.setScrollPlaceholders(true);
    expect(parsed.length).toBe(1);
    for (const key of ["m0", "m7", "m29"]) {
      const content = skeletonOf(h, key)?.firstElementChild as HTMLElement;
      expect(content.style.width).toBe("100%");
      expect(content.style.height).toBe("100%");
      expect(content.getAttribute("style")).toContain(
        "var(--virtual-list-placeholder-color",
      );
      expect(content.getAttribute("style")).toContain("data:image/svg+xml");
    }
    expect(skeletonOf(h, "m0")?.firstElementChild).not.toBe(
      skeletonOf(h, "m7")?.firstElementChild,
    );
  } finally {
    Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", cssText);
    h.list.dispose();
  }
});

it("follows a key order change, a removal, and an insertion", () => {
  const items = range(0, 40);
  const h = mount(items, { boot: "start" });
  try {
    h.list.setScrollPlaceholders(true);
    h.heights.set(2, 130);
    h.heights.set(41, 70);
    const kept = skeletonOf(h, "m30");
    const next = [
      message(41),
      ...items.slice(0, 10).reverse(),
      ...items.slice(12),
    ];
    h.list.setItems(next, { anchor: "none" });
    expectSynced(h, next);
    expect(skeletonOf(h, "m30")).toBe(kept);
    expect(skeletonOf(h, "m10")).toBeNull();
    expect(skeletonOf(h, "m9")?.style.top).toBe("70px");
  } finally {
    h.list.dispose();
  }
});

it.each(["runtime", "native"] as const)(
  "follows a prepend (%s anchoring)",
  (anchoring) => {
    const items = range(10, 60);
    const h = mount(items, { boot: "start", anchoring });
    try {
      h.list.setScrollPlaceholders(true);
      const kept = skeletonOf(h, "m10");
      const next = [...range(0, 10), ...items];
      h.list.setItems(next, { anchor: "viewport" });
      expectSynced(h, next);
      expect(skeletonOf(h, "m10")).toBe(kept);
      expect(kept?.style.top).toBe("1000px");
    } finally {
      h.list.dispose();
    }
  },
);

it("follows an edge slot that arrives, changes height, and leaves", () => {
  const items = range(0, 30);
  const h = mount(items, { boot: "start" });
  const slot = (height: number) => ({
    key: "loader",
    height,
    render: () => document.createElement("div"),
  });
  try {
    h.list.setScrollPlaceholders(true);
    h.list.setEdgeSlot("start", slot(50));
    expectSynced(h, items);
    expect(skeletonOf(h, "m0")?.style.top).toBe("50px");
    h.list.setEdgeSlot("start", slot(80));
    expectSynced(h, items);
    expect(skeletonOf(h, "m29")?.style.top).toBe("2980px");
    h.list.setEdgeSlot("end", slot(40));
    expectSynced(h, items);
    h.list.setEdgeSlot("start", null);
    expectSynced(h, items);
    expect(skeletonOf(h, "m0")?.style.top).toBe("0px");
    expect(surfaceOf(h)?.style.height).toBe("3040px");
  } finally {
    h.list.dispose();
  }
});

it("drops and restores the skeleton of an item whose anchorable result flips in place", () => {
  const items = range(0, 30);
  const anchorable = (m: Msg): boolean => !m.body.startsWith("separator");
  const h = mount(items, { boot: "start", anchorable });
  try {
    h.list.setScrollPlaceholders(true);
    expectSynced(h, items, anchorable);
    const neighbor = skeletonOf(h, "m6");
    items[5] = message(5, "separator");
    h.list.updateItem("m5", items[5]);
    expect(skeletonOf(h, "m5")).toBeNull();
    expectSynced(h, items, anchorable);
    items[5] = message(5, "text again");
    h.list.updateItem("m5", items[5]);
    expect(skeletonOf(h, "m5")).not.toBeNull();
    expectSynced(h, items, anchorable);
    expect(skeletonOf(h, "m6")).toBe(neighbor);
  } finally {
    h.list.dispose();
  }
});

it("follows the measured width of a row", () => {
  const items = range(0, 20);
  const h = mount(items, { boot: "start" });
  try {
    h.list.setScrollPlaceholders(true);
    expect(skeletonOf(h, "m2")?.style.maxWidth).toBe("48rem");
    const element = h.list.elementOf("m2") as HTMLElement;
    let width = 320;
    element.getBoundingClientRect = () => ({ height: 100, width }) as DOMRect;
    items[2] = message(2, "measured");
    h.list.updateItem("m2", items[2]);
    expect(skeletonOf(h, "m2")?.style.maxWidth).toBe("320px");
    expect(skeletonOf(h, "m3")?.style.maxWidth).toBe("48rem");
    // A resize delivery re-reads the row: the same height, a new width.
    width = 280;
    h.heights.set(2, 120);
    element.getBoundingClientRect = () => ({ height: 120, width }) as DOMRect;
    fireResize(0, element, 120);
    expect(skeletonOf(h, "m2")?.style.maxWidth).toBe("280px");
    expectSynced(h, items);
  } finally {
    h.list.dispose();
  }
});

it("rebuilds the layer when the option is turned off and on again", () => {
  const items = range(0, 30);
  const render = vi.fn((_item: Msg, existing?: HTMLElement) => {
    return existing ?? document.createElement("div");
  });
  const h = mount(items, { boot: "start", renderScrollPlaceholder: render });
  try {
    h.list.setScrollPlaceholders(true);
    const before = skeletonOf(h, "m4");
    h.list.setScrollPlaceholders(false);
    expect(surfaceOf(h)).toBeNull();
    render.mockClear();
    h.list.setScrollPlaceholders(true);
    expectSynced(h, items);
    expect(render).toHaveBeenCalledTimes(items.length);
    expect(skeletonOf(h, "m4")).not.toBe(before);
    h.list.setScrollPlaceholders(false);
    expect(surfaceOf(h)).toBeNull();
    // Commits land while the option is off.
    h.heights.set(4, 170);
    items[4] = message(4, "changed while off");
    h.list.updateItem("m4", items[4]);
    const next = [...items.slice(0, 20), ...range(30, 35)];
    h.list.setItems(next, { anchor: "none" });
    expect(surfaceOf(h)).toBeNull();
    render.mockClear();
    h.list.setScrollPlaceholders(true);
    expectSynced(h, next);
    expect(render).toHaveBeenCalledTimes(next.length);
    expect(skeletonOf(h, "m4")).not.toBe(before);
    expect(skeletonOf(h, "m4")?.style.height).toBe("170px");
    expect(skeletonOf(h, "m25")).toBeNull();
  } finally {
    h.list.dispose();
  }
});

it("follows a height change of a row near the top", () => {
  const items = range(0, 80);
  const h = mount(items, { boot: "start" });
  try {
    h.list.setScrollPlaceholders(true);
    const below = skeletonOf(h, "m70");
    h.heights.set(3, 150);
    items[3] = message(3, "grown");
    h.list.updateItem("m3", items[3]);
    expectSynced(h, items);
    expect(skeletonOf(h, "m3")?.style.height).toBe("150px");
    expect(skeletonOf(h, "m4")?.style.top).toBe("450px");
    expect(skeletonOf(h, "m70")).toBe(below);
    expect(below?.style.top).toBe("7050px");
    // An observed resize of a mounted row, and a shrink.
    h.heights.set(1, 60);
    fireResize(0, h.list.elementOf("m1") as HTMLElement, 60);
    expectSynced(h, items);
    expect(below?.style.top).toBe("7010px");
  } finally {
    h.list.dispose();
  }
});

it("keeps every offset exact on a fractional device pixel grid", () => {
  vi.stubGlobal("devicePixelRatio", 1.5);
  const items = range(0, 120);
  const h = mount(items, { boot: "start" });
  try {
    for (const m of items) h.heights.set(m.id, 40 + ((m.id * 7) % 23) / 3);
    h.list.setScrollPlaceholders(true);
    for (const m of items) h.list.updateItem(`m${m.id}`, message(m.id, "x"));
    expectSynced(h, items);
    // Thirds of a pixel do not sum exactly: the kernel's offsets are the
    // reference, in whatever order it added them.
    for (const [id, height] of [
      [2, 78.5],
      [40, 51.2],
      [2, 40.1],
      [77, 93.4],
    ] as const) {
      h.heights.set(id, height);
      h.list.updateItem(`m${id}`, message(id, `y ${height}`));
      expectSynced(h, items);
    }
    const tops = items.map((m) => h.list.positionOf(`m${m.id}`)?.top as number);
    expect(tops.filter((top) => !Number.isInteger(top)).length).toBeGreaterThan(
      60,
    );
  } finally {
    h.list.dispose();
  }
});

it("syncs a deferred render of a declared row inside its settle commit", () => {
  const items = range(0, 100);
  const render = vi.fn((item: Msg, existing?: HTMLElement) => {
    const element = existing ?? document.createElement("div");
    element.textContent = item.body;
    return element;
  });
  const h = mount(items, {
    boot: "start",
    itemHeight: (m) => (m.body.startsWith("tall") ? 180 : 100),
    renderScrollPlaceholder: render,
  });
  try {
    h.list.setScrollPlaceholders(true);
    expect(skeletonOf(h, "m1")?.style.maxWidth).toBe("48rem");
    h.userScroll(300);
    render.mockClear();
    // Above the anchor, mid-phase: the row renders inside the settle commit.
    items[1] = message(1, "tall 1");
    h.list.updateItem("m1", items[1]);
    expect(h.list.state.held).toBe(true);
    expect(skeletonOf(h, "m1")?.style.height).toBe("100px");
    expect(render).toHaveBeenCalledTimes(0);
    h.settle();
    expect(h.list.state.held).toBe(false);
    expectSynced(h, items);
    expect(skeletonOf(h, "m1")?.style.height).toBe("180px");
    expect(skeletonOf(h, "m1")?.textContent).toBe("tall 1");
    expect(render).toHaveBeenCalledTimes(1);
    // A declared row that never rendered changes too.
    items[90] = message(90, "tall 90");
    h.list.updateItem("m90", items[90]);
    expectSynced(h, items);
    expect(skeletonOf(h, "m90")?.textContent).toBe("tall 90");
    expect(skeletonOf(h, "m91")?.style.top).toBe("9260px");
  } finally {
    h.list.dispose();
  }
});

it("syncs commits that land during active fast scrolling", () => {
  const items = range(0, 100);
  const h = mount(items, { boot: "start" });
  try {
    h.list.setScrollPlaceholders(true);
    h.userScroll(10);
    vi.advanceTimersByTime(16);
    h.userScroll(250);
    expect(surfaceOf(h)?.hasAttribute("data-active")).toBe(true);
    const grown = skeletonOf(h, "m5");
    const below = skeletonOf(h, "m6");
    // Below the anchor: the height lands in this delivery.
    h.heights.set(5, 160);
    items[5] = message(5, "grown");
    h.list.updateItem("m5", items[5]);
    expect(surfaceOf(h)?.hasAttribute("data-active")).toBe(true);
    expect(skeletonOf(h, "m5")).toBe(grown);
    expect(skeletonOf(h, "m6")).toBe(below);
    expect(grown?.style.height).toBe("160px");
    expect(below?.style.top).toBe("660px");
    expectSynced(h, items);
    // Above the anchor: held for the settle, and the layer waits with it.
    h.heights.set(0, 130);
    items[0] = message(0, "grown above");
    h.list.updateItem("m0", items[0]);
    expect(skeletonOf(h, "m0")?.style.height).toBe("100px");
    expectSynced(h, items);
    h.settle();
    expect(skeletonOf(h, "m0")?.style.height).toBe("130px");
    expect(below?.style.top).toBe("690px");
    expectSynced(h, items);
  } finally {
    h.list.dispose();
  }
});

it("shows a held row's new item in its skeleton at the next commit", () => {
  const items = range(0, 100);
  const render = vi.fn((item: Msg, existing?: HTMLElement) => {
    const element = existing ?? document.createElement("div");
    element.textContent = item.body;
    return element;
  });
  const h = mount(items, { boot: "start", renderScrollPlaceholder: render });
  try {
    h.list.setScrollPlaceholders(true);
    h.userScroll(300);
    render.mockClear();
    // Rendered in place above the anchor; its height waits for the settle.
    h.heights.set(0, 130);
    items[0] = message(0, "held");
    h.list.updateItem("m0", items[0]);
    expect(render).toHaveBeenCalledTimes(0);
    items[5] = message(5, "landed");
    h.list.updateItem("m5", items[5]);
    expect(render.mock.calls.map(([item]) => item.body).sort()).toEqual([
      "held",
      "landed",
    ]);
    expect(skeletonOf(h, "m0")?.textContent).toBe("held");
    expect(skeletonOf(h, "m0")?.style.height).toBe("100px");
    expectSynced(h, items);
    h.settle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(skeletonOf(h, "m0")?.style.height).toBe("130px");
    expectSynced(h, items);
  } finally {
    h.list.dispose();
  }
});

it("asks again at the next commit for a host skeleton that failed", () => {
  const items = range(0, 12);
  let fail = false;
  const render = vi.fn((item: Msg, existing?: HTMLElement) => {
    if (fail && item.body === "broken") throw new Error("skeleton failed");
    const element = existing ?? document.createElement("div");
    element.textContent = item.body;
    return element;
  });
  const h = mount(items, { boot: "start", renderScrollPlaceholder: render });
  try {
    h.list.setScrollPlaceholders(true);
    fail = true;
    items[4] = message(4, "broken");
    expect(() => h.list.updateItem("m4", items[4] as Msg)).toThrow(
      "skeleton failed",
    );
    expect(skeletonOf(h, "m4")?.textContent).toBe("msg 4");
    expectSynced(h, items);
    fail = false;
    render.mockClear();
    items[9] = message(9, "unrelated");
    h.list.updateItem("m9", items[9]);
    expect(render.mock.calls.map(([item]) => item.body).sort()).toEqual([
      "broken",
      "unrelated",
    ]);
    expect(skeletonOf(h, "m4")?.textContent).toBe("broken");
    expectSynced(h, items);
  } finally {
    h.list.dispose();
  }
});

it("keeps positioned layouts without a skeleton layer", () => {
  const h = mount(range(0, 12), {
    boot: "start",
    itemHeight: () => 100,
    position: (m) => ({ top: m.id * 100, lane: 0 }),
  });
  try {
    h.list.setScrollPlaceholders(true);
    h.list.updateItem("m3", message(3, "changed"));
    expect(surfaceOf(h)).toBeNull();
  } finally {
    h.list.dispose();
  }
});
