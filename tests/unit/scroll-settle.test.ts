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
  settled: () => number;
  started: () => number;
  cancelledSmooth: () => number;
  setSmoothActive: (active: boolean) => void;
  scrollTo: (top: number) => void;
  wheel: (deltaY: number, deltaMode?: number) => void;
  touchStart: () => void;
  touchEnd: () => void;
  scrollEnd: () => void;
  dispose: () => void;
}

const live: Harness[] = [];

function mount(
  strategy: VirtualListScrollSettleStrategy,
  options: {
    canLoadTop?: boolean;
    canLoadBottom?: boolean;
    /** Let scrollTop leave [0, max] — Safari rubber-band simulation. */
    overscroll?: boolean;
  } = {},
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
        // Browsers clamp scrollTop writes to the scrollable range; Safari
        // rubber-band tests bypass the clamp to simulate overscroll.
        scrollTop = options.overscroll
          ? next
          : Math.max(0, Math.min(maxScrollTop, next));
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
    noSmoothScrollInFlight: () => !smoothActive,
    onGestureStarted: () => {
      startCount += 1;
    },
    onGestureSettled: () => {
      settleCount += 1;
    },
    onGestureReset: () => {},
    onScrollEventObserved: () => {},
  });

  const harness: Harness = {
    controller,
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
    touchStart: () => {
      viewport.dispatchEvent(new Event("touchstart"));
    },
    touchEnd: () => {
      const event = new Event("touchend");
      Object.defineProperty(event, "touches", { value: [] });
      viewport.dispatchEvent(event);
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
    // Headless Chrome is Chrome: the token differs, the engine does not.
    expect(
      detectScrollSettleStrategy(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("chromium-wheel");
    // WebKit without the Safari token — a WKWebView, an in-app browser,
    // Chrome or Firefox on iOS — rubber-bands like Safari and settles like it.
    expect(
      detectScrollSettleStrategy(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ),
    ).toBe("safari-wheel");
    expect(
      detectScrollSettleStrategy(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("safari-wheel");
    expect(
      detectScrollSettleStrategy(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
      ),
    ).toBe("safari-wheel");
    // An engine nobody has characterised gets the conservative contract.
    expect(detectScrollSettleStrategy("Mozilla/5.0 jsdom/24.0")).toBe(
      "firefox-wheel",
    );
    expect(detectScrollSettleStrategy("SomethingNew/1.0")).toBe(
      "firefox-wheel",
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
    expect(harness.controller.isScrollPhaseActive()).toBe(true);
  });

  it("cancels a pending wheel release when touch re-grabs the edge", () => {
    const harness = mount("firefox-wheel", { canLoadTop: true });
    harness.scrollTo(600);
    harness.wheel(-50);
    harness.scrollTo(0);
    vi.advanceTimersByTime(150);
    harness.scrollEnd(); // Pending Firefox edge release.

    vi.advanceTimersByTime(100);
    harness.touchStart();
    harness.touchEnd();
    vi.advanceTimersByTime(500);
    // Touch is deliberate new input, never a decaying wheel-tail marker.
    expect(harness.settled()).toBe(0);

    harness.scrollTo(200);
    harness.scrollEnd();
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });
});

describe("firefox delta-mode coverage", () => {
  it("contests on a page-delta wheel regardless of magnitude", () => {
    const harness = mount("firefox-wheel");
    firefoxEdgeReleasePreamble(harness);

    vi.advanceTimersByTime(8);
    harness.wheel(-1, WheelEvent.DOM_DELTA_PAGE);

    vi.advanceTimersByTime(600);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(1300);
    expect(harness.settled()).toBe(1);
  });

  it("resets the predecessor unit after a non-pixel wheel (pinned permissive)", () => {
    // A line-mode wheel just before the scrollend resets the signed
    // predecessor: a small same-band pixel wheel after the scrollend is
    // neither a reversal (no comparable unit) nor energy growth, so it is
    // classified as a trailing marker. Characterizes the deliberate
    // permissive choice at the unit boundary.
    const harness = mount("firefox-wheel");
    harness.scrollTo(600);
    harness.wheel(-50);
    harness.scrollTo(300);
    vi.advanceTimersByTime(16);
    harness.wheel(-3, WheelEvent.DOM_DELTA_LINE); // Unit reset.
    harness.scrollTo(0);
    vi.advanceTimersByTime(150);
    harness.scrollEnd();

    vi.advanceTimersByTime(8);
    harness.wheel(2); // Small pixel delta, incomparable predecessor.

    // Uncontested: settles on the short window from that wheel.
    vi.advanceTimersByTime(300);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(harness.settled()).toBe(1);
  });
});

describe("chromium sequences (trace replay)", () => {
  it("suppresses the early edge scrollend and settles on the edge-quiet fallback", () => {
    const harness = mount("chromium-wheel", { canLoadTop: true });
    harness.scrollTo(600);
    harness.wheel(-100);
    harness.scrollTo(300);
    vi.advanceTimersByTime(16);
    harness.wheel(-100);
    harness.scrollTo(0);
    vi.advanceTimersByTime(16);
    harness.wheel(-50); // Outward at the loadable top: suppressed.
    harness.scrollEnd(); // Chromium's single, EARLY scrollend at the edge.

    // Wheel-idle (140) → edge settle fallback (450) → cooldown (140):
    // settle lands ~730ms after the last wheel, not on the early scrollend.
    vi.advanceTimersByTime(500);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(320);
    expect(harness.settled()).toBe(1);
  });

  it("settles mid-list from the final scrollend once wheel input idles", () => {
    const harness = mount("chromium-wheel");
    harness.scrollTo(600);
    harness.wheel(-100);
    harness.scrollTo(500);
    vi.advanceTimersByTime(16);
    harness.wheel(-80);
    harness.scrollTo(420);
    harness.scrollEnd(); // Consumed by the trailing wheel activity...

    // ...so settling waits for wheel idle (140) + cooldown (140).
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });

  it("closes the wheel-idle dead-end via the stall fallback (no scrollend)", () => {
    const harness = mount("chromium-wheel");
    harness.scrollTo(600);
    harness.wheel(-100);
    harness.scrollTo(500);
    vi.advanceTimersByTime(16);
    harness.wheel(-80);
    harness.scrollTo(420);
    // No scrollend ever: chromium fires one per sequence and a trailing
    // wheel consumed it. The stall fallback must still settle the gesture
    // ("stuck loads" close): idle (140) + quiet (450) + cooldown (140).
    vi.advanceTimersByTime(500);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(400);
    expect(harness.settled()).toBe(1);
  });
});

describe("safari sequences (trace replay)", () => {
  it("a scrollend from a programmatic write does not cancel the gesture a wheel tick just started", () => {
    const harness = mount("safari-wheel");
    // A command's write: pre-announced, its scroll event is consumed.
    harness.controller.recordProgrammaticScrollTop(1000);
    harness.scrollTo(1000);
    expect(harness.controller.isScrollPhaseActive()).toBe(false);
    // Momentum keeps delivering: a wheel tick starts a fresh gesture...
    harness.wheel(-120);
    expect(harness.controller.isScrollPhaseActive()).toBe(true);
    // ...and the write's scrollend arrives before the tick's own scroll
    // event. Cancelling here opened an idle gap under live wheel input.
    harness.scrollEnd();
    expect(harness.controller.isScrollPhaseActive()).toBe(true);
    // The tick's scroll event lands; the gesture settles normally later.
    harness.scrollTo(880);
    harness.scrollEnd();
    vi.advanceTimersByTime(2_000);
    expect(harness.controller.isScrollPhaseActive()).toBe(false);
    expect(harness.settled()).toBe(1);
  });

  it("wheel input that never moves the viewport ends when the wheel goes quiet", () => {
    const harness = mount("safari-wheel");
    harness.controller.recordProgrammaticScrollTop(1000); // Mid-list, no edge.
    harness.scrollTo(1000);
    harness.wheel(-120);
    expect(harness.controller.isScrollPhaseActive()).toBe(true);
    harness.scrollEnd(); // Withheld: wheel input is live.
    expect(harness.controller.isScrollPhaseActive()).toBe(true);
    vi.advanceTimersByTime(300); // The wheel-idle window closes.
    expect(harness.controller.isScrollPhaseActive()).toBe(false);
    // The host is notified even though scrollTop did not move: boundary
    // work may have become held while this real wheel phase was active.
    expect(harness.settled()).toBe(1);
  });

  it("never settles while rubber-band overscrolled; settles after the bounce", () => {
    const harness = mount("safari-wheel", { overscroll: true });
    harness.scrollTo(600);
    harness.wheel(-100);
    harness.scrollTo(200);
    vi.advanceTimersByTime(16);
    harness.wheel(-80);
    harness.scrollTo(-30); // Rubber-banded past the top.
    vi.advanceTimersByTime(150);
    harness.scrollEnd();

    vi.advanceTimersByTime(2000); // Held overscrolled: must not settle.
    expect(harness.settled()).toBe(0);

    harness.scrollTo(0); // The bounce returns into range...
    vi.advanceTimersByTime(200); // ...but the edge needs 350ms of silence.
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(harness.settled()).toBe(1);
  });

  it("requires the post-motion quiet window at a pinned edge", () => {
    const harness = mount("safari-wheel");
    harness.scrollTo(600);
    harness.wheel(-100);
    harness.scrollTo(0); // Pinned at the top.
    vi.advanceTimersByTime(150);
    harness.scrollEnd();

    // The settle's writes would snap a live bounce: near an edge, 350ms of
    // scroll-event silence is required beyond the cooldown.
    vi.advanceTimersByTime(150);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(harness.settled()).toBe(1);
  });

  it("cancels a pending bottom release when upward input resumes before motion", () => {
    const harness = mount("safari-wheel", { canLoadBottom: true });
    harness.scrollTo(4300);
    harness.wheel(100);
    harness.scrollTo(4700); // Bottom load is held behind this gesture.
    vi.advanceTimersByTime(150); // Wheel input idles.
    harness.scrollEnd(); // Possible release at the bottom.

    vi.advanceTimersByTime(100); // Still inside its settle cooldown.
    harness.wheel(-60); // User reverses, before Safari reports motion.
    vi.advanceTimersByTime(300);
    // The old bottom scrollend must not commit between reversal input and
    // its delayed upward scroll event. A fresh fallback is still pending.
    expect(harness.settled()).toBe(0);

    harness.scrollTo(4500); // Safari delivers the upward motion.
    harness.scrollEnd();
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });

  it("a touch that stops a decelerating scroll still lets the gesture settle", () => {
    // iOS: the tap that stops a deceleration is a touchstart (cancelling any
    // pending release) followed by a touchend, with no scroll event or
    // scrollend in between — the tap held the viewport exactly still.
    const harness = mount("safari-wheel");
    harness.scrollTo(2000);
    harness.scrollTo(2400); // Still decelerating: no scrollend yet.
    harness.touchStart();
    harness.touchEnd();
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(600);
    expect(harness.settled()).toBe(1);

    // The same after a scrollend whose release the touch cancelled.
    harness.scrollTo(2800);
    harness.scrollTo(3200);
    harness.scrollEnd();
    vi.advanceTimersByTime(50);
    harness.touchStart();
    harness.touchEnd();
    expect(harness.settled()).toBe(1);
    vi.advanceTimersByTime(600);
    expect(harness.settled()).toBe(2);
  });

  it("cancels a pending release when touch re-grabs before new motion", () => {
    const harness = mount("safari-wheel", { canLoadBottom: true });
    harness.scrollTo(4300);
    harness.scrollTo(4700);
    harness.scrollEnd();

    vi.advanceTimersByTime(100);
    harness.touchStart();
    harness.touchEnd();
    // touchend must not honor the release that preceded this fresh touch.
    expect(harness.settled()).toBe(0);

    harness.scrollTo(4500);
    harness.scrollEnd();
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
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
    expect(harness.controller.isScrollPhaseActive()).toBe(true);
  });

  it("ignores scrollends while the glide is still short of its target", () => {
    const harness = mount("firefox-wheel");
    harness.setSmoothActive(true);
    harness.controller.beginProgrammaticGesture();
    harness.scrollTo(700);
    harness.scrollEnd(); // Mid-glide scrollend: not the release.

    // Timing discriminates the paths: an HONORED scrollend would settle
    // after the bare cooldown (~140ms); the ignored one leaves settling to
    // the wheel-scrollend fallback (~280ms after the last scroll event),
    // since the harness keeps the glide in flight throughout.
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(harness.settled()).toBe(1);
  });
});
