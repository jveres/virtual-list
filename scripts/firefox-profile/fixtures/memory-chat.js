// Fixed synthetic image workload. No remote images or private transcript data.
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 4000;
  canvas.height = 3000;
  const context = canvas.getContext("2d");
  const turns = [];
  for (let i = 0; i < 24; i++) {
    const gradient = context.createLinearGradient(0, 0, 4000, 3000);
    gradient.addColorStop(0, `hsl(${(i * 37) % 360} 50% 35%)`);
    gradient.addColorStop(1, `hsl(${(i * 37 + 90) % 360} 60% 65%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4000, 3000);
    context.fillStyle = "white";
    context.font = "120px sans-serif";
    context.fillText(`Memory fixture ${i}`, 120, 250);
    const image = canvas.toDataURL("image/jpeg", 0.8);
    turns.push(
      "**User**",
      "",
      `Inspect local image ${i}.`,
      "",
      "**Assistant**",
      "",
      `## Response ${i}`,
      "",
      `![Synthetic image ${i}](${image})`,
      "",
      "```typescript",
      "const rows = items.map(item => ({ id: item.id, value: item.value }));",
      "```",
      "",
      ...Array.from(
        { length: 6 },
        (_, n) =>
          `${n + 1}. Inspect the image and preserve the scrolling position.`,
      ),
      "",
    );
  }
  canvas.width = canvas.height = 1;
  window.confirm = () => true;
  const transfer = new DataTransfer();
  transfer.items.add(
    new File([turns.join("\n")], "memory-chat.md", { type: "text/markdown" }),
  );
  const input = document.querySelector("#import-file");
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { turns: 48, images: 24, width: 4000, height: 3000 };
})();
