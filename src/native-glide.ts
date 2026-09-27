export interface Glide {
  readonly active: boolean;
  cancel(): void;
}

const ARRIVAL_PX = 1;
const QUIET_MS = 120;
const STALL_MS = 2000;

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
): Glide {
  let finished = false;
  let frame = 0;
  let timer = 0;
  let requested: number | null = null;
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
        // Firefox can discard an instant request to its current position
        // without cancelling compositor motion. Change the position by one
        // pixel and restore it in the same task, before the browser paints.
        try {
          viewport.scrollTo({
            top: current > 0 ? current - 1 : current + 1,
            behavior: "instant",
          });
        } finally {
          viewport.scrollTo({ top: current, behavior: "instant" });
        }
      }
    } finally {
      onDone(completed);
    }
  }

  function scheduleCheck(): void {
    clearTimeout(timer);
    timer = window.setTimeout(() => check(false), QUIET_MS);
  }

  function request(destination: number): void {
    requested = destination;
    lastMovement = performance.now();
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
        requested === null ||
        Math.abs(current - requested) <= ARRIVAL_PX ||
        (ended && Math.abs(destination - requested) > ARRIVAL_PX)
      ) {
        // Finish the current leg before following streaming growth. Issuing
        // a new smooth scroll on every frame would restart native easing.
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
