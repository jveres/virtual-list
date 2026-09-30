import { describe, expect, it } from "vitest";
import {
  type ConversationNode,
  conversationEntries,
} from "../../demos/streaming/conversation-tree-model.js";

function fixture(): Map<number, ConversationNode> {
  const node = (
    id: number,
    parentId: number,
    childrenIds: number[],
    selectedChildIndex = 0,
  ): ConversationNode => ({
    message: id
      ? { id, role: id % 2 ? "user" : "assistant", markdown: `Message ${id}` }
      : null,
    parentId,
    childrenIds,
    selectedChildIndex,
  });
  return new Map([
    [0, node(0, 0, [1])],
    [1, node(1, 0, [2, 4], 1)],
    [2, node(2, 1, [3, 6])],
    [3, node(3, 2, [])],
    [6, node(6, 2, [])],
    [4, node(4, 1, [5])],
    [5, node(5, 4, [])],
  ]);
}

describe("conversation tree layout", () => {
  it("should list every branch depth-first and mark the selected path", () => {
    const tree = fixture();

    const entries = conversationEntries(tree);

    expect(
      entries.map(({ id, parentId, row, active }) => ({
        id,
        parentId,
        row,
        active,
      })),
    ).toEqual([
      { id: 1, parentId: 0, row: 0, active: true },
      { id: 2, parentId: 1, row: 1, active: false },
      { id: 3, parentId: 2, row: 2, active: false },
      { id: 6, parentId: 2, row: 2, active: false },
      { id: 4, parentId: 1, row: 1, active: true },
      { id: 5, parentId: 4, row: 2, active: true },
    ]);
    expect(tree.get(1)?.childrenIds).toEqual([2, 4]);
    expect(tree.get(1)?.selectedChildIndex).toBe(1);
  });

  it("should pair a prompt with its only reply as one turn row", () => {
    const node = (
      id: number,
      role: "user" | "assistant",
      childrenIds: number[],
      selectedChildIndex = 0,
    ): ConversationNode => ({
      message: { id, role, markdown: `Message ${id}` },
      parentId: 0,
      childrenIds,
      selectedChildIndex,
    });
    const tree = new Map<number, ConversationNode>([
      [
        0,
        { message: null, parentId: 0, childrenIds: [1], selectedChildIndex: 0 },
      ],
      [1, node(1, "user", [2])],
      [2, node(2, "assistant", [3])],
      [3, node(3, "user", [4, 5], 1)],
      [4, node(4, "assistant", [])],
      [5, node(5, "assistant", [6])],
      [6, node(6, "user", [])],
    ]);

    const entries = conversationEntries(tree);

    expect(
      entries.map(({ id, parentId, row, attached }) => ({
        id,
        parentId,
        row,
        attached,
      })),
    ).toEqual([
      { id: 1, parentId: 0, row: 0, attached: false },
      { id: 2, parentId: 1, row: 0, attached: true },
      { id: 3, parentId: 2, row: 1, attached: false },
      { id: 4, parentId: 3, row: 2, attached: false },
      { id: 5, parentId: 3, row: 2, attached: false },
      { id: 6, parentId: 5, row: 3, attached: false },
    ]);
  });

  it("should move the selected path without reordering branches", () => {
    const tree = fixture();
    const parent = tree.get(1);
    if (!parent) throw new Error("Missing fixture parent");
    parent.selectedChildIndex = 0;

    const entries = conversationEntries(tree);

    expect(
      entries.filter((entry) => entry.active).map((entry) => entry.id),
    ).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.id)).toEqual([1, 2, 3, 6, 4, 5]);
  });

  it("should handle an empty conversation", () => {
    expect(conversationEntries(new Map())).toEqual([]);
  });

  it.each(["thinking", "streaming"] as const)(
    "should label an empty %s response as in progress until it has content",
    (status) => {
      const tree = fixture();
      const first = tree.get(1);
      if (!first?.message) throw new Error("Missing fixture message");
      first.message = {
        ...first.message,
        role: "assistant",
        markdown: "",
        status,
      };

      const pending = conversationEntries(tree)[0];

      expect(pending?.label).toBe("Response in progress…");
      first.message.markdown = "A finished answer";
      first.message.status = "done";
      expect(conversationEntries(tree)[0]?.label).toBe("A finished answer");
    },
  );

  it.each([
    {
      markdown: "",
      names: ["landscape.png"],
      image: true,
      label: "landscape.png",
    },
    {
      markdown: "",
      names: ["first.png", "second.png"],
      image: true,
      label: "first.png",
    },
    {
      markdown: "Compare these images",
      names: ["first.png", "second.png"],
      image: false,
      label: "Compare these images",
    },
  ])(
    "should describe attached images for '$label'",
    ({ markdown, names, image, label }) => {
      const tree = fixture();
      const first = tree.get(1);
      if (!first?.message) throw new Error("Missing fixture message");
      const message = {
        ...first.message,
        markdown,
        attachments: names.map((name) => ({
          name,
          mimeType: "image/png",
          size: 3,
          dataUrl: "data:image/png;base64,AAAA",
        })),
      };
      first.message = message;

      const entry = conversationEntries(tree)[0];

      expect(entry).toMatchObject({
        label,
        image,
        hasImages: true,
        imageCount: names.length,
        fileCount: 0,
      });
    },
  );

  it.each([
    { types: ["application/pdf"], fileCount: 1, imageCount: 0 },
    { types: ["text/plain", "text/csv"], fileCount: 2, imageCount: 0 },
    { types: ["image/png", "application/pdf"], fileCount: 1, imageCount: 1 },
    { types: [], fileCount: 0, imageCount: 0 },
  ])(
    "should distinguish file and image attachments for $types",
    ({ types, fileCount, imageCount }) => {
      const tree = fixture();
      const first = tree.get(1);
      if (!first?.message) throw new Error("Missing fixture message");
      first.message.attachments = types.map((mimeType, index) => ({
        name: `Attachment ${index + 1}`,
        mimeType,
        size: 3,
        dataUrl: `data:${mimeType};base64,AAAA`,
      }));

      const entry = conversationEntries(tree)[0];

      expect(entry).toMatchObject({ fileCount, imageCount, image: false });
    },
  );

  it.each([
    { count: 0, caption: "A text response", image: false },
    { count: 1, caption: "", image: true },
    { count: 3, caption: "", image: true },
    { count: 1, caption: "A mixed response", image: false },
    { count: 3, caption: "A mixed response", image: false },
  ])(
    "should count $count images with caption '$caption'",
    ({ count, caption, image }) => {
      const tree = fixture();
      const first = tree.get(1);
      if (!first?.message) throw new Error("Missing fixture message");
      first.message.markdown = `${Array.from(
        { length: count },
        (_, index) =>
          `![Picture ${index + 1}](data:image/png;base64,${"A".repeat(10000)})`,
      ).join("\n\n")}\n\n${caption}`;

      const entry = conversationEntries(tree)[0];

      expect(entry).toMatchObject({
        imageCount: count,
        image,
        hasImages: count > 0,
        label: caption || "Picture 1",
      });
    },
  );

  it.each([
    [
      "Text before the image\n\n![Picture](data:image/png;base64,AAAA)",
      "Text before the image",
    ],
    [
      `![Picture](data:image/png;base64,${"A".repeat(10000)})\n\nText after the image`,
      "Text after the image",
    ],
  ])(
    "should represent mixed text and images as a response with an image indicator",
    (markdown, label) => {
      const tree = new Map<number, ConversationNode>([
        [
          0,
          {
            message: null,
            parentId: 0,
            childrenIds: [1],
            selectedChildIndex: 0,
          },
        ],
        [
          1,
          {
            message: { id: 1, role: "assistant", markdown },
            parentId: 0,
            childrenIds: [],
            selectedChildIndex: 0,
          },
        ],
      ]);

      const entries = conversationEntries(tree);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        label,
        image: false,
        hasImages: true,
      });
    },
  );

  it("should keep sibling positions unchanged when a different version is selected", () => {
    const tree = fixture();
    const positions = () =>
      conversationEntries(tree)
        .filter((entry) => entry.parentId === 1)
        .map(({ id, row }) => ({ id, row }));
    const before = positions();
    const parent = tree.get(1);
    if (!parent) throw new Error("Missing fixture parent");

    parent.selectedChildIndex = 0;

    expect(positions()).toEqual(before);
  });

  it.each([
    [
      "# **A heading**\n\nMore paragraphs\n## Another heading",
      "A heading",
      false,
    ],
    ["![Landscape](https://example.test/picture.png)", "Landscape", true],
    [
      `![Generated landscape](data:image/png;base64,${"A".repeat(10000)})`,
      "Generated landscape",
      true,
    ],
    [`![](data:image/png;base64,${"A".repeat(10000)})`, "Image", true],
    [
      "```ts\nconst code = 1;\n```\n\nA [linked summary](https://example.test)",
      "A linked summary",
      false,
    ],
    ["", "Untitled message", false],
    ["x".repeat(200), "x".repeat(200), false],
    ["<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>", false],
  ])(
    "should summarize a message without adding paragraph nodes: %s",
    (markdown, label, image) => {
      const tree = new Map<number, ConversationNode>([
        [
          0,
          {
            message: null,
            parentId: 0,
            childrenIds: [1],
            selectedChildIndex: 0,
          },
        ],
        [
          1,
          {
            message: { id: 1, role: "user", markdown },
            parentId: 0,
            childrenIds: [],
            selectedChildIndex: 0,
          },
        ],
      ]);

      const entries = conversationEntries(tree);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ label, image });
    },
  );

  it("should traverse a deep conversation without recursive stack growth", () => {
    const tree = new Map<number, ConversationNode>();
    for (let id = 0; id <= 12000; id++)
      tree.set(id, {
        message: id ? { id, role: "assistant", markdown: "Answer" } : null,
        parentId: Math.max(0, id - 1),
        childrenIds: id < 12000 ? [id + 1] : [],
        selectedChildIndex: 0,
      });

    const entries = conversationEntries(tree);

    expect(entries).toHaveLength(12000);
    expect(entries.at(-1)).toMatchObject({ id: 12000, row: 11999 });
  });
});
