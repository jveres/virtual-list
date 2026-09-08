import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("localStorage", { getItem: () => null });
});

afterEach(() => vi.unstubAllGlobals());

it("should retain the latest conversation when database storage is unavailable", async () => {
  const { loadOpenAIHistory, saveOpenAIHistory } = await import(
    "../../demos/streaming/openai"
  );
  const turns = [{ role: "user" as const, markdown: "Keep this conversation" }];

  saveOpenAIHistory(turns);

  await expect(loadOpenAIHistory()).resolves.toEqual(turns);
});

it("should not restore stale legacy history after saving an empty conversation", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify([{ role: "user", markdown: "Old chat" }]),
  });
  const { loadOpenAIHistory, saveOpenAIHistory } = await import(
    "../../demos/streaming/openai"
  );
  await expect(loadOpenAIHistory()).resolves.toEqual([
    { role: "user", markdown: "Old chat" },
  ]);

  saveOpenAIHistory([]);

  await expect(loadOpenAIHistory()).resolves.toEqual([]);
});
