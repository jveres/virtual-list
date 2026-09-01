/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // The sensor's rubber-band check reads the native scroll range; mirror the
  // canvas height jsdom cannot lay out.
  Object.defineProperty(viewport, "scrollHeight", {
    get: () => {
      const canvas = viewport.firstElementChild as HTMLElement | null;
      return canvas ? Number.parseFloat(canvas.style.height) || 0 : 0;
    },
  });
  document.body.appendChild(viewport);
  return viewport;
}

function mount(
  items: Msg[],
  hooks: {
    onReachStart?: () => void;
    onState?: (s: VirtualListState) => void;
    onRender?: (m: Msg) => void;
    onUnmount?: (element: HTMLElement, m: Msg) => void;
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
      hooks.onRender?.(m);
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
    onUnmount: hooks.onUnmount,
  });
  return { viewport, list, states, renders };
}

// A scroll event whose scrollTop matches no recorded programmatic write is
// classified as a user gesture. Values are chosen ≥ 2px away from any write
// target so they cannot be consumed by a stale expectation (tolerance 1px),
// and INSIDE the scroll range — an out-of-range position reads as a
// rubber-band overscroll, which the sensor refuses to settle into.
function userScroll(viewport: HTMLElement, top: number): void {
  viewport.scrollTop = top;
  viewport.dispatchEvent(new Event("scroll"));
}

function settleGesture(viewport: HTMLElement): void {
  viewport.dispatchEvent(new Event("scrollend"));
  vi.advanceTimersByTime(200); // The default strategy's settle cooldown.
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

interface ControlledRO {
  fire: (instance: number, element: HTMLElement, height: number) => void;
  /** Elements passed to observe() on the given instance, in call order. */
  observed: (instance: number) => HTMLElement[];
}

function withControlledResizeObserver<R>(run: (ro: ControlledRO) => R): R {
  const instances: { callback: ROCallback; observed: HTMLElement[] }[] = [];
  class ControlledResizeObserver {
    private readonly record: { callback: ROCallback; observed: HTMLElement[] };
    constructor(callback: ROCallback) {
      this.record = { callback, observed: [] };
      instances.push(this.record);
    }
    observe(element: Element): void {
      this.record.observed.push(element as HTMLElement);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  const original = globalThis.ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver =
    ControlledResizeObserver;
  try {
    return run({
      fire: (instance, element, height) => {
        const entry = {
          target: element,
          borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
        } as unknown as ResizeObserverEntry;
        instances[instance]?.callback([entry], null as never);
      },
      observed: (instance) => instances[instance]?.observed ?? [],
    });
  } finally {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = original;
  }
}

beforeEach(() => {
  // The sensor's settle lifecycle is timer-driven (cooldowns, stability
  // windows); the whole suite runs on fake timers.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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
    userScroll(viewport, 4398);

    list.setItems(range(0, 52));
    // Committed (not deferred), but the user owns the viewport: no write.
    expect(list.state.count).toBe(52);
    expect(viewport.scrollTop).toBe(4398);

    settleGesture(viewport);
    // Follow intent survived the suppressed write: exact landing.
    expect(viewport.scrollTop).toBe(52 * ESTIMATE - VIEWPORT_H);
  });

  it("restores exact end-follow at settle for bottom growth during a gesture (I2)", () => {
    withControlledResizeObserver((ro) => {
      const { viewport, list } = mount(range(0, 50));
      const lastRow = rowElement(viewport, "msg 49");
      userScroll(viewport, 4398);

      // The bottom row grows 100 → 300 mid-gesture (streamed image decode).
      ro.fire(0, lastRow, 300);
      expect(list.state.totalSize).toBe(50 * ESTIMATE + 200);
      expect(viewport.scrollTop).toBe(4398); // Write suppressed.

      settleGesture(viewport);
      expect(viewport.scrollTop).toBe(50 * ESTIMATE + 200 - VIEWPORT_H);
    });
  });

  it("replaces a deferred snapshot with a newer one — latest wins at settle", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4398);
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

  it("an explicit command supersedes an active gesture immediately", async () => {
    const { viewport, list } = mount(range(0, 100));
    userScroll(viewport, 9398);

    const command = list.scrollTo("start");
    // No settle wait: the command took the viewport over at once.
    expect(viewport.scrollTop).toBe(0);
    await expect(command).resolves.toBe(true);
    expect(list.state.atStart).toBe(true);
  });

  it("a takeover genuinely ends the gesture — later updates commit immediately", () => {
    const { viewport, list } = mount(range(0, 100));
    userScroll(viewport, 9398);

    void list.scrollTo("start");
    expect(viewport.scrollTop).toBe(0);
    // The gesture is over (momentum cancelled, settle fired): a structural
    // update now commits immediately instead of deferring.
    list.setItems(range(-5, 100));
    expect(list.state.count).toBe(105);
  });

  it("keeps a deferred snapshot through a glide→gesture handoff until settle", () => {
    const { viewport, list } = mount(range(0, 100));
    void list.scrollTo("start", { behavior: "smooth" });
    vi.advanceTimersByTime(48);

    list.setItems(range(-10, 100)); // Structural: deferred (glide phase).
    expect(list.state.count).toBe(100);

    // The user takes over mid-glide with real input. The phase transitions
    // programmatic → native WITHOUT going idle: nothing settles, nothing
    // flushes — the cancelled glide must not commit the snapshot.
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    userScroll(viewport, viewport.scrollTop + 120);
    expect(list.state.count).toBe(100);

    // Only the native gesture's true settle flushes it.
    settleGesture(viewport);
    expect(list.state.count).toBe(110);
  });

  it("resolves false when a glide-deferred snapshot removed the keyed target", async () => {
    const { list } = mount(range(0, 100));
    const command = list.scrollTo("m2", { behavior: "smooth" });
    vi.advanceTimersByTime(48);

    list.setItems(range(3, 100)); // Removes m2; deferred to the phase end.
    vi.advanceTimersByTime(6000); // The glide lands, then the flush commits.

    // The landing spot is where m2 USED to be; the target itself is gone.
    await expect(command).resolves.toBe(false);
    expect(list.state.count).toBe(97);
  });

  it("defers structural updates during a glide and flushes at glide end", async () => {
    const { viewport, list } = mount(range(0, 100));
    const command = list.scrollTo("start", { behavior: "smooth" });
    vi.advanceTimersByTime(48);

    list.setItems(range(-10, 100)); // Structural during the glide phase.
    expect(list.state.count).toBe(100); // Deferred, not committed.

    vi.advanceTimersByTime(4000);
    await expect(command).resolves.toBe(true);
    // The glide phase ended: the kept snapshot committed, anchored — the
    // prepend appears without movement (m0 stays at the viewport top).
    expect(list.state.count).toBe(110);
    expect(viewport.scrollTop).toBe(10 * ESTIMATE);
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
    userScroll(viewport, 4398); // Gesture at the end; follow stays engaged.

    list.setItems(range(0, 52), { anchor: "viewport" });
    expect(list.state.count).toBe(50); // Explicit policy ⇒ deferred.

    settleGesture(viewport);
    expect(list.state.count).toBe(52);
    // The stated policy wins over follow state: position held, no end jump.
    expect(viewport.scrollTop).toBe(4398);
  });

  it("honors an explicit end anchor at settle even after follow disengaged", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4398);
    userScroll(viewport, 4300); // Upward past the threshold: follow disarms.

    list.setItems(range(0, 52), { anchor: "end" });
    expect(list.state.count).toBe(50); // Explicit policy ⇒ deferred.

    settleGesture(viewport);
    expect(viewport.scrollTop).toBe(52 * ESTIMATE - VIEWPORT_H);
    expect(list.state.atEnd).toBe(true);
  });

  it("disengages follow on cumulative sub-pixel upward drift", () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4398);
    // -0.75px per event: no single step exceeds the threshold, but the
    // cumulative distance from the gesture's high-water mark does.
    for (const top of [4397.25, 4396.5, 4395.75, 4395, 4394.25, 4393.5]) {
      userScroll(viewport, top);
    }

    settleGesture(viewport);
    // Follow disengaged: settle preserves the position, no snap to the end.
    expect(viewport.scrollTop).toBe(4393.5);
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

  it("runs a takeover-flush-queued command after the takeover's own, so it wins", () => {
    let listRef: VirtualList<Msg> | null = null;
    let once = false;
    const { viewport, list } = mount(range(0, 100), {
      onState: (state) => {
        if (!listRef || once || state.count !== 105) return;
        once = true;
        // Queued during the takeover flush's publication: must execute
        // after the takeover's own scrollTo("start"), not before it.
        void listRef.scrollTo("m20");
      },
    });
    listRef = list;

    userScroll(viewport, 9398);
    list.setItems(range(-5, 100)); // Structural: deferred during the gesture.
    // The command takes over: flushes the deferred snapshot (whose
    // publication queues the newer command), then runs — the newer command
    // drains afterwards and wins.
    void list.scrollTo("start");
    // m20 sits at index 25 in the new list — the newer command's target.
    expect(viewport.scrollTop).toBe(25 * ESTIMATE);
  });

  it("aborts reconciliation when render() disposes the list", () => {
    let listRef: VirtualList<Msg> | null = null;
    const { viewport, list } = mount(range(0, 10), {
      onRender: (m) => {
        if (m.id === 99) listRef?.dispose();
      },
    });
    listRef = list;

    expect(() => list.setItems([...range(0, 10), message(99)])).not.toThrow();
    // The canvas is gone and nothing was re-appended, observed, or
    // bookkept after the disposing render call.
    expect(viewport.children.length).toBe(0);
  });

  it("captures a queued setItems snapshot at call time (owned inputs)", () => {
    let listRef: VirtualList<Msg> | null = null;
    let once = false;
    const { list } = mount(range(0, 10), {
      onState: (state) => {
        if (!listRef || once || state.count !== 12) return;
        once = true;
        const next = range(0, 5);
        listRef.setItems(next);
        next.push(message(99)); // Mutated after the call, before the queue drains.
      },
    });
    listRef = list;

    list.setItems(range(0, 12));
    expect(list.state.count).toBe(5); // The mutation never leaked in.
  });

  it("lets a command from a cancelled glide's publication beat the interrupter", () => {
    vi.useFakeTimers();
    try {
      let listRef: VirtualList<Msg> | null = null;
      let once = false;
      const { viewport, list } = mount(range(0, 100), {
        onState: (state) => {
          // First fires from the cancelled glide's onDone publication —
          // the only pre-cancel publication with atEnd false.
          if (!listRef || once || state.atEnd) return;
          once = true;
          listRef.scrollTo("end");
        },
      });
      listRef = list;

      list.scrollTo("start", { behavior: "smooth" });
      vi.advanceTimersByTime(48); // A few glide frames toward 0.
      expect(viewport.scrollTop).toBeLessThan(100 * ESTIMATE - VIEWPORT_H);

      // The interrupting command cancels the glide inside its own guard, so
      // the newer scrollTo("end") issued by the cancellation's onState
      // drains after the whole "m30" command — and wins.
      list.scrollTo("m30");
      expect(viewport.scrollTop).toBe(100 * ESTIMATE - VIEWPORT_H);
    } finally {
      vi.useRealTimers();
    }
  });

  it("absorbs above-viewport growth during a gesture with zero scroll writes", () => {
    withControlledResizeObserver((ro) => {
      const { viewport, list } = mount(range(0, 50));
      void list.scrollTo("m30");
      userScroll(viewport, 3005);

      // A mounted row wholly above the viewport grows 100 → 300 mid-gesture.
      ro.fire(0, rowElement(viewport, "msg 25"), 300);

      // The measurement committed immediately: total size and the positions
      // of the rows below are current (no overlapping boxes)...
      expect(list.state.totalSize).toBe(50 * ESTIMATE + 200);
      expect(rowElement(viewport, "msg 30").style.transform).toBe(
        `translateY(${30 * ESTIMATE + 200}px)`,
      );
      // ...with NO scrollTop write — the anchor delta became a canvas
      // translation of the opposite sign (the gesture shift).
      expect(viewport.scrollTop).toBe(3005);
      const canvas = viewport.firstElementChild as HTMLElement;
      expect(canvas.style.transform).toBe("translateY(-200px)");

      settleGesture(viewport);
      // Settle exchanges the shift for one scrollTop write in the same
      // frame — visually a no-op — and the flush preserves the position.
      expect(viewport.scrollTop).toBe(3005 + 200);
      expect(canvas.style.transform).toBe("");
    });
  });

  it("scrollTo resolves true on completion", async () => {
    const { viewport, list } = mount(range(0, 100));
    await expect(list.scrollTo("start")).resolves.toBe(true);
    expect(viewport.scrollTop).toBe(0);

    vi.useFakeTimers();
    try {
      const glide = list.scrollTo("end", { behavior: "smooth" });
      vi.advanceTimersByTime(3000);
      await expect(glide).resolves.toBe(true);
      expect(viewport.scrollTop).toBe(100 * ESTIMATE - VIEWPORT_H);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrollTo resolves false when a newer command interrupts the glide", async () => {
    vi.useFakeTimers();
    try {
      const { viewport, list } = mount(range(0, 100));
      const first = list.scrollTo("start", { behavior: "smooth" });
      vi.advanceTimersByTime(48);
      const second = list.scrollTo("m10");
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(true);
      expect(viewport.scrollTop).toBe(10 * ESTIMATE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a newer command supersedes a takeover glide: false, then true", async () => {
    vi.useFakeTimers();
    try {
      const { viewport, list } = mount(range(0, 100));
      userScroll(viewport, 9398);

      const first = list.scrollTo("start", { behavior: "smooth" }); // Takeover.
      vi.advanceTimersByTime(48);
      const second = list.scrollTo("m20"); // Newer command wins.

      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(true);
      expect(viewport.scrollTop).toBe(20 * ESTIMATE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unmounts with the element and its item — scroll-out, replacement, dispose", () => {
    const unmounted: number[] = [];
    const initial = range(0, 100);
    const { list } = mount(initial, {
      replaceOnRerender: true,
      onUnmount: (element, m) => {
        expect(element.isConnected).toBe(false);
        unmounted.push(m.id);
      },
    });

    list.scrollTo("start"); // The rows near the end scroll out.
    expect(unmounted).toContain(99);

    const next = [...initial];
    next[0] = message(0, "updated body"); // Replacement unmounts the old element.
    list.setItems(next);
    expect(unmounted).toContain(0);

    unmounted.length = 0;
    list.dispose(); // Every still-mounted row is reported.
    expect(unmounted.length).toBeGreaterThan(0);
    expect(new Set(unmounted).size).toBe(unmounted.length);
  });

  it("resolves a command queued behind a disposing callback as interrupted", async () => {
    let listRef: VirtualList<Msg> | null = null;
    let queued: Promise<boolean> | null = null;
    let once = false;
    const { list } = mount(range(0, 30), {
      onState: (state) => {
        if (!listRef || once || state.count !== 40) return;
        once = true;
        queued = listRef.scrollTo("start"); // Queued behind the open commit.
        listRef.dispose(); // Drops the queue — the promise must still settle.
      },
    });
    listRef = list;

    list.setItems(range(0, 40));
    await expect(queued).resolves.toBe(false);
  });

  it("resolves false for a missing target without moving or pinning", async () => {
    const { viewport, list } = mount(range(0, 50));
    const top = viewport.scrollTop;
    const total = list.state.totalSize;

    await expect(list.scrollTo("nope")).resolves.toBe(false);
    expect(viewport.scrollTop).toBe(top);
    expect(list.state.totalSize).toBe(total); // No pin, no reserve.
  });

  it("resolves false when the takeover-flushed snapshot removed the target", async () => {
    const { viewport, list } = mount(range(0, 50));
    userScroll(viewport, 4398);

    list.setItems(range(0, 49)); // Structural: removes m49, deferred.
    // The takeover flushes the snapshot first; the command's target is gone.
    const command = list.scrollTo("m49");

    await expect(command).resolves.toBe(false);
    expect(list.state.count).toBe(49); // The flush did apply.
  });

  it("defers observing rows mounted by a measurement commit to the next frame", () => {
    vi.useFakeTimers();
    try {
      withControlledResizeObserver((ro) => {
        const { viewport, list } = mount(range(0, 50));
        void list.scrollTo("m30");
        userScroll(viewport, 3005);
        const observedBefore = ro.observed(0).length;

        // Shrinking a row above the anchor compensates the scroll upward,
        // which mounts a new row above the old window — from inside the
        // observer's delivery.
        ro.fire(0, rowElement(viewport, "msg 25"), 20);

        const newRow = rowElement(viewport, "msg 23"); // Mounted by the commit.
        // Observing it synchronously would leave an undeliverable
        // notification in this delivery loop; it registers next frame.
        expect(ro.observed(0)).toHaveLength(observedBefore);
        vi.advanceTimersByTime(32);
        expect(ro.observed(0)).toContain(newRow);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose removes the canvas and stops reacting", () => {
    const { viewport, list } = mount(range(0, 10));
    list.dispose();
    expect(viewport.children.length).toBe(0);
    expect(() => list.setItems(range(0, 5))).not.toThrow();
  });
});
