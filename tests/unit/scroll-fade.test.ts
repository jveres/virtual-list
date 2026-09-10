/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollFade } from "../../demos/shared/scroll-fade.js";

class ResizeProbe {
  static latest: ResizeProbe;
  readonly observed = new Set<Element>();
  constructor(readonly callback: () => void) {
    ResizeProbe.latest = this;
  }
  observe(element: Element): void {
    this.observed.add(element);
  }
  unobserve(element: Element): void {
    this.observed.delete(element);
  }
  disconnect(): void {
    this.observed.clear();
  }
}

const properties = [
  "--scroll-fade-top",
  "--scroll-fade-bottom",
  "--scroll-fade-left",
  "--scroll-fade-right",
];
const disposers: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("ResizeObserver", ResizeProbe));
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture(top = 0, left = 0) {
  const element = document.createElement("div");
  element.style.border = "0px solid transparent";
  const content = document.createElement("div");
  element.append(content);
  document.body.append(element);
  const size = { height: 600, width: 900 };
  Object.defineProperties(element, {
    scrollHeight: { get: () => size.height },
    scrollWidth: { get: () => size.width },
    clientHeight: { value: 200 },
    clientWidth: { value: 300 },
  });
  element.scrollTop = top;
  element.scrollLeft = left;
  const values = () =>
    properties.map((property) => element.style.getPropertyValue(property));
  return { element, content, size, values };
}

describe("scroll edge fades", () => {
  it.each([
    [0, 0, ["0px", "14px", "0px", "14px"]],
    [50, 50, ["14px", "14px", "14px", "14px"]],
    [400, 600, ["14px", "0px", "14px", "0px"]],
    [4, 4, ["0px", "14px", "0px", "14px"]],
    [398, 598, ["14px", "0px", "14px", "0px"]],
  ])(
    "should fade only overflowing directions at %i, %i",
    (top, left, expected) => {
      const { element, values } = fixture(top, left);

      disposers.push(scrollFade(element));

      expect(values()).toEqual(expected);
    },
  );

  it("should update offsets during a scroll and remove fades when content fits", () => {
    const { element, size, values } = fixture();
    disposers.push(scrollFade(element));

    element.scrollTop = 400;
    element.dispatchEvent(new Event("scroll"));

    expect(values()).toEqual(["14px", "0px", "0px", "14px"]);
    size.height = 100;
    size.width = 100;
    element.scrollTop = 0;
    ResizeProbe.latest.callback();
    expect(values()).toEqual(["0px", "0px", "0px", "0px"]);
  });

  it("should observe replacement content and release detached children", async () => {
    const { element, content } = fixture();
    disposers.push(scrollFade(element));
    const replacement = document.createElement("div");

    element.replaceChildren(replacement);
    await Promise.resolve();

    expect(ResizeProbe.latest.observed).toEqual(
      new Set([element, replacement]),
    );
    expect(ResizeProbe.latest.observed.has(content)).toBe(false);
  });

  it("should restore existing styles and release all installed work on disposal", () => {
    const { element, values } = fixture();
    element.style.setProperty("--scroll-fade-top", "3px");
    const dispose = scrollFade(element);

    dispose();
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));

    expect(values()).toEqual(["3px", "", "", ""]);
    expect(element.classList.contains("scroll-fade")).toBe(false);
    expect(ResizeProbe.latest.observed.size).toBe(0);
  });

  it.each([0, 6])(
    "should exempt only the actual scrollbar gutter of %i pixels",
    (gutter) => {
      const { element } = fixture();
      Object.defineProperties(element, {
        offsetWidth: { value: 300 + gutter },
        offsetHeight: { value: 200 + gutter },
      });

      disposers.push(scrollFade(element));

      expect(element.style.getPropertyValue("--scroll-fade-gutter-x")).toBe(
        `${gutter}px`,
      );
      expect(element.style.getPropertyValue("--scroll-fade-gutter-y")).toBe(
        `${gutter}px`,
      );
    },
  );
});
