/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { mount, range, useHarness } from "../helpers/list-harness";

useHarness();

it("activates above 12 px/ms, survives renewed input, and restores below 6 px/ms", () => {
  const h = mount(range(0, 100), { boot: "start" });
  h.list.setScrollPlaceholders(true);
  const skeletons = () =>
    h.viewport.querySelectorAll(
      "[data-scroll-skeletons][data-active] [data-scroll-placeholder]",
    );
  try {
    h.userScroll(10);
    vi.advanceTimersByTime(16);
    h.userScroll(170);
    expect(skeletons().length).toBe(0);

    vi.advanceTimersByTime(16);
    h.userScroll(410);
    expect(skeletons().length).toBeGreaterThan(0);
    const retained = h.viewport.querySelector(
      '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
    );
    expect(retained).not.toBeNull();

    vi.advanceTimersByTime(16);
    h.userScroll(522);
    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
      ),
    ).toBe(retained);
    h.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    vi.advanceTimersByTime(1);
    h.userScroll(523);
    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
      ),
    ).toBe(retained);
    vi.advanceTimersByTime(15);
    h.userScroll(714);
    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
      ),
    ).toBe(retained);

    vi.advanceTimersByTime(16);
    h.userScroll(746);
    expect(skeletons().length).toBeGreaterThan(0);
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(16);
      h.userScroll(746 + i * 32);
    }
    expect(skeletons().length).toBe(0);
    expect(h.list.elementOf("m8")?.style.opacity).toBe("");
    expect(h.list.elementOf("m8")?.inert).not.toBe(true);
  } finally {
    h.list.dispose();
  }
});

it("clears skeletons after movement really stops, even without scrollend", () => {
  const h = mount(range(0, 100), { boot: "start" });
  h.list.setScrollPlaceholders(true);
  try {
    h.userScroll(10);
    vi.advanceTimersByTime(16);
    h.userScroll(250);
    expect(
      h.viewport.querySelectorAll(
        "[data-scroll-skeletons][data-active] [data-scroll-placeholder]",
      ).length,
    ).toBeGreaterThan(0);
    vi.advanceTimersByTime(119);
    expect(
      h.viewport.querySelectorAll(
        "[data-scroll-skeletons][data-active] [data-scroll-placeholder]",
      ).length,
    ).toBeGreaterThan(0);
    vi.advanceTimersByTime(1);
    expect(
      h.viewport.querySelectorAll(
        "[data-scroll-skeletons][data-active] [data-scroll-placeholder]",
      ).length,
    ).toBe(0);
  } finally {
    h.list.dispose();
  }
});

it("keeps the same skeleton through a touch re-grab and brief slow handoff", () => {
  const h = mount(range(0, 100), { boot: "start" });
  h.list.setScrollPlaceholders(true);
  try {
    h.userScroll(10);
    vi.advanceTimersByTime(16);
    h.userScroll(250);
    const retained = h.viewport.querySelector(
      '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
    );
    expect(retained).not.toBeNull();

    h.viewport.dispatchEvent(new Event("touchstart"));
    vi.advanceTimersByTime(160);
    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
      ),
    ).toBe(retained);
    h.userScroll(260);
    vi.advanceTimersByTime(16);
    h.userScroll(280);
    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
      ),
    ).toBe(retained);
    h.viewport.dispatchEvent(
      Object.assign(new Event("touchend"), { touches: [] }),
    );
    vi.advanceTimersByTime(16);
    h.userScroll(520);
    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m8"]',
      ),
    ).toBe(retained);

    vi.advanceTimersByTime(120);
    expect(
      h.viewport.querySelectorAll(
        "[data-scroll-skeletons][data-active] [data-scroll-placeholder]",
      ).length,
    ).toBe(0);
  } finally {
    h.list.dispose();
  }
});

it("prepares offscreen skeletons before motion and reuses them across window changes", () => {
  const h = mount(range(0, 100), { boot: "start" });
  h.list.setScrollPlaceholders(true);
  try {
    const away = h.viewport.querySelector<HTMLElement>(
      '[data-scroll-placeholder="m80"]',
    );
    expect(away).not.toBeNull();
    expect(away?.style.top).toBe("8000px");
    expect(away?.style.height).toBe("100px");
    expect(h.list.elementOf("m80")).toBeNull();
    expect(
      h.viewport.querySelectorAll("[data-scroll-placeholder]").length,
    ).toBe(100);

    h.userScroll(10);
    vi.advanceTimersByTime(16);
    h.userScroll(250);
    vi.advanceTimersByTime(16);
    h.userScroll(8000);

    expect(
      h.viewport.querySelector(
        '[data-scroll-skeletons][data-active] [data-scroll-placeholder="m80"]',
      ),
    ).toBe(away);
    expect(
      h.viewport.querySelectorAll("[data-scroll-placeholder]").length,
    ).toBe(100);
    expect(h.list.elementOf("m80")?.style.opacity).toBe("0");
  } finally {
    h.list.dispose();
  }
});

it("uses optional host skeletons, reuses them while scrolling, and updates changed items", () => {
  const render = vi.fn((item, existing?: HTMLElement) => {
    const element = existing ?? document.createElement("div");
    element.textContent = `Skeleton: ${item.body}`;
    return element;
  });
  const h = mount(range(0, 20), {
    boot: "start",
    renderScrollPlaceholder: render,
  });
  try {
    expect(render).toHaveBeenCalledTimes(0);
    h.list.setScrollPlaceholders(true);
    expect(render).toHaveBeenCalledTimes(20);
    const wrapper = h.viewport.querySelector('[data-scroll-placeholder="m8"]');
    const content = wrapper?.firstElementChild;
    expect(content?.textContent).toBe("Skeleton: msg 8");
    h.userScroll(10);
    vi.advanceTimersByTime(16);
    h.userScroll(250);
    expect(render).toHaveBeenCalledTimes(20);
    h.settle();
    h.list.updateItem("m8", { id: 8, body: "Changed" });
    expect(render).toHaveBeenCalledTimes(21);
    expect(wrapper?.firstElementChild).toBe(content);
    expect(content?.textContent).toBe("Skeleton: Changed");
    h.list.setScrollPlaceholders(false);
    expect(
      h.viewport.querySelectorAll("[data-scroll-placeholder]").length,
    ).toBe(0);
  } finally {
    h.list.dispose();
  }
});
