// Smooth scroll glide: rAF-driven ease-out toward a live target. The target
// is re-read every frame, so gliding to the end keeps up with streaming
// growth. Two hard-won behaviors are contractual (I2):
// - the step advances at least one whole pixel per frame — WebKit floors
//   scrollTop writes, and a sub-pixel step would park the glide short of the
//   target forever;
// - the landing is exact: the final frame writes the target itself.
//
// A third is contractual for I1: when either endpoint moves externally —
// the position under an anchor-preserving prepend, or the live target under
// a snapshot — the glide REBASES its curve from the current position instead
// of snapping back onto the stale one. No frame ever jumps the full distance.

export interface GlideHost {
  read(): number;
  /** Perform the (self-inflicted, pre-announced) scroll write. */
  write(top: number): void;
  /** Live target — re-evaluated every frame. */
  target(): number;
}

export interface Glide {
  readonly active: boolean;
  cancel(): void;
}

const SNAP_PX = 1;
// External endpoint movement beyond this rebases the curve. Above the 1px
// integer-floor noise of engines that floor scrollTop writes.
const REBASE_PX = 2;
const MIN_DURATION_MS = 320;
const MAX_DURATION_MS = 1400;
const VIEWPORTS_PER_SECOND = 7;

/** Distance-derived duration: quick short hops, bounded long jumps. */
export function glideDuration(
  distancePx: number,
  viewportHeight: number,
): number {
  const speed = Math.max(1, viewportHeight) * VIEWPORTS_PER_SECOND;
  const ms = (Math.abs(distancePx) / speed) * 1000;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, ms));
}

function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

export function startGlide(
  host: GlideHost,
  duration: number | ((distancePx: number) => number),
  onDone: (completed: boolean) => void,
): Glide {
  let frame = 0;
  let startTime = -1;
  let finished = false;
  let startTop = host.read();
  let lastWritten: number | null = null;
  let lastTarget: number | null = null;
  let durationMs =
    typeof duration === "number"
      ? duration
      : duration(host.target() - startTop);

  function finish(completed: boolean): void {
    if (finished) return;
    finished = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    onDone(completed);
  }

  function tick(now: number): void {
    frame = 0;
    if (finished) return;
    if (startTime < 0) startTime = now;
    const target = host.target();
    const current = host.read();
    // Either endpoint moved externally (an anchor-preserving prepend shifted
    // the position; a snapshot moved the live target): restart the curve
    // from where we are now — never snap back onto the stale curve.
    if (
      (lastWritten !== null && Math.abs(current - lastWritten) > REBASE_PX) ||
      (lastTarget !== null && Math.abs(target - lastTarget) > REBASE_PX)
    ) {
      startTop = current;
      startTime = now;
      // A duration policy re-derives the pace for the new remaining
      // distance, so a rebased leg glides at policy speed, not the stale
      // clock of the original (possibly much shorter) leg.
      if (typeof duration === "function") {
        durationMs = duration(target - current);
      }
    }
    lastTarget = target;
    const remaining = target - current;

    if (Math.abs(remaining) <= SNAP_PX) {
      host.write(target);
      finish(true);
      return;
    }

    const t = Math.min(1, (now - startTime) / Math.max(1, durationMs));
    const eased = startTop + (target - startTop) * easeOutQuint(t);
    let step = eased - current;
    // Never a sub-pixel frame: floored engines must still make progress.
    if (Math.abs(step) < 1 || Math.sign(step) !== Math.sign(remaining)) {
      step = Math.sign(remaining) * Math.min(1, Math.abs(remaining));
    }
    host.write(current + step);
    lastWritten = current + step;

    if (t >= 1 && Math.abs(host.target() - host.read()) <= SNAP_PX) {
      host.write(host.target());
      finish(true);
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  frame = requestAnimationFrame(tick);
  return {
    get active() {
      return !finished;
    },
    cancel(): void {
      finish(false);
    },
  };
}
