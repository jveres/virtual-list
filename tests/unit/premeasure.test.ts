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

    const element = document.createElement("div");
    element.textContent = "hello";
    const [height] = measurer.measureMany([element]);
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
    expect(() => measurer.measureMany([document.createElement("div")])).toThrow(
      /disposed/,
    );
    measurer.dispose(); // Idempotent.
  });

  it("measures many retained elements in one pass and hands them all back detached", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    const root = document.body.lastElementChild as HTMLElement;
    const elements = [0, 1, 2].map(() => document.createElement("div"));
    const heights = measurer.measureMany(elements);
    expect(heights).toHaveLength(3);
    for (const height of heights) expect(height).toBeGreaterThan(0);
    for (const element of elements) {
      expect(element.isConnected).toBe(false);
      expect(element.style.position).toBe("absolute");
    }
    expect(root.childNodes.length).toBe(0);
    expect(measurer.measureMany([])).toEqual([]);
    measurer.dispose();
    expect(() => measurer.measureMany(elements)).toThrow(/disposed/);
  });

  it("takes its width from the host's source when one is supplied", () => {
    const viewport = makeViewport(640);
    let width = 500;
    const measurer = createItemMeasurer({
      viewport,
      viewportWidth: () => width,
    });
    const root = document.body.lastElementChild as HTMLElement;
    expect(root.style.width).toBe("500px");
    width = 720;
    measurer.measureMany([document.createElement("div")]);
    expect(root.style.width).toBe("720px");
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
    measurer.measureMany([document.createElement("div")]);
    expect(root.style.width).toBe("720px");
    measurer.dispose();
  });
});
