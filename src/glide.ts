// Smooth scroll glide: rAF-driven ease-out toward a live target. The target
// is re-read every frame, so gliding to the end keeps up with streaming
// growth. Two hard-won behaviors are contractual (I2):
// - the step advances at least one whole pixel per frame — WebKit floors
//   scrollTop writes, and a sub-pixel step would round back to the previous
//   position, a stalled frame in the glide's tail;
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
  /** In the final landing leg; false after completion or cancellation. */
  readonly landing: boolean;
  cancel(): void;
}

const SNAP_PX = 1;
// External endpoint movement beyond this rebases the curve. Above the 1px
// integer-floor noise of engines that floor scrollTop writes.
const REBASE_PX = 2;
const LANDING_MS = 280;
const MAX_DURATION_MS = 1080;

/**
 * A glide is two legs. The LANDING leg — the last `landingPx` of travel
 * (or the whole trip when shorter) — uses a cubic ease-out over
 * `landingMs`, with no separate low-speed tail. A hop of one viewport and
 * a jump across the whole list arrive identically. The APPROACH leg covers
 * the rest with constant braking to the landing leg's entry speed, its
 * duration derived from distance and capped at `approachCapMs`.
 */
interface GlidePace {
  landingMs: number;
  landingPx: number;
  approachCapMs: number;
}

/**
 * The runtime's pace for a viewport: an explicit duration is the landing
 * timescale of a one-viewport hop and the cap on the approach (a trip from the
 * far end takes at most twice it); the default lands in LANDING_MS and
 * bounds the whole trip by MAX_DURATION_MS.
 */
export function glidePace(
  viewportHeight: number,
  landingMs?: number,
): GlidePace {
  // The runtime hands over a positive duration or none at all.
  const explicit = landingMs !== undefined;
  return {
    landingMs: explicit ? landingMs : LANDING_MS,
    landingPx: Math.max(1, viewportHeight),
    approachCapMs: explicit
      ? landingMs
      : Math.max(0, MAX_DURATION_MS - LANDING_MS),
  };
}

function easeOutLanding(t: number): number {
  // Speed and braking both taper to zero at the landing.
  return 1 - (1 - t) ** 3;
}

/** The legs of one trip of `distance` px (magnitude), all in px and ms. */
interface Legs {
  approachPx: number;
  approachMs: number;
  /** Approach speeds, px/ms: it brakes at a constant rate from `approachStartSpeed` to the landing's entry speed. */
  approachStartSpeed: number;
  entrySpeed: number;
  landingPx: number;
  landingMs: number;
}

// The approach brakes at a constant rate into the landing: its speed falls
// linearly from a start speed to the landing's entry speed, and the rate
// is the landing's own initial braking, so the hand-off is continuous in
// speed AND in deceleration — a long trip is one unbroken slow-down ending
// in the same landing as a short hop. (A decay that reached the entry
// speed asymptotically held a constant speed for its last third and then
// braked hard: a visible stutter one viewport before the end.) A capped
// approach brakes harder than the landing; the seam then softens the
// braking, never resumes it.
function planLegs(distance: number, pace: GlidePace): Legs {
  const landingPx = Math.min(distance, pace.landingPx);
  const approachPx = Math.max(0, distance - landingPx);
  // Cubic ease-out: entry speed 3 L / T and initial braking 6 L / T².
  const entrySpeed = landingPx > 0 ? (3 * landingPx) / pace.landingMs : 0;
  const landingBraking = (6 * landingPx) / pace.landingMs ** 2;
  // A linear decay at that braking covers approachPx in T ms when
  // (a/2) T² + v1 T = approachPx.
  const uncappedMs =
    landingBraking > 0
      ? (-entrySpeed +
          Math.sqrt(entrySpeed ** 2 + 2 * landingBraking * approachPx)) /
        landingBraking
      : 0;
  const approachMs =
    approachPx > 0 && entrySpeed > 0
      ? Math.min(pace.approachCapMs, uncappedMs)
      : 0;
  // Mean speed of a linear decay is (v0 + v1) / 2.
  const approachStartSpeed =
    approachMs > 0 ? (2 * approachPx) / approachMs - entrySpeed : 0;
  return {
    approachPx,
    approachMs,
    approachStartSpeed,
    entrySpeed,
    landingPx,
    landingMs: pace.landingMs,
  };
}

/** Distance travelled after `elapsed` ms of a trip with these legs. */
function travelled(legs: Legs, elapsed: number): number {
  if (legs.approachMs > 0 && elapsed < legs.approachMs) {
    const t = elapsed / legs.approachMs;
    // Speed v1 + (v0 - v1)(1 - t) integrated: arrives exactly on the
    // approach distance at the entry speed.
    const { approachStartSpeed: v0, entrySpeed: v1, approachMs } = legs;
    return approachMs * (v1 * t + ((v0 - v1) * (1 - (1 - t) ** 2)) / 2);
  }
  const u = Math.min(
    1,
    (elapsed - legs.approachMs) / Math.max(1, legs.landingMs),
  );
  return legs.approachPx + legs.landingPx * easeOutLanding(u);
}

function totalMs(legs: Legs): number {
  return legs.approachMs + legs.landingMs;
}

export function startGlide(
  host: GlideHost,
  pace: GlidePace | number,
  onDone: (completed: boolean) => void,
): Glide {
  // A bare number is a single-leg glide: that duration, ease-out, whatever
  // the distance.
  const resolved: GlidePace =
    typeof pace === "number"
      ? {
          landingMs: pace,
          landingPx: Number.POSITIVE_INFINITY,
          approachCapMs: 0,
        }
      : pace;
  let frame = 0;
  let startTime = -1;
  let finished = false;
  let landing = false;
  let startTop = host.read();
  let lastWritten: number | null = null;
  let lastTarget: number | null = null;
  let legs = planLegs(Math.abs(host.target() - startTop), resolved);

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
    try {
      advance(now);
    } catch (error) {
      // A host exception must not leave an active glide with no next frame.
      // Release its owner (and pending command) before surfacing the error.
      try {
        finish(false);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "glide cleanup failed");
      }
      throw error;
    }
  }

  function land(target: number): void {
    host.write(target);
    if (finished) return;
    lastWritten = target;
    // The write publishes host callbacks. Streaming can move the target
    // inside that same transaction, so arriving at the old end is not a
    // completed glide. Keep ownership and rebase on the next frame.
    const latestTarget = host.target();
    if (
      latestTarget === target &&
      Math.abs(latestTarget - host.read()) <= SNAP_PX
    ) {
      finish(true);
    } else {
      frame = requestAnimationFrame(tick);
    }
  }

  function advance(now: number): void {
    if (startTime < 0) startTime = now;
    const target = host.target();
    const current = host.read();
    // Either endpoint moved externally (an anchor-preserving prepend shifted
    // the position; a snapshot moved the live target): restart the curve
    // from where we are now — never snap back onto the stale curve. The
    // legs re-plan for the new remaining distance: a rebased trip still
    // lands through the same landing leg.
    if (
      (lastWritten !== null && Math.abs(current - lastWritten) > REBASE_PX) ||
      (lastTarget !== null && Math.abs(target - lastTarget) > REBASE_PX)
    ) {
      startTop = current;
      startTime = now;
      legs = planLegs(Math.abs(target - current), resolved);
    }
    lastTarget = target;
    landing = now - startTime >= legs.approachMs;
    const remaining = target - current;
    if (Math.abs(remaining) <= SNAP_PX) {
      land(target);
      return;
    }
    const elapsed = now - startTime;
    const distance = Math.abs(target - startTop);
    // Small live-target drift (under REBASE_PX per frame) stretches the
    // current legs proportionally rather than re-planning them.
    const planned = Math.max(1, legs.approachPx + legs.landingPx);
    const eased =
      startTop +
      Math.sign(target - startTop) *
        Math.min(distance, (travelled(legs, elapsed) * distance) / planned);
    let step = eased - current;
    // Never a sub-pixel frame: floored engines must still make progress.
    if (Math.abs(step) < 1 || Math.sign(step) !== Math.sign(remaining)) {
      step = Math.sign(remaining); // |remaining| > SNAP_PX here.
    }
    host.write(current + step);
    // The write publishes host callbacks, which can cancel or replace us.
    if (finished) return;
    lastWritten = current + step;
    if (
      elapsed >= totalMs(legs) &&
      Math.abs(host.target() - host.read()) <= SNAP_PX
    ) {
      land(host.target());
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  frame = requestAnimationFrame(tick);
  return {
    get active() {
      return !finished;
    },
    get landing() {
      return !finished && landing;
    },
    cancel(): void {
      finish(false);
    },
  };
}
