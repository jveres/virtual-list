/**
 * The measurement queue: pending row heights reported by the host's
 * ResizeObserver (or explicit re-measures), coalesced into one rAF-deferred
 * flush. The queue owns the batching and the defer rules — never flush during
 * an active user scroll, hand off to a running bottom-follow loop that drains
 * on its own frame — while the host owns what a flush *means* (committing
 * sizes and applying the scroll-anchoring correction).
 */

import { positiveSize } from "./layout-kernel";

/** What the measurement queue needs from the virtualizer that owns it. */
export interface MeasurementQueueHost {
  isDisposed(): boolean;
  isUserScrollActive(): boolean;
  itemCount(): number;
  /** A bottom-follow loop is running and will drain the queue on its frame. */
  followLoopDrains(): boolean;
  wakeFollowLoop(): void;
  /**
   * Commit the queued heights (deleting entries as they are consumed) and
   * apply the resulting scroll correction and re-render.
   */
  drain(pending: Map<number, number>): void;
}

export interface MeasurementQueue {
  /** Queue a measured height; flushes on the next frame unless deferred. */
  queue(index: number, height: number): void;
  /** Drop a queued entry (an explicit commit is superseding it). */
  delete(index: number): void;
  /** Drop entries at or beyond the logical count. */
  removeAtOrBeyond(count: number): void;
  clear(): void;
  hasPending(): boolean;
  scheduleFlush(): void;
  cancelFlush(): void;
  /** Drain synchronously when allowed; true when a flush ran. */
  flushNow(): boolean;
}

export function createMeasurementQueue(
  host: MeasurementQueueHost,
): MeasurementQueue {
  const pending = new Map<number, number>();
  let frame = 0;

  function cancelFlush(): void {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function flush(): void {
    if (pending.size === 0) return;
    if (host.isUserScrollActive()) return;
    host.drain(pending);
  }

  // rAF body for the deferred flush. While bottom-follow is animating (e.g.
  // streaming follow) it already drains pending measurements via flushNow and
  // runs a single scroll+render pass per frame, so hand off to it instead of
  // running a second flush+scroll+render the same frame.
  function runScheduledFlush(): void {
    frame = 0;
    if (host.followLoopDrains()) {
      host.wakeFollowLoop();
      return;
    }
    flush();
  }

  function scheduleFlush(): void {
    if (frame || host.isDisposed()) return;
    frame = requestAnimationFrame(runScheduledFlush);
  }

  function queue(index: number, height: number): void {
    if (
      !Number.isFinite(height) ||
      height <= 0 ||
      index < 0 ||
      index >= host.itemCount()
    ) {
      return;
    }
    pending.set(index, positiveSize(height));
    if (host.isUserScrollActive()) return;
    scheduleFlush();
  }

  function flushNow(): boolean {
    if (pending.size === 0 || host.isUserScrollActive()) {
      return false;
    }
    cancelFlush();
    flush();
    return true;
  }

  return {
    queue,
    delete: (index) => {
      pending.delete(index);
    },
    removeAtOrBeyond: (count) => {
      for (const index of pending.keys()) {
        if (index >= count) pending.delete(index);
      }
    },
    clear: () => {
      pending.clear();
    },
    hasPending: () => pending.size > 0,
    scheduleFlush,
    cancelFlush,
    flushNow,
  };
}
