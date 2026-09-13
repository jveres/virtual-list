/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { autosizeTextarea } from "../../integrations/index";

afterEach(() => document.body.replaceChildren());

function setup(height: number) {
  const container = document.createElement("div");
  const input = document.createElement("textarea");
  input.style.border = "1px solid";
  container.style.minHeight = "18px";
  container.append(input);
  document.body.append(container);
  container.getBoundingClientRect = () => ({ height: 200 }) as DOMRect;
  Object.defineProperty(input, "scrollHeight", {
    get: () => {
      expect(container.style.minHeight).toBe("200px");
      return height;
    },
  });
  return { container, input };
}

describe("textarea sizing", () => {
  it("should preserve the composer box during the input probe", () => {
    const { container, input } = setup(90);
    autosizeTextarea(input, { minHeight: 42, maxHeight: 160 });
    expect(input.style.height).toBe("92px");
    expect(input.style.overflowY).toBe("hidden");
    expect(container.style.minHeight).toBe("18px");
  });
  it("should clamp a long input and enable its own scrolling", () => {
    const { input } = setup(250);
    autosizeTextarea(input, { minHeight: 42, maxHeight: 160 });
    expect(input.style.height).toBe("160px");
    expect(input.style.overflowY).toBe("auto");
  });
  it("should reject invalid bounds before changing layout", () => {
    const { input, container } = setup(90);
    expect(() =>
      autosizeTextarea(input, { minHeight: 100, maxHeight: 42 }),
    ).toThrow(RangeError);
    expect(input.style.height).toBe("");
    expect(container.style.minHeight).toBe("18px");
  });
});
