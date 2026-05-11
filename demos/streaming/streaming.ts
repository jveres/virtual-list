import { conversation } from "../../src/chat-data.js";
import {
  type AssistantStatus,
  buildChatItem,
  setRoleLabel,
} from "../../src/chat-ui.js";
import {
  createDynamicVirtualizer,
  type DynamicVirtualizer,
  measureDynamicVirtualizerItem,
} from "../../src/dynamic-virtualizer.js";
import {
  applyDocumentTheme,
  codeThemeName,
  hasHighlighter,
  initMarkdown,
  loadHighlighter,
  renderMarkdown,
  watchSystemTheme,
} from "../../src/markdown.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";
import "../../src/styles.css";

interface Message {
  id: number;
  role: "user" | "assistant";
  markdown: string;
  status?: AssistantStatus;
  itemHeight: number;
}

interface StreamAbort {
  cancelled: boolean;
  onCancel: Set<() => void>;
}

interface ReplyVariant {
  markdown: string;
  thinkingDelayMs: number;
  tokenDelayMs: {
    min: number;
    max: number;
  };
}

const COMPOSER_FALLBACK_MIN_HEIGHT = 42;
const COMPOSER_MAX_HEIGHT = 160;
const DEFAULT_THINKING_DELAY_MS = 1200;
const DEFAULT_TOKEN_DELAY_MS = { min: 18, max: 54 };
const FAST_THINKING_DELAY_MS = 240;
const FAST_TOKEN_DELAY_MS = { min: 4, max: 12 };

const demoParams = new URLSearchParams(location.search);
const instantReplies =
  demoParams.has("instant") || demoParams.get("stream") === "instant";
const forceFastLongReply =
  demoParams.has("fast-long") || demoParams.get("stream") === "fast-long";

const viewport = mustGet("viewport");
const promptInput = mustGet("prompt", HTMLTextAreaElement);
const sendBtn = mustGet("send-btn", HTMLButtonElement);
const scrollTopBtn = mustGet("scroll-top-btn", HTMLButtonElement);
const scrollBottomBtn = mustGet("scroll-bottom-btn", HTMLButtonElement);
const composerMinHeight = Math.max(
  COMPOSER_FALLBACK_MIN_HEIGHT,
  promptInput.getBoundingClientRect().height,
);

let virtualizer: DynamicVirtualizer;
let nextMessageId = 1;
let streamAbort: StreamAbort | null = null;
let scrollTurnInProgress = false;
let scrollButtonsFrame = 0;
let nextResponse = 0;

const templateHeights = new Float64Array(conversation.length);
templateHeights.fill(180);
const htmlCache = new Map<string, string>();
const messages: Message[] = [
  createMessage({
    role: "assistant",
    status: "done",
    markdown:
      "Hi! I'm a **simulated** streaming assistant. Type a prompt below and I'll stream a response back. Try asking for *code*, a list, or a table.",
    itemHeight: 180,
  }),
];

const BULK_RESPONSES = [
  `Sure — here's a quick rundown.

**Streaming** is straightforward when the renderer is incremental:

1. Append tokens to the buffer
2. Re-render markdown on each chunk
3. Let the virtual list's \`ResizeObserver\` adjust the scroll geometry

\`\`\`typescript
for await (const chunk of stream) {
  msg.markdown += chunk;
  refreshItem(idx);
}
\`\`\`

The scroll geometry stays stable because the list tracks growth automatically.`,

  `Good question. Here's a comparison:

| Approach | Latency | Complexity |
|----------|---------|------------|
| Full re-render | High | Low |
| Patch DOM | Low | High |
| Virtualized + chunked HTML | **Low** | **Medium** |

The sweet spot is rendering markdown to HTML on each chunk and replacing the
inner content of a single mounted item. That keeps reflow scoped to one row.`,

  `Longer markdown also helps catch parser and layout edge cases:

- Lists can grow item by item.
- Code fences may start incomplete and become valid later.
- Tables can change width as cells arrive.
- Syntax highlighting may rerender a mounted message after the initial stream.

\`\`\`typescript
messages[idx].markdown += tok;
refreshItem(idx);
\`\`\`

The virtualizer observes the row and maintains scroll geometry from browser
measurements.`,
];

const FAST_LONG_RESPONSE = `${BULK_RESPONSES[0]}

Here is the faster long-form variant. It intentionally creates a tall assistant
message quickly so ResizeObserver correction and scroll button visibility can
be tested without waiting through a slow stream.

The important thing to watch is not only the bottom edge. The streaming message
can grow below the viewport without stealing the user's position.

### Runtime path

1. Append a user message.
2. Reserve trailing space and scroll the user message to the top.
3. Append an assistant placeholder below it.
4. Stream markdown chunks into the mounted assistant row.
5. Let row measurement update the modeled height.
6. Keep the scroll-to-bottom control visible when new content grows below the
   viewport.

### Stress content

The response includes prose, a table, and multiple code blocks because each of
those creates a different layout shape.

| Area | What it stresses |
|------|------------------|
| Paragraphs | Continuous height growth |
| Lists | Repeated line wrapping |
| Tables | Wider intrinsic content |
| Code blocks | Late syntax highlighting and horizontal overflow |
| Status label | Streaming state refresh without rebuilding the row |

\`\`\`typescript
type Measurement = {
  index: number;
  previous: number;
  next: number;
};

function correctionForAnchor(measurement: Measurement, anchorIndex: number) {
  if (measurement.index >= anchorIndex) return 0;
  return measurement.next - measurement.previous;
}
\`\`\`

When the row grows below the viewport, the virtualizer must not hide the bottom
button just because streaming is still active. The button state has to come from
the true scroll range, not from the existence of an active stream.

\`\`\`typescript
const atBottom = scrollMax - scrollTop <= 1;
scrollBottomButton.hidden = atBottom || scrollTurnInProgress;
\`\`\`

This paragraph adds more vertical size so a single response can cross the
viewport boundary quickly. It also keeps enough text after the table and code
blocks to make height correction visible at normal desktop and mobile viewport
heights.

One more checklist closes the sample:

- The message starts mounted.
- The stream is fast enough for repeated testing.
- The final height is large enough to push content below the viewport.
- The bottom affordance returns when the stream continues off screen.`;

const SAMPLE_RESPONSES: ReplyVariant[] = [
  {
    markdown: `${BULK_RESPONSES[0]}

Let's stretch that into a more realistic response so the scroll geometry has
time to react while content is still being measured.

When the assistant starts with an empty placeholder, the row's first measured
height is tiny. As tokens arrive, markdown paragraphs, lists, code blocks, and
tables all change the row's border-box size. If the user has scrolled away, the
row can grow in place without stealing the viewport.

Here's another code block to make the row taller:

\`\`\`typescript
type StreamChunk = {
  id: string;
  index: number;
  text: string;
};

function appendChunk(buffer: string, chunk: StreamChunk) {
  if (chunk.text.length === 0) return buffer;
  return buffer + chunk.text;
}
\`\`\`

This final paragraph keeps the simulated stream alive long enough to observe
ResizeObserver-driven relayout.`,
    thinkingDelayMs: DEFAULT_THINKING_DELAY_MS,
    tokenDelayMs: DEFAULT_TOKEN_DELAY_MS,
  },

  {
    markdown: `${BULK_RESPONSES[1]}

For a longer example, imagine a production chat surface that receives chunks
from a model endpoint, renders markdown incrementally, and keeps the latest
answer visible unless the user intentionally scrolls away.

| Scenario | Expected behavior |
|----------|-------------------|
| Short response grows past viewport | Native scroll becomes available |
| Code block appears late | Row height updates without remounting the range |
| Response finishes | No final jump |

Streaming should be continuous content growth, not repeated navigation.`,
    thinkingDelayMs: DEFAULT_THINKING_DELAY_MS,
    tokenDelayMs: DEFAULT_TOKEN_DELAY_MS,
  },

  {
    markdown: `${BULK_RESPONSES[2]}

To make the stream last a bit longer, this response continues with a checklist:

1. The title row should appear first.
2. Text should flow below it without being clipped by the composer.
3. Once content is taller than the viewport, native scroll should be available.
4. If the user scrolls away, user intent should win.

If those remain stable, the demo is covering the failure modes that are easy to
miss with very short responses.`,
    thinkingDelayMs: DEFAULT_THINKING_DELAY_MS,
    tokenDelayMs: DEFAULT_TOKEN_DELAY_MS,
  },

  {
    markdown: FAST_LONG_RESPONSE,
    thinkingDelayMs: FAST_THINKING_DELAY_MS,
    tokenDelayMs: FAST_TOKEN_DELAY_MS,
  },
];

function createMessage(message: Omit<Message, "id">): Message {
  return { id: nextMessageId++, ...message };
}

function cacheKey(message: Message): string {
  const themeKey = hasHighlighter() ? codeThemeName() : "plain";
  return `${themeKey}:${message.id}`;
}

function htmlForMessage(message: Message): string {
  const key = cacheKey(message);
  let html = htmlCache.get(key);
  if (html === undefined) {
    html = renderMarkdown(message.markdown);
    htmlCache.set(key, html);
  }
  return html;
}

function measureTemplateHeights(): void {
  for (let templateId = 0; templateId < conversation.length; templateId++) {
    templateHeights[templateId] = measureDynamicVirtualizerItem({
      viewport,
      canvasClassName: "chat-canvas",
      index: templateId,
      buildItem: buildTemplateItem,
    });
  }
}

function buildTemplateItem(index: number): HTMLElement {
  const sample = conversation[index];
  if (!sample) throw new Error(`missing template ${index}`);
  return buildChatItem(index, sample, renderMarkdown(sample.markdown));
}

function measureMessageHeight(index: number, message: Message): number {
  return measureDynamicVirtualizerItem({
    viewport,
    canvasClassName: "chat-canvas",
    index,
    buildItem: (itemIndex) =>
      buildChatItem(itemIndex, message, htmlForMessage(message)),
  });
}

function measureExistingMessages(): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    message.itemHeight = measureMessageHeight(index, message);
  }
}

function getItemHeight(index: number): number {
  return messages[index]?.itemHeight ?? 180;
}

function buildItem(index: number): HTMLElement {
  const message = messages[index];
  if (!message) throw new Error(`missing message ${index}`);
  return buildChatItem(index, message, htmlForMessage(message));
}

function refreshItem(index: number): void {
  const message = messages[index];
  if (!message) return;

  htmlCache.delete(cacheKey(message));
  const element = virtualizer.getMountedElement(index);
  if (!element) return;

  const label = element.querySelector<HTMLElement>(".role-label");
  const markdown = element.querySelector<HTMLElement>(".md");
  if (!label || !markdown) {
    virtualizer.refreshIndex(index);
    return;
  }

  if (label.dataset.status !== message.status) {
    setRoleLabel(label, message, index);
  }
  markdown.innerHTML = htmlForMessage(message);
}

function refreshMountedItems(): void {
  htmlCache.clear();
  virtualizer.refreshMounted();
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
  refreshMountedItems();
}

function syncScrollButtons(state = virtualizer.state): void {
  scrollTopBtn.hidden = state.atTop;
  scrollBottomBtn.hidden = state.atBottom || scrollTurnInProgress;
}

function scheduleScrollButtons(): void {
  if (scrollButtonsFrame) return;
  scrollButtonsFrame = requestAnimationFrame(() => {
    scrollButtonsFrame = 0;
    syncScrollButtons();
  });
}

function pickResponse(): ReplyVariant {
  if (forceFastLongReply) {
    return SAMPLE_RESPONSES[SAMPLE_RESPONSES.length - 1]!;
  }

  const response = SAMPLE_RESPONSES[nextResponse % SAMPLE_RESPONSES.length]!;
  nextResponse++;
  return response;
}

function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

function wait(ms: number, abort: StreamAbort): Promise<void> {
  if (ms <= 0 || abort.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      abort.onCancel.delete(finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    abort.onCancel.add(finish);
    if (abort.cancelled) finish();
  });
}

async function streamResponse(
  reply: ReplyVariant,
  index: number,
  abort: StreamAbort,
): Promise<void> {
  if (instantReplies) {
    if (abort.cancelled) return;
    messages[index]!.markdown = reply.markdown;
    refreshItem(index);
    return;
  }

  const delayRange = reply.tokenDelayMs;
  for (const token of tokenize(reply.markdown)) {
    if (abort.cancelled) return;
    messages[index]!.markdown += token;
    refreshItem(index);
    await wait(
      delayRange.min + Math.random() * (delayRange.max - delayRange.min),
      abort,
    );
  }
}

function cancelStream(abort: StreamAbort): void {
  if (abort.cancelled) return;
  abort.cancelled = true;
  for (const callback of abort.onCancel) callback();
  abort.onCancel.clear();
}

function borderBlockSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0)
  );
}

function autosize(): void {
  promptInput.style.height = `${composerMinHeight}px`;
  const next = Math.min(
    COMPOSER_MAX_HEIGHT,
    Math.max(
      composerMinHeight,
      promptInput.scrollHeight + borderBlockSize(promptInput),
    ),
  );
  promptInput.style.height = `${next}px`;
  promptInput.style.overflowY = next >= COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

function setStreamingUI(streaming: boolean): void {
  sendBtn.textContent = streaming ? "Stop" : "Send";
  sendBtn.classList.toggle("stop-btn", streaming);
}

function linkedAbortSignal(abort: StreamAbort): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const cleanup = () => {
    abort.onCancel.delete(cancel);
    controller.signal.removeEventListener("abort", cleanup);
  };
  abort.onCancel.add(cancel);
  controller.signal.addEventListener("abort", cleanup, { once: true });
  if (abort.cancelled) controller.abort();
  return { signal: controller.signal, cleanup };
}

async function scrollMessageToTop(
  index: number,
  abort: StreamAbort,
): Promise<void> {
  const abortLink = linkedAbortSignal(abort);
  scrollTurnInProgress = true;
  scheduleScrollButtons();
  try {
    await virtualizer.scrollToIndex(index, "top", {
      behavior: "smooth",
      signal: abortLink.signal,
    });
  } finally {
    scrollTurnInProgress = false;
    abortLink.cleanup();
    scheduleScrollButtons();
  }
}

async function handleSend(): Promise<void> {
  if (streamAbort) {
    cancelStream(streamAbort);
    return;
  }

  const text = promptInput.value.trim();
  if (!text) return;

  promptInput.value = "";
  autosize();

  const abort: StreamAbort = { cancelled: false, onCancel: new Set() };
  streamAbort = abort;
  setStreamingUI(true);
  let assistantIndex: number | null = null;

  try {
    const userIndex = messages.length;
    const userMessage = createMessage({
      role: "user",
      markdown: text,
      itemHeight: 180,
    });
    userMessage.itemHeight = measureMessageHeight(userIndex, userMessage);
    messages.push(userMessage);
    virtualizer.setCount();
    virtualizer.setStickyIndex(userIndex);
    await scrollMessageToTop(userIndex, abort);
    scheduleScrollButtons();
    if (abort.cancelled) return;

    const assistantMessage = createMessage({
      role: "assistant",
      markdown: "",
      status: "thinking",
      itemHeight: 180,
    });
    assistantIndex = messages.length;
    assistantMessage.itemHeight = measureMessageHeight(
      assistantIndex,
      assistantMessage,
    );
    messages.push(assistantMessage);
    virtualizer.setCount();
    scheduleScrollButtons();
    if (abort.cancelled) return;

    const reply = pickResponse();
    await wait(instantReplies ? 0 : reply.thinkingDelayMs, abort);
    if (abort.cancelled) return;

    messages[assistantIndex]!.status = "streaming";
    refreshItem(assistantIndex);
    await streamResponse(reply, assistantIndex, abort);
  } finally {
    if (assistantIndex !== null) {
      const assistant = messages[assistantIndex];
      if (assistant?.role === "assistant") {
        assistant.status = abort.cancelled ? "cancelled" : "done";
        refreshItem(assistantIndex);
      }
    }
    streamAbort = null;
    setStreamingUI(false);
    scheduleScrollButtons();
    promptInput.focus();
  }
}

bindThemeButtons(refreshTheme);

mustGet("bulk-btn", HTMLButtonElement).addEventListener("click", () => {
  const start = messages.length;
  for (let i = 0; i < 100; i++) {
    const templateId = (start + i) % conversation.length;
    const sample = conversation[templateId]!;
    messages.push(
      createMessage({
        ...sample,
        itemHeight: templateHeights[templateId]!,
      }),
    );
  }
  virtualizer.setCount();
  void virtualizer.scrollToBottom().then(() => {
    syncScrollButtons();
  });
  scheduleScrollButtons();
});

scrollTopBtn.addEventListener("click", () => {
  void virtualizer.scrollToIndex(0, "top").then(() => {
    syncScrollButtons();
  });
});

scrollBottomBtn.addEventListener("click", () => {
  void virtualizer.scrollToIndex(messages.length - 1, "bottom").then(() => {
    syncScrollButtons();
  });
});

promptInput.addEventListener("input", autosize);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void handleSend();
  }
});
sendBtn.addEventListener("click", () => {
  void handleSend();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && streamAbort) {
    event.preventDefault();
    cancelStream(streamAbort);
  }
});

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
autosize();
measureTemplateHeights();
measureExistingMessages();

virtualizer = createDynamicVirtualizer({
  viewport,
  canvasClassName: "chat-canvas",
  getCount: () => messages.length,
  getItemHeight,
  buildItem,
  overscanPx: 700,
  onRangeChange: scheduleScrollButtons,
});

await virtualizer.scrollToBottom();
syncScrollButtons();
document.documentElement.classList.remove("booting");
promptInput.focus();

watchSystemTheme(refreshTheme);
loadHighlighter()
  .then(() => {
    measureTemplateHeights();
    refreshMountedItems();
  })
  .catch(console.error);
