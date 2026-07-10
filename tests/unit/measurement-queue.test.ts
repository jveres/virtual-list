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
  drainChangesLayout: boolean;
}

function makeQueue(overrides: Partial<HostState> = {}): {
  queue: MeasurementQueue;
  state: HostState;
  drained: Map<number, number>[];
  wakes: () => number;
  renders: () => number;
} {
  const state: HostState = {
    disposed: false,
    userScrollActive: false,
    itemCount: 100,
    followDrains: false,
    drainChangesLayout: true,
    ...overrides,
  };
  const drained: Map<number, number>[] = [];
  const wakeFollowLoop = vi.fn();
  const render = vi.fn();
  const host: MeasurementQueueHost = {
    isDisposed: () => state.disposed,
    isUserScrollActive: () => state.userScrollActive,
    itemCount: () => state.itemCount,
    followLoopDrains: () => state.followDrains,
    wakeFollowLoop,
    drain: (pending) => {
      drained.push(new Map(pending));
      return state.drainChangesLayout;
    },
    render,
  };
  return {
    queue: createMeasurementQueue(host),
    state,
    drained,
    wakes: () => wakeFollowLoop.mock.calls.length,
    renders: () => render.mock.calls.length,
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
    queue.queue(Number.NaN, 50);
    queue.queue(1.5, 50);
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
    expect(queue.flushNow()).toEqual({
      flushed: false,
      needsRender: false,
    });

    state.userScrollActive = false;
    expect(queue.flushNow()).toEqual({ flushed: true, needsRender: true });
    expect(drained).toHaveLength(1);
  });

  it("hands off to an active follow loop instead of draining", () => {
    const { queue, drained, wakes } = makeQueue({ followDrains: true });
    queue.queue(1, 50);
    expect(drained).toHaveLength(0);
    expect(wakes()).toBe(1);
    expect(queue.hasPending()).toBe(true); // the loop drains via flushNow
    vi.advanceTimersByTime(17);
    expect(wakes()).toBe(1); // no redundant queue frame was left behind
  });

  it("should hand off when bottom-follow starts after scheduling", () => {
    const { queue, state, drained, wakes } = makeQueue();
    queue.queue(1, 50);
    state.followDrains = true;

    vi.advanceTimersByTime(17);

    expect(drained).toHaveLength(0);
    expect(wakes()).toBe(1);
    expect(queue.hasPending()).toBe(true);
  });

  it("should let a follow frame defer the queue-owned render", () => {
    const { queue, renders } = makeQueue();
    queue.queue(1, 50);

    expect(queue.flushNow({ deferRender: true })).toEqual({
      flushed: true,
      needsRender: true,
    });
    expect(renders()).toBe(0);
  });

  it("should skip rendering when a batch does not change row geometry", () => {
    const { queue, renders } = makeQueue({ drainChangesLayout: false });
    queue.queue(1, 50);
    expect(queue.flushNow()).toEqual({ flushed: true, needsRender: false });
    expect(renders()).toBe(0);
  });

  it("flushNow drains synchronously and cancels the scheduled frame", () => {
    const { queue, drained } = makeQueue();
    queue.queue(1, 50);
    expect(queue.flushNow()).toEqual({ flushed: true, needsRender: true });
    expect(drained).toHaveLength(1);
    vi.advanceTimersByTime(50); // the canceled frame must not double-drain
    expect(drained).toHaveLength(1);
    expect(queue.flushNow()).toEqual({
      flushed: false,
      needsRender: false,
    });
  });

  it("keeps the scheduled frame when flushNow is blocked by scrolling", () => {
    const { queue, state, drained } = makeQueue();
    queue.queue(1, 50);
    state.userScrollActive = true;

    expect(queue.flushNow()).toEqual({
      flushed: false,
      needsRender: false,
    });

    state.userScrollActive = false;
    vi.advanceTimersByTime(17);
    expect(drained).toEqual([new Map([[1, 50]])]);
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
