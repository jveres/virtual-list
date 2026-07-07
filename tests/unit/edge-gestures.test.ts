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
    vi.advanceTimersByTime(1200); // held, motionless, inside the last resort
    expect(harness.applies()).toBe(0);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    // Firefox defers scrollend until the gesture truly ends: the release.
    harness.scrollEnd();
    vi.advanceTimersByTime(300);
    expect(harness.applies()).toBe(1);
    expect(harness.list.state.count).toBe(150);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("firefox: a missing scrollend cannot strand the load (long last resort)", () => {
    const harness = mountEdgeDemo("firefox-wheel");
    momentumScrollTo(harness, harness.maxScrollTop() - 0.8);
    harness.wheel(8);

    vi.advanceTimersByTime(1200);
    expect(harness.applies()).toBe(0); // still waiting for the release

    vi.advanceTimersByTime(2500); // past the last resort
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

    vi.advanceTimersByTime(600);
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

    harness.scrollEnd(); // release
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
