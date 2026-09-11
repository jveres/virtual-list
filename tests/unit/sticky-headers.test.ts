/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStickyHeaders } from "../../demos/shared/sticky-headers";

describe("sticky headers", () => {
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
    const sticky = createStickyHeaders({
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
    const sticky = createStickyHeaders({
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
});
