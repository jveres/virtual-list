/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createItemMeasurementStage,
  createItemMeasurer,
} from "../../demos/newspaper/premeasure";

// Lifecycle characterization only: jsdom has no layout engine, so measured
// heights here are the positiveSize fallback (1) — real premeasurement
// accuracy is validated in real browsers. What jsdom CAN pin: root
// creation/teardown, width syncing, and bounded single-row retention (that many
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
  it("measures in a hidden width-synced root and retains one element off-scroller", () => {
    const viewport = makeViewport(640);
    const measurer = createItemMeasurer({
      viewport,
      canvasClassName: "chat-canvas wide",
    });

    const root = document.body.lastElementChild as HTMLElement;
    expect(root.classList.contains("chat-canvas")).toBe(true);
    expect(root.classList.contains("wide")).toBe(true);
    expect(root.style.visibility).toBe("hidden");
    expect(root.style.opacity).toBe("0");
    expect(root.inert).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.style.position).toBe("fixed");
    expect(root.style.width).toBe("640px");

    const element = document.createElement("div");
    element.textContent = "hello";
    const [height] = measurer.measureMany([element]);
    expect(height).toBeGreaterThan(0); // jsdom: the positive-size fallback.
    expect(element.parentElement).toBe(root);
    expect(viewport.contains(element)).toBe(false);
    expect(element.style.position).toBe("absolute");
    expect(root.childNodes.length).toBe(1); // The root never accumulates.
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

  it("should reuse the same connected row while refreshing height and positioning", () => {
    let width = 640;
    const measurer = createItemMeasurer({
      viewport: makeViewport(),
      viewportWidth: () => width,
    });
    const row = document.createElement("article");
    let height = 40;
    row.getBoundingClientRect = () => ({ height }) as DOMRect;
    expect(measurer.measureMany([row])).toEqual([40]);
    const root = row.parentElement as HTMLElement;
    const observer = new MutationObserver(() => {});
    observer.observe(root, { childList: true });

    height = 80;
    width = 360;
    row.style.position = "relative";
    expect(measurer.measureMany([row])).toEqual([80]);
    expect(measurer.measureMany([])).toEqual([]);

    expect(observer.takeRecords()).toEqual([]);
    expect(root.childNodes).toHaveLength(1);
    expect(row.style.position).toBe("absolute");
    expect(root.style.width).toBe("360px");
    observer.disconnect();
    measurer.dispose();
    expect(row.parentElement).toBeNull();
  });

  it("should evict the previous resident and detach every larger batch", () => {
    const measurer = createItemMeasurer({ viewport: makeViewport() });
    const first = document.createElement("article");
    const second = document.createElement("article");
    const third = document.createElement("article");
    measurer.measureMany([first]);
    const root = first.parentElement as HTMLElement;

    measurer.measureMany([second]);
    expect(first.parentElement).toBeNull();
    expect([...root.children]).toEqual([second]);
    measurer.measureMany([first, third]);

    expect(root.childElementCount).toBe(0);
    for (const row of [first, second, third]) {
      expect(row.parentElement).toBeNull();
    }
    measurer.dispose();
  });

  it.each(["layout", "width"])(
    "should clear a resident after a %s failure and recover",
    (failure) => {
      let fail = false;
      const measurer = createItemMeasurer({
        viewport: makeViewport(),
        viewportWidth: () => {
          if (fail && failure === "width") throw new Error("width failed");
          return 640;
        },
      });
      const row = document.createElement("article");
      row.getBoundingClientRect = () => {
        if (fail && failure === "layout") throw new Error("layout failed");
        return { height: 40 } as DOMRect;
      };
      measurer.measureMany([row]);
      const root = row.parentElement as HTMLElement;

      fail = true;
      expect(() => measurer.measureMany([row])).toThrow(`${failure} failed`);
      expect(root.childElementCount).toBe(0);
      expect(row.parentElement).toBeNull();
      fail = false;
      expect(measurer.measureMany([row])).toEqual([40]);
      expect(row.parentElement).toBe(root);
      measurer.dispose();
    },
  );

  it("should leave no resident when disposed during measurement", () => {
    const measurer = createItemMeasurer({ viewport: makeViewport() });
    const root = document.body.lastElementChild as HTMLElement;
    const row = document.createElement("article");
    row.getBoundingClientRect = () => {
      measurer.dispose();
      return { height: 40 } as DOMRect;
    };

    expect(measurer.measureMany([row])).toEqual([40]);

    expect(root.isConnected).toBe(false);
    expect(root.childElementCount).toBe(0);
    expect(row.parentElement).toBeNull();
    measurer.dispose();
  });

  it("should not retain ownership after a row is mounted or removed", () => {
    const viewport = makeViewport();
    const measurer = createItemMeasurer({ viewport });
    const mounted = document.createElement("article");
    const removed = document.createElement("article");
    measurer.measureMany([mounted]);
    const root = mounted.parentElement as HTMLElement;
    viewport.appendChild(mounted);
    measurer.measureMany([removed]);
    removed.remove();

    expect(root.childElementCount).toBe(0);
    measurer.dispose();

    expect(mounted.parentElement).toBe(viewport);
    expect(removed.parentElement).toBeNull();
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
    expect(live.isConnected).toBe(true);
    expect(live.parentElement).not.toBe(staged.parentElement);
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
