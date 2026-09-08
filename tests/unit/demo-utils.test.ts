/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  setAttributeIfChanged,
  setHiddenIfChanged,
  setTextIfChanged,
} from "../../demos/shared/utils";

describe("status text", () => {
  it("should preserve unchanged text without emitting DOM mutations", () => {
    const label = document.createElement("span");
    label.textContent = "5 active";
    const text = label.firstChild;
    const observer = new MutationObserver(() => {});
    observer.observe(label, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    setTextIfChanged(label, "5 active");

    expect(label.firstChild).toBe(text);
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it("should display changed text and clear an empty status", () => {
    const label = document.createElement("span");
    label.textContent = "loading";

    setTextIfChanged(label, "ready");
    expect(label.textContent).toBe("ready");

    setTextIfChanged(label, "");
    expect(label.textContent).toBe("");
  });
});

describe("status attributes", () => {
  it.each([
    ["class", "dot", "dot on"],
    ["title", "idle", "loading"],
    ["data-retained", "24", "48"],
    ["aria-busy", "false", "true"],
  ])("should update %s only when its value changes", (name, initial, next) => {
    const element = document.createElement("span");
    element.setAttribute(name, initial);
    const observer = new MutationObserver(() => {});
    observer.observe(element, { attributes: true });

    setAttributeIfChanged(element, name, initial);
    expect(observer.takeRecords()).toEqual([]);

    setAttributeIfChanged(element, name, next);
    expect(element.getAttribute(name)).toBe(next);
    expect(observer.takeRecords()).toHaveLength(1);

    setAttributeIfChanged(element, name, next);
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it.each([false, true])(
    "should preserve visibility without mutations when hidden is %s",
    (hidden) => {
      const element = document.createElement("div");
      element.hidden = hidden;
      const observer = new MutationObserver(() => {});
      observer.observe(element, { attributes: true });

      setHiddenIfChanged(element, hidden);
      expect(observer.takeRecords()).toEqual([]);

      setHiddenIfChanged(element, !hidden);
      expect(element.hidden).toBe(!hidden);
      expect(observer.takeRecords()).toHaveLength(1);
      observer.disconnect();
    },
  );
});
