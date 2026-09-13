import { describe, expect, it } from "vitest";
import { streamingMarkdownText } from "../../integrations/index";

describe("streaming display text", () => {
  it("should remove a phantom trailing text line without changing its source", () => {
    const source = "Answer\n\n";
    expect(streamingMarkdownText(source)).toBe("Answer");
    expect(source).toBe("Answer\n\n");
  });
  it("should reserve a cursor line after an embedded image", () => {
    const image = "![Generated](data:image/png;base64,aGVsbG8=)";
    expect(streamingMarkdownText(`${image}\n\n\n`)).toBe(`${image}\n\n`);
  });
  it("should be idempotent for text, whitespace, and image tails", () => {
    for (const text of [
      "",
      "\n \t",
      "Answer\n",
      "![Generated](data:image/png;base64,aGVsbG8=)\n",
      "```ts\nconst x = 1;\n```\n",
    ]) {
      const displayed = streamingMarkdownText(text);
      expect(streamingMarkdownText(displayed)).toBe(displayed);
    }
  });
});
