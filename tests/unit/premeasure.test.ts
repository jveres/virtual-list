/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createItemMeasurementStage,
  createItemMeasurer,
} from "../../src/premeasure";

// Lifecycle characterization only: jsdom has no layout engine, so measured
// heights here are the positiveSize fallback (1) — real premeasurement
// accuracy is validated in real browsers. What jsdom CAN pin: root
// creation/teardown, width syncing, and detach-before-return (that many
// fresh rows share ONE detached layout is pinned by the runtime suite).

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
  it("measures under the supplied styling context and removes only its own root", () => {
    const viewport = makeViewport();
    const context = document.createElement("section");
    context.className = "chat-context";
    document.body.appendChild(context);
    const measurer = createItemMeasurer({ viewport, container: context });
    const element = document.createElement("div");
    element.getBoundingClientRect = () => {
      expect(element.closest(".chat-context")).toBe(context);
      return { height: 72 } as DOMRect;
    };
    expect(measurer.measureMany([element])).toEqual([72]);
    measurer.dispose();
    expect(context.isConnected).toBe(true);
    expect(context.childElementCount).toBe(0);
  });
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

  it("measures many retained elements and hands them all back detached", () => {
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

describe("staged item measurement", () => {
  it("should keep batches connected and read their latest heights at handoff", () => {
    const viewport = makeViewport();
    const stage = createItemMeasurementStage({ viewport });
    const first = document.createElement("article");
    const second = document.createElement("article");
    let height = 80;
    first.getBoundingClientRect = () => ({ height }) as DOMRect;
    second.getBoundingClientRect = () => ({ height: 120 }) as DOMRect;

    stage.append([first]);
    stage.append([second]);
    height = 160;

    expect(first.isConnected).toBe(true);
    expect(second.parentElement).toBe(first.parentElement);
    expect(viewport.contains(first)).toBe(false);
    expect(stage.measure()).toEqual([160, 120]);
    stage.dispose();
    expect(first.parentElement).toBeNull();
    expect(second.parentElement).toBeNull();
    expect(() => stage.measure()).toThrow("disposed");
    expect(() => stage.append([first])).toThrow("disposed");
    stage.dispose();
  });

  it("should stay independent of synchronous measurements in the same list", () => {
    const viewport = makeViewport();
    const stage = createItemMeasurementStage({ viewport });
    const measurer = createItemMeasurer({ viewport });
    const staged = document.createElement("article");
    staged.getBoundingClientRect = () => ({ height: 80 }) as DOMRect;
    const live = document.createElement("article");
    live.getBoundingClientRect = () => ({ height: 50 }) as DOMRect;

    stage.append([staged]);
    expect(measurer.measureMany([live])).toEqual([50]);

    expect(staged.isConnected).toBe(true);
    expect(live.isConnected).toBe(false);
    expect(stage.measure()).toEqual([80]);
    stage.dispose();
    measurer.dispose();
    expect(document.body.childElementCount).toBe(1);
  });

  it("should remove every staged row after a warm-layout failure", () => {
    const viewport = makeViewport();
    const stage = createItemMeasurementStage({ viewport });
    const row = document.createElement("article");
    row.getBoundingClientRect = () => {
      throw new Error("layout failed");
    };

    expect(() => stage.append([row])).toThrow("layout failed");
    stage.dispose();

    expect(row.parentElement).toBeNull();
    expect(document.body.childElementCount).toBe(1);
  });
});
