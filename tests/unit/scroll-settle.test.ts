/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScrollSettleController,
  detectScrollSettleStrategy,
  type ScrollSettleController,
  type VirtualListScrollSettleStrategy,
} from "../../src/scroll-settle";

// Deterministic trace-replay characterization of the settle controller,
// driven through a mock host (no runtime): recorded engine sequences — the
// Firefox lab traces among them — replayed with fake timers. jsdom performs
// no real scrolling; the harness mocks viewport geometry and replays the
// event order each engine actually emits. These pin the externally
// observable contract, including the two v2 Firefox deviations (contested
// releases and the two-window design).

const VIEWPORT_HEIGHT = 300;
const CONTENT_HEIGHT = 5000;

interface Harness {
  controller: ScrollSettleController;
  viewport: HTMLElement;
  settled: () => number;
  started: () => number;
  cancelledSmooth: () => number;
  setSmoothActive: (active: boolean) => void;
  scrollTo: (top: number) => void;
  wheel: (deltaY: number, deltaMode?: number) => void;
  scrollEnd: () => void;
  dispose: () => void;
}

const live: Harness[] = [];

function mount(
  strategy: VirtualListScrollSettleStrategy,
  options: { canLoadTop?: boolean; canLoadBottom?: boolean } = {},
): Harness {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const maxScrollTop = CONTENT_HEIGHT - VIEWPORT_HEIGHT;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_HEIGHT },
    clientWidth: { get: () => 300 },
    offsetWidth: { get: () => 315 },
    scrollHeight: { get: () => CONTENT_HEIGHT },
    scrollTop: {
      get: () => scrollTop,
      set: (next: number) => {
        // Browsers clamp scrollTop writes to the scrollable range.
        scrollTop = Math.max(0, Math.min(maxScrollTop, next));
      },
    },
  });
  document.body.appendChild(viewport);

  let settleCount = 0;
  let startCount = 0;
  let cancelCount = 0;
  let smoothActive = false;

  const controller = createScrollSettleController({
    viewport,
    strategy,
    measureEpsilon: 0.5,
    isDisposed: () => false,
    canLoadAtBoundary: (boundary) =>
      boundary === "top"
        ? (options.canLoadTop ?? true)
        : (options.canLoadBottom ?? false),
    cancelActiveSmoothScroll: () => {
      cancelCount += 1;
    },
    smoothScrollReachedTarget: () => !smoothActive,
    onGestureActivity: () => {},
    onGestureStarted: () => {
      startCount += 1;
    },
    onGestureSettled: () => {
      settleCount += 1;
    },
    onGestureReset: () => {},
    onScrollEventObserved: () => {},
    onNativeScrollEndIdle: () => {},
  });

  const harness: Harness = {
    controller,
    viewport,
    settled: () => settleCount,
    started: () => startCount,
    cancelledSmooth: () => cancelCount,
    setSmoothActive: (active) => {
      smoothActive = active;
    },
    scrollTo: (top) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
    },
    wheel: (deltaY, deltaMode = WheelEvent.DOM_DELTA_PIXEL) => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode }));
    },
    scrollEnd: () => {
      viewport.dispatchEvent(new Event("scrollend"));
    },
    dispose: () => {
      controller.dispose();
      viewport.remove();
    },
  };
  live.push(harness);
  return harness;
}

/**
 * The shared Firefox preamble: an upward wheel gesture from mid-list to the
 * pinned top edge, ending with a small pre-scrollend wheel so the trailing
 * classification has a defined predecessor. Ends with the wheel-idle window
 * expired and a scrollend delivered (an EDGE release, pending uncontested).
 * Timeline: last wheel at t+32, scrollend at t+182.
 */
function firefoxEdgeReleasePreamble(harness: Harness): void {
  harness.scrollTo(600);
  harness.wheel(-50);
  harness.scrollTo(400);
  vi.advanceTimersByTime(16);
  harness.wheel(-50);
  harness.scrollTo(200);
  vi.advanceTimersByTime(16);
  harness.wheel(-8);
  harness.scrollTo(0); // Pinned at the loadable top: protected edge.
  vi.advanceTimersByTime(150); // Wheel-idle expires; no timer backstop fires.
  harness.scrollEnd(); // The (possible) release.
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const harness of live.splice(0)) harness.dispose();
  vi.useRealTimers();
});

describe("detectScrollSettleStrategy", () => {
  const CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  it("classifies engines, including Chrome's Safari/ token", () => {
    expect(detectScrollSettleStrategy(CHROME)).toBe("chromium-wheel");
    expect(detectScrollSettleStrategy(`${CHROME} Edg/126.0`)).toBe(
      "chromium-wheel",
    );
    expect(
      detectScrollSettleStrategy("Mozilla/5.0 Gecko/20100101 Firefox/127.0"),
    ).toBe("firefox-wheel");
    expect(
      detectScrollSettleStrategy(
        "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
      ),
    ).toBe("safari-wheel");
    expect(detectScrollSettleStrategy("Mozilla/5.0 jsdom/24.0")).toBe(
      "default",
    );
  });
});

describe("default strategy", () => {
  it("ignores pre-announced programmatic writes and settles on scrollend + cooldown", () => {
    const harness = mount("default");
    harness.controller.recordProgrammaticScrollTop(500);
    harness.scrollTo(500);
    expect(harness.started()).toBe(0); // Self-inflicted, not a gesture.

    harness.scrollTo(700); // Unmatched: a user gesture.
    expect(harness.started()).toBe(1);
    harness.scrollEnd();
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });
});

describe("firefox edge sequences (trace replay)", () => {
  it("settles an uncontested release ~450ms after the last wheel", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness); // Last wheel t+32; now t+182.

    vi.advanceTimersByTime(250); // t+432 — inside the confirm window.
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(120); // t+552 — past t+482 (+ a frame for rAF).
    expect(harness.settled()).toBe(1);
  });

  it("contests a release when post-scrollend wheels add energy (3→4→7)", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness); // Now t+182.

    // The mid-hold lab trace: growing post-scrollend deltas.
    vi.advanceTimersByTime(8);
    harness.wheel(-3);
    vi.advanceTimersByTime(16);
    harness.wheel(-4);
    vi.advanceTimersByTime(16);
    harness.wheel(-7); // Adds energy: contested. Last wheel at t+222.

    vi.advanceTimersByTime(1500); // t+1722 — inside the stability window.
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(200); // t+1922 — past t+1822.
    expect(harness.settled()).toBe(1);
  });

  it("treats a decaying pixel tail as trailing markers: short window, no hang", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness); // Predecessor delta -8; now t+182.

    // The hang lab trace: a monotone decaying momentum tail.
    for (const delta of [-6, -5, -4, -3, -2, -1]) {
      vi.advanceTimersByTime(16);
      harness.wheel(delta);
    }
    // Last marker at t+278 → settle due ~t+728, not +1878 and not never.
    vi.advanceTimersByTime(380); // t+658.
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(150); // t+808.
    expect(harness.settled()).toBe(1);
  });

  it("contests on a line/page-delta wheel regardless of magnitude", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness);

    vi.advanceTimersByTime(8);
    harness.wheel(-1, WheelEvent.DOM_DELTA_LINE); // A deliberate notch.

    vi.advanceTimersByTime(600); // Far past the confirm window.
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(1300); // Past the stability window.
    expect(harness.settled()).toBe(1);
  });

  it("contests on a direction reversal regardless of magnitude", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness); // Predecessor delta -8.

    vi.advanceTimersByTime(8);
    harness.wheel(2); // Reversed: new intent.

    vi.advanceTimersByTime(600);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(1300);
    expect(harness.settled()).toBe(1);
  });

  it("lets the gesture's own second scrollend settle on the short window", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness);

    // Contest the first scrollend with an energetic continuation...
    vi.advanceTimersByTime(8);
    harness.wheel(-3);
    vi.advanceTimersByTime(16);
    harness.wheel(-9);
    harness.scrollTo(40);
    harness.scrollTo(0);
    vi.advanceTimersByTime(150); // Wheel idle passes.
    // ...then the gesture releases for real: its own scrollend.
    harness.scrollEnd();

    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(300); // Short confirm window from the last wheel.
    expect(harness.settled()).toBe(1);
  });

  it("never settles a scrollend-less hold at a protected edge", () => {
    const harness = mount("firefox-wheel");
    harness.scrollTo(600);
    harness.wheel(-50);
    harness.scrollTo(200);
    vi.advanceTimersByTime(16);
    harness.wheel(-30);
    harness.scrollTo(0); // Held at the loadable top; no scrollend ever.

    vi.advanceTimersByTime(10_000);
    expect(harness.settled()).toBe(0);
    expect(harness.controller.isUserScrollActive()).toBe(true);
  });
});

describe("programmatic gestures", () => {
  it("classifies glide writes as self-inflicted and settles after markSettlePending", () => {
    const harness = mount("firefox-wheel");
    harness.controller.beginProgrammaticGesture();
    expect(harness.started()).toBe(1);

    harness.controller.recordProgrammaticScrollTop(400);
    harness.scrollTo(400); // Consumed: no smooth-scroll cancellation.
    expect(harness.cancelledSmooth()).toBe(0);

    harness.controller.markSettlePending();
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });

  it("cancels the glide when genuine user input takes over", () => {
    const harness = mount("firefox-wheel");
    harness.setSmoothActive(true);
    harness.controller.beginProgrammaticGesture();

    harness.wheel(-40); // Real input mid-glide.
    expect(harness.cancelledSmooth()).toBe(1);
    expect(harness.controller.isUserScrollActive()).toBe(true);
  });

  it("ignores scrollends while the glide is still short of its target", () => {
    const harness = mount("firefox-wheel");
    harness.setSmoothActive(true);
    harness.controller.beginProgrammaticGesture();
    harness.scrollTo(700);
    harness.scrollEnd(); // Mid-glide scrollend: not the release.

    // Timing discriminates the paths: an HONORED scrollend would settle
    // after the bare cooldown (~140ms); the ignored one leaves settling to
    // the wheel-scrollend fallback (~280ms after the last scroll event) —
    // main's normal idle path for a finished programmatic phase.
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });
});
