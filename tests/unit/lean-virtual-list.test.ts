/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createLeanVirtualList,
  type LeanVirtualListState,
} from "../../src/lean/virtual-list";

// Runtime smoke tests under jsdom: no layout engine, so heights are always
// estimates (the setup stubs ResizeObserver) and geometry is exact by
// construction. Real measurement, gestures, and paint timing are validated
// at the real-browser gauntlet — jsdom proved constitutionally blind to
// those (three shipped bugs' worth of proof).

interface Msg {
  id: number;
  body: string;
}

const VIEWPORT_H = 600;
const ESTIMATE = 100;

function message(id: number, body = `msg ${id}`): Msg {
  return { id, body };
}

function range(from: number, to: number): Msg[] {
  return Array.from({ length: to - from }, (_, i) => message(from + i));
}

function makeViewport(): HTMLElement {
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "clientHeight", {
    get: () => VIEWPORT_H,
  });
  document.body.appendChild(viewport);
  return viewport;
}

function mount(items: Msg[], hooks: { onReachStart?: () => void } = {}) {
  const viewport = makeViewport();
  const states: LeanVirtualListState[] = [];
  const renders: number[] = [];
  const list = createLeanVirtualList<Msg>(viewport, {
    items,
    key: (m) => `m${m.id}`,
    estimateSize: ESTIMATE,
    render: (m, existing) => {
      renders.push(m.id);
      const el = existing ?? document.createElement("div");
      el.textContent = m.body;
      return el;
    },
    onState: (s) => states.push(s),
    onReachStart: hooks.onReachStart,
  });
  return { viewport, list, states, renders };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("lean runtime", () => {
  it("boots at the end with a bounded mounted window", () => {
    const { viewport, list } = mount(range(0, 100));
    expect(list.state.count).toBe(100);
    expect(list.state.atEnd).toBe(true);
    expect(viewport.scrollTop).toBe(100 * ESTIMATE - VIEWPORT_H);
    // Only the window is in the DOM.
    const canvas = viewport.firstElementChild as HTMLElement;
    expect(canvas.children.length).toBeLessThan(30);
    expect(canvas.style.height).toBe(`${100 * ESTIMATE}px`);
  });

  it("follows the end for appends while at the end", () => {
    const { viewport, list } = mount(range(0, 50));
    list.setItems(range(0, 52));
    expect(viewport.scrollTop).toBe(52 * ESTIMATE - VIEWPORT_H);
    expect(list.state.atEnd).toBe(true);
  });

  it("preserves the reading position through a prepend", () => {
    const { viewport, list } = mount(range(10, 60));
    list.scrollTo("m30");
    const anchorTop = viewport.scrollTop;

    list.setItems(range(0, 60));
    expect(viewport.scrollTop).toBe(anchorTop + 10 * ESTIMATE);
    expect(list.state.atEnd).toBe(false);
  });

  it("re-renders changed items in place, keyed by identity", () => {
    const initial = range(0, 20);
    const { viewport, list, renders } = mount(initial);
    renders.length = 0;

    // Unchanged items keep their object identity; only m19 is replaced.
    const next = [...initial];
    next[19] = message(19, "updated body");
    list.setItems(next);

    expect(renders).toEqual([19]);
    const canvas = viewport.firstElementChild as HTMLElement;
    const texts = [...canvas.children].map((el) => el.textContent);
    expect(texts).toContain("updated body");
  });

  it("scrollTo(key, align start) pins and reserves the shortfall (I5)", () => {
    const { viewport, list } = mount(range(0, 20));
    list.scrollTo("m18", { align: "start" });

    // 18 rows above ⇒ offset 1800; the reserve tops the surface out so the
    // key can sit exactly at the viewport top.
    expect(viewport.scrollTop).toBe(1800);
    expect(list.state.totalSize).toBe(1800 + VIEWPORT_H);
    expect(list.state.atEnd).toBe(true);
  });

  it("streaming growth after a pin is absorbed by the reserve (no motion)", () => {
    const { viewport, list } = mount(range(0, 20));
    list.scrollTo("m18", { align: "start" });
    const top = viewport.scrollTop;
    const total = list.state.totalSize;

    // Streamed update to the last message (same keys): end-compatible.
    const next = range(0, 20);
    next[19] = message(19, "longer streamed body");
    list.setItems(next);

    expect(viewport.scrollTop).toBe(top);
    expect(list.state.totalSize).toBe(total);
  });

  it("signals reach-start once per approach", () => {
    let reached = 0;
    const { list } = mount(range(0, 100), {
      onReachStart: () => {
        reached += 1;
      },
    });
    expect(reached).toBe(0);

    list.scrollTo("start");
    expect(reached).toBe(1);
    list.scrollTo("start");
    expect(reached).toBe(1); // Still in the zone — not re-armed.

    list.scrollTo("end");
    list.scrollTo("start");
    expect(reached).toBe(2);
  });

  it("dispose removes the canvas and stops reacting", () => {
    const { viewport, list } = mount(range(0, 10));
    list.dispose();
    expect(viewport.children.length).toBe(0);
    expect(() => list.setItems(range(0, 5))).not.toThrow();
  });
});
