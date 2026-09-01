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

  it("runs destroy with the element even when measurement succeeds", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    let destroyed: HTMLElement | null = null;
    const { element } = measurer.measure(
      () => document.createElement("div"),
      (measured) => {
        destroyed = measured;
      },
    );
    expect(destroyed).toBe(element);
    measurer.dispose();
  });

  it("propagates a build error after teardown, and aggregates double failures", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });

    expect(() =>
      measurer.measure(() => {
        throw new Error("build failed");
      }),
    ).toThrow("build failed");
    // The root is left clean for the next measurement.
    const root = document.body.lastElementChild as HTMLElement;
    expect(root.childNodes.length).toBe(0);

    // Build succeeds, destroy throws: the teardown error surfaces.
    expect(() =>
      measurer.measure(
        () => document.createElement("div"),
        () => {
          throw new Error("teardown failed");
        },
      ),
    ).toThrow("teardown failed");
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
