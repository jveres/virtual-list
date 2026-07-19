/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScrollSettleController } from "../../src/scroll-settle";
import {
  createVirtualList,
  detectScrollSettleStrategy,
  type VirtualList,
  type VirtualListScrollSettleStrategy,
} from "../../src/virtual-list";

// Characterization tests for the scroll-settle state machine: the per-engine
// heuristics that decide when a user scroll gesture has finished — and thus
// when deferred layout updates and measurements may flush and onScrollEnd may
// fire. jsdom performs no real scrolling, so the harness mocks the viewport
// geometry and replays the event sequences each engine actually emits; fake
// timers make the idle/cooldown windows (140ms wheel idle and settle cooldown,
// 450ms chromium edge quiet period) deterministic. These pin the machine's
// externally observable contract ahead of any extraction refactor.

const ITEM_HEIGHT = 50;
const VIEWPORT_HEIGHT = 300;
const CLIENT_WIDTH = 300;
const OFFSET_WIDTH = 315; // 15px classic scrollbar gutter

// jsdom has no PointerEvent; a MouseEvent subclass carrying pointerId and
// pointerType is enough for the pointer listeners. Installed at module load so
// createVirtualList sees "PointerEvent" in window and attaches them.
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}
if (!("PointerEvent" in window)) {
  (
    window as unknown as { PointerEvent: typeof FakePointerEvent }
  ).PointerEvent = FakePointerEvent;
}

interface SettleHarness {
  list: VirtualList;
  viewport: HTMLElement;
  onScrollStart: ReturnType<typeof vi.fn>;
  onScrollEnd: ReturnType<typeof vi.fn>;
  /** Set the value getCount() returns; follow with list.syncLayout(). */
  setCountValue: (next: number) => void;
  /** Set the modeled height returned for every item. */
  setItemHeightValue: (next: number) => void;
  /** Move the mocked scrollTop and dispatch a scroll event, like a real scroll. */
  scrollTo: (top: number) => void;
  wheel: (deltaY: number) => void;
  scrollEnd: () => void;
  pointerDown: (clientX: number) => void;
  pointerUp: () => void;
  maxScrollTop: () => number;
}

const liveHarnesses: SettleHarness[] = [];

function mountScrollList(
  strategy: VirtualListScrollSettleStrategy,
  initialCount = 100,
  boundaries: { top?: boolean; bottom?: boolean } = {},
): SettleHarness {
  const viewport = document.createElement("div");
  document.body.appendChild(viewport);

  // Geometry the library reads but jsdom doesn't lay out: the content div's
  // style.height (which the list itself writes) backs scrollHeight, so
  // nativeMaxScrollTop() tracks count changes exactly like a real browser.
  const contentHeight = (): number => {
    const content = viewport.firstElementChild;
    return content instanceof HTMLElement
      ? Number.parseFloat(content.style.height || "0")
      : 0;
  };
  const scrollHeight = (): number => Math.max(VIEWPORT_HEIGHT, contentHeight());
  const maxScrollTop = (): number => scrollHeight() - VIEWPORT_HEIGHT;

  let scrollTop = 0;
  let itemHeight = ITEM_HEIGHT;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_HEIGHT },
    clientWidth: { get: () => CLIENT_WIDTH },
    offsetWidth: { get: () => OFFSET_WIDTH },
    scrollHeight: { get: scrollHeight },
    scrollTop: {
      get: () => {
        scrollTop = Math.max(0, Math.min(maxScrollTop(), scrollTop));
        return scrollTop;
      },
      set: (next: number) => {
        // Browsers clamp scrollTop writes to the scrollable range.
        scrollTop = Math.max(0, Math.min(maxScrollTop(), next));
      },
    },
  });
  (
    viewport as unknown as { scrollTo: (options: ScrollToOptions) => void }
  ).scrollTo = (options) => {
    if (options.top !== undefined) viewport.scrollTop = options.top;
  };

  let count = initialCount;
  const onScrollStart = vi.fn();
  const onScrollEnd = vi.fn();
  const list = createVirtualList({
    viewport,
    getCount: () => count,
    getItemHeight: () => itemHeight,
    buildItem: (index) => {
      const element = document.createElement("div");
      element.textContent = `item ${index}`;
      return element;
    },
    scrollSettleStrategy: strategy,
    onScrollStart,
    onScrollEnd,
    onReachTop: boundaries.top ? () => {} : undefined,
    onReachBottom: boundaries.bottom ? () => {} : undefined,
  });

  const harness: SettleHarness = {
    list,
    viewport,
    onScrollStart,
    onScrollEnd,
    setCountValue: (next) => {
      count = next;
    },
    setItemHeightValue: (next) => {
      itemHeight = next;
    },
    scrollTo: (top) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
    },
    wheel: (deltaY) => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY }));
    },
    scrollEnd: () => {
      viewport.dispatchEvent(new Event("scrollend"));
    },
    pointerDown: (clientX) => {
      viewport.dispatchEvent(
        new window.PointerEvent("pointerdown", {
          pointerId: 1,
          pointerType: "mouse",
          clientX,
        }),
      );
    },
    pointerUp: () => {
      window.dispatchEvent(
        new window.PointerEvent("pointerup", {
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    },
    maxScrollTop,
  };
  liveHarnesses.push(harness);
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const harness of liveHarnesses.splice(0)) {
    harness.list.dispose();
    harness.viewport.remove();
  }
  vi.useRealTimers();
});

describe("detectScrollSettleStrategy", () => {
  const CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const EDGE = `${CHROME} Edg/126.0.0.0`;
  const FIREFOX =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0";
  const SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const IOS_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  it("classifies Chrome as chromium-wheel despite its Safari/ token", () => {
    expect(detectScrollSettleStrategy(CHROME)).toBe("chromium-wheel");
  });

  it("classifies Edge as chromium-wheel", () => {
    expect(detectScrollSettleStrategy(EDGE)).toBe("chromium-wheel");
  });

  it("classifies Firefox as firefox-wheel", () => {
    expect(detectScrollSettleStrategy(FIREFOX)).toBe("firefox-wheel");
  });

  it("classifies Safari (Version/ + Safari/) as safari-wheel", () => {
    expect(detectScrollSettleStrategy(SAFARI)).toBe("safari-wheel");
    expect(detectScrollSettleStrategy(IOS_SAFARI)).toBe("safari-wheel");
  });

  it("falls back to default for unrecognized engines", () => {
    expect(
      detectScrollSettleStrategy("Mozilla/5.0 (compatible; Bot/1.0)"),
    ).toBe("default");
  });
});

describe("controller disposal continuation", () => {
  it("should not schedule wheel settling after the start callback disposes", () => {
    const viewport = document.createElement("div");
    let disposed = false;
    const settled = vi.fn();
    const controller = createScrollSettleController({
      viewport,
      strategy: "safari-wheel",
      measureEpsilon: 0.5,
      isDisposed: () => disposed,
      canLoadAtBoundary: () => false,
      cancelActiveSmoothScroll: vi.fn(),
      smoothScrollReachedTarget: () => true,
      onGestureActivity: vi.fn(),
      onGestureStarted: () => {
        disposed = true;
      },
      onGestureSettled: settled,
      onGestureReset: vi.fn(),
      onScrollEventObserved: vi.fn(),
      onNativeScrollEndIdle: vi.fn(),
    });

    try {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 8 }));

      expect(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      expect(settled).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it("should not settle after the reset callback disposes", () => {
    const viewport = document.createElement("div");
    let disposed = false;
    const reset = vi.fn(() => {
      disposed = true;
    });
    const settled = vi.fn();
    const controller = createScrollSettleController({
      viewport,
      strategy: "default",
      measureEpsilon: 0.5,
      isDisposed: () => disposed,
      canLoadAtBoundary: () => false,
      cancelActiveSmoothScroll: vi.fn(),
      smoothScrollReachedTarget: () => true,
      onGestureActivity: vi.fn(),
      onGestureStarted: vi.fn(),
      onGestureSettled: settled,
      onGestureReset: reset,
      onScrollEventObserved: vi.fn(),
      onNativeScrollEndIdle: vi.fn(),
    });

    try {
      controller.beginProgrammaticGesture();
      controller.finishGesture();

      expect(reset).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.dispose();
    }
  });

  it("should not re-arm a smooth-scroll frame after rendering disposes", async () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let scrollTop = 0;
    Object.defineProperties(viewport, {
      clientHeight: { get: () => VIEWPORT_HEIGHT },
      clientWidth: { get: () => CLIENT_WIDTH },
      scrollHeight: { get: () => 5_000 },
      scrollTop: {
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = Math.max(0, Math.min(4_700, next));
        },
      },
    });
    (
      viewport as unknown as { scrollTo: (options: ScrollToOptions) => void }
    ).scrollTo = (options) => {
      if (options.top !== undefined) viewport.scrollTop = options.top;
    };
    let disposeOnRange = false;
    let list: VirtualList;
    const onScrollEnd = vi.fn();
    list = createVirtualList({
      viewport,
      getCount: () => 100,
      getItemHeight: () => 50,
      buildItem: () => document.createElement("div"),
      onRangeChange: () => {
        if (disposeOnRange) list.dispose();
      },
      onScrollEnd,
    });
    disposeOnRange = true;

    try {
      const completed = list.scrollToBottom({
        behavior: "smooth",
        duration: 300,
      });
      vi.advanceTimersByTime(34);

      await expect(completed).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(onScrollEnd).not.toHaveBeenCalled();
    } finally {
      list.dispose();
      viewport.remove();
    }
  });
});

describe("default strategy", () => {
  it("settles one cooldown after scrollend, emitting a single start/end pair", () => {
    const harness = mountScrollList("default");

    harness.scrollTo(100);
    harness.scrollTo(200);
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    harness.scrollEnd();
    vi.advanceTimersByTime(100); // inside the 140ms cooldown
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
  });

  it("defers count changes during a user scroll and applies them on settle", () => {
    const harness = mountScrollList("default");

    harness.scrollTo(100);
    harness.setCountValue(150);
    harness.list.syncLayout();
    expect(harness.list.state.count).toBe(100); // deferred while scrolling

    harness.scrollEnd();
    vi.advanceTimersByTime(200);
    expect(harness.list.state.count).toBe(150);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("does not treat a measurement-invalidation clamp as a user scroll", () => {
    const harness = mountScrollList("default");

    harness.viewport.scrollTop = harness.maxScrollTop();
    harness.setItemHeightValue(40);
    harness.list.invalidateMeasurements();

    // The content shrink clamps the native scrollTop before the browser emits
    // its scroll echo. That landing belongs to the invalidation, not the user.
    harness.viewport.dispatchEvent(new Event("scroll"));
    expect(harness.onScrollStart).not.toHaveBeenCalled();

    harness.setCountValue(101);
    harness.list.syncLayout({ apply: () => true });
    expect(harness.list.state.count).toBe(101);
  });

  it("interrupts an active scroll and commits its deferred work exactly once", () => {
    const harness = mountScrollList("default");
    const apply = vi.fn(() => {
      harness.setCountValue(101);
      return true;
    });

    harness.scrollTo(100);
    harness.list.syncLayout({ apply });
    expect(apply).not.toHaveBeenCalled();
    expect(harness.list.state.count).toBe(100);

    harness.list.interruptScroll();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(harness.list.state.count).toBe(101);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("does nothing when interruptScroll is called while idle", () => {
    const harness = mountScrollList("default");

    harness.list.interruptScroll();

    expect(harness.onScrollStart).not.toHaveBeenCalled();
    expect(harness.onScrollEnd).not.toHaveBeenCalled();
  });

  it("keeps follow-bottom alive through its own scroll echoes; a user scroll tears it down", () => {
    const harness = mountScrollList("default");

    harness.list.followBottom();
    vi.advanceTimersByTime(50); // a few animation frames
    expect(harness.viewport.scrollTop).toBe(harness.maxScrollTop());

    // The browser echoes the follow write as a scroll event; matching it to the
    // recorded programmatic target must keep it from reading as a user scroll.
    harness.viewport.dispatchEvent(new Event("scroll"));
    expect(harness.onScrollStart).not.toHaveBeenCalled();

    harness.setCountValue(120);
    harness.list.syncLayout();
    vi.advanceTimersByTime(50);
    expect(harness.viewport.scrollTop).toBe(harness.maxScrollTop()); // chased growth

    harness.scrollTo(1000); // no pending programmatic target: a real user scroll
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
    harness.scrollEnd();
    vi.advanceTimersByTime(200);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);

    harness.setCountValue(140);
    harness.list.syncLayout();
    vi.advanceTimersByTime(100);
    expect(harness.viewport.scrollTop).toBe(1000); // follow stayed torn down
  });
});

describe("chromium-wheel strategy", () => {
  it("holds settle until the wheel idle window passes after scrollend", () => {
    const harness = mountScrollList("chromium-wheel");

    harness.wheel(100);
    harness.scrollTo(100);
    harness.scrollTo(200);
    harness.scrollEnd();

    // Wheel idle (140ms) elapses first, which restarts the settle cooldown.
    vi.advanceTimersByTime(150);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
  });

  it("suppresses boundary scrollend and settles via the edge quiet fallback", () => {
    const harness = mountScrollList("chromium-wheel");

    harness.viewport.scrollTop = harness.maxScrollTop(); // parked at the bottom
    harness.wheel(100); // outward wheel: nothing can move
    harness.scrollEnd(); // chromium emits scrollend immediately at the edge

    // 140ms wheel idle + 450ms edge quiet + 140ms cooldown ≈ 730ms.
    vi.advanceTimersByTime(500);
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
  });
});

describe.each(["firefox-wheel", "safari-wheel"] as const)(
  "%s strategy",
  (strategy) => {
    it("drops an early scrollend while the wheel glide is still moving", () => {
      const harness = mountScrollList(strategy);

      harness.wheel(100);
      harness.scrollTo(100);
      harness.scrollEnd(); // engine fires scrollend before the glide settles

      vi.advanceTimersByTime(50);
      harness.scrollTo(200); // glide keeps moving: pending settle must drop
      harness.wheel(100);

      vi.advanceTimersByTime(200);
      expect(harness.onScrollEnd).not.toHaveBeenCalled();

      // Wheel idle, then the scroll-end fallback, then the cooldown.
      vi.advanceTimersByTime(300);
      expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
      expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
    });

    it("cancels a wheel tap that never moves the viewport without emitting scroll end", () => {
      const harness = mountScrollList(strategy);

      harness.viewport.scrollTop = 1000; // mid-list: not an outward boundary tap
      harness.wheel(1);
      expect(harness.onScrollStart).toHaveBeenCalledTimes(1);

      harness.scrollEnd(); // no movement happened
      vi.advanceTimersByTime(1000);
      expect(harness.onScrollEnd).not.toHaveBeenCalled();

      // The machine is idle again: the next real scroll starts a fresh gesture.
      harness.scrollTo(1200);
      expect(harness.onScrollStart).toHaveBeenCalledTimes(2);
    });
  },
);

describe("firefox edge release policy", () => {
  it("uses the generic settle policy at an edge without a load callback", () => {
    // Matches the streaming demo: older messages load at the top, but the
    // transcript tail is complete and cannot grow through onReachBottom.
    const harness = mountScrollList("firefox-wheel", 100, { top: true });
    harness.scrollTo(harness.maxScrollTop() - 0.8);
    harness.wheel(8);
    vi.advanceTimersByTime(150);

    harness.scrollEnd();
    vi.advanceTimersByTime(200);

    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("does not hydrate placeholders when neutral wheel jitter goes idle", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    let scrollTop = 700;
    Object.defineProperties(viewport, {
      clientHeight: { get: () => 300 },
      scrollHeight: { get: () => 1_000 },
      scrollTop: {
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = Math.max(0, Math.min(700, next));
        },
      },
    });

    const hydrate = vi.fn();
    const settled = vi.fn();
    const controller = createScrollSettleController({
      viewport,
      strategy: "firefox-wheel",
      measureEpsilon: 0.5,
      isDisposed: () => false,
      canLoadAtBoundary: () => true,
      cancelActiveSmoothScroll: vi.fn(),
      smoothScrollReachedTarget: () => true,
      onGestureActivity: vi.fn(),
      onGestureStarted: vi.fn(),
      onGestureSettled: settled,
      onGestureReset: vi.fn(),
      onScrollEventObserved: vi.fn(),
      onNativeScrollEndIdle: hydrate,
    });

    try {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 8 }));
      viewport.dispatchEvent(new Event("scrollend"));
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 0 }));
      vi.advanceTimersByTime(200);

      expect(hydrate).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1500);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
      viewport.remove();
    }
  });

  it("keeps the triggering edge protected after loading chrome grows", () => {
    const harness = mountScrollList("firefox-wheel", 100, { bottom: true });
    harness.scrollTo(harness.maxScrollTop());

    harness.list.setBoundarySlot("bottom", {
      key: "loading",
      height: 40,
      build: () => document.createElement("div"),
    });
    // The scroll event reached the old bottom before the spinner expanded it.
    // The next outward wheel therefore sees a native gap, not the trigger edge.
    harness.wheel(8);
    vi.advanceTimersByTime(1_000);

    // The spinner moved the native bottom away from the pinned scrollTop, but
    // this is still the same held edge gesture and must not use the fallback.
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    harness.scrollEnd();
    vi.advanceTimersByTime(1_600);
    vi.advanceTimersToNextFrame();
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    { boundary: "top", scrollTop: 0, deltaY: -8 },
    { boundary: "bottom", scrollTop: 700, deltaY: 8 },
  ])(
    "defers the $boundary commit when a re-grab arrives inside the stability window",
    ({ scrollTop: initialScrollTop, deltaY }) => {
      const viewport = document.createElement("div");
      document.body.appendChild(viewport);
      let scrollTop = initialScrollTop;
      Object.defineProperties(viewport, {
        clientHeight: { get: () => 300 },
        scrollHeight: { get: () => 1_000 },
        scrollTop: {
          get: () => scrollTop,
          set: (next: number) => {
            scrollTop = Math.max(0, Math.min(700, next));
          },
        },
      });

      const settled = vi.fn();
      const controller = createScrollSettleController({
        viewport,
        strategy: "firefox-wheel",
        measureEpsilon: 0.5,
        isDisposed: () => false,
        canLoadAtBoundary: () => true,
        cancelActiveSmoothScroll: vi.fn(),
        smoothScrollReachedTarget: () => true,
        onGestureActivity: vi.fn(),
        onGestureStarted: vi.fn(),
        onGestureSettled: settled,
        onGestureReset: vi.fn(),
        onScrollEventObserved: vi.fn(),
        onNativeScrollEndIdle: vi.fn(),
      });

      try {
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY }));
        vi.advanceTimersByTime(150);
        viewport.dispatchEvent(new Event("scrollend"));

        // The old 600ms grace committed here. Keep the range stable so a re-grab
        // in the empirically observed APZ publication window can postpone it.
        vi.advanceTimersByTime(1_000);
        expect(settled).not.toHaveBeenCalled();

        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY }));
        vi.advanceTimersByTime(1_000);
        expect(settled).not.toHaveBeenCalled();

        // The second release reuses the remaining stability quiet time and then
        // commits atomically on the next frame.
        viewport.dispatchEvent(new Event("scrollend"));
        vi.advanceTimersByTime(600);
        expect(settled).not.toHaveBeenCalled();
        vi.advanceTimersByTime(17);
        expect(settled).toHaveBeenCalledTimes(1);
      } finally {
        controller.dispose();
        viewport.remove();
      }
    },
  );

  it("keeps an accepted release through a pinned scroll echo before paint", () => {
    const harness = mountScrollList("firefox-wheel", 100, { bottom: true });
    harness.scrollTo(harness.maxScrollTop() - 0.8);
    harness.wheel(8);
    vi.advanceTimersByTime(150);
    harness.scrollEnd();
    vi.advanceTimersByTime(1450);

    harness.viewport.dispatchEvent(new Event("scroll"));
    vi.advanceTimersToNextFrame();

    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("re-arms an accepted release after zero-delta jitter before paint", () => {
    const harness = mountScrollList("firefox-wheel", 100, { bottom: true });
    harness.scrollTo(harness.maxScrollTop() - 0.8);
    harness.wheel(8);
    vi.advanceTimersByTime(150);
    harness.scrollEnd();
    vi.advanceTimersByTime(1450);

    harness.wheel(0);
    vi.advanceTimersToNextFrame();
    expect(harness.onScrollEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1600);
    vi.advanceTimersToNextFrame();
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("renders a deferred top prepend in the Firefox commit frame", () => {
    const harness = mountScrollList("firefox-wheel", 100, { top: true });
    harness.list.setBoundarySlot("top", {
      key: "loading",
      height: 40,
      build: () => document.createElement("div"),
    });
    const topSlot = harness.list.getBoundaryElement("top");
    const previousFirst = harness.list.getMountedElement(0);
    const apply = vi.fn(() => {
      harness.setCountValue(102);
      return true;
    });

    harness.wheel(-8);
    harness.list.syncLayout({
      addedBefore: 2,
      topSlot: {
        key: "idle",
        height: 1,
        build: () => document.createElement("div"),
      },
      apply,
    });
    vi.advanceTimersByTime(150);
    harness.scrollEnd();
    vi.advanceTimersByTime(1450);

    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(harness.list.state.count).toBe(102);
    expect(harness.viewport.scrollTop).toBe(61);
    expect(topSlot?.style.height).toBe("1px");
    expect(harness.list.getMountedElement(0)?.style.transform).toBe(
      "translateY(1px)",
    );
    expect(harness.list.getMountedElement(1)?.style.transform).toBe(
      "translateY(51px)",
    );
    expect(harness.list.getMountedElement(2)).toBe(previousFirst);
    expect(previousFirst?.style.transform).toBe("translateY(101px)");
  });
});

describe("scrollbar pointer drags", () => {
  it("settles immediately on pointer release without a native scrollend", () => {
    const harness = mountScrollList("default");

    harness.pointerDown(310); // inside the gutter: client area ends at x=300
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);

    harness.scrollTo(400);
    harness.pointerUp();
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores mouse-downs inside the content area", () => {
    const harness = mountScrollList("default");

    harness.pointerDown(150);
    expect(harness.onScrollStart).not.toHaveBeenCalled();
  });
});

describe("programmatic smooth scrolls", () => {
  it("resolves true after gliding to the target and settles", async () => {
    const harness = mountScrollList("default");

    const done = harness.list.scrollToOffset(1000, { behavior: "smooth" });
    vi.advanceTimersByTime(2000);
    await expect(done).resolves.toBe(true);
    expect(harness.viewport.scrollTop).toBe(1000);
    expect(harness.onScrollStart).toHaveBeenCalledTimes(1);
    expect(harness.onScrollEnd).toHaveBeenCalledTimes(1);
  });

  it("resolves false when a user wheel interrupts the glide", async () => {
    const harness = mountScrollList("default");

    const done = harness.list.scrollToOffset(2000, { behavior: "smooth" });
    vi.advanceTimersByTime(48); // a few frames into the glide
    harness.wheel(-100); // the user grabs the wheel

    await expect(done).resolves.toBe(false);
    const topAtCancel = harness.viewport.scrollTop;
    expect(topAtCancel).toBeLessThan(2000);

    vi.advanceTimersByTime(1000); // the glide is no longer driving the viewport
    expect(harness.viewport.scrollTop).toBe(topAtCancel);
  });
});
