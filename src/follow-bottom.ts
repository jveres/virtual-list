/**
 * The bottom-follow driver: a rAF chase loop that keeps the viewport pinned
 * to the growing content bottom while rows stream in. Each frame it drains
 * pending measurements, re-syncs the content height, and eases toward the
 * current native maximum; content growth re-wakes an idle loop through
 * `wake()` (called by the host's content-height sync). A user gesture or an
 * abort signal tears it down.
 */

import { clamp } from "./layout-kernel";

// Structurally identical to VirtualListScrollOptions on purpose: declaring it
// locally keeps this module free of an import cycle with virtual-list.ts, and
// the virtualizer's followBottom() passes its options straight through.
export interface FollowBottomOptions {
  behavior?: ScrollBehavior;
  duration?: number;
  signal?: AbortSignal;
  snapThreshold?: number;
}

/** What the follow driver needs from the virtualizer that owns it. */
export interface FollowBottomHost {
  viewport: HTMLElement;
  /** Duration used for behavior: "smooth" when the caller gives none. */
  defaultSmoothDuration: number;
  /** Snap distance used when the caller gives none. */
  defaultSnapThreshold: number;
  isDisposed(): boolean;
  isUserScrollActive(): boolean;
  /** count > 0 — there is content to follow. */
  hasContent(): boolean;
  syncContentHeight(): void;
  /** Drain settled measurements; true when committed geometry needs rendering. */
  flushMeasurementsNow(): boolean;
  /** Programmatic clamped scrollTop write; true when scrollTop moved. */
  writeScrollTop(top: number): boolean;
  renderNow(): void;
  /** The loop stopped (or a stop was requested): re-schedule deferred work. */
  onStopped(): void;
}

export interface FollowBottomController {
  follow(options?: FollowBottomOptions): void;
  stop(): void;
  /** Content grew: re-arm the chase if a follow is active and unobstructed. */
  wake(): void;
  isActive(): boolean;
}

export function createFollowBottomController(
  host: FollowBottomHost,
): FollowBottomController {
  const { viewport } = host;

  let frame = 0;
  let active = false;
  let lastFrameAt = 0;
  let duration = host.defaultSmoothDuration;
  let snapThreshold = host.defaultSnapThreshold;
  let signal: AbortSignal | null = null;
  let abortHandler: (() => void) | null = null;

  function nativeMaxScrollTop(): number {
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function clearSignal(): void {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    signal = null;
    abortHandler = null;
  }

  function stop(): void {
    active = false;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    clearSignal();
    // Drain any measurements that were deferred to the follow loop while it ran.
    host.onStopped();
  }

  function wake(): void {
    if (
      !active ||
      host.isDisposed() ||
      host.isUserScrollActive() ||
      signal?.aborted ||
      !host.hasContent()
    ) {
      return;
    }
    scheduleFrame();
  }

  function frameProgress(now: number): number {
    const previousFrameAt = lastFrameAt || now;
    lastFrameAt = now;
    const elapsed = Math.max(0, now - previousFrameAt);
    const clampedDuration = Math.max(1, duration);
    if (clampedDuration <= 1) return 1;

    return clamp(1 - 0.01 ** (elapsed / clampedDuration), 0, 1);
  }

  function scheduleFrame(): void {
    if (frame || host.isDisposed()) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    frame = 0;
    if (
      host.isDisposed() ||
      !active ||
      host.isUserScrollActive() ||
      signal?.aborted ||
      !host.hasContent()
    ) {
      stop();
      return;
    }

    const measurementsChanged = host.flushMeasurementsNow();
    host.syncContentHeight();

    const target = nativeMaxScrollTop();

    const distance = Math.abs(viewport.scrollTop - target);
    if (distance <= snapThreshold) {
      const didScroll = host.writeScrollTop(target);
      if (didScroll || measurementsChanged) {
        host.renderNow();
      }
      if (Math.abs(viewport.scrollTop - target) <= snapThreshold) {
        return;
      }
      lastFrameAt = now;
      scheduleFrame();
      return;
    }

    const progress = frameProgress(now);
    const nextTop =
      viewport.scrollTop + (target - viewport.scrollTop) * progress;
    const didScroll = host.writeScrollTop(nextTop);
    if (didScroll || measurementsChanged) {
      host.renderNow();
    }
    scheduleFrame();
  }

  function follow(options: FollowBottomOptions = {}): void {
    stop();
    if (host.isDisposed() || options.signal?.aborted) return;
    const hasContent = host.hasContent();
    if (host.isDisposed() || !hasContent) return;

    host.syncContentHeight();
    if (host.isDisposed()) return;
    duration = Math.max(
      1,
      options.behavior === "smooth"
        ? (options.duration ?? host.defaultSmoothDuration)
        : 1,
    );
    snapThreshold = options.snapThreshold ?? host.defaultSnapThreshold;
    active = true;
    signal = options.signal ?? null;
    if (signal) {
      abortHandler = stop;
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    lastFrameAt = performance.now();
    scheduleFrame();
  }

  return {
    follow,
    stop,
    wake,
    isActive: () => active,
  };
}
