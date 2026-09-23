/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createItemMeasurer } from "../../demos/newspaper/premeasure";

// Lifecycle characterization only: jsdom has no layout engine, so measured
// heights here are stubbed or the positive-size fallback (1). Real
// measurement accuracy is checked by the newspaper browser regressions.

function makeViewport(width = 640): HTMLElement {
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "clientWidth", { get: () => width });
  document.body.appendChild(viewport);
  return viewport;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("newspaper item measurer", () => {
  it("should create a hidden, inert, width-synced root", () => {
    const measurer = createItemMeasurer({ viewport: makeViewport(640) });
    const root = document.body.lastElementChild as HTMLElement;

    expect(root.style.visibility).toBe("hidden");
    expect(root.style.opacity).toBe("0");
    expect(root.inert).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.style.position).toBe("fixed");
    expect(root.style.width).toBe("640px");
    measurer.dispose();
  });

  it("should measure a batch inside the root and hand every element back detached", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    const root = document.body.lastElementChild as HTMLElement;
    const elements = [40, 80, 120].map((height) => {
      const element = document.createElement("article");
      element.getBoundingClientRect = () => {
        expect(element.parentElement).toBe(root);
        return { height } as DOMRect;
      };
      return element;
    });

    expect(measurer.measureMany(elements)).toEqual([40, 80, 120]);

    for (const element of elements) {
      expect(element.isConnected).toBe(false);
      expect(element.style.position).toBe("absolute");
    }
    expect(root.childNodes).toHaveLength(0);
    expect(measurer.measureMany([])).toEqual([]);
    measurer.dispose();
  });

  it("should fall back to a positive height when layout reports none", () => {
    const measurer = createItemMeasurer({ viewport: makeViewport() });

    const [height] = measurer.measureMany([
      document.createElement("div"),
      document.createElement("div"),
    ]);

    expect(height).toBe(1);
    measurer.dispose();
  });

  it("should detach every element after a layout failure and recover", () => {
    const measurer = createItemMeasurer({ viewport: makeViewport() });
    const root = document.body.lastElementChild as HTMLElement;
    let fail = true;
    const first = document.createElement("article");
    const second = document.createElement("article");
    first.getBoundingClientRect = () => {
      if (fail) throw new Error("layout failed");
      return { height: 40 } as DOMRect;
    };
    second.getBoundingClientRect = () => ({ height: 50 }) as DOMRect;

    expect(() => measurer.measureMany([first, second])).toThrow(
      "layout failed",
    );
    expect(root.childElementCount).toBe(0);

    fail = false;
    expect(measurer.measureMany([first, second])).toEqual([40, 50]);
    measurer.dispose();
  });

  it("should re-sync the root width to the viewport on every measure", () => {
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

  it("should remove the root on dispose and refuse further measurement", () => {
    const measurer = createItemMeasurer({ viewport: makeViewport() });
    const root = document.body.lastElementChild as HTMLElement;

    measurer.dispose();

    expect(root.isConnected).toBe(false);
    expect(() => measurer.measureMany([document.createElement("div")])).toThrow(
      /disposed/,
    );
    measurer.dispose(); // Idempotent.
  });
});
