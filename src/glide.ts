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
  cancel(): void;
}

const SNAP_PX = 1;
// External endpoint movement beyond this rebases the curve. Above the 1px
// integer-floor noise of engines that floor scrollTop writes.
const REBASE_PX = 2;
const LANDING_MS = 600;
const MAX_DURATION_MS = 1400;

/**
 * A glide is two legs. The LANDING leg — the last `landingPx` of travel
 * (or the whole trip when shorter) — always takes `landingMs` on the same
 * ease-out curve, so a hop of one viewport and a jump across the whole
 * list arrive identically. The APPROACH leg covers the rest: a cubic from
 * rest to the landing leg's entry speed, its duration derived from the
 * distance and capped at `approachCapMs`, so a long trip cruises and then
 * decelerates through the very same landing.
 */
export interface GlidePace {
  landingMs: number;
  landingPx: number;
  approachCapMs: number;
}

/**
 * The runtime's pace for a viewport: an explicit duration is the landing
 * time of a one-viewport hop and the cap on the approach (a trip from the
 * far end takes at most twice it); the default lands in LANDING_MS and
 * bounds the whole trip by MAX_DURATION_MS.
 */
export function glidePace(
  viewportHeight: number,
  landingMs?: number,
): GlidePace {
  const landing =
    landingMs !== undefined && landingMs > 0 ? landingMs : LANDING_MS;
  return {
    landingMs: landing,
    landingPx: Math.max(1, viewportHeight),
    approachCapMs:
      landingMs !== undefined && landingMs > 0
        ? landingMs
        : Math.max(0, MAX_DURATION_MS - LANDING_MS),
  };
}

function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

/** The legs of one trip of `distance` px (magnitude), all in px and ms. */
interface Legs {
  approachPx: number;
  approachMs: number;
  /** Approach speeds, px/ms: it decelerates from `approachStartSpeed` to the landing's entry speed. */
  approachStartSpeed: number;
  entrySpeed: number;
  landingPx: number;
  landingMs: number;
}

// The approach is a burst that decays into the landing: its speed falls
// from a start speed to the landing's entry speed along (1 - t)^k, and
// starts this many times faster than it ends when its duration is not
// capped — a long trip is one continuous deceleration, front-loaded like a
// single ease-out, ending in the same landing as a short hop.
const APPROACH_DECAY_POWER = 3;
const APPROACH_START_SPEED_RATIO = 6;

function planLegs(distance: number, pace: GlidePace): Legs {
  const landingPx = Math.min(distance, pace.landingPx);
  const approachPx = Math.max(0, distance - landingPx);
  // easeOutQuint starts at slope 5: the landing's entry speed in px/ms.
  const entrySpeed = landingPx > 0 ? (5 * landingPx) / pace.landingMs : 0;
  // Mean speed over the decay is entry + (start - entry) / (k + 1), so the
  // distance fixes the duration for the uncapped start ratio; a capped
  // duration just starts faster.
  const meanFactor =
    1 + (APPROACH_START_SPEED_RATIO - 1) / (APPROACH_DECAY_POWER + 1);
  const uncappedMs = approachPx / (entrySpeed * meanFactor);
  const approachMs =
    approachPx > 0 && entrySpeed > 0
      ? Math.min(pace.approachCapMs, uncappedMs)
      : 0;
  const approachStartSpeed =
    approachMs > 0
      ? entrySpeed +
        (APPROACH_DECAY_POWER + 1) * (approachPx / approachMs - entrySpeed)
      : 0;
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
    // Speed v1 + (v0 - v1)(1 - t)^k integrated: arrives exactly on the
    // approach distance at the entry speed.
    const { approachStartSpeed: v0, entrySpeed: v1, approachMs } = legs;
    const k = APPROACH_DECAY_POWER;
    return (
      approachMs * (v1 * t + ((v0 - v1) * (1 - (1 - t) ** (k + 1))) / (k + 1))
    );
  }
  const u = Math.min(
    1,
    (elapsed - legs.approachMs) / Math.max(1, legs.landingMs),
  );
  return legs.approachPx + legs.landingPx * easeOutQuint(u);
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
    const remaining = target - current;
    if (Math.abs(remaining) <= SNAP_PX) {
      host.write(target);
      finish(true);
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
    lastWritten = current + step;
    if (
      elapsed >= totalMs(legs) &&
      Math.abs(host.target() - host.read()) <= SNAP_PX
    ) {
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
