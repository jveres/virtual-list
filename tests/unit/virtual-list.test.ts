/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createVirtualList,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list";

// Runtime smoke tests under jsdom: no layout engine, so heights are always
// estimates (the setup stubs ResizeObserver) and geometry is exact by
// construction. Real measurement, gestures, and paint timing are validated
// at the real-browser gauntlet — jsdom proved constitutionally blind to
// those (three shipped bugs' worth of proof).
//
// What jsdom CAN exercise deterministically: the sensor's classification
// core (an unmatched scroll event is a user gesture; `scrollend` settles
// it) and the measurement pipeline (via a controllable ResizeObserver stub
// that lets a test fire entries by hand). The gesture-gating tests below
// are built on exactly those two hooks.

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

function mount(
  items: Msg[],
  hooks: {
    onReachStart?: () => void;
    onState?: (s: VirtualListState) => void;
    replaceOnRerender?: boolean;
  } = {},
) {
  const viewport = makeViewport();
  const states: VirtualListState[] = [];
  const renders: number[] = [];
  const list = createVirtualList<Msg>(viewport, {
    items,
    key: (m) => `m${m.id}`,
    estimateSize: ESTIMATE,
    render: (m, existing) => {
      renders.push(m.id);
      const el =
        hooks.replaceOnRerender || !existing
          ? document.createElement("div")
          : existing;
      el.textContent = m.body;
      return el;
    },
    onState: (s) => {
      states.push(s);
      hooks.onState?.(s);
    },
    onReachStart: hooks.onReachStart,
  });
  return { viewport, list, states, renders };
}

// A scroll event whose scrollTop matches no recorded programmatic write is
// classified as a user gesture. Values are chosen ≥ 2px away from any write
// target so they cannot be consumed by a stale expectation (tolerance 1px).
function userScroll(viewport: HTMLElement, top: number): void {
  viewport.scrollTop = top;
  viewport.dispatchEvent(new Event("scroll"));
}

function settleGesture(viewport: HTMLElement): void {
  viewport.dispatchEvent(new Event("scrollend"));
}

function rowElement(viewport: HTMLElement, body: string): HTMLElement {
  const canvas = viewport.firstElementChild as HTMLElement;
  const el = [...canvas.children].find((c) => c.textContent === body);
  expect(el, `row "${body}" should be mounted`).toBeDefined();
  return el as HTMLElement;
}

// Controllable ResizeObserver: records constructed instances so a test can
// fire measurement entries by hand. createVirtualList constructs the item
// observer first, then the viewport observer.
type ROCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

function withControlledResizeObserver<R>(
  run: (
    fire: (instance: number, element: HTMLElement, height: number) => void,
  ) => R,
): R {
  const callbacks: ROCallback[] = [];
  class ControlledResizeObserver {
    constructor(callback: ROCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const original = globalThis.ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver =
    ControlledResizeObserver;
  try {
    return run((instance, element, height) => {
      const entry = {
        target: element,
        borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
      } as unknown as ResizeObserverEntry;
      callbacks[instance]?.([entry], null as never);
    });
  } finally {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = original;
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("virtual list runtime", () => {
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

  it("positions a replacement element from render(item, existing)", () => {
    const initial = range(0, 20);
    const { viewport, list } = mount(initial, { replaceOnRerender: true });
    const before = rowElement(viewport, "msg 19");

    const next = [...initial];
    next[19] = message(19, "updated body");
    list.setItems(next);

    // The replacement is in the canvas, positioned at the row's offset; the
    // element it replaced is detached.
    const after = rowElement(viewport, "updated body");
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(after.style.transform).toBe(`translateY(${19 * ESTIMATE}px)`);
    expect(after.style.position).toBe("absolute");
  });

  it("queues API calls made from host callbacks until after the commit (I4)", () => {
    let listRef: VirtualList<Msg> | null = null;
    let once = false;
    let countInsideCallback = -1;
    const { list } = mount(range(0, 30), {
      onState: (state) => {
        if (!listRef || once || state.count !== 40) return;
        once = true;
        listRef.setItems(range(0, 5));
        // The nested call is queued, not executed: published state still
        // reflects the commit that invoked this callback.
        countInsideCallback = listRef.state.count;
      },
    });
    listRef = list;

    list.setItems(range(0, 40));
    expect(countInsideCallback).toBe(40);
    expect(list.state.count).toBe(5); // Queued call ran after the callback.
  });

  it("restores exact end-follow at settle for an append during a gesture (I2)", () => {
    const { viewport, list } = mount(range(0, 50));
    expect(viewport.scrollTop).toBe(4400);

    // Gesture at the end without upward movement (a touch-hold jiggle).
    userScroll(viewport, 4402);

    list.setItems(range(0, 52));
    // Committed (not deferred), but the user owns the viewport: no write.
    expect(list.state.count).toBe(52);
    expect(viewport.scrollTop).toBe(4402);

    settleGesture(viewport);
    // Follow intent survived the suppressed write: exact landing.
    expect(viewport.scrollTop).toBe(52 * ESTIMATE - VIEWPORT_H);
  });

  it("restores exact end-follow at settle for bottom growth during a gesture (I2)", () => {
    withControlledResizeObserver((fire) => {
      const { viewport, list } = mount(range(0, 50));
      const lastRow = rowElement(viewport, "msg 49");
      userScroll(viewport, 4402);

      // The bottom row grows 100 → 300 mid-gesture (streamed image decode).
      fire(0, lastRow, 300);
      expect(list.state.totalSize).toBe(50 * ESTIMATE + 200);
      expect(viewport.scrollTop).toBe(4402); // Write suppressed.

      settleGesture(viewport);
      expect(viewport.scrollTop).toBe(50 * ESTIMATE + 200 - VIEWPORT_H);
    });
  });

  it("replaces a deferred snapshot with a newer one — latest wins at settle", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4402);
    userScroll(viewport, 4000); // Upward: a real scroll-away gesture.

    list.setItems(range(-10, 50)); // A: structural (prepend) → deferred.
    expect(list.state.count).toBe(50);
    list.setItems(range(0, 55)); // B: end-compatible, but must replace A.
    expect(list.state.count).toBe(50); // Still deferred — no bypass.

    settleGesture(viewport);
    expect(list.state.count).toBe(55);
    const canvas = viewport.firstElementChild as HTMLElement;
    const texts = [...canvas.children].map((el) => el.textContent);
    expect(texts).not.toContain("msg -1"); // A's snapshot never applied.
  });

  it("defers scrollTo during a gesture and executes it at settle", () => {
    const { viewport, list } = mount(range(0, 100));
    userScroll(viewport, 9402);

    list.scrollTo("start");
    expect(viewport.scrollTop).toBe(9402); // The user owns the viewport.

    settleGesture(viewport);
    expect(viewport.scrollTop).toBe(0); // Command outranks the settle anchors.
    expect(list.state.atStart).toBe(true);
  });

  it("rejects an invalid snapshot atomically, leaving the runtime unchanged", () => {
    const { viewport, list } = mount(range(0, 20));
    const topBefore = viewport.scrollTop;

    expect(() => list.setItems([message(1, "a"), message(1, "b")])).toThrow(
      /duplicate/i,
    );
    expect(list.state.count).toBe(20);
    expect(viewport.scrollTop).toBe(topBefore);
    const canvas = viewport.firstElementChild as HTMLElement;
    expect([...canvas.children].some((el) => el.textContent === "msg 19")).toBe(
      true,
    );

    // Runtime data and geometry stayed coherent: the next valid update works.
    list.setItems(range(0, 25));
    expect(list.state.count).toBe(25);
    expect(viewport.scrollTop).toBe(25 * ESTIMATE - VIEWPORT_H);
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

  it("does not refire inside the hysteresis band (enter 800px, exit 1200px)", () => {
    let reached = 0;
    const { list } = mount(range(0, 100), {
      onReachStart: () => {
        reached += 1;
      },
    });

    list.scrollTo("m7"); // 700px from start: inside the enter zone.
    expect(reached).toBe(1);
    list.scrollTo("m9"); // 900px: outside enter, inside exit — no re-arm.
    list.scrollTo("m7");
    expect(reached).toBe(1); // Oscillation on the boundary cannot refire.
    list.scrollTo("m20"); // 2000px: past the exit zone — re-armed.
    list.scrollTo("m7");
    expect(reached).toBe(2);
  });

  it("executes a newer command queued from onState after the original, so it wins", () => {
    let listRef: VirtualList<Msg> | null = null;
    let once = false;
    const { viewport, list } = mount(range(0, 100), {
      onState: (state) => {
        if (!listRef || once || state.atEnd) return;
        once = true;
        // Queued mid-command: must drain after the whole scrollTo("m30")
        // operation, so this newer command's write lands last.
        listRef.scrollTo("end");
      },
    });
    listRef = list;

    list.scrollTo("m30");
    expect(viewport.scrollTop).toBe(100 * ESTIMATE - VIEWPORT_H);
    expect(list.state.atEnd).toBe(true);
  });

  it("honors an explicit viewport anchor at settle even while following", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4402); // Gesture at the end; follow stays engaged.

    list.setItems(range(0, 52), { anchor: "viewport" });
    expect(list.state.count).toBe(50); // Explicit policy ⇒ deferred.

    settleGesture(viewport);
    expect(list.state.count).toBe(52);
    // The stated policy wins over follow state: position held, no end jump.
    expect(viewport.scrollTop).toBe(4402);
  });

  it("honors an explicit end anchor at settle even after follow disengaged", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4402);
    userScroll(viewport, 4300); // Upward past the threshold: follow disarms.

    list.setItems(range(0, 52), { anchor: "end" });
    expect(list.state.count).toBe(50); // Explicit policy ⇒ deferred.

    settleGesture(viewport);
    expect(viewport.scrollTop).toBe(52 * ESTIMATE - VIEWPORT_H);
    expect(list.state.atEnd).toBe(true);
  });

  it("disengages follow on cumulative sub-pixel upward drift", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4402);
    // -0.75px per event: no single step exceeds the threshold, but the
    // cumulative distance from the gesture's high-water mark does.
    for (const top of [4401.25, 4400.5, 4399.75, 4399, 4398.25, 4397.5]) {
      userScroll(viewport, top);
    }

    settleGesture(viewport);
    // Follow disengaged: settle preserves the position, no snap to the end.
    expect(viewport.scrollTop).toBe(4397.5);
    expect(list.state.atEnd).toBe(false);
  });

  it("disposal from a callback halts publication immediately", () => {
    let listRef: VirtualList<Msg> | null = null;
    let reached = 0;
    const { viewport, list } = mount(range(0, 100), {
      onReachStart: () => {
        reached += 1;
      },
      onState: (state) => {
        if (listRef && state.atStart) listRef.dispose();
      },
    });
    listRef = list;

    list.scrollTo("start");
    // The reach-start signal comes after onState in the same publication;
    // disposal in the callback must stop it from firing.
    expect(reached).toBe(0);
    expect(viewport.children.length).toBe(0);
  });

  it("dispose removes the canvas and stops reacting", () => {
    const { viewport, list } = mount(range(0, 10));
    list.dispose();
    expect(viewport.children.length).toBe(0);
    expect(() => list.setItems(range(0, 5))).not.toThrow();
  });
});
