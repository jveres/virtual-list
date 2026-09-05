import { describe, expect, it } from "vitest";
import { type ReachContext, ReachController } from "../../src/reach";

describe("edge reach policy", () => {
  it("should release completed reaches without aborting them or rearming the edge", () => {
    const contexts: ReachContext[] = [];
    const reach = new ReachController({
      start: (context) => contexts.push(context),
    });
    reach.update(0, 5000);
    const first = contexts[0];
    if (!first) throw new Error("missing reach");

    first.complete();
    first.complete();
    reach.update(0, 5000);

    expect(contexts).toHaveLength(1);
    reach.update(1500, 5000);
    reach.update(0, 5000);
    reach.update(5000, 5000);
    expect(contexts.map(({ signal }) => signal.aborted)).toEqual([false, true]);
    reach.dispose();
    expect(first.signal.aborted).toBe(false);
  });

  it("should release a reach whose callback throws", () => {
    const signals: AbortSignal[] = [];
    const error = new Error("load failed");
    const reach = new ReachController({
      start: ({ signal }) => {
        signals.push(signal);
        throw error;
      },
    });

    expect(() => reach.update(0, 5000)).toThrow(error);
    reach.dispose();

    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
  });

  it("should tolerate completion from an abort listener", () => {
    const signals: AbortSignal[] = [];
    const reach = new ReachController({
      start: ({ signal, complete }) => {
        signals.push(signal);
        signal.addEventListener("abort", complete, { once: true });
      },
    });
    reach.update(0, 5000);
    reach.update(1500, 5000);
    reach.update(0, 5000);

    reach.dispose();

    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("re-arms only after leaving the hysteresis band", () => {
    const signals: AbortSignal[] = [];
    const reach = new ReachController({
      start: ({ signal }) => signals.push(signal),
    });
    reach.update(800, 5000);
    reach.update(1000, 5000);
    reach.update(700, 5000);
    expect(signals).toHaveLength(1);
    reach.update(1201, 5000);
    reach.update(800, 5000);
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    reach.update(5000, 5000);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("stops checking edges if a reach callback disposes the controller", () => {
    const edges: string[] = [];
    const reach = new ReachController({
      start: () => {
        edges.push("start");
        reach.dispose();
      },
      end: () => edges.push("end"),
    });
    reach.update(0, 0);
    expect(edges).toEqual(["start"]);
  });

  it("does not start a load if aborting the opposite edge disposes it", () => {
    const edges: string[] = [];
    const reach = new ReachController({
      start: ({ signal }) => {
        edges.push("start");
        signal.addEventListener("abort", () => reach.dispose());
      },
      end: () => edges.push("end"),
    });
    reach.update(0, 5000);
    reach.update(5000, 5000);
    expect(edges).toEqual(["start"]);
  });
});
