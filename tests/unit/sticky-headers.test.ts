/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStickyHeaders as createCompanion } from "../../src/companions/index";

describe("sticky headers", () => {
  it("should skip unavailable headers and preserve their source ordinals", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    const keys = ["missing-start", "a", "missing-middle", "b", "missing-end"];
    const positions = new Map([
      ["a", { top: 100, height: 40 }],
      ["b", { top: 200, height: 40 }],
    ]);
    const sticky = createCompanion({
      container,
      viewport,
      headerKeys: () => keys,
      positionOf: (key) => positions.get(key) ?? null,
      renderHeader: (slot, ordinal) => {
        slot.textContent = keys[ordinal] ?? "invalid ordinal";
      },
    });
    const overlay = container.querySelector<HTMLElement>(".vl-sticky-header");
    const slots = container.querySelectorAll(".sticky-group");
    try {
      expect(overlay?.style.display).toBe("none");
      sticky.update(100);
      expect(slots[0]?.textContent).toBe("a");
      sticky.update(180);
      expect(slots[1]?.textContent).toBe("b");
      sticky.update(200);
      expect(slots[0]?.textContent).toBe("b");
      keys.unshift("another-missing");
      sticky.refresh(200);
      expect(slots[0]?.textContent).toBe("b");
      positions.clear();
      sticky.refresh(200);
      expect(overlay?.style.display).toBe("none");
    } finally {
      sticky.destroy();
    }
  });

  it("should remove the overlay if initial header rendering fails", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    container.append(viewport);
    document.body.append(container);

    expect(() =>
      createCompanion({
        container,
        viewport,
        headerKeys: () => ["a"],
        positionOf: () => ({ top: 0, height: 40 }),
        renderHeader: () => {
          throw new Error("header failed");
        },
      }),
    ).toThrow("header failed");

    expect([...container.children]).toEqual([viewport]);
  });

  it.each(["active", "incoming"])(
    "should retry a failed %s header render on the next refresh",
    (target) => {
      const container = document.createElement("div");
      const viewport = document.createElement("div");
      let fail = true;
      const sticky = createCompanion({
        container,
        viewport,
        headerKeys: () => ["a", "b"],
        positionOf: (key) => ({ top: key === "a" ? 0 : 100, height: 40 }),
        renderHeader: (slot, ordinal) => {
          if (ordinal === 1 && fail) {
            slot.replaceChildren();
            throw new Error("header failed");
          }
          slot.textContent = String(ordinal);
        },
      });
      const top = target === "active" ? 100 : 80;

      expect(() => sticky.refresh(top)).toThrow("header failed");
      fail = false;
      sticky.refresh(top);

      const index = target === "active" ? 0 : 1;
      expect(
        container.querySelectorAll(".sticky-group")[index]?.textContent,
      ).toBe("1");
      sticky.destroy();
    },
  );

  it("should not hide inline headers again after destruction", () => {
    const { sticky, inline } = setup();
    sticky.destroy();

    sticky.refresh(90);
    sticky.update(110);
    sticky.setEnabled(false);
    sticky.setEnabled(true);

    expect([...inline.values()].map((element) => element.className)).toEqual([
      "",
      "",
    ]);
  });

  it("should restore the previous header when scrolling back after a failed render", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    const sticky = createCompanion({
      container,
      viewport,
      headerKeys: () => ["a", "b"],
      positionOf: (key) => ({ top: key === "a" ? 0 : 100, height: 40 }),
      renderHeader: (slot, ordinal) => {
        slot.replaceChildren();
        if (ordinal === 1) throw new Error("header failed");
        slot.textContent = String(ordinal);
      },
    });

    expect(() => sticky.update(100)).toThrow("header failed");
    sticky.update(0);

    expect(container.querySelector(".sticky-group")?.textContent).toBe("0");
    sticky.destroy();
  });

  it.each(["render", "lookup"])(
    "should stop a refresh if %s destroys the companion",
    (callback) => {
      const container = document.createElement("div");
      const viewport = document.createElement("div");
      const inline = document.createElement("div");
      let onRender = () => {};
      let onLookup = () => {};
      const sticky = createCompanion({
        container,
        viewport,
        headerKeys: () => ["a", "b"],
        positionOf: (key) => ({ top: key === "a" ? 0 : 100, height: 40 }),
        renderHeader: () => onRender(),
        elementOf: () => {
          onLookup();
          return inline;
        },
      });
      if (callback === "render") onRender = () => sticky.destroy();
      else onLookup = () => sticky.destroy();

      sticky.update(100);

      expect(inline.className).toBe("");
      expect(container.children).toHaveLength(0);
    },
  );

  it("should detect key changes when the host reuses its header array", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    const keys = ["a"];
    const sticky = createCompanion({
      container,
      viewport,
      headerKeys: () => keys,
      positionOf: () => ({ top: 0, height: 40 }),
      renderHeader: (slot, ordinal) => {
        slot.textContent = keys[ordinal] ?? "";
      },
    });
    expect(container.querySelector(".sticky-group")?.textContent).toBe("a");

    keys[0] = "b";
    sticky.refresh(0);

    expect(container.querySelector(".sticky-group")?.textContent).toBe("b");
    sticky.destroy();
  });

  it.each(["render", "lookup"])(
    "should keep inline headers visible when %s disables the companion",
    (callback) => {
      const container = document.createElement("div");
      const viewport = document.createElement("div");
      const inline = document.createElement("div");
      let disable = () => {};
      const sticky = createCompanion({
        container,
        viewport,
        headerKeys: () => ["a", "b"],
        positionOf: (key) => ({ top: key === "a" ? 0 : 100, height: 40 }),
        renderHeader: (slot, ordinal) => {
          slot.textContent = String(ordinal);
          if (callback === "render") disable();
        },
        elementOf: () => {
          if (callback === "lookup") disable();
          return inline;
        },
      });
      disable = () => sticky.setEnabled(false);

      sticky.update(100);

      expect(inline.className).toBe("");
      expect(
        container.querySelector<HTMLElement>(".vl-sticky-header")?.style
          .display,
      ).toBe("none");
      disable = () => {};
      viewport.scrollTop = 100;
      sticky.setEnabled(true);
      expect(container.querySelector(".sticky-group")?.textContent).toBe("1");
      sticky.destroy();
    },
  );

  it("should use runtime publications without a native scroll listener by default", () => {
    const viewport = document.createElement("div");
    const container = document.createElement("div");
    document.body.append(container);
    const sticky = createCompanion({
      container,
      viewport,
      headerKeys: () => ["a", "b"],
      positionOf: (key) => ({ top: key === "a" ? 0 : 100, height: 40 }),
      renderHeader: (slot, index) => {
        slot.textContent = String(index);
      },
    });
    Object.defineProperty(viewport, "scrollTop", {
      get() {
        throw new Error("Unexpected native sample");
      },
    });
    viewport.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);
    sticky.refresh(110);
    expect(container.querySelector(".sticky-group")?.textContent).toBe("1");
    sticky.destroy();
    expect(container.children.length).toBe(0);
  });
  function setup(beforeSticky?: (viewport: HTMLElement) => void) {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    container.appendChild(viewport);
    document.body.appendChild(container);
    beforeSticky?.(viewport);
    const positions = new Map([
      ["day:0", { top: 0, height: 44 }],
      ["day:1", { top: 100, height: 44 }],
    ]);
    const inline = new Map([
      ["day:0", document.createElement("div")],
      ["day:1", document.createElement("div")],
    ]);
    const sticky = createCompanion({
      observeScroll: true,
      container,
      viewport,
      headerKeys: () => [...positions.keys()],
      positionOf: (key) => positions.get(key) ?? null,
      elementOf: (key) => inline.get(key) ?? null,
      renderHeader: (slot, ordinal) => {
        const label = document.createElement("span");
        label.textContent = `day ${ordinal}`;
        slot.replaceChildren(label);
      },
    });
    const slots = container.querySelectorAll<HTMLElement>(".sticky-group");
    const active = slots.item(0);
    const incoming = slots.item(1);
    return { sticky, viewport, positions, inline, active, incoming };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("should retain header nodes across unchanged geometry publications", () => {
    const { sticky, active, incoming } = setup();
    sticky.refresh(90);
    const activeLabel = active.firstChild;
    const incomingLabel = incoming.firstChild;

    sticky.refresh(91.5);

    expect(active.firstChild).toBe(activeLabel);
    expect(incoming.firstChild).toBe(incomingLabel);
    expect(incoming.style.transform).toBe("translateY(8.5px)");
    sticky.destroy();
  });

  it("should use the supplied scroll snapshot without reading layout", () => {
    const { sticky, viewport, active } = setup();
    Object.defineProperty(viewport, "scrollTop", {
      get() {
        throw new Error("Unexpected layout read");
      },
    });

    sticky.refresh(110);

    expect(active.textContent).toBe("day 1");
    sticky.destroy();
  });

  it("should sample the default viewport before header callbacks can change layout", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    let dirty = false;
    Object.defineProperty(viewport, "scrollTop", {
      get() {
        if (dirty) throw new Error("Read after header callback");
        return 0;
      },
    });
    const sticky = createCompanion({
      container,
      viewport,
      headerKeys: () => {
        dirty = true;
        return ["a"];
      },
      positionOf: () => ({ top: 0, height: 40 }),
      renderHeader: (slot) => {
        slot.textContent = "Header";
      },
    });
    dirty = false;

    sticky.refresh();

    expect(container.querySelector(".sticky-group")?.textContent).toBe(
      "Header",
    );
    sticky.destroy();
    // A late refresh must not read a destroyed viewport either.
    sticky.refresh();
  });

  it("should keep a glide snapshot ahead of a queued native scroll frame", () => {
    const { sticky, viewport, incoming } = setup();
    viewport.scrollTop = 70;
    viewport.dispatchEvent(new Event("scroll"));
    Object.defineProperty(viewport, "scrollTop", {
      get() {
        throw new Error("Unexpected layout read");
      },
    });

    sticky.update(90);

    expect(incoming.style.transform).toBe("translateY(10px)");
    vi.advanceTimersByTime(20);
    expect(incoming.style.transform).toBe("translateY(10px)");
    sticky.destroy();
  });

  it("should sample scroll before an earlier bubbling listener mutates layout", () => {
    let dirty = false;
    let top = 0;
    const { sticky, viewport, active } = setup((element) => {
      Object.defineProperty(element, "scrollTop", {
        get() {
          if (dirty) throw new Error("Read after window reconciliation");
          return top;
        },
      });
      element.addEventListener("scroll", () => {
        dirty = true;
      });
    });
    top = 110;

    viewport.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);

    expect(active.textContent).toBe("day 1");
    sticky.destroy();
  });

  it("should hide a remounted inline header without rebuilding the overlay", () => {
    const { sticky, inline, active } = setup();
    const previous = inline.get("day:0");
    const replacement = document.createElement("div");
    const label = active.firstChild;
    inline.set("day:0", replacement);

    sticky.refresh(10);

    expect(previous?.classList.contains("vl-sticky-inline-hidden")).toBe(false);
    expect(replacement.classList.contains("vl-sticky-inline-hidden")).toBe(
      true,
    );
    expect(active.firstChild).toBe(label);
    sticky.destroy();
    expect(replacement.classList.contains("vl-sticky-inline-hidden")).toBe(
      false,
    );
  });

  it("should adopt changed header geometry and retire an obsolete incoming slot", () => {
    const { sticky, positions, active, incoming } = setup();
    sticky.refresh(90);
    positions.set("day:1", { top: 80, height: 50 });

    sticky.refresh(90);

    expect(active.textContent).toBe("day 1");
    expect(active.style.height).toBe("50px");
    expect(incoming.textContent).toBe("");
    expect(incoming.style.display).toBe("none");
    sticky.destroy();
  });

  it("should push the previous pill out instead of stacking it behind the next", () => {
    const { sticky, active, incoming, inline } = setup();

    sticky.refresh(90);

    expect(active.style.transform).toBe("translateY(-34px)");
    expect(incoming.style.transform).toBe("translateY(10px)");
    expect(active.parentElement?.style.height).toBe("54px");
    expect(
      inline.get("day:0")?.classList.contains("vl-sticky-inline-hidden"),
    ).toBe(true);
    expect(
      inline.get("day:1")?.classList.contains("vl-sticky-inline-hidden"),
    ).toBe(true);
    sticky.refresh(100);
    expect(active.textContent).toBe("day 1");
    expect(active.style.transform).toBe("");
    expect(active.parentElement?.style.height).toBe("44px");
    expect(incoming.textContent).toBe("");
    expect(
      inline.get("day:0")?.classList.contains("vl-sticky-inline-hidden"),
    ).toBe(false);
    sticky.destroy();
    expect(
      inline.get("day:1")?.classList.contains("vl-sticky-inline-hidden"),
    ).toBe(false);
  });

  it("should keep the incoming date attached to its row in both scroll directions", () => {
    const { sticky, active, incoming } = setup();

    for (const [scroll, offset] of [
      [57, -1],
      [70, -14],
      [90, -34],
      [99, -43],
      [90, -34],
      [70, -14],
      [57, -1],
    ] as const) {
      sticky.update(scroll);

      expect(active.style.transform).toBe(`translateY(${offset}px)`);
      expect(active.style.visibility).not.toBe("hidden");
      expect(incoming.style.transform).toBe(`translateY(${100 - scroll}px)`);
    }
    sticky.destroy();
  });

  it("should restore both inline pills when sticky headers are disabled during handoff", () => {
    const { sticky, inline } = setup();
    sticky.refresh(90);

    sticky.setEnabled(false);

    expect(
      inline.get("day:0")?.classList.contains("vl-sticky-inline-hidden"),
    ).toBe(false);
    expect(
      inline.get("day:1")?.classList.contains("vl-sticky-inline-hidden"),
    ).toBe(false);
    sticky.destroy();
  });

  it("refresh retires a scroll frame sampled against pre-commit geometry", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    container.appendChild(viewport);
    document.body.appendChild(container);
    let positions = new Map([
      ["day:0", { top: 0, height: 44 }],
      ["day:1", { top: 100, height: 44 }],
    ]);
    const sticky = createCompanion({
      observeScroll: true,
      container,
      viewport,
      headerKeys: () => ["day:0", "day:1"],
      positionOf: (key) => positions.get(key) ?? null,
      renderHeader: (slot, ordinal) => {
        slot.textContent = `day ${ordinal}`;
      },
    });

    viewport.scrollTop = 90;
    viewport.dispatchEvent(new Event("scroll")); // Queues a frame at 90.
    // After the commit day 1 starts at 95: the frame sampled at 90 would
    // resolve day 0 against the new tops, the refresh at 110 resolves day 1.
    positions = new Map([
      ["day:0", { top: 0, height: 44 }],
      ["day:1", { top: 95, height: 44 }],
    ]);
    viewport.scrollTop = 110;
    sticky.refresh(); // Commit authority: day 1 is active now.
    vi.advanceTimersByTime(20);

    expect(container.querySelector(".sticky-group")?.textContent).toBe("day 1");
    sticky.destroy();
  });

  it("should hide and restore a mounted incoming inline header when the active header is unmounted", () => {
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    const incomingRow = document.createElement("div");
    const positions = new Map([
      ["day:0", { top: 0, height: 40 }],
      ["day:1", { top: 200, height: 40 }],
      ["day:2", { top: 400, height: 40 }],
    ]);
    const elements = new Map<string, HTMLElement>([["day:1", incomingRow]]);
    const sticky = createCompanion({
      container,
      viewport,
      headerKeys: () => ["day:0", "day:1", "day:2"],
      positionOf: (key) => positions.get(key) ?? null,
      elementOf: (key) => elements.get(key) ?? null,
      renderHeader: (slot, ordinal) => {
        slot.textContent = `day ${ordinal}`;
      },
    });
    try {
      // Handoff zone [160, 200): active day:0 is unmounted (null), incoming day:1 is mounted.
      sticky.update(175);
      expect(incomingRow.classList.contains("vl-sticky-inline-hidden")).toBe(
        true,
      );
      sticky.refresh(180); // Unchanged header boxes: fast-path refresh keeps inline state exact.
      expect(incomingRow.classList.contains("vl-sticky-inline-hidden")).toBe(
        true,
      );

      // Once day:1 becomes active and day:1 is then unmounted or scrolled before day:2, restore cleanly.
      elements.delete("day:1");
      sticky.update(250);
      expect(incomingRow.classList.contains("vl-sticky-inline-hidden")).toBe(
        false,
      );
    } finally {
      sticky.destroy();
    }
  });
});
