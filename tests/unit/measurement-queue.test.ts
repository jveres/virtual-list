/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMeasurementQueue,
  type MeasurementQueue,
  type MeasurementQueueHost,
} from "../../src/measurement-queue";

// The measurement queue in isolation: batching, the defer rules (user scroll,
// follow-loop hand-off), and the drain contract, driven through a fake host.

interface HostState {
  disposed: boolean;
  userScrollActive: boolean;
  itemCount: number;
  followDrains: boolean;
}

function makeQueue(overrides: Partial<HostState> = {}): {
  queue: MeasurementQueue;
  state: HostState;
  drained: Map<number, number>[];
  wakes: () => number;
} {
  const state: HostState = {
    disposed: false,
    userScrollActive: false,
    itemCount: 100,
    followDrains: false,
    ...overrides,
  };
  const drained: Map<number, number>[] = [];
  const wakeFollowLoop = vi.fn();
  const host: MeasurementQueueHost = {
    isDisposed: () => state.disposed,
    isUserScrollActive: () => state.userScrollActive,
    itemCount: () => state.itemCount,
    followLoopDrains: () => state.followDrains,
    wakeFollowLoop,
    drain: (pending) => {
      drained.push(new Map(pending));
      pending.clear();
    },
  };
  return {
    queue: createMeasurementQueue(host),
    state,
    drained,
    wakes: () => wakeFollowLoop.mock.calls.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("measurement queue", () => {
  it("coalesces queued heights into one drain on the next frame", () => {
    const { queue, drained } = makeQueue();
    queue.queue(3, 120);
    queue.queue(5, 80);
    queue.queue(3, 130); // later sample wins
    expect(drained).toHaveLength(0);

    vi.advanceTimersByTime(17);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toEqual(
      new Map([
        [3, 130],
        [5, 80],
      ]),
    );
  });

  it("rejects non-finite, non-positive, and out-of-count measurements", () => {
    const { queue, drained } = makeQueue({ itemCount: 10 });
    queue.queue(0, Number.NaN);
    queue.queue(1, 0);
    queue.queue(-1, 50);
    queue.queue(10, 50);
    vi.advanceTimersByTime(17);
    expect(drained).toHaveLength(0);
    expect(queue.hasPending()).toBe(false);
  });

  it("holds the queue while a user scroll is active", () => {
    const { queue, state, drained } = makeQueue({ userScrollActive: true });
    queue.queue(1, 50);
    vi.advanceTimersByTime(100);
    expect(drained).toHaveLength(0);
    expect(queue.flushNow()).toBe(false); // still scrolling

    state.userScrollActive = false;
    expect(queue.flushNow()).toBe(true); // gesture settled: drains now
    expect(drained).toHaveLength(1);
  });

  it("hands off to an active follow loop instead of draining", () => {
    const { queue, drained, wakes } = makeQueue({ followDrains: true });
    queue.queue(1, 50);
    vi.advanceTimersByTime(17);
    expect(drained).toHaveLength(0);
    expect(wakes()).toBe(1);
    expect(queue.hasPending()).toBe(true); // the loop drains via flushNow
  });

  it("flushNow drains synchronously and cancels the scheduled frame", () => {
    const { queue, drained } = makeQueue();
    queue.queue(1, 50);
    expect(queue.flushNow()).toBe(true);
    expect(drained).toHaveLength(1);
    vi.advanceTimersByTime(50); // the canceled frame must not double-drain
    expect(drained).toHaveLength(1);
    expect(queue.flushNow()).toBe(false); // nothing pending
  });

  it("supports targeted eviction: delete, removeAtOrBeyond, clear", () => {
    const { queue, drained } = makeQueue();
    queue.queue(1, 50);
    queue.queue(7, 60);
    queue.queue(9, 70);

    queue.delete(1);
    queue.removeAtOrBeyond(9);
    vi.advanceTimersByTime(17);
    expect(drained[0]).toEqual(new Map([[7, 60]]));

    queue.queue(2, 40);
    queue.clear();
    expect(queue.hasPending()).toBe(false);
  });

  it("cancelFlush stops a scheduled drain without dropping the entries", () => {
    const { queue, drained } = makeQueue();
    queue.queue(1, 50);
    queue.cancelFlush();
    vi.advanceTimersByTime(100);
    expect(drained).toHaveLength(0);
    expect(queue.hasPending()).toBe(true);
  });

  it("does not schedule once disposed", () => {
    const { queue, state, drained } = makeQueue();
    state.disposed = true;
    queue.queue(1, 50);
    vi.advanceTimersByTime(100);
    expect(drained).toHaveLength(0);
  });
});
