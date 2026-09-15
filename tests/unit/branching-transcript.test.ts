import { describe, expect, it } from "vitest";
import {
  branchingTranscriptMarkdown,
  parseBranchingTranscript,
  selectTranscriptBranches,
  type TranscriptTree,
} from "../../demos/streaming/branching-transcript";
import { parseTranscriptMarkdown } from "../../demos/streaming/transcript";

const days = { dayOf: () => 0, dayLabel: () => "Today" };

it("should change branch choices without copying message payloads", () => {
  const tree = conversation();
  const selection = {
    selectedRootId: 1,
    nodes: tree.nodes.map((node) => ({
      id: node.id,
      selectedChildId: node.id === 1 ? 2 : node.selectedChildId,
    })),
  };

  const selected = selectTranscriptBranches(tree, selection);

  expect(selected?.turns).toEqual([
    message(tree, 1),
    message(tree, 2),
    message(tree, 6),
  ]);
  expect(
    selected?.tree?.nodes.map((node) => [node.id, node.selectedChildId]),
  ).toEqual([
    [1, 2],
    [2, 6],
    [3, 4],
    [4, 5],
    [5, null],
    [6, null],
    [10, 11],
    [11, null],
  ]);
  for (const node of selected?.tree?.nodes ?? []) {
    expect(node.message).toBe(message(tree, node.id));
  }
  expect(tree.nodes[0]?.selectedChildId).toBe(3);
});

it.each([null, undefined, {}, { selectedRootId: 1, nodes: [] }])(
  "should reject incomplete saved branch choices (%j)",
  (selection) => {
    expect(selectTranscriptBranches(conversation(), selection)).toBeNull();
  },
);

it.each([
  { label: "wrong root", root: 99, id: 1, child: 3 },
  { label: "non-child selection", root: 1, id: 1, child: 11 },
  { label: "missing selection", root: 1, id: 1, child: null },
  { label: "unknown node", root: 1, id: 99, child: 3 },
  { label: "duplicate node", root: 1, id: 2, child: 3 },
  { label: "invalid node ID", root: 1, id: "1", child: 3 },
])(
  "should reject $label without changing the transcript",
  ({ root, id, child }) => {
    const tree = conversation();
    const original = structuredClone(tree);
    const selection = {
      selectedRootId: root,
      nodes: tree.nodes.map((node, index) => ({
        id: index === 0 ? id : node.id,
        selectedChildId: index === 0 ? child : node.selectedChildId,
      })),
    };

    expect(selectTranscriptBranches(tree, selection)).toBeNull();
    expect(tree).toEqual(original);
  },
);

it("should preserve folded choices when selecting another root and returning", () => {
  const tree = conversation();
  const nodes = tree.nodes.map(({ id, selectedChildId }) => ({
    id,
    selectedChildId,
  }));

  const alternate = selectTranscriptBranches(tree, {
    selectedRootId: 10,
    nodes,
  });
  const restored =
    alternate?.tree &&
    selectTranscriptBranches(alternate.tree, { selectedRootId: 1, nodes });

  expect(alternate?.turns).toEqual([message(tree, 10), message(tree, 11)]);
  expect(restored?.tree).toEqual(tree);
  expect(restored?.turns).toEqual([
    message(tree, 1),
    message(tree, 3),
    message(tree, 4),
    message(tree, 5),
  ]);
});

function message(tree: TranscriptTree, id: number) {
  const node = tree.nodes.find((node) => node.id === id);
  if (!node) throw new Error(`Missing fixture node ${id}`);
  return node.message;
}

function conversation(): TranscriptTree {
  return {
    selectedRootId: 1,
    nodes: [
      {
        id: 1,
        parentId: 0,
        selectedChildId: 3,
        message: { role: "user", markdown: "Question", sentAt: 1234 },
      },
      {
        id: 2,
        parentId: 1,
        selectedChildId: 6,
        message: { role: "assistant", markdown: "Original answer" },
      },
      {
        id: 3,
        parentId: 1,
        selectedChildId: 4,
        message: { role: "assistant", markdown: "Regenerated answer" },
      },
      {
        id: 4,
        parentId: 3,
        selectedChildId: 5,
        message: { role: "user", markdown: "Follow up" },
      },
      {
        id: 5,
        parentId: 4,
        selectedChildId: null,
        message: { role: "assistant", markdown: "Final answer" },
      },
      {
        id: 6,
        parentId: 2,
        selectedChildId: null,
        message: { role: "user", markdown: "Old branch follow up" },
      },
      {
        id: 10,
        parentId: 0,
        selectedChildId: 11,
        message: { role: "user", markdown: "Edited question" },
      },
      {
        id: 11,
        parentId: 10,
        selectedChildId: null,
        message: { role: "assistant", markdown: "Edited branch answer" },
      },
    ],
  };
}

describe("branching Markdown transcripts", () => {
  it("should retain stopped status on active and folded versions", () => {
    const tree = conversation();
    message(tree, 2).stopped = true;
    message(tree, 3).stopped = true;

    const restored = parseBranchingTranscript(
      branchingTranscriptMarkdown(tree, days),
    );

    expect(restored.tree).toEqual(tree);
    expect(restored.turns[1]?.stopped).toBe(true);
  });

  it("should round-trip all versions, sibling order, and inactive branch selections", () => {
    const tree = conversation();

    const file = branchingTranscriptMarkdown(tree, days);
    const imported = parseBranchingTranscript(file);

    expect(imported.tree).toEqual(tree);
    expect(imported.turns.map((turn) => turn.markdown)).toEqual([
      "Question",
      "Regenerated answer",
      "Follow up",
      "Final answer",
    ]);
    expect(parseTranscriptMarkdown(file)).toEqual(imported.turns);
    expect(branchingTranscriptMarkdown(imported.tree ?? tree, days)).toBe(file);
  });

  it("should import older files as linear conversations", () => {
    expect(
      parseBranchingTranscript(
        "**User**\n\nQuestion\n\n**Assistant**\n\nAnswer",
      ),
    ).toEqual({
      turns: [
        { role: "user", markdown: "Question" },
        { role: "assistant", markdown: "Answer" },
      ],
      tree: null,
    });
  });

  it("should preserve an empty selected reply without shifting turn references", () => {
    const tree = conversation();
    message(tree, 3).markdown = "";

    const imported = parseBranchingTranscript(
      branchingTranscriptMarkdown(tree, days),
    );

    expect(imported.tree).toEqual(tree);
    expect(imported.turns.map((turn) => turn.markdown)).toEqual([
      "Question",
      "",
      "Follow up",
      "Final answer",
    ]);
  });

  it("should store active attachments and alternate tool payloads only once", () => {
    const tree = conversation();
    message(tree, 1).attachments = [
      {
        name: "hello.txt",
        mimeType: "text/plain",
        size: 5,
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      },
    ];
    message(tree, 2).toolCalls = [
      {
        name: "search",
        status: "done",
        durationMs: 3,
        input: "Unique alternate input",
        output: "Unique alternate output",
      },
    ];
    message(tree, 2).generatedFiles = [
      {
        fileId: "local_alternate",
        filename: "alternate.html",
        content: "Unique alternate file <!-- -->",
      },
    ];
    message(tree, 3).generatedFiles = [
      {
        fileId: "local_selected",
        filename: "selected.html",
        content: "Unique selected file <!-- -->",
      },
    ];

    const file = branchingTranscriptMarkdown(tree, days);

    expect(file.split("aGVsbG8=")).toHaveLength(2);
    expect(file.split("Unique alternate output")).toHaveLength(2);
    expect(file.split("Unique alternate file")).toHaveLength(2);
    expect(file.split("Unique selected file")).toHaveLength(2);
    expect(parseBranchingTranscript(file).tree).toEqual(tree);
  });

  it("should keep comment delimiters and fake tree headers inside message bodies opaque", () => {
    const tree = conversation();
    const literal =
      '<!-- branching-tree {"version":999} -->\n**User**\n<script>alert(1)</script>';
    message(tree, 1).markdown = literal;
    message(tree, 2).markdown = literal;

    const file = branchingTranscriptMarkdown(tree, days);

    expect(file.split("\n")[2]?.match(/-->/g)).toEqual(["-->"]);
    expect(parseBranchingTranscript(file).tree).toEqual(tree);
  });

  it("should accept CRLF files and a byte-order mark", () => {
    const tree = conversation();
    const file = `\uFEFF${branchingTranscriptMarkdown(tree, days).replace(/\n/g, "\r\n")}`;

    expect(parseBranchingTranscript(file).tree).toEqual(tree);
  });

  it("should preserve selections when nodes are not in parent-first order", () => {
    const tree = conversation();
    tree.nodes.reverse();

    expect(
      parseBranchingTranscript(branchingTranscriptMarkdown(tree, days)).tree,
    ).toEqual(tree);
  });

  it.each([
    { version: 2 },
    { selectedRootId: 99 },
    { selectedRootId: null },
    { nodes: [{ id: 1, parentId: 99, selectedChildId: null, turn: 0 }] },
    { nodes: [{ id: 1, parentId: 0, selectedChildId: 99, turn: 0 }] },
    { nodes: [{ id: 1, parentId: 0, selectedChildId: null, turn: 1 }] },
    {
      nodes: [
        {
          id: 1,
          parentId: 0,
          selectedChildId: null,
          turn: 0,
          message: { role: "user", markdown: "Ambiguous" },
        },
      ],
    },
    {
      nodes: [
        { id: 1, parentId: 0, selectedChildId: null, turn: 0 },
        { id: 1, parentId: 0, selectedChildId: null, turn: 0 },
      ],
    },
    {
      nodes: [
        { id: 1, parentId: 0, selectedChildId: null, turn: 0 },
        {
          id: 2,
          parentId: 3,
          selectedChildId: 3,
          message: { role: "user", markdown: "Cycle" },
        },
        {
          id: 3,
          parentId: 2,
          selectedChildId: 2,
          message: { role: "assistant", markdown: "Cycle" },
        },
      ],
    },
  ])("should reject malformed tree metadata: %j", (overrides) => {
    const metadata = {
      version: 1,
      selectedRootId: 1,
      nodes: [{ id: 1, parentId: 0, selectedChildId: null, turn: 0 }],
      ...overrides,
    };
    const file = `# streaming-chat transcript\n\n<!-- branching-tree ${JSON.stringify(metadata)} -->\n\n**User**\n\nQuestion`;

    expect(() => parseBranchingTranscript(file)).toThrow(
      "Invalid transcript version tree",
    );
  });

  it.each(["{oops} -->", '{"version":1'])(
    "should reject broken metadata instead of silently importing only the active branch: %s",
    (metadata) => {
      const file = `# streaming-chat transcript\n\n<!-- branching-tree ${metadata}\n\n**User**\n\nQuestion`;
      expect(() => parseBranchingTranscript(file)).toThrow(
        "Invalid transcript version tree",
      );
    },
  );
});
