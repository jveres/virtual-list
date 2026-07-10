/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVirtualList, type VirtualList } from "../../src/virtual-list";

// Boundary-reach semantics (onReachTop/onReachBottom): the armed/consumed
// state machine driven by slot visibility. Untestable in jsdom while it rode
// on IntersectionObserver; now geometry-driven, so the harness only mocks the
// viewport geometry the way the settle tests do. Uses the "default" settle
// strategy: gestures settle one cooldown (140ms) after a scrollend event.

const VIEWPORT_HEIGHT = 300;
const ROW = 50;
const SETTLE_MS = 200;

interface ReachHarness {
  list: VirtualList;
  viewport: HTMLElement;
  onReachTop: ReturnType<typeof vi.fn>;
  onReachBottom: ReturnType<typeof vi.fn>;
  setCountValue: (next: number) => void;
  setBuildHook: (hook: ((index: number) => void) | null) => void;
  /** User scroll: move the mocked scrollTop, dispatch scroll, run the frame. */
  scrollTo: (top: number) => void;
  /** Finish the user gesture: scrollend plus the settle cooldown. */
  settle: () => void;
  maxScrollTop: () => number;
}

const liveHarnesses: ReachHarness[] = [];

function mountReachList(initialCount = 100): ReachHarness {
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

  let count = initialCount;
  let buildHook: ((index: number) => void) | null = null;
  const onReachTop = vi.fn();
  const onReachBottom = vi.fn();
  const list = createVirtualList({
    viewport,
    getCount: () => count,
    getItemHeight: () => ROW,
    buildItem: (index) => {
      const element = document.createElement("div");
      element.textContent = `item ${index}`;
      buildHook?.(index);
      return element;
    },
    scrollSettleStrategy: "default",
    onReachTop,
    onReachBottom,
  });

  const harness: ReachHarness = {
    list,
    viewport,
    onReachTop,
    onReachBottom,
    setCountValue: (next) => {
      count = next;
    },
    setBuildHook: (hook) => {
      buildHook = hook;
    },
    scrollTo: (top) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(17); // run the scheduled render frame
    },
    settle: () => {
      viewport.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(SETTLE_MS);
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

describe("boundary reach", () => {
  it("does not fire onReachTop at mount even though the list starts at the top", () => {
    const harness = mountReachList();
    vi.advanceTimersByTime(100);
    expect(harness.onReachTop).not.toHaveBeenCalled();
    expect(harness.onReachBottom).not.toHaveBeenCalled();
  });

  it("fires onReachBottom exactly once when a user scroll reaches the bottom", () => {
    const harness = mountReachList();

    harness.scrollTo(harness.maxScrollTop());
    expect(harness.onReachBottom).toHaveBeenCalledTimes(1);

    // Further scroll events parked at the bottom: consumed, no repeat.
    harness.scrollTo(harness.maxScrollTop());
    harness.settle();
    expect(harness.onReachBottom).toHaveBeenCalledTimes(1);
    expect(harness.onReachTop).not.toHaveBeenCalled();
  });

  it("fires bottom reach after a newly built edge row queues a refresh", () => {
    const harness = mountReachList();
    let queuedRefresh = false;
    harness.setBuildHook((index) => {
      if (queuedRefresh) return;
      queuedRefresh = true;
      harness.list.refreshIndex(index);
    });

    harness.scrollTo(harness.maxScrollTop());

    expect(queuedRefresh).toBe(true);
    expect(harness.onReachBottom).toHaveBeenCalledTimes(1);
  });

  it("re-arms when the user scrolls away and fires again on the next approach", () => {
    const harness = mountReachList();

    harness.scrollTo(harness.maxScrollTop());
    harness.settle();
    expect(harness.onReachBottom).toHaveBeenCalledTimes(1);

    harness.scrollTo(1000); // away: slot covered during a user scroll -> re-arm
    harness.settle();
    harness.scrollTo(harness.maxScrollTop());
    expect(harness.onReachBottom).toHaveBeenCalledTimes(2);
  });

  it("fires onReachTop after scrolling down and returning to the top", () => {
    const harness = mountReachList();

    harness.scrollTo(2000);
    harness.settle();
    expect(harness.onReachTop).not.toHaveBeenCalled();

    harness.scrollTo(0);
    expect(harness.onReachTop).toHaveBeenCalledTimes(1);
  });

  it("preserves an armed top reach when boundary construction queues a refresh", () => {
    const harness = mountReachList();

    harness.scrollTo(500);
    harness.settle();
    harness.viewport.scrollTop = 0;
    harness.list.setBoundarySlot("top", {
      key: "loading-top",
      height: 1,
      build: () => {
        harness.list.refreshIndex(0);
        return document.createElement("div");
      },
    });

    expect(harness.onReachTop).toHaveBeenCalledTimes(1);
  });

  it("emits for programmatic scrollToBottom and scrollToTop", async () => {
    const harness = mountReachList();

    const toBottom = harness.list.scrollToBottom();
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(toBottom).resolves.toBe(true);
    expect(harness.onReachBottom).toHaveBeenCalledTimes(1);

    const toTop = harness.list.scrollToTop();
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(toTop).resolves.toBe(true);
    expect(harness.onReachTop).toHaveBeenCalledTimes(1);
  });

  it("supports the load-older loop: prepend on reach, no refire until the user scrolls again", () => {
    const harness = mountReachList();

    // Reach the top the way a user would.
    harness.scrollTo(500);
    harness.settle();
    harness.scrollTo(0);
    expect(harness.onReachTop).toHaveBeenCalledTimes(1);
    harness.settle();

    // The app loads 20 older rows and prepends them; scroll position is
    // preserved, so the top slot is covered again — without a user gesture,
    // the consumed flag must hold and no second reach may fire.
    harness.setCountValue(120);
    harness.list.syncLayout({ addedBefore: 20 });
    vi.advanceTimersByTime(100);
    expect(harness.onReachTop).toHaveBeenCalledTimes(1);
    expect(harness.list.state.scrollTop).toBeGreaterThan(0);

    // The next user approach fires again.
    harness.scrollTo(200);
    harness.settle();
    harness.scrollTo(0);
    expect(harness.onReachTop).toHaveBeenCalledTimes(2);
  });
});
