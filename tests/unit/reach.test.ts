import { describe, expect, it } from "vitest";
import { ReachController } from "../../src/reach";

describe("edge reach policy", () => {
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
