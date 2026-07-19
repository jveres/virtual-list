/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualListScrollSettleStrategy } from "../../src/scroll-settle";
import { createVirtualList, type VirtualList } from "../../src/virtual-list";

// The per-engine gesture contract at overscrolled edges (see the
// scroll-settle module header): deferred boundary loads must apply only when
// a gesture settles, and engines pin scroll positions FRACTIONALLY shy of the
// exact limit — up to ~1px — so edge decisions must tolerate that gap.
// These traces reproduce two real-browser failures that shipped when edge
// proximity was judged with the 0.5px measure epsilon:
// - chromium: the wheel-idle dead-end wedged the gesture forever, leaving a
//   deferred load stuck until the user scrolled away and back.
// - firefox: the fallback timer settled mid-overscroll, applying the load
//   under the user's fingers and flashing the content.

const VIEWPORT_HEIGHT = 300;
const ROW = 50;

interface EdgeHarness {
  list: VirtualList;
  viewport: HTMLElement;
  onScrollStart: ReturnType<typeof vi.fn>;
  onScrollEnd: ReturnType<typeof vi.fn>;
  applies: () => number;
  count: () => number;
  scrollTo: (top: number) => void;
  wheel: (deltaY: number) => void;
  scrollEnd: () => void;
  maxScrollTop: () => number;
}

const live: EdgeHarness[] = [];

function mountEdgeDemo(strategy: VirtualListScrollSettleStrategy): EdgeHarness {
  const viewport = document.createElement("div");
  document.body.appendChild(viewport);

  const contentHeight = (): number => {
    const content = viewport.firstElementChild;
    return content instanceof HTMLElement
      ? Number.parseFloat(content.style.height || "0")
      : 0;
  };
  const scrollHeight = (): number => Math.max(VIEWPORT_HEIGHT, contentHeight());
  const maxScrollTop = (): number => scrollHeight() - VIEWPORT_HEIGHT;

  let scrollTop = 0;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_HEIGHT },
    clientWidth: { get: () => 300 },
    offsetWidth: { get: () => 300 },
    scrollHeight: { get: scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.max(0, Math.min(maxScrollTop(), next));
      },
    },
  });
  (
    viewport as unknown as { scrollTo: (options: ScrollToOptions) => void }
  ).scrollTo = (options) => {
    if (options.top !== undefined) viewport.scrollTop = options.top;
  };

  let count = 100;
  let loading = false;
  let applies = 0;
  const onScrollStart = vi.fn();
  const onScrollEnd = vi.fn();
  const list: VirtualList = createVirtualList({
    viewport,
    getCount: () => count,
    getItemHeight: () => ROW,
    buildItem: (index) => {
      const element = document.createElement("div");
      element.textContent = `item ${index}`;
      return element;
    },
    scrollSettleStrategy: strategy,
    onScrollStart,
    onScrollEnd,
    onReachBottom: () => {
      if (loading) return;
      loading = true;
      // Chunk arrives 180ms later; the runtime must defer it to settle.
      setTimeout(() => {
        count += 50;
        list.syncLayout({
          apply: () => {
            applies++;
            loading = false;
            return true;
          },
        });
      }, 180);
    },
  });

  const harness: EdgeHarness = {
    list,
    viewport,
    onScrollStart,
    onScrollEnd,
    applies: () => applies,
    count: () => count,
    scrollTo: (top) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(17);
    },
    wheel: (deltaY) =>
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY })),
    scrollEnd: () => viewport.dispatchEvent(new Event("scrollend")),
    maxScrollTop,
  };
  live.push(harness);
  return harness;
}

/** Momentum-scroll to `edge` in 120px steps with accompanying wheel events. */
function momentumScrollTo(harness: EdgeHarness, edge: number): void {
  let top = 4000;
  while (top < edge) {
    harness.wheel(120);
    top = Math.min(edge, top + 120);
    harness.scrollTo(top);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const harness of live.splice(0)) {
    harness.list.dispose();
    harness.viewport.remove();
  }
  vi.useRealTimers();
});

describe("fractional-edge gestures", () => {
  it("chromium: a trailing wheel after the lone scrollend never wedges the gesture", () => {
    const harness = mountEdgeDemo("chromium-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);

    // Chromium fires its single scrollend at the edge, then momentum wheels
    // keep arriving with fingers down; each one consumes the pending settle.
    harness.scrollEnd();
    vi.advanceTimersByTime(30);
    for (let i = 0; i < 6; i++) {
      harness.wheel(30);
      vi.advanceTimersByTime(60);
    }
    expect(harness.applies()).toBe(0); // still deferred mid-gesture

    // True quiet: the accepted chromium contract is apply-after-a-delay.
    // Before the stall fallback this wedged forever (the load stayed stuck
    // until the user scrolled away and back).
    vi.advanceTimersByTime(5000);
    expect(harness.applies()).toBe(1);
    expect(harness.list.state.count).toBe(150);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("firefox: holds through momentum-tail gaps and stillness until the release scrollend", () => {
    const harness = mountEdgeDemo("firefox-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);

    // Sparse momentum wheels at the pinned fractional edge, fingers down. The
    // 350ms gaps exceed the old 280ms fallback window (which used to settle
    // inside them and flash the list). Then a motionless hold: still no
    // apply — any timer apply during a held overscroll flashes in Firefox.
    for (let i = 0; i < 5; i++) {
      harness.wheel(8);
      vi.advanceTimersByTime(350);
    }
    vi.advanceTimersByTime(5000); // held, motionless — no timer may fire
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    // Firefox defers scrollend until the gesture truly ends: the release. The
    // previous wheel signal has already been quiet for several seconds, so
    // only the paint-aligned commit frame remains.
    harness.scrollEnd();
    expect(harness.applies()).toBe(0);
    vi.advanceTimersToNextFrame();
    expect(harness.applies()).toBe(1);
    expect(harness.list.state.count).toBe(150);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("firefox: never settles from a timer at the edge; the next gesture recovers a missed scrollend", () => {
    const harness = mountEdgeDemo("firefox-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);
    harness.wheel(8);

    // No timer may ever apply here: doing so while the engine gesture is
    // alive flashes and leaves a ghost end no main-thread reset can clear.
    vi.advanceTimersByTime(10_000);
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    // The scrollend was missed entirely; the user scrolls away and that
    // gesture's settle applies the deferred load.
    harness.scrollTo(3000);
    harness.scrollEnd();
    vi.advanceTimersByTime(300);
    expect(harness.applies()).toBe(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("firefox: the release scrollend survives its trailing momentum-end wheels", () => {
    const harness = mountEdgeDemo("firefox-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);

    // The user releases: Firefox fires the deferred scrollend, then delivers
    // a few trailing momentum-end wheel events. Those wheels must not destroy
    // the release settle (that starved the load and left the spinner forever);
    // the gesture settles one cooldown after they go idle.
    vi.advanceTimersByTime(300);
    harness.scrollEnd(); // the release
    vi.advanceTimersByTime(50);
    harness.wheel(8); // trailing momentum-end wheels
    vi.advanceTimersByTime(40);
    harness.wheel(4);

    // The trailing wheels re-arm the stability window rather than destroying
    // the
    // pending settle (that starved the load before) or being cooked at the
    // short cooldown (that applied mid-gesture before).
    vi.advanceTimersByTime(400);
    expect(harness.applies()).toBe(0); // still inside idle + stability wait
    vi.advanceTimersByTime(1300);
    expect(harness.applies()).toBe(1);
    expect(harness.list.state.count).toBe(150);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("firefox: momentum scrolls without wheel events cannot fallback-settle at the edge", () => {
    const harness = mountEdgeDemo("firefox-wheel");

    // Momentum delivered as bare scroll events (no accompanying wheels), so
    // the generic scroll-end fallback is the only timer that could arm.
    let top = 4300;
    while (top < harness.maxScrollTop() - 0.8) {
      top = Math.min(harness.maxScrollTop() - 0.8, top + 80);
      harness.scrollTo(top);
      vi.advanceTimersByTime(63);
    }
    vi.advanceTimersByTime(2000); // held at the edge, no release yet
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    harness.scrollEnd(); // release, honored after the stability window
    vi.advanceTimersByTime(1700);
    expect(harness.applies()).toBe(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("firefox: a scrollend inside a momentum-wheel gap cannot settle mid-hold", () => {
    const harness = mountEdgeDemo("firefox-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);

    // Momentum wheels with 300ms gaps; a scrollend slips into one of the
    // gaps (Firefox emits one whenever scrolling pauses). The old 140ms
    // cooldown applied the load inside the gap — mid-hold, randomly.
    harness.wheel(12);
    vi.advanceTimersByTime(150);
    harness.scrollEnd(); // scrolling paused; the gesture is still alive
    vi.advanceTimersByTime(150);
    for (let i = 0; i < 4; i++) {
      harness.wheel(8); // ...as these wheels prove
      vi.advanceTimersByTime(300);
    }
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    // Wheels stop for good: the stability window elapses and the gesture settles.
    vi.advanceTimersByTime(1400);
    expect(harness.applies()).toBe(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      trailingEvent: "a pinned scroll event",
      dispatch: (harness: EdgeHarness) =>
        harness.viewport.dispatchEvent(new Event("scroll")),
      waitMs: 200,
    },
    {
      trailingEvent: "zero-delta wheel jitter",
      dispatch: (harness: EdgeHarness) => harness.wheel(0),
      waitMs: 350,
    },
  ])(
    "firefox: $trailingEvent cannot shorten the edge stability wait",
    ({ dispatch, waitMs }) => {
      const harness = mountEdgeDemo("firefox-wheel");
      momentumScrollTo(harness, harness.maxScrollTop() - 0.8);

      // Let the async load arrive and remain deferred while the touchpad
      // gesture is held at the edge, then replay Firefox's mid-hold end.
      vi.advanceTimersByTime(200);
      harness.scrollEnd();
      dispatch(harness);

      // Pinned scroll events and neutral wheel jitter used to replace the
      // protected edge wait with the generic 140ms cooldown, flushing here.
      vi.advanceTimersByTime(waitMs);
      expect(harness.applies()).toBe(0);
      expect(harness.onScrollEnd).not.toHaveBeenCalled();

      // A later scrollend is the actual release and may apply the load.
      harness.scrollEnd();
      vi.advanceTimersByTime(1700);
      expect(harness.applies()).toBe(1);
      expect(harness.list.state.count).toBe(150);
      expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
    },
  );

  it("firefox: edge chrome growth cannot downgrade a pending release", () => {
    const harness = mountEdgeDemo("firefox-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);
    vi.advanceTimersByTime(200);

    harness.scrollEnd();
    harness.list.setBoundarySlot("bottom", {
      key: "taller-spinner",
      height: 80,
      build: () => document.createElement("div"),
    });
    harness.scrollEnd();

    // Growing the slot moves the native bottom away from scrollTop. A later
    // scrollend must retain the edge classification, not switch to 140ms.
    vi.advanceTimersByTime(200);
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1400);
    expect(harness.applies()).toBe(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("safari: a bounce-tail event gap longer than the cooldown cannot settle at the edge", () => {
    const harness = mountEdgeDemo("safari-wheel");
    const max = harness.maxScrollTop();
    momentumScrollTo(harness, max - 0.8); // reach fires; the load defers

    // Early scrollend, then a bounce event after a gap that exceeds the
    // 140ms cooldown. The old behavior settled 280ms after that event —
    // inside the still-decaying bounce — and the settle's anchor writes
    // (a bottom load trims the retained top) snapped the animation.
    harness.scrollEnd();
    vi.advanceTimersByTime(200);
    harness.scrollTo(max - 0.5); // the bounce is still delivering events

    vi.advanceTimersByTime(283); // past the old cooldown-based settle point
    expect(harness.onScrollEnd).not.toHaveBeenCalled();
    expect(harness.applies()).toBe(0);

    // 350ms of genuine scroll-event silence: the bounce is over, settle.
    vi.advanceTimersByTime(300);
    expect(harness.applies()).toBe(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("safari: sub-pixel decaying motion keeps canceling a pending settle", () => {
    const harness = mountEdgeDemo("safari-wheel");
    const max = harness.maxScrollTop();
    momentumScrollTo(harness, max - 0.8); // reach fires; the load defers

    // Safari fires an early scrollend while decaying momentum still moves in
    // sub-0.5px steps; settling into that motion writes scrollTop and kills
    // the animation. Every real movement must cancel the pending settle.
    harness.scrollEnd();
    const decayingOffsets = [0.6, 0.45, 0.55, 0.4, 0.5, 0.38, 0.48, 0.36];
    for (const offset of decayingOffsets) {
      harness.scrollTo(max - offset);
      vi.advanceTimersByTime(120);
    }
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    // Release: scrollend at rest applies the deferred load.
    harness.scrollEnd();
    vi.advanceTimersByTime(300);
    expect(harness.applies()).toBe(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });
});
