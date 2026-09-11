import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("localStorage", { getItem: () => null });
});

afterEach(() => vi.unstubAllGlobals());

it("should return no saved simulated conversation when storage is unavailable", async () => {
  const { loadSimulatedHistory } = await import("../../demos/streaming/openai");

  await expect(loadSimulatedHistory()).resolves.toBeNull();
});

it("should retain simulated versions and progress separately from real history", async () => {
  const {
    loadOpenAIHistory,
    saveOpenAIHistory,
    loadSimulatedHistory,
    saveSimulatedHistory,
  } = await import("../../demos/streaming/openai");
  const real = [{ role: "user" as const, markdown: "Real conversation" }];
  const simulated = {
    markdown: "Saved version tree",
    nextResponse: 3,
    changed: true,
  };
  saveOpenAIHistory(real);

  saveSimulatedHistory({ ...simulated, nextResponse: 2 });
  saveSimulatedHistory(simulated);

  await expect(loadSimulatedHistory()).resolves.toEqual(simulated);
  await expect(loadOpenAIHistory()).resolves.toEqual(real);
});

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

it("should retain branch selection separately from unchanged transcript bytes without storage", async () => {
  const { saveSimulatedHistory, saveSimulatedSelection, loadSimulatedHistory } =
    await import("../../demos/streaming/openai");
  const history = {
    markdown: "Unchanged saved tree",
    nextResponse: 3,
    changed: false,
  };
  const chosenNode = { id: 1, selectedChildId: 3 };
  const selection = {
    selectedRootId: 1,
    nodes: [chosenNode],
  };
  saveSimulatedHistory(history);

  expect(saveSimulatedSelection(selection, 4, true)).toBe(true);
  chosenNode.selectedChildId = 2;

  await expect(loadSimulatedHistory()).resolves.toEqual({
    ...history,
    nextResponse: 4,
    changed: true,
    selection: { selectedRootId: 1, nodes: [{ id: 1, selectedChildId: 3 }] },
  });
});

it("should discard an old selection when a full transcript replaces its snapshot", async () => {
  const { saveSimulatedHistory, saveSimulatedSelection, loadSimulatedHistory } =
    await import("../../demos/streaming/openai");
  saveSimulatedHistory({
    markdown: "Old tree",
    nextResponse: 3,
    changed: true,
  });
  saveSimulatedSelection({ selectedRootId: 1, nodes: [] }, 4, true);
  const replacement = {
    markdown: "Replacement tree",
    nextResponse: 0,
    changed: false,
  };

  saveSimulatedHistory(replacement);

  await expect(loadSimulatedHistory()).resolves.toEqual(replacement);
});

it("should require a saved snapshot before persisting its branch choices", async () => {
  const { saveSimulatedSelection, loadSimulatedHistory } = await import(
    "../../demos/streaming/openai"
  );

  expect(
    saveSimulatedSelection({ selectedRootId: 1, nodes: [] }, 0, true),
  ).toBe(false);

  await expect(loadSimulatedHistory()).resolves.toBeNull();
});

it("should save history without requiring secure-context UUID support", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  const { saveSimulatedHistory, loadSimulatedHistory } = await import(
    "../../demos/streaming/openai"
  );
  const history = {
    markdown: "LAN demo history",
    nextResponse: 0,
    changed: true,
  };

  saveSimulatedHistory(history);

  await expect(loadSimulatedHistory()).resolves.toEqual(history);
});
