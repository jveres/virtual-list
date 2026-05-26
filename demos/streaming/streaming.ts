import { conversation } from "../../src/chat-data.js";
import {
  type AssistantStatus,
  buildChatItem,
  type ChatToolCall,
  setRoleLabel,
} from "../../src/chat-ui.js";
import {
  createDynamicVirtualizer,
  type DynamicVirtualizer,
  type DynamicVirtualizerBoundary,
  type DynamicVirtualizerBoundarySlot,
  type DynamicVirtualizerState,
  measureDynamicVirtualizerItem,
  planDynamicVirtualizerPixelWindowFromEnd,
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

import "../demo-styles.css";

interface Message {
  id: number;
  role: "user" | "assistant";
  markdown: string;
  status?: AssistantStatus;
  itemHeight: number;
  toolCalls?: ChatToolCall[];
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
const BOTTOM_FOLLOW_DURATION_MS = 300;
const SCROLL_BUTTONS_DEBOUNCE_MS = 120;
const MESSAGE_TOP_EPSILON_PX = 2;
const DATA_WINDOW_FACTOR = 5;
const DOM_OVERSCAN_FACTOR = 1;
const BOUNDARY_SLOT_HEIGHT = 52;
const LOAD_OLDER_DELAY_MS = 180;
const INITIAL_TRANSCRIPT_COUNT = 100;

type BoundarySlotKind = "none" | "idle" | "loading" | "no-more";

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
const windowStatus = mustGet("window-status");
const virtualizerStatus = mustGet("virtualizer-status");
const composerMinHeight = Math.max(
  COMPOSER_FALLBACK_MIN_HEIGHT,
  promptInput.getBoundingClientRect().height,
);

let virtualizer: DynamicVirtualizer;
let measuredViewportWidth = viewport.clientWidth;
let nextMessageId = 1;
let streamAbort: StreamAbort | null = null;
let scrollTurnInProgress = false;
let scrollButtonsTimer = 0;
let nextResponse = 0;
let bottomFollowArmed = false;
let bottomFollowPending = false;
let bottomFollowCleanup: (() => void) | null = null;
let virtualizerScrollActive = false;
let loadedStart = 0;
let loadingTop = false;
const virtualizerScrollEndWaiters = new Set<() => void>();

const templateHeights = new Float64Array(conversation.length);
templateHeights.fill(180);
const htmlCache = new Map<string, string>();
const transcript: Message[] = [];
let messages: Message[] = [];
const boundarySlotStates: Record<
  DynamicVirtualizerBoundary,
  { kind: BoundarySlotKind }
> = {
  top: { kind: "none" },
  bottom: { kind: "none" },
};

interface LoadedAppendResult {
  startIndex: number;
  replacedWindow: boolean;
}

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

const TOOL_CALL_SETS: readonly (readonly ChatToolCall[])[] = [
  [
    {
      name: "search_index",
      status: "done",
      durationMs: 42,
      input: '{ "query": "streaming markdown resize observer" }',
      output: "Found 4 matching notes in the local demo corpus.",
    },
    {
      name: "read_snippet",
      status: "done",
      durationMs: 18,
      input: '{ "id": "runtime-scroll-geometry" }',
      output: "Loaded measurement guidance for rows that grow after mount.",
    },
  ],
  [
    {
      name: "inspect_layout",
      status: "done",
      durationMs: 55,
      input: '{ "target": "assistant-row", "include": ["height", "overflow"] }',
      output: "The row is mounted and can report height changes interactively.",
    },
    {
      name: "rank_options",
      status: "done",
      durationMs: 31,
      input: '{ "criteria": ["latency", "stability", "complexity"] }',
      output: "ResizeObserver-based correction remains the simplest path.",
    },
  ],
  [
    {
      name: "run_formatter",
      status: "done",
      durationMs: 27,
      input: '{ "scope": "markdown-sample" }',
      output: "Normalized the generated markdown before streaming tokens.",
    },
  ],
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

function cloneToolCalls(toolCalls: readonly ChatToolCall[]): ChatToolCall[] {
  return toolCalls.map((toolCall) => ({ ...toolCall }));
}

function createSimulatedToolCalls(): ChatToolCall[] {
  const toolCalls = TOOL_CALL_SETS[nextResponse % TOOL_CALL_SETS.length]!;
  return cloneToolCalls(toolCalls);
}

function findTranscriptMessageById(id: number): Message | undefined {
  return transcript.find((message) => message.id === id);
}

function findLoadedMessageIndex(id: number): number {
  return messages.findIndex((message) => message.id === id);
}

function mutateMessageById(
  id: number,
  mutate: (message: Message) => void,
  options: { refreshUnmounted?: boolean } = {},
): number {
  const message = findTranscriptMessageById(id);
  if (!message) return -1;
  mutate(message);

  const index = findLoadedMessageIndex(id);
  if (index >= 0) refreshItem(index, options);
  return index;
}

function dataWindowPx(): number {
  return Math.max(1, viewport.clientHeight * DATA_WINDOW_FACTOR);
}

function domOverscanPx(): number {
  return Math.max(1, viewport.clientHeight * DOM_OVERSCAN_FACTOR);
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatPx(value: number): string {
  return `${formatCount(value)}px`;
}

function transcriptItemHeight(index: number): number {
  return transcript[index]?.itemHeight ?? 180;
}

function loadedEnd(): number {
  return loadedStart + messages.length;
}

function loadedHeight(): number {
  let height = 0;
  for (const message of messages) height += message.itemHeight;
  return height;
}

function canLoadOlderMessages(): boolean {
  return loadedStart > 0;
}

function measureMessageRange(start: number, end: number): void {
  for (let index = start; index < end; index++) {
    const message = messages[index];
    if (!message) continue;
    message.itemHeight = measureMessageHeight(index, message);
  }
}

function measureStandaloneMessages(
  nextMessages: readonly Message[],
  startIndex = 0,
): void {
  for (let index = 0; index < nextMessages.length; index++) {
    const message = nextMessages[index];
    if (!message) continue;
    message.itemHeight = measureMessageHeight(startIndex + index, message);
  }
}

function setLoadedWindow(start: number, end: number): void {
  loadedStart = Math.min(Math.max(0, Math.floor(start)), transcript.length);
  const loadedWindowEnd = Math.min(
    Math.max(loadedStart, Math.floor(end)),
    transcript.length,
  );
  messages = transcript.slice(loadedStart, loadedWindowEnd);
  measureExistingMessages();
}

function setNewestLoadedWindow(): void {
  const plan = planDynamicVirtualizerPixelWindowFromEnd({
    count: transcript.length,
    minimumPx: dataWindowPx(),
    getItemHeight: transcriptItemHeight,
  });
  setLoadedWindow(plan.start, plan.end);
}

function appendMessagesToLoadedBottom(
  nextMessages: readonly Message[],
): LoadedAppendResult {
  const previousTranscriptEnd = transcript.length;
  const previousLoadedEnd = loadedEnd();
  const shouldReplaceLoadedWindow =
    messages.length > 0 && previousLoadedEnd !== previousTranscriptEnd;
  transcript.push(...nextMessages);

  if (messages.length === 0 || shouldReplaceLoadedWindow) {
    setNewestLoadedWindow();
    return {
      startIndex: Math.max(0, messages.length - nextMessages.length),
      replacedWindow: shouldReplaceLoadedWindow,
    };
  }

  const localStart = messages.length;
  messages.push(...nextMessages);
  measureMessageRange(localStart, messages.length);
  return { startIndex: localStart, replacedWindow: false };
}

function createTemplateMessages(count: number): Message[] {
  const start = transcript.length;
  const nextMessages: Message[] = [];
  for (let offset = 0; offset < count; offset++) {
    const templateId = (start + offset) % conversation.length;
    const sample = conversation[templateId]!;
    nextMessages.push(
      createMessage({
        ...sample,
        itemHeight: templateHeights[templateId]!,
      }),
    );
  }
  return nextMessages;
}

function refreshLoadedWindowIfReplaced(result: LoadedAppendResult): void {
  if (!result.replacedWindow) return;
  virtualizer.invalidateMeasurements();
  virtualizer.refreshMounted();
}

interface BoundarySlotContext {
  loadedCount: number;
  loadedStart: number;
  loadingTop: boolean;
}

function currentBoundarySlotContext(): BoundarySlotContext {
  return {
    loadedCount: messages.length,
    loadedStart,
    loadingTop,
  };
}

function visibleBoundarySlotKind(
  boundary: DynamicVirtualizerBoundary,
): Exclude<BoundarySlotKind, "none"> {
  const kind = boundarySlotStates[boundary].kind;
  return kind === "none" ? "idle" : kind;
}

function boundarySlotLabel(
  boundary: DynamicVirtualizerBoundary,
  kind: BoundarySlotKind,
): string {
  if (boundary !== "top") return "";
  if (kind === "loading") return "Loading older messages";
  if (kind === "no-more") return "At the top";
  return "";
}

function buildBoundarySlot(boundary: DynamicVirtualizerBoundary): HTMLElement {
  const element = document.createElement("div");
  element.className = "boundary-slot";
  element.dataset.boundaryContent = boundary;
  element.dataset.state = "idle";

  const spinner = document.createElement("span");
  spinner.className = "boundary-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");

  element.append(spinner, label);
  updateBoundarySlotElement(element, boundary);
  return element;
}

function updateBoundarySlotElement(
  container: HTMLElement,
  boundary: DynamicVirtualizerBoundary,
): void {
  const element = container.matches(".boundary-slot")
    ? container
    : container.querySelector<HTMLElement>(".boundary-slot");
  if (!element) return;

  const kind = visibleBoundarySlotKind(boundary);
  const label = element.querySelector<HTMLElement>("span:last-child");
  if (element.dataset.state !== kind) {
    element.dataset.state = kind;
  }

  if (kind === "idle") {
    if (element.getAttribute("aria-hidden") !== "true") {
      element.setAttribute("aria-hidden", "true");
    }
    if (element.hasAttribute("role")) element.removeAttribute("role");
  } else {
    if (element.hasAttribute("aria-hidden")) {
      element.removeAttribute("aria-hidden");
    }
    if (element.getAttribute("role") !== "status") {
      element.setAttribute("role", "status");
    }
  }

  if (!label) return;
  const nextLabel = boundarySlotLabel(boundary, kind);
  if (label.textContent !== nextLabel) {
    label.textContent = nextLabel;
  }
}

function shouldMountBoundarySlot(
  boundary: DynamicVirtualizerBoundary,
  context = currentBoundarySlotContext(),
): boolean {
  if (boundary === "bottom") return false;
  return context.loadedCount > 0;
}

function boundarySlotFor(
  boundary: DynamicVirtualizerBoundary,
  context = currentBoundarySlotContext(),
): DynamicVirtualizerBoundarySlot | null {
  if (!shouldMountBoundarySlot(boundary, context)) return null;

  return {
    key: `${boundary}:streaming-window-slot`,
    height: BOUNDARY_SLOT_HEIGHT,
    build: () => buildBoundarySlot(boundary),
  };
}

function setBoundarySlotState(
  boundary: DynamicVirtualizerBoundary,
  kind: BoundarySlotKind,
): void {
  boundarySlotStates[boundary] = { kind };
}

function idleBoundarySlotState(
  boundary: DynamicVirtualizerBoundary,
  context = currentBoundarySlotContext(),
): BoundarySlotKind {
  if (boundary === "bottom" || context.loadedCount === 0) return "none";
  return context.loadedStart <= 0 ? "no-more" : "none";
}

function setBoundarySlotIdleState(
  boundary: DynamicVirtualizerBoundary,
  context = currentBoundarySlotContext(),
): void {
  setBoundarySlotState(boundary, idleBoundarySlotState(boundary, context));
}

function refreshBoundarySlot(boundary: DynamicVirtualizerBoundary): void {
  const element = virtualizer.getBoundaryElement(boundary);
  if (element) updateBoundarySlotElement(element, boundary);
}

function syncBoundarySlot(boundary: DynamicVirtualizerBoundary): void {
  virtualizer.setBoundarySlot(boundary, boundarySlotFor(boundary));
  refreshBoundarySlot(boundary);
}

function updateRenderedBoundarySlots(): void {
  refreshBoundarySlot("top");
}

function syncVirtualizerLayout(options?: { addedBefore?: number }): void {
  if (!loadingTop) setBoundarySlotIdleState("top");
  virtualizer.syncLayout({
    ...options,
    topSlot: boundarySlotFor("top"),
    after: () => {
      updateRenderedBoundarySlots();
      syncDemoState();
    },
  });
}

function loadOlderMessages(): void {
  if (loadingTop) return;

  if (!canLoadOlderMessages()) {
    setBoundarySlotState("top", "no-more");
    refreshBoundarySlot("top");
    syncDemoState();
    return;
  }

  loadingTop = true;
  setBoundarySlotState("top", "loading");
  refreshBoundarySlot("top");
  syncDemoState();

  window.setTimeout(() => {
    const plan = planDynamicVirtualizerPixelWindowFromEnd({
      count: transcript.length,
      end: loadedStart,
      minimumPx: dataWindowPx(),
      getItemHeight: transcriptItemHeight,
    });

    if (plan.count === 0) {
      loadingTop = false;
      setBoundarySlotState("top", "no-more");
      refreshBoundarySlot("top");
      syncDemoState();
      return;
    }

    const addedMessages = transcript.slice(plan.start, plan.end);
    measureStandaloneMessages(addedMessages);
    const nextContext: BoundarySlotContext = {
      loadedCount: messages.length + addedMessages.length,
      loadedStart: plan.start,
      loadingTop: false,
    };

    virtualizer.syncLayout({
      addedBefore: addedMessages.length,
      topSlot: boundarySlotFor("top", nextContext),
      apply: () => {
        loadedStart = plan.start;
        messages = [...addedMessages, ...messages];
        loadingTop = false;
        setBoundarySlotIdleState("top", nextContext);
        return true;
      },
      after: () => {
        updateRenderedBoundarySlots();
        syncDemoState();
      },
    });
  }, LOAD_OLDER_DELAY_MS);
}

function syncDemoState(state = virtualizer.state): void {
  syncScrollButtons(state);
  syncMetrics(state);
}

function syncMetrics(state: DynamicVirtualizerState): void {
  const loadedRange =
    messages.length === 0
      ? "loaded 0-0/0"
      : `loaded ${formatCount(loadedStart + 1)}-${formatCount(loadedEnd())}/${formatCount(transcript.length)}`;
  const topStatus = loadingTop
    ? "loading top"
    : canLoadOlderMessages()
      ? "top"
      : "none";
  const mountedEnd = Math.max(state.range.start, state.range.end - 1);

  windowStatus.textContent = `${loadedRange} · height ${formatPx(loadedHeight())}/${formatPx(dataWindowPx())} · load ${topStatus}`;
  virtualizerStatus.textContent = `dom ${formatCount(state.mountedCount)}/${formatCount(state.count)} · measured ${formatCount(state.measuredCount)} · mounted ${formatCount(state.range.start)}-${formatCount(mountedEnd)}`;
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
  measuredViewportWidth = viewport.clientWidth;
  for (let templateId = 0; templateId < conversation.length; templateId++) {
    templateHeights[templateId] = measureDynamicVirtualizerItem({
      viewport,
      canvasClassName: "chat-canvas",
      index: templateId,
      buildItem: buildTemplateItem,
    });
  }
}

function remeasureForViewportWidth(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measureTemplateHeights();
  measureExistingMessages();
  virtualizer.invalidateMeasurements();
  syncDemoState();
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

function refreshItem(
  index: number,
  options: { refreshUnmounted?: boolean } = {},
): void {
  const message = messages[index];
  if (!message) return;

  htmlCache.delete(cacheKey(message));
  const element = virtualizer.getMountedElement(index);
  if (!element) {
    if (options.refreshUnmounted) virtualizer.refreshIndex(index);
    return;
  }

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
  syncDemoState();
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
  measureExistingMessages();
  virtualizer.invalidateMeasurements();
  refreshMountedItems();
}

function syncScrollButtons(state = virtualizer.state): void {
  if (scrollButtonsTimer) {
    window.clearTimeout(scrollButtonsTimer);
    scrollButtonsTimer = 0;
  }
  scrollTopBtn.hidden = state.atTop;
  scrollBottomBtn.hidden = state.atBottom || scrollTurnInProgress;
}

function scheduleScrollButtons(): void {
  if (scrollButtonsTimer) window.clearTimeout(scrollButtonsTimer);
  scrollButtonsTimer = window.setTimeout(() => {
    scrollButtonsTimer = 0;
    syncDemoState();
  }, SCROLL_BUTTONS_DEBOUNCE_MS);
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
  messageId: number,
  abort: StreamAbort,
): Promise<void> {
  if (instantReplies) {
    if (abort.cancelled) return;
    mutateMessageById(
      messageId,
      (message) => {
        message.markdown = reply.markdown;
      },
      { refreshUnmounted: true },
    );
    return;
  }

  const delayRange = reply.tokenDelayMs;
  for (const token of tokenize(reply.markdown)) {
    if (abort.cancelled) return;
    mutateMessageById(messageId, (message) => {
      message.markdown += token;
    });
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

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function waitForMountedMessageTop(
  index: number,
  abort: StreamAbort,
): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let frame = 0;
  let done = false;
  let resolvePromise: () => void = () => {};

  const finish = () => {
    if (done) return;
    done = true;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    abort.onCancel.delete(finish);
    resolvePromise();
  };

  const tick = () => {
    frame = 0;
    if (abort.cancelled) {
      finish();
      return;
    }

    const element = virtualizer.getMountedElement(index);
    if (element) {
      const viewportTop = viewport.getBoundingClientRect().top;
      const itemTop = element.getBoundingClientRect().top;
      if (Math.abs(itemTop - viewportTop) <= MESSAGE_TOP_EPSILON_PX) {
        finish();
        return;
      }
    }

    frame = requestAnimationFrame(tick);
  };

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
    abort.onCancel.add(finish);
    frame = requestAnimationFrame(tick);
    if (abort.cancelled) finish();
  });

  return { promise, cancel: finish };
}

async function settleVirtualizerFrames(): Promise<void> {
  await nextAnimationFrame();
  await nextAnimationFrame();
}

function beginStreamingBottomFollow(abort: StreamAbort): void {
  if (abort.cancelled) return;

  bottomFollowCleanup?.();
  const followAbort = linkedAbortSignal(abort);
  bottomFollowPending = false;
  bottomFollowArmed = true;
  bottomFollowCleanup = followAbort.cleanup;
  virtualizer.followBottom({
    behavior: "smooth",
    duration: BOTTOM_FOLLOW_DURATION_MS,
    signal: followAbort.signal,
  });
}

function startStreamingBottomFollow(abort: StreamAbort): void {
  if (abort.cancelled) return;
  if (!virtualizerScrollActive) {
    beginStreamingBottomFollow(abort);
    return;
  }

  bottomFollowPending = true;
  void waitForVirtualizerScrollEnd(abort).then(() => {
    if (bottomFollowPending && !abort.cancelled)
      beginStreamingBottomFollow(abort);
  });
}

function dearmStreamingBottomFollow(): void {
  bottomFollowPending = false;
  bottomFollowArmed = false;
  bottomFollowCleanup?.();
  bottomFollowCleanup = null;
}

function stopStreamingBottomFollow(): void {
  virtualizer.stopFollowBottom();
  dearmStreamingBottomFollow();
}

function getMountedMessageContent(index: number): HTMLElement | null {
  const element = virtualizer.getMountedElement(index);
  if (!element) return null;
  return element.querySelector<HTMLElement>(".message-content") ?? element;
}

function animateMountedItemsClass(
  indices: readonly number[],
  className: string,
  abort: StreamAbort,
): Promise<void> {
  const targets = indices
    .map(getMountedMessageContent)
    .filter((element): element is HTMLElement => element !== null);
  if (targets.length === 0) return Promise.resolve();

  return Promise.all(
    targets.map(
      (target) =>
        new Promise<void>((resolve) => {
          let done = false;
          let cleanupTimer = 0;
          const cleanup = () => {
            if (done) return;
            done = true;
            target.classList.remove(className);
            target.removeEventListener("animationend", cleanup);
            target.removeEventListener("animationcancel", cleanup);
            abort.onCancel.delete(cleanup);
            window.clearTimeout(cleanupTimer);
            resolve();
          };

          target.classList.add(className);
          target.addEventListener("animationend", cleanup);
          target.addEventListener("animationcancel", cleanup);
          abort.onCancel.add(cleanup);
          cleanupTimer = window.setTimeout(cleanup, 300);
          if (abort.cancelled) cleanup();
        }),
    ),
  ).then(() => undefined);
}

function flyInMountedItems(
  indices: readonly number[],
  abort: StreamAbort,
): Promise<void> {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }

  return animateMountedItemsClass(indices, "fly", abort);
}

function fadeInMountedItems(
  indices: readonly number[],
  abort: StreamAbort,
): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  void animateMountedItemsClass(indices, "fade", abort);
}

function handleVirtualizerScrollStart(): void {
  virtualizerScrollActive = true;
  if (!bottomFollowArmed && !bottomFollowPending) return;
  dearmStreamingBottomFollow();
}

function finishVirtualizerScrollTracking(): void {
  virtualizerScrollActive = false;
  for (const resolve of virtualizerScrollEndWaiters) resolve();
  virtualizerScrollEndWaiters.clear();
}

function handleVirtualizerScrollEnd(): void {
  finishVirtualizerScrollTracking();
  syncDemoState();
}

function waitForVirtualizerScrollEnd(abort: StreamAbort): Promise<void> {
  if (!virtualizerScrollActive || abort.cancelled) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      virtualizerScrollEndWaiters.delete(finish);
      abort.onCancel.delete(finish);
      resolve();
    };

    virtualizerScrollEndWaiters.add(finish);
    abort.onCancel.add(finish);
    if (!virtualizerScrollActive || abort.cancelled) finish();
  });
}

async function scrollMessageToTop(
  index: number,
  abort: StreamAbort,
  afterTargetMount?: () => void,
): Promise<void> {
  const abortLink = linkedAbortSignal(abort);
  let targetAtTop: ReturnType<typeof waitForMountedMessageTop> | null = null;
  scrollTurnInProgress = true;
  scheduleScrollButtons();
  try {
    targetAtTop = waitForMountedMessageTop(index, abort);
    const scroll = virtualizer.scrollToIndex(index, "top", {
      behavior: "smooth",
      signal: abortLink.signal,
    });
    afterTargetMount?.();
    await Promise.race([scroll.then(() => undefined), targetAtTop.promise]);
  } finally {
    targetAtTop?.cancel();
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
  let assistantId: number | null = null;
  const shouldFlyIn = transcript.length === 0;

  try {
    const userMessage = createMessage({
      role: "user",
      markdown: text,
      itemHeight: 180,
    });
    const userAppend = appendMessagesToLoadedBottom([userMessage]);
    syncVirtualizerLayout();
    refreshLoadedWindowIfReplaced(userAppend);
    const userIndex = userAppend.startIndex;
    virtualizer.setStickyIndex(userIndex);
    await scrollMessageToTop(
      userIndex,
      abort,
      shouldFlyIn ? undefined : () => fadeInMountedItems([userIndex], abort),
    );
    scheduleScrollButtons();
    if (abort.cancelled) return;
    if (shouldFlyIn) {
      await flyInMountedItems([userIndex], abort);
      if (abort.cancelled) return;
    }

    const assistantMessage = createMessage({
      role: "assistant",
      markdown: "",
      status: "thinking",
      itemHeight: 180,
      toolCalls: createSimulatedToolCalls(),
    });
    assistantId = assistantMessage.id;
    const assistantAppend = appendMessagesToLoadedBottom([assistantMessage]);
    syncVirtualizerLayout();
    refreshLoadedWindowIfReplaced(assistantAppend);
    scheduleScrollButtons();
    if (abort.cancelled) return;

    startStreamingBottomFollow(abort);

    const reply = pickResponse();
    await wait(instantReplies ? 0 : reply.thinkingDelayMs, abort);
    if (abort.cancelled) return;

    mutateMessageById(assistantId, (message) => {
      message.status = "streaming";
    });
    await streamResponse(reply, assistantId, abort);
  } finally {
    if (assistantId !== null) {
      mutateMessageById(
        assistantId,
        (message) => {
          if (message.role === "assistant") {
            message.status = abort.cancelled ? "cancelled" : "done";
          }
        },
        { refreshUnmounted: true },
      );
    }
    if (!abort.cancelled) {
      await settleVirtualizerFrames();
      if (bottomFollowArmed) {
        await virtualizer.scrollToBottom();
      }
    }
    stopStreamingBottomFollow();
    streamAbort = null;
    setStreamingUI(false);
    scheduleScrollButtons();
    promptInput.focus();
  }
}

bindThemeButtons(refreshTheme);

scrollTopBtn.addEventListener("click", () => {
  void virtualizer.scrollToTop({ behavior: "smooth" }).then(() => {
    syncDemoState();
  });
});

scrollBottomBtn.addEventListener("click", () => {
  void virtualizer.scrollToBottom({ behavior: "smooth" }).then(() => {
    syncDemoState();
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
appendMessagesToLoadedBottom(createTemplateMessages(INITIAL_TRANSCRIPT_COUNT));

virtualizer = createDynamicVirtualizer({
  viewport,
  canvasClassName: "chat-canvas",
  getCount: () => messages.length,
  getItemHeight,
  buildItem,
  overscanPx: domOverscanPx,
  onRangeChange: syncDemoState,
  onReachTop: loadOlderMessages,
  onScrollStart: handleVirtualizerScrollStart,
  onScrollEnd: handleVirtualizerScrollEnd,
});
setBoundarySlotIdleState("top");
syncBoundarySlot("top");
const viewportResizeObserver = new ResizeObserver(remeasureForViewportWidth);
viewportResizeObserver.observe(viewport);

await virtualizer.scrollToBottom();
syncDemoState();
document.documentElement.classList.remove("booting");
promptInput.focus();

watchSystemTheme(refreshTheme);
loadHighlighter()
  .then(() => {
    measureTemplateHeights();
    measureExistingMessages();
    virtualizer.invalidateMeasurements();
    refreshMountedItems();
  })
  .catch(console.error);
