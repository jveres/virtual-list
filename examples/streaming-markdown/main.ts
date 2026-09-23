import {
  createMarkdownViewer,
  initMarkdownViewer,
  loadLanguages,
  type MarkdownViewerHandle,
} from "markdown-viewer";
import "markdown-viewer/styles.css";
import {
  autosizeTextarea,
  streamingMarkdownText,
} from "../../integrations/index";
import { createVirtualList } from "../../src/index";
import "../../integrations/markdown.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const form = document.querySelector<HTMLFormElement>("form")!;
const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
const button = document.querySelector<HTMLButtonElement>("button")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const viewers = new Map<HTMLElement, MarkdownViewerHandle>();
const lifetime = new AbortController();
let messages: Message[] = [];
let busy = false;
await initMarkdownViewer();
await loadLanguages(["typescript"]);
const list = createVirtualList(viewport, {
  items: messages,
  key: (item) => item.id,
  pinning: { match: (item) => item.role === "user" },
  followBehavior: "smooth",
  render: (item, existing) => {
    const row = existing ?? document.createElement("article");
    row.className = `message ${item.role}`;
    row.dataset.key = item.id;
    if (item.role === "user") {
      row.textContent = item.text;
      return row;
    }
    const options = {
      text: item.streaming ? streamingMarkdownText(item.text) : item.text,
      isStreaming: item.streaming === true,
    };
    const viewer = viewers.get(row);
    if (viewer) viewer.update(options);
    else {
      const host = document.createElement("div");
      row.append(host);
      viewers.set(
        row,
        createMarkdownViewer(host, {
          ...options,
          preserveStreamingHeight: true,
          cursor: "bar",
          unfocusedCursorStyle: "block",
        }),
      );
    }
    return row;
  },
  onDestroy: (row) => {
    viewers.get(row)?.destroy();
    viewers.delete(row);
  },
});
const sizeInput = () =>
  autosizeTextarea(input, { minHeight: 42, maxHeight: 160 });
input.addEventListener("input", sizeInput, { signal: lifetime.signal });
sizeInput();
button.disabled = false;
status.value = "Ready";
const replyText = [
  "## A streaming reply",
  "",
  "A renderer owns **Markdown**. The virtual list owns scrolling and measurement.",
  "",
  "```typescript",
  "const answer = 42;",
  "```",
  "",
  "| Owner | Responsibility |",
  "| --- | --- |",
  "| Runtime | Scrolling |",
  "| Renderer | Content |",
  "",
  ...Array.from(
    { length: 30 },
    (_, i) =>
      `${i + 1}. A stable line that can be read while more text arrives.`,
  ),
  "",
].join("\n");
async function submit(): Promise<void> {
  if (busy || !input.value.trim()) return;
  busy = true;
  button.disabled = true;
  status.value = "Streaming";
  const prompt: Message = {
    id: String(messages.length),
    role: "user",
    text: input.value,
  };
  let reply: Message = {
    id: String(messages.length + 1),
    role: "assistant",
    text: "",
    streaming: true,
  };
  input.value = "";
  sizeInput();
  messages = [...messages, prompt, reply];
  try {
    list.setItems(messages, { anchor: "viewport" });
    await list.scrollTo(prompt.id, { align: "start", behavior: "smooth" });
    for (const chunk of replyText.match(/.{1,18}/gs) ?? []) {
      if (lifetime.signal.aborted) return;
      reply = { ...reply, text: reply.text + chunk };
      messages[messages.length - 1] = reply;
      list.updateItem(reply.id, reply);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    reply = { ...reply, streaming: false };
    messages[messages.length - 1] = reply;
    list.updateItem(reply.id, reply);
    status.value = "Done";
  } finally {
    busy = false;
    button.disabled = false;
  }
}
form.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    void submit().catch((error: unknown) => {
      status.value = String(error);
    });
  },
  { signal: lifetime.signal },
);
window.addEventListener(
  "pagehide",
  () => {
    lifetime.abort();
    list.dispose();
  },
  { once: true },
);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
