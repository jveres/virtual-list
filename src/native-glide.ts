export interface Glide {
  readonly active: boolean;
  cancel(): void;
}

const ARRIVAL_PX = 1;
const QUIET_MS = 120;
const RETARGET_MS = 100;
const STALL_MS = 2000;

/** Cancel compositor motion without rebuilding the viewport's scrolling layer. */
export function stopNativeScroll(viewport: HTMLElement): void {
  const current = viewport.scrollTop;
  // Firefox can ignore a no-op instant request. Nudge and restore in one task,
  // before painting, so cancellation also works at a stationary endpoint.
  try {
    viewport.scrollTo({
      top: current > 0 ? current - 1 : current + 1,
      behavior: "instant",
    });
  } finally {
    viewport.scrollTo({ top: current, behavior: "instant" });
  }
}

/**
 * One browser-owned animation at a time. A scrollend is only a completion
 * candidate: the live destination must also have been reached. The quiet
 * fallback can confirm an arrival without scrollend, but cannot turn a
 * stationary, unfinished animation into a successful command.
 */
export function startNativeGlide(
  viewport: HTMLElement,
  target: () => number,
  onDone: (completed: boolean) => void,
  options: { trackTarget?: boolean } = {},
): Glide {
  let finished = false;
  let frame = 0;
  let timer = 0;
  let requested: number | null = null;
  let lastRequest = 0;
  let lastMovement = performance.now();
  let lastPosition = viewport.scrollTop;

  function finish(completed: boolean): void {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    viewport.removeEventListener("scroll", onScroll);
    viewport.removeEventListener("scrollend", onEnd);
    // Release browser motion on cancellation or early arrival at a changed
    // target. Removing our listeners alone does not stop its old destination.
    try {
      const current = viewport.scrollTop;
      if (
        requested !== null &&
        (!completed || Math.abs(current - requested) > ARRIVAL_PX)
      ) {
        stopNativeScroll(viewport);
      }
    } finally {
      onDone(completed);
    }
  }

  function scheduleCheck(): void {
    // Streaming must check growth during motion, rather than postponing the
    // check on every scroll event until the old animation has stopped.
    if (options.trackTarget && timer) return;
    clearTimeout(timer);
    timer = window.setTimeout(
      () => {
        timer = 0;
        check(false);
      },
      options.trackTarget ? RETARGET_MS : QUIET_MS,
    );
  }

  function request(destination: number): void {
    lastRequest = performance.now();
    if (requested === null || !options.trackTarget) lastMovement = lastRequest;
    requested = destination;
    viewport.scrollTo({ top: destination, behavior: "smooth" });
    if (!finished) scheduleCheck();
  }

  function check(ended: boolean): void {
    if (finished) return;
    try {
      const current = viewport.scrollTop;
      const destination = target();
      if (Math.abs(current - destination) <= ARRIVAL_PX) {
        finish(true);
      } else if (
        options.trackTarget &&
        performance.now() - lastMovement >= STALL_MS
      ) {
        finish(false);
      } else if (
        requested === null ||
        (options.trackTarget &&
          performance.now() - lastRequest >= RETARGET_MS &&
          Math.abs(destination - requested) > ARRIVAL_PX) ||
        Math.abs(current - requested) <= ARRIVAL_PX ||
        (ended && Math.abs(destination - requested) > ARRIVAL_PX)
      ) {
        // Explicit navigation finishes each leg. Streaming can retarget at a
        // bounded cadence while the browser continues to own the animation.
        request(destination);
      } else if (performance.now() - lastMovement >= STALL_MS) {
        finish(false);
      } else scheduleCheck(); // Ignore stale ends from the preceding command.
    } catch (error) {
      try {
        finish(false);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "native scrolling and cleanup failed",
        );
      }
      throw error;
    }
  }

  function onScroll(): void {
    const position = viewport.scrollTop;
    if (position !== lastPosition) {
      lastMovement = performance.now();
      lastPosition = position;
    }
    scheduleCheck();
  }

  function onEnd(): void {
    check(true);
  }

  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("scrollend", onEnd, { passive: true });
  // Ownership must be assigned before even a no-op command completes.
  frame = requestAnimationFrame(() => {
    frame = 0;
    check(false);
  });
  return {
    get active() {
      return !finished;
    },
    cancel: () => finish(false),
  };
}
