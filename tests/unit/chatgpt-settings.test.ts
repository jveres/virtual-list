// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = readFileSync("demos/streaming/index.html", "utf8");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ authenticated: false }),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

it("should keep code interpreter selectable when switching providers", async () => {
  localStorage.setItem(
    "virtual-list:ai-settings",
    JSON.stringify({
      provider: "openai",
      tools: { webSearch: true, imageGeneration: true, codeInterpreter: true },
    }),
  );
  const { initAISettingsPanel, getAISettings } = await import(
    "../../demos/streaming/openai"
  );
  initAISettingsPanel();
  const select = document.querySelector<HTMLSelectElement>("#ai-provider");
  const code = document.querySelector<HTMLInputElement>("#ai-tool-code");
  if (!select || !code) throw new Error("Missing settings controls");
  expect(code.checked).toBe(true);
  expect(code.disabled).toBe(false);

  select.value = "chatgpt";
  select.dispatchEvent(new Event("change"));
  expect(code.checked).toBe(true);
  expect(code.disabled).toBe(false);
  expect(getAISettings().tools.codeInterpreter).toBe(true);

  code.checked = false;
  code.dispatchEvent(new Event("change"));
  expect(getAISettings().tools.codeInterpreter).toBe(false);
  code.checked = true;
  code.dispatchEvent(new Event("change"));
  expect(getAISettings().tools.codeInterpreter).toBe(true);

  select.value = "openai";
  select.dispatchEvent(new Event("change"));
  expect(code.checked).toBe(true);
  expect(code.disabled).toBe(false);
  expect(getAISettings().tools.codeInterpreter).toBe(true);
});

it("should restore enabled code interpreter on a subscription reload", async () => {
  localStorage.setItem(
    "virtual-list:ai-settings",
    JSON.stringify({
      provider: "chatgpt",
      tools: { webSearch: true, imageGeneration: true, codeInterpreter: true },
    }),
  );
  const { initAISettingsPanel } = await import("../../demos/streaming/openai");
  initAISettingsPanel();
  const code = document.querySelector<HTMLInputElement>("#ai-tool-code");
  expect(code?.checked).toBe(true);
  expect(code?.disabled).toBe(false);
});
