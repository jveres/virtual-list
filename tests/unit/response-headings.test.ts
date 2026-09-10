import { readFileSync } from "node:fs";
import { initMarkdownViewerSync } from "markdown-viewer";
import { beforeAll, describe, expect, it } from "vitest";
import { responseHeadings } from "../../demos/streaming/response-headings.js";

beforeAll(() => {
  const wasm = new URL(
    "../../comrak-wasm/pkg/comrak.wasm",
    import.meta.resolve("markdown-viewer"),
  );
  initMarkdownViewerSync({ module: readFileSync(wasm) });
});

describe("response heading outline", () => {
  it.each([
    { name: "plain text", markdown: "No headings here", expected: [] },
    {
      name: "setext disabled by the message renderer",
      markdown: "Not a heading\n===\n\nAlso plain text\n---",
      expected: [],
    },
    {
      name: "ATX headings and deeper sections",
      markdown:
        "# Overview\n\n## Details\n\n### Not in the outline\n\n## Details",
      expected: [
        { index: 0, level: 1, label: "Overview" },
        { index: 1, level: 2, label: "Details" },
        { index: 2, level: 2, label: "Details" },
      ],
    },
    {
      name: "inline formatting",
      markdown:
        "# **Overview** &amp; scope\n\n## [Details](https://example.test) with `code`",
      expected: [
        { index: 0, level: 1, label: "Overview & scope" },
        { index: 1, level: 2, label: "Details with code" },
      ],
    },
    {
      name: "fenced and indented code",
      markdown:
        "```md\n# Not a heading\n```\n\n    ## Also code\n\n~~~\n## Still code\n~~~\n\n## Actual section",
      expected: [{ index: 0, level: 2, label: "Actual section" }],
    },
    {
      name: "empty headings and duplicate labels",
      markdown: "#\n\n## Same\n\n## Same",
      expected: [
        { index: 0, level: 1, label: "Untitled section" },
        { index: 1, level: 2, label: "Same" },
        { index: 2, level: 2, label: "Same" },
      ],
    },
    {
      name: "HTML-like text",
      markdown: "## &lt;img src=x onerror=alert(1)&gt;",
      expected: [{ index: 0, level: 2, label: "<img src=x onerror=alert(1)>" }],
    },
  ])(
    "should extract the response outline from $name",
    ({ markdown, expected }) => {
      const headings = responseHeadings({ markdown });

      expect(headings).toEqual(expected);
    },
  );

  it("should match separately rendered text around a tool call", () => {
    const markdown = "# Before\n\n## After";
    const message = {
      markdown,
      toolCalls: [
        {
          name: "Search",
          status: "done" as const,
          markdownOffset: 10,
          durationMs: 0,
          input: "",
          output: "",
        },
      ],
    };

    const headings = responseHeadings(message);

    expect(headings).toEqual([
      { index: 0, level: 1, label: "Before" },
      { index: 1, level: 2, label: "After" },
    ]);
  });
});
