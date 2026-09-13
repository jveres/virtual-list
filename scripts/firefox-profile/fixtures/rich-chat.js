// Synthetic, local-only workload for the streaming demo's transcript importer.
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  context.fillStyle = "#223344";
  context.fillRect(0, 0, 1280, 720);
  context.fillStyle = "#9bd";
  context.font = "48px sans-serif";
  context.fillText("Local Firefox scroll fixture", 70, 360);
  const image = canvas.toDataURL("image/png");
  const lines = ["# streaming-chat transcript", ""];
  for (let i = 0; i < 160; i++) {
    const assistant = i % 2 === 1;
    lines.push(assistant ? "**Assistant**" : "**User**");
    const meta = { sentAt: 1789200000000 + i * 60000 };
    if (assistant)
      meta.toolCalls = [
        {
          name: "local_search",
          status: "done",
          durationMs: 42,
          input: { query: `fixture ${i}` },
          output: { matches: ["alpha", "beta", "gamma"] },
        },
      ];
    lines.push(`<!-- turn ${JSON.stringify(meta)} -->`, "");
    const body = assistant
      ? [
          `## Rich response ${i}`,
          "A repeatable local response with **bold**, _emphasis_, `inline code`, and a [local link](#fixture).",
          "",
          "| Component | Items | State |",
          "| --- | ---: | --- |",
          ...Array.from(
            { length: 8 },
            (_, j) => `| Stage ${j} | ${i + j} | Ready |`,
          ),
          "",
          "```typescript",
          "interface Item { id: string; value: number; }",
          "export function total(items: readonly Item[]): number {",
          "  return items.reduce((sum, item) => sum + item.value, 0);",
          "}",
          "```",
          "",
          "$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$",
          "",
          ...Array.from(
            { length: 6 },
            (_, j) =>
              `${j + 1}. Validate the committed geometry and keep the visible content stable during native scrolling.`,
          ),
          "",
          `![Local fixture image](${image})`,
          "",
          "> This content is synthetic; no user transcript or remote image is used.",
        ].join("\n")
      : `Please inspect stage ${i} and show the table, code, equation, and image.`;
    lines.push(
      `<!-- body ${body.split("\n").length} -->`,
      body,
      "<!-- /body -->",
      "",
    );
  }
  window.confirm = () => true;
  const transfer = new DataTransfer();
  const markdown = lines.join("\n");
  transfer.items.add(
    new File([markdown], "runtime-scroll-rich.md", { type: "text/markdown" }),
  );
  const input = document.querySelector("#import-file");
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    workload:
      "160 synthetic turns; 80 rich replies with tables, TypeScript, math, tool panels, local 1280x720 PNG",
    bytes: markdown.length,
  };
})();
