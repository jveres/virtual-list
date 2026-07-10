/**
 * The measurement queue: pending row heights reported by the host's
 * ResizeObserver (or explicit re-measures), coalesced into one rAF-deferred
 * flush. The queue owns the batching and the defer rules — never flush during
 * an active user scroll, hand off to a running bottom-follow loop that drains
 * on its own frame — while the host owns what a flush *means* (committing
 * sizes and applying the scroll-anchoring correction).
 */

/** What the measurement queue needs from the virtualizer that owns it. */
export interface MeasurementQueueHost {
  isDisposed(): boolean;
  isUserScrollActive(): boolean;
  itemCount(): number;
  /** A bottom-follow loop is running and will drain the queue on its frame. */
  followLoopDrains(): boolean;
  wakeFollowLoop(): void;
  /**
   * Commit the queued heights and apply the resulting scroll correction.
   * Returns true when row geometry changed and needs rendering.
   */
  drain(pending: ReadonlyMap<number, number>): boolean;
  /** Render geometry committed by drain(). */
  render(): void;
}

export interface MeasurementFlushOptions {
  /** Let the caller combine the committed geometry with its own frame render. */
  deferRender?: boolean;
}

export interface MeasurementFlushResult {
  /** The pending queue was drained. */
  readonly flushed: boolean;
  /** The drained measurements changed row geometry. */
  readonly needsRender: boolean;
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
  /** Drain synchronously when allowed and report both work and render state. */
  flushNow(options?: MeasurementFlushOptions): MeasurementFlushResult;
}

const NOT_FLUSHED: MeasurementFlushResult = {
  flushed: false,
  needsRender: false,
};
const FLUSHED_UNCHANGED: MeasurementFlushResult = {
  flushed: true,
  needsRender: false,
};
const FLUSHED_CHANGED: MeasurementFlushResult = {
  flushed: true,
  needsRender: true,
};

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

  function flush(deferRender: boolean): MeasurementFlushResult {
    if (pending.size === 0 || host.isUserScrollActive()) return NOT_FLUSHED;
    const needsRender = host.drain(pending);
    pending.clear();
    if (needsRender && !deferRender) host.render();
    return needsRender ? FLUSHED_CHANGED : FLUSHED_UNCHANGED;
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
    flush(false);
  }

  function scheduleFlush(): void {
    if (frame || host.isDisposed()) return;
    frame = requestAnimationFrame(runScheduledFlush);
  }

  function queue(index: number, height: number): void {
    if (
      !Number.isFinite(height) ||
      height <= 0 ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= host.itemCount()
    ) {
      return;
    }
    pending.set(index, height);
    if (host.isUserScrollActive()) return;
    if (host.followLoopDrains()) {
      cancelFlush();
      host.wakeFollowLoop();
      return;
    }
    scheduleFlush();
  }

  function flushNow(options?: MeasurementFlushOptions): MeasurementFlushResult {
    // A blocked synchronous attempt must not cancel the queue's existing frame:
    // callers such as scrollToBottom can cancel the gesture immediately after
    // this returns, allowing that frame to drain the still-pending heights.
    if (pending.size === 0 || host.isUserScrollActive()) return NOT_FLUSHED;
    cancelFlush();
    return flush(options?.deferRender === true);
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
