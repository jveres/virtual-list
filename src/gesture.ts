// Gesture sensor: classifies viewport scrolling as user-driven or
// self-inflicted. The arbiter never writes scrollTop while the user owns the
// viewport; structural work deferred during a gesture flushes on settle.
//
// v1 strategy: programmatic-write matching (a scroll event landing on a
// recorded target is ours; anything else is the user) plus `scrollend` with
// an idle-timeout fallback. The old runtime's deep engine-specific wheel and
// momentum knowledge returns at the real-browser gauntlet, where it is
// actually testable; jsdom can only exercise the classification core.

export interface GestureSensor {
  readonly active: boolean;
  /** Record an upcoming self-inflicted scroll so it is not misread. */
  expectWrite(scrollTop: number): void;
  /** Feed a scroll event; returns true when it was user-driven. */
  handleScroll(scrollTop: number): boolean;
  dispose(): void;
}

const WRITE_TOLERANCE_PX = 1;
const IDLE_SETTLE_MS = 140;
const MAX_PENDING_WRITES = 8;

export function createGestureSensor(
  viewport: HTMLElement,
  hooks: { onStart?: () => void; onSettle?: () => void } = {},
): GestureSensor {
  const expected: number[] = [];
  let active = false;
  let idleTimer = 0;
  let disposed = false;

  // A scroll landing on (or past, in order) a recorded target is ours.
  // An unmatched value means the user took over; stale targets are dropped
  // so they cannot shadow later events.
  function consume(scrollTop: number): boolean {
    const index = expected.findIndex(
      (target) => Math.abs(target - scrollTop) <= WRITE_TOLERANCE_PX,
    );
    if (index === -1) {
      expected.length = 0;
      return false;
    }
    expected.splice(0, index + 1);
    return true;
  }

  function settle(): void {
    window.clearTimeout(idleTimer);
    idleTimer = 0;
    if (!active) return;
    active = false;
    hooks.onSettle?.();
  }

  function handleScroll(scrollTop: number): boolean {
    if (disposed || consume(scrollTop)) return false;
    if (!active) {
      active = true;
      hooks.onStart?.();
    }
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(settle, IDLE_SETTLE_MS);
    return true;
  }

  const onScroll = (): void => {
    handleScroll(viewport.scrollTop);
  };
  const onScrollEnd = (): void => settle();
  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("scrollend", onScrollEnd);

  return {
    get active() {
      return active;
    },
    expectWrite(scrollTop: number): void {
      expected.push(scrollTop);
      if (expected.length > MAX_PENDING_WRITES) expected.shift();
    },
    handleScroll,
    dispose(): void {
      disposed = true;
      window.clearTimeout(idleTimer);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("scrollend", onScrollEnd);
    },
  };
}
