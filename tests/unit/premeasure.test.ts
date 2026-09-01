/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createItemMeasurer } from "../../src/premeasure";

// Lifecycle characterization only: jsdom has no layout engine, so measured
// heights here are the positiveSize fallback (1) — real premeasurement
// accuracy is validated in real browsers. What jsdom CAN pin: root
// creation/teardown, width syncing, detach-before-return, the destroy
// lifecycle, and error aggregation.

function makeViewport(width = 640): HTMLElement {
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "clientWidth", { get: () => width });
  document.body.appendChild(viewport);
  return viewport;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("item measurer", () => {
  it("measures in a hidden width-synced root and returns the element detached", () => {
    const viewport = makeViewport(640);
    const measurer = createItemMeasurer({
      viewport,
      canvasClassName: "chat-canvas wide",
    });

    const root = document.body.lastElementChild as HTMLElement;
    expect(root.classList.contains("chat-canvas")).toBe(true);
    expect(root.classList.contains("wide")).toBe(true);
    expect(root.style.visibility).toBe("hidden");
    expect(root.style.position).toBe("fixed");
    expect(root.style.width).toBe("640px");

    const { element, height } = measurer.measure(() => {
      const built = document.createElement("div");
      built.textContent = "hello";
      return built;
    });
    expect(height).toBeGreaterThan(0); // jsdom: the positive-size fallback.
    expect(element.isConnected).toBe(false); // Detached, ready to mount.
    expect(element.style.position).toBe("absolute");
    expect(root.childNodes.length).toBe(0); // The root never accumulates.
    measurer.dispose();
  });

  it("removes the root on dispose and refuses further measurement", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    const root = document.body.lastElementChild as HTMLElement;
    measurer.dispose();
    expect(root.isConnected).toBe(false);
    expect(() => measurer.measure(() => document.createElement("div"))).toThrow(
      /disposed/,
    );
    measurer.dispose(); // Idempotent.
  });

  it("does NOT destroy on success — the caller owns the returned live element", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    let destroyed = 0;
    const { element } = measurer.measure(
      () => document.createElement("div"),
      () => {
        destroyed += 1;
      },
    );
    // The retained-node contract: resources (live viewers, observers)
    // survive to mount; teardown is the caller's, exactly once, later.
    expect(destroyed).toBe(0);
    expect(element.isConnected).toBe(false);
    measurer.dispose();
  });

  it("destroys only on measurement failure after a successful build", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });

    // Build throws: no element exists, destroy must not be invoked.
    let destroyed = 0;
    expect(() =>
      measurer.measure(
        () => {
          throw new Error("build failed");
        },
        () => {
          destroyed += 1;
        },
      ),
    ).toThrow("build failed");
    expect(destroyed).toBe(0);

    // Measurement throws after the build: the never-returned element's
    // resources are torn down and the measurement error surfaces.
    let torndown: HTMLElement | null = null;
    const failing = document.createElement("div");
    failing.getBoundingClientRect = () => {
      throw new Error("measure failed");
    };
    expect(() =>
      measurer.measure(
        () => failing,
        (element) => {
          torndown = element;
        },
      ),
    ).toThrow("measure failed");
    expect(torndown).toBe(failing);

    // The root is left clean for the next measurement.
    const root = document.body.lastElementChild as HTMLElement;
    expect(root.childNodes.length).toBe(0);
    measurer.dispose();
  });

  it("aggregates a measurement failure with a teardown failure", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    const failing = document.createElement("div");
    failing.getBoundingClientRect = () => {
      throw new Error("measure failed");
    };

    let caught: unknown;
    try {
      measurer.measure(
        () => failing,
        () => {
          throw new Error("teardown failed");
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
      "measure failed",
      "teardown failed",
    ]);
    measurer.dispose();
  });

  it("re-syncs the root width to the viewport on every measure", () => {
    let width = 500;
    const viewport = document.createElement("div");
    Object.defineProperty(viewport, "clientWidth", { get: () => width });
    document.body.appendChild(viewport);
    const measurer = createItemMeasurer({ viewport });
    const root = document.body.lastElementChild as HTMLElement;
    expect(root.style.width).toBe("500px");

    width = 720;
    measurer.measure(() => document.createElement("div"));
    expect(root.style.width).toBe("720px");
    measurer.dispose();
  });
});
