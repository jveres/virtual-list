/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { setTextIfChanged } from "../../demos/shared/utils";

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
