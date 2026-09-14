// The synthetic 70-section workload from the earlier follow-complex probe.
// Use public runtime APIs and the real demo renderer, without instrumenting
// runtime internals or reading layout in the delivery/frame loop.

import { initMarkdown } from "../../../demos/shared/markdown.ts";
import { createMessageContent } from "../../../demos/streaming/message-content.ts";
import { createVirtualList } from "../../../src/virtual-list.ts";
import "../../../demos/shared/styles.css";

const section =
  "\n\n## Detailed section\n\n" +
  "Long-form explanation with **bold**, _emphasis_, and `code`. ".repeat(12) +
  "\n\n| Item | Description |\n|---|---|\n| one | A detailed item |\n| two | Another detailed item |\n\n```typescript\ninterface Example { value: string; }\nconst values = [1, 2, 3];\n```\n\n- First list item\n- Second list item\n";
const text = section.repeat(70);
const mode = new URLSearchParams(location.search).get("trail") ?? "off";
if (!["off", "long"].includes(mode))
  throw new Error("Unsupported complex fixture trail mode");
await initMarkdown();
const viewport = document.querySelector("#viewport");
const status = document.querySelector("#status");
const handles = new Map();
const list = createVirtualList(viewport, {
  items: [
    { id: "history", text: "" },
    { id: "reply", text: "", done: false },
  ],
  key: (item) => item.id,
  followBehavior: "smooth",
  scrollingUpdates: "live",
  render(item, existing) {
    const row = existing ?? document.createElement("article");
    if (item.id === "history") {
      row.style.height = "1400px";
      row.textContent = "Synthetic history before the complex reply";
      return row;
    }
    row.className = "message assistant";
    let handle = handles.get(row);
    if (!handle) {
      const host = document.createElement("div");
      host.className = "message-content";
      row.append(host);
      handle = createMessageContent(host, "bar", mode);
      handles.set(row, handle);
    }
    handle.update({ markdown: item.text }, item.text, !item.done);
    return row;
  },
  onMount: (row) => handles.get(row)?.setMounted(true),
  onUnmount: (row) => handles.get(row)?.setMounted(false),
  onDestroy(row) {
    handles.get(row)?.destroy();
    handles.delete(row);
  },
});
await list.scrollTo("end", { behavior: "instant" });
let timer = 0;
let delivered = 0;
let started = false;
let done = false;
let startedAt = 0;
let deadline = 0;
let nextStatus = 0;
const workload = {
  sections: 70,
  characters: text.length,
  bytes: new TextEncoder().encode(text).length,
  chunkCharacters: 128,
  chunkIntervalMs: 8,
  stallEveryCharacters: 4096,
  stallMs: 100,
  mode,
};
function tick() {
  const now = performance.now();
  // Preserve wall-clock input cadence even if rendering delays a timer.
  // Batched overdue chunks represent network buffering, not slower input.
  while (delivered < text.length && deadline <= now) {
    delivered = Math.min(text.length, delivered + 128);
    deadline += delivered % 4096 === 0 ? 100 : 8;
  }
  done = delivered === text.length;
  list.updateItem("reply", {
    id: "reply",
    text: text.slice(0, delivered),
    done,
  });
  if (done || now >= nextStatus) {
    status.textContent = `${mode}: ${delivered}/${text.length} characters; ${done ? "done" : "streaming"}; 70 complex sections`;
    nextStatus = now + 250;
  }
  if (!done)
    timer = setTimeout(tick, Math.max(0, deadline - performance.now()));
  else performance.mark("complex-stream-complete");
}
window.complexStream = {
  start() {
    if (started) throw new Error("Complex fixture already started");
    started = true;
    startedAt = performance.now();
    deadline = startedAt;
    performance.mark("complex-stream-start");
    tick();
    return workload;
  },
  snapshot: () => ({
    ...workload,
    delivered,
    done,
    elapsed: started ? performance.now() - startedAt : 0,
    following: list.state.following,
  }),
};
status.textContent = `Ready: ${workload.characters} characters; 70 complex sections; ${mode}`;
window.addEventListener(
  "pagehide",
  () => {
    clearTimeout(timer);
    list.dispose();
  },
  { once: true },
);
