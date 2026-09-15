import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptTree } from "../../demos/streaming/branching-transcript";

// Structured-clone storage double survives module reload, unlike session caches.
function installHistoryDatabase() {
  const records = new Map<string, unknown>();
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = {
        result: {
          transaction: () => {
            const transaction = {
              oncomplete: () => {},
              objectStore: () => ({
                put: (value: unknown, key: string) => {
                  records.set(key, structuredClone(value));
                  queueMicrotask(() => transaction.oncomplete());
                  return { transaction };
                },
                get: (key: string) => {
                  const read = {
                    result: structuredClone(records.get(key)),
                    onsuccess: () => {},
                  };
                  queueMicrotask(() => read.onsuccess());
                  return read;
                },
              }),
            };
            return transaction;
          },
        },
        onsuccess: () => {},
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
}

it.each(["openai", "chatgpt"] as const)(
  "should restore all answer versions and their selection after %s storage reload",
  async (provider) => {
    installHistoryDatabase();
    const history = await import("../../demos/streaming/openai");
    const tree: TranscriptTree = {
      selectedRootId: 1,
      nodes: [
        {
          id: 1,
          parentId: 0,
          selectedChildId: 3,
          message: { role: "user", markdown: "hi" },
        },
        {
          id: 2,
          parentId: 1,
          selectedChildId: 5,
          message: {
            role: "assistant",
            markdown: "> [!CAUTION]\n> Request failed",
          },
        },
        {
          id: 3,
          parentId: 1,
          selectedChildId: null,
          message: {
            role: "assistant",
            markdown: "Hello",
            responseState: {
              id: "resp_success",
              model: "fixture",
              contextStart: 0,
              contextTurns: 0,
              output: [
                { type: "reasoning", encrypted_content: "retained-state" },
              ],
            },
          },
        },
        {
          id: 4,
          parentId: 1,
          selectedChildId: null,
          message: { role: "assistant", markdown: "", stopped: true },
        },
        {
          id: 5,
          parentId: 2,
          selectedChildId: null,
          message: { role: "user", markdown: "Follow-up on the earlier path" },
        },
      ],
    };
    const [prompt, failed, success] = tree.nodes;
    if (!prompt || !failed || !success)
      throw new Error("Missing fixture versions");
    const turns = [prompt.message, success.message];
    history.saveOpenAIHistory(turns, provider, tree);
    await history.loadOpenAIHistory(provider); // Flush queued writes before reload.
    vi.resetModules();
    const reloaded = await import("../../demos/streaming/openai");
    await expect(reloaded.loadOpenAIConversation(provider)).resolves.toEqual({
      turns,
      tree,
    });
    await expect(
      reloaded.loadOpenAIConversation(
        provider === "openai" ? "chatgpt" : "openai",
      ),
    ).resolves.toEqual({ turns: [], tree: null });

    const selectedTree = {
      ...tree,
      nodes: tree.nodes.map((node) =>
        node.id === 1 ? { ...node, selectedChildId: 2 } : node,
      ),
    };
    const followUp = tree.nodes[4];
    if (!followUp) throw new Error("Missing fixture follow-up");
    const selectedTurns = [prompt.message, failed.message, followUp.message];
    reloaded.saveOpenAIHistory(selectedTurns, provider, selectedTree);
    await reloaded.loadOpenAIHistory(provider);
    vi.resetModules();
    const switched = await import("../../demos/streaming/openai");
    await expect(switched.loadOpenAIConversation(provider)).resolves.toEqual({
      turns: selectedTurns,
      tree: selectedTree,
    });
    switched.saveOpenAIHistory([], provider);
    await switched.loadOpenAIHistory(provider);
    vi.resetModules();
    await expect(
      (await import("../../demos/streaming/openai")).loadOpenAIConversation(
        provider,
      ),
    ).resolves.toEqual({ turns: [], tree: null });
  },
);

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("localStorage", { getItem: () => null });
});

afterEach(() => vi.unstubAllGlobals());

it("should keep OAuth and API-key histories independent even without browser storage", async () => {
  const { saveOpenAIHistory, loadOpenAIHistory } = await import(
    "../../demos/streaming/openai"
  );
  const api = [{ role: "user" as const, markdown: "API history" }];
  const oauth = [{ role: "user" as const, markdown: "OAuth history" }];
  saveOpenAIHistory(api, "openai");
  saveOpenAIHistory(oauth, "chatgpt");
  await expect(loadOpenAIHistory("openai")).resolves.toEqual(api);
  await expect(loadOpenAIHistory("chatgpt")).resolves.toEqual(oauth);
  saveOpenAIHistory([], "chatgpt");
  await expect(loadOpenAIHistory("openai")).resolves.toEqual(api);
  await expect(loadOpenAIHistory("chatgpt")).resolves.toEqual([]);
});

it("should never migrate legacy API history into the OAuth conversation", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify([{ role: "user", markdown: "Legacy API chat" }]),
  });
  const { loadOpenAIHistory } = await import("../../demos/streaming/openai");
  await expect(loadOpenAIHistory("chatgpt")).resolves.toEqual([]);
  await expect(loadOpenAIHistory("openai")).resolves.toEqual([
    { role: "user", markdown: "Legacy API chat" },
  ]);
});

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
