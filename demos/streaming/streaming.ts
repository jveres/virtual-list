import {
  createVirtualList,
  measureVirtualListItem,
  planVirtualListPixelWindowFromEnd,
  type VirtualListBoundary,
  type VirtualListBoundarySlot,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { conversation } from "../shared/chat-data.js";
import {
  type AssistantStatus,
  buildChatItem,
  buildChatRow,
  type ChatToolCall,
  setRoleLabel,
} from "../shared/chat-ui.js";
import {
  attachInteractions,
  createMarkdownViewer,
  initMarkdown,
  loadLanguages,
  type MarkdownViewerHandle,
  renderMarkdown,
} from "../shared/markdown.js";
import { applyDocumentTheme, watchSystemTheme } from "../shared/theme.js";
import {
  at,
  bindThemeButtons,
  mustGet,
  refreshTheme,
  syncThemeButtons,
} from "../shared/utils.js";
import {
  type ChatTurn,
  getAISettings,
  initAISettingsPanel,
  loadOpenAIHistory,
  type StoredTurn,
  saveOpenAIHistory,
  streamOpenAIChat,
  stripGeneratedImages,
} from "./openai.js";

import "../shared/styles.css";

interface Message {
  id: number;
  role: "user" | "assistant";
  markdown: string;
  status?: AssistantStatus;
  itemHeight: number;
  toolCalls?: ChatToolCall[];
  /**
   * Streaming ended with a line-owning cursor, so markdown-viewer left its
   * height-neutral spacer. The flag makes every later render of the message
   * include that line permanently: reclaiming it anywhere risks a visible
   * jump (deferred rebuilds fire at scroll settle, in plain view), and one
   * blank line is cheaper than any amount of jank. A page reload starts
   * fresh renders without it — invisibly.
   */
  trailingSpacer?: boolean;
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
// The send scroll travels about one viewport, which the distance-based
// duration policy clamps to its 320ms floor — a quick flick next to the
// buttons' long 1400ms glides. An explicit duration gives the send its own
// deliberate pace.
const SEND_SCROLL_DURATION_MS = 650;
const SCROLL_BUTTONS_DEBOUNCE_MS = 120;
const MESSAGE_TOP_EPSILON_PX = 2;
const DATA_WINDOW_FACTOR = 5;
const DOM_OVERSCAN_FACTOR = 1;
const BOUNDARY_SLOT_HEIGHT = 52;
const LOAD_OLDER_DELAY_MS = 180;
// Modeled row height before a message is measured; real heights replace it.
const ESTIMATED_ITEM_HEIGHT = 180;
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
const virtualListStatus = mustGet("virtual-list-status");
const composerMinHeight = Math.max(
  COMPOSER_FALLBACK_MIN_HEIGHT,
  promptInput.getBoundingClientRect().height,
);

let measuredViewportWidth = viewport.clientWidth;
let nextMessageId = 1;
let streamAbort: StreamAbort | null = null;
let scrollTurnInProgress = false;
let scrollButtonsTimer = 0;
let nextResponse = 0;
let bottomFollowArmed = false;
let bottomFollowPending = false;
let bottomFollowCleanup: (() => void) | null = null;
let virtualListScrollActive = false;
let loadedStart = 0;
let loadingTop = false;
const virtualListScrollEndWaiters = new Set<() => void>();

const templateHeights = new Float64Array(conversation.length);
templateHeights.fill(ESTIMATED_ITEM_HEIGHT);
const htmlCache = new Map<string, string>();
// Live markdown-viewer instances for streaming rows, keyed by their row element
// (not message id) so the build → destroy handoff in `refreshIndex` — which
// builds the next element before destroying the previous — never kills the row
// it just created. The viewport's recycle pool is off, so every unmount destroys
// the element and fires `destroyItem`, where we tear the viewer down.
const streamingViewers = new WeakMap<HTMLElement, MarkdownViewerHandle>();
// The transcript is the *active path* through the message tree: the linear
// list the virtualizer renders. `messages` is the loaded pixel window over it.
const transcript: Message[] = [];
let messages: Message[] = [];

// Branching messages. Each turn is a tree node; a node's `childrenIds` are the
// versions that follow it (a regenerated response, an edited prompt) and
// `selectedChildIndex` marks the active one. Walking `selectedChildIndex` from
// the root sentinel yields the active path. Switching a version only rewrites
// the path from that node down — everything above stays byte-identical, so the
// virtualizer reuses the prefix DOM untouched (see `switchMessageVersion`).
interface TreeNode {
  message: Message | null; // null only for the root sentinel
  parentId: number;
  childrenIds: number[];
  selectedChildIndex: number;
}

// Message ids start at 1, so 0 is free for the root sentinel.
const TREE_ROOT_ID = 0;
const tree = new Map<number, TreeNode>([
  [
    TREE_ROOT_ID,
    {
      message: null,
      parentId: TREE_ROOT_ID,
      childrenIds: [],
      selectedChildIndex: 0,
    },
  ],
]);
const boundarySlotStates: Record<
  VirtualListBoundary,
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

The virtualList observes the row and maintains scroll geometry from browser
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

When the row grows below the viewport, the virtualList must not hide the bottom
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
  const toolCalls = at(TOOL_CALL_SETS, nextResponse % TOOL_CALL_SETS.length);
  return cloneToolCalls(toolCalls);
}

function addTreeChild(
  parentId: number,
  message: Message,
  { select = true }: { select?: boolean } = {},
): number {
  const parent = tree.get(parentId);
  if (!parent) throw new Error(`missing tree node ${parentId}`);
  tree.set(message.id, {
    message,
    parentId,
    childrenIds: [],
    selectedChildIndex: 0,
  });
  parent.childrenIds.push(message.id);
  if (select) parent.selectedChildIndex = parent.childrenIds.length - 1;
  return message.id;
}

function selectedChildId(node: TreeNode): number | undefined {
  return node.childrenIds[node.selectedChildIndex];
}

function activeLeafId(): number {
  let id = TREE_ROOT_ID;
  let node = tree.get(TREE_ROOT_ID);
  while (node) {
    const childId = selectedChildId(node);
    if (childId === undefined) break;
    const child = tree.get(childId);
    if (!child) break;
    id = childId;
    node = child;
  }
  return id;
}

// Rewrites `transcript` in place (keeping the reference stable) to the active
// path: the chain of selected children from the root.
function rebuildActiveTranscript(): void {
  transcript.length = 0;
  let node = tree.get(TREE_ROOT_ID);
  while (node) {
    const childId = selectedChildId(node);
    if (childId === undefined) break;
    const child = tree.get(childId);
    if (!child?.message) break;
    transcript.push(child.message);
    node = child;
  }
}

// Version metadata for the navigator: a message has versions when its parent
// holds more than one child.
function versionInfo(
  messageId: number,
): { index: number; count: number } | null {
  const node = tree.get(messageId);
  if (!node) return null;
  const parent = tree.get(node.parentId);
  if (!parent || parent.childrenIds.length <= 1) return null;
  return { index: parent.selectedChildIndex, count: parent.childrenIds.length };
}

// New sends extend the active branch: each appended message becomes the
// selected child of the current leaf, keeping the tree and `transcript` in sync
// without a full rebuild.
function linkAppendedMessages(nextMessages: readonly Message[]): void {
  for (const message of nextMessages) {
    addTreeChild(activeLeafId(), message, { select: true });
  }
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
  return transcript[index]?.itemHeight ?? ESTIMATED_ITEM_HEIGHT;
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
  const plan = planVirtualListPixelWindowFromEnd({
    count: transcript.length,
    minimumPx: dataWindowPx(),
    getItemHeight: transcriptItemHeight,
  });
  setLoadedWindow(plan.start, plan.end);
}

function appendMessagesToLoadedBottom(
  nextMessages: readonly Message[],
): LoadedAppendResult {
  linkAppendedMessages(nextMessages);
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
    const sample = at(conversation, templateId);
    nextMessages.push(
      createMessage({
        ...sample,
        itemHeight: at(templateHeights, templateId),
      }),
    );
  }
  return nextMessages;
}

// Synthetic branches seeded onto the tail so version switching is testable
// without first having to edit or regenerate anything.
const BRANCH_BRIDGE_REPLY =
  "Sure — what would you like to dig into next? I can compare rendering strategies, walk through the windowing math, or sketch an API.";
const BRANCH_USER_V1 =
  "Can you summarize the trade-offs between **virtual scrolling** and **pagination** for a long chat log?";
const BRANCH_USER_V2 =
  "Actually — compare virtual scrolling, pagination, and **infinite scroll** for a long chat log, and tell me which you'd reach for.";
const BRANCH_REPLY_V2 = `Three options, roughly from most to least seamless:

| Approach | Feels like | Cost |
| --- | --- | --- |
| **Virtual scroll** | one continuous log | windowing + measurement bookkeeping |
| **Infinite scroll** | continuous, loads as you go | needs a sentinel + dedupe on prepend |
| **Pagination** | discrete pages | simplest, but breaks the "scrollback" mental model |

For a chat log I'd reach for **virtual scrolling**: the transcript is conceptually one stream, and users expect to scroll back through it without page seams. Infinite scroll is the fallback when you can't measure rows cheaply.`;
const BRANCH_REGEN_REPLIES = [
  `Short version:

- **Virtual scrolling** keeps the whole transcript addressable and scrollable, mounting only what's on screen. You pay for measurement + offset bookkeeping, but the scrollback experience is seamless.
- **Pagination** is far simpler to build and reason about, but it fragments one logical conversation into pages — awkward for a chat history people skim through.

For a chat log, virtual scrolling wins on UX; pagination wins on implementation effort.`,
  `Here's the trade-off as a table:

| | Virtual scroll | Pagination |
| --- | --- | --- |
| Scrollback UX | seamless, one stream | broken into pages |
| Implementation | windowing + measurement | trivial |
| Memory | bounded (only mounted rows) | bounded (one page) |
| Jump-to-message | direct (offset lookup) | needs page math |

A chat log reads as one continuous thing, so virtual scrolling matches the mental model — at the cost of the windowing machinery you're looking at right now.`,
  `It comes down to whether the conversation should *feel* continuous.

**Virtual scrolling** treats the transcript as a single scrollable surface and only renders the visible slice, so scrollback is uninterrupted — at the cost of measuring rows and maintaining offsets. **Pagination** is dramatically simpler but slices one conversation into discrete pages, which fights how people actually re-read a chat.

I'd pick virtual scrolling for a chat log nearly every time; pagination only when row heights are unknowable or the dataset is enormous and rarely revisited.`,
];

// Builds the linear spine from the conversation template, then grafts on the
// synthetic version branches above. The active path becomes the transcript.
function seedConversationTree(count: number): void {
  for (const message of createTemplateMessages(count)) {
    addTreeChild(activeLeafId(), message, { select: true });
  }
  seedSyntheticBranches();
  rebuildActiveTranscript();
  setNewestLoadedWindow();
}

function seedSyntheticBranches(): void {
  // A user prompt has to follow an assistant turn; bridge if the spine ended on
  // a user message so the seeded turn always reads naturally.
  let anchorId = activeLeafId();
  if (tree.get(anchorId)?.message?.role === "user") {
    anchorId = addTreeChild(
      anchorId,
      createMessage({
        role: "assistant",
        markdown: BRANCH_BRIDGE_REPLY,
        itemHeight: ESTIMATED_ITEM_HEIGHT,
      }),
      { select: true },
    );
  }

  // Edit scenario: one prompt, two versions, each with its own reply branch.
  const userV1 = createMessage({
    role: "user",
    markdown: BRANCH_USER_V1,
    itemHeight: ESTIMATED_ITEM_HEIGHT,
  });
  const userV2 = createMessage({
    role: "user",
    markdown: BRANCH_USER_V2,
    itemHeight: ESTIMATED_ITEM_HEIGHT,
  });
  addTreeChild(anchorId, userV1, { select: true });
  addTreeChild(anchorId, userV2, { select: false });

  // userV2 → a single reply.
  addTreeChild(
    userV2.id,
    createMessage({
      role: "assistant",
      markdown: BRANCH_REPLY_V2,
      itemHeight: ESTIMATED_ITEM_HEIGHT,
    }),
    { select: true },
  );

  // userV1 → a reply with three regenerations (the regenerate scenario).
  BRANCH_REGEN_REPLIES.forEach((markdown, index) => {
    addTreeChild(
      userV1.id,
      createMessage({ role: "assistant", markdown, itemHeight: 180 }),
      { select: index === 0 },
    );
  });
}

// Each provider owns a fully separate conversation: the simulated side reseeds
// the template spine + synthetic branches, the OpenAI side reloads the history
// persisted in localStorage as a linear chain. Switching swaps all of it.
// Bumped on every conversation swap so an in-flight send's finally block can
// tell it is finishing against a conversation that no longer exists — its
// persistence must not write the other provider's transcript into the history.
let conversationEpoch = 0;

function resetConversationState(): void {
  conversationEpoch++;
  topBoundaryLoadSeen = false;
  tree.clear();
  tree.set(TREE_ROOT_ID, {
    message: null,
    parentId: TREE_ROOT_ID,
    childrenIds: [],
    selectedChildIndex: 0,
  });
  transcript.length = 0;
  messages = [];
  loadedStart = 0;
  loadingTop = false;
  htmlCache.clear();
  nextMessageId = 1;
  nextResponse = 0;
}

// The fence languages a stored history actually uses. The static render is
// synchronous and only highlights already-loaded languages, so these must be
// loaded before the history rows first render — the boot preload only covers
// the simulated corpus, while real replies fence anything.
function historyFenceLanguages(turns: readonly StoredTurn[]): string[] {
  const languages = new Set<string>();
  const fence = /^\s{0,3}(?:```|~~~)\s*([A-Za-z0-9+#_-]+)/gm;
  for (const turn of turns) {
    for (const match of turn.markdown.matchAll(fence)) {
      const language = match[1];
      if (language) languages.add(language.toLowerCase());
    }
  }
  return [...languages];
}

// loadLanguages ignores unknown names, so the raw fence info strings are safe.
async function prepareOpenAILanguages(): Promise<void> {
  const languages = historyFenceLanguages(loadOpenAIHistory());
  if (languages.length > 0) await loadLanguages(languages);
}

function seedOpenAIConversation(): void {
  for (const turn of loadOpenAIHistory()) {
    addTreeChild(
      activeLeafId(),
      createMessage({
        role: turn.role,
        markdown: turn.markdown,
        itemHeight: ESTIMATED_ITEM_HEIGHT,
        ...(turn.toolCalls
          ? { toolCalls: cloneToolCalls(turn.toolCalls) }
          : {}),
      }),
      { select: true },
    );
  }
  rebuildActiveTranscript();
  setNewestLoadedWindow();
}

function seedActiveConversation(): void {
  resetConversationState();
  if (getAISettings().provider === "openai") {
    seedOpenAIConversation();
  } else {
    seedConversationTree(INITIAL_TRANSCRIPT_COUNT);
  }
}

// Swaps the rendered conversation after a provider change or a history clear:
// cancel any live stream, rebuild the state inside a layout transaction, then
// repaint every row and land at the bottom of the other conversation.
function reloadConversation(): void {
  if (streamAbort) cancelStream(streamAbort);
  virtualList.interruptScroll();
  virtualList.setStickyIndex(null);
  virtualList.syncLayout({
    apply: () => {
      seedActiveConversation();
      setBoundarySlotIdleState("top");
      return true;
    },
    after: () => {
      virtualList.refreshFrom(0);
      virtualList.invalidateMeasurements();
      syncBoundarySlot("top");
      syncDemoState();
      void virtualList.scrollToBottom();
    },
  });
}

function refreshLoadedWindowIfReplaced(result: LoadedAppendResult): void {
  if (!result.replacedWindow) return;
  virtualList.invalidateMeasurements();
  virtualList.refreshMounted();
}

// Switches the active version of a branched message: rewrites the active path
// from that message down and repaints only that suffix, leaving the prefix
// above it (DOM and scroll position) untouched.
function switchMessageVersion(messageId: number, offset: number): void {
  // Mid-stream switches would fight the live update loop.
  if (streamAbort) return;
  const node = tree.get(messageId);
  if (!node) return;
  const parent = tree.get(node.parentId);
  if (!parent || parent.childrenIds.length <= 1) return;
  const nextSelected = Math.min(
    Math.max(0, parent.selectedChildIndex + offset),
    parent.childrenIds.length - 1,
  );
  if (nextSelected === parent.selectedChildIndex) return;

  // A version click owns the viewport: stop native momentum and finish any
  // queued settle transaction before deriving loaded-window indexes. Clearing
  // cooldown timers alone would leave geometry updates blocked, and a pending
  // top prepend may change loadedStart while it is being drained here.
  virtualList.interruptScroll();

  // The branch point is this message's spot on the active path. Its navigator is
  // mounted, so it sits inside the loaded window: localBranchIndex >= 0.
  const branchIndex = transcript.findIndex(
    (message) => message.id === messageId,
  );
  if (branchIndex < 0) return;
  const localBranchIndex = branchIndex - loadedStart;
  const nextNode = tree.get(parent.childrenIds[nextSelected] ?? -1);
  if (!nextNode?.message) return;

  // Regenerated replies at the transcript tail are leaf-for-leaf swaps: row
  // count and every surrounding identity stay unchanged. Repaint that mounted
  // row and its already-measured geometry immediately, even if the settle
  // controller is only cooling down from a recent scroll. This explicit UI
  // interaction does not need the structural deferral used by boundary loads.
  const isLoadedLeafSwap =
    node.childrenIds.length === 0 &&
    nextNode.childrenIds.length === 0 &&
    localBranchIndex >= 0 &&
    localBranchIndex < messages.length &&
    messages[localBranchIndex]?.id === messageId;
  if (isLoadedLeafSwap) {
    parent.selectedChildIndex = nextSelected;
    nextNode.message.itemHeight = measureMessageHeight(
      localBranchIndex,
      nextNode.message,
    );
    transcript[branchIndex] = nextNode.message;
    messages[localBranchIndex] = nextNode.message;
    virtualList.refreshIndex(localBranchIndex);
    // The replacement was measured above, so commit its geometry in the same
    // interaction instead of leaving the surrounding UI behind until the
    // ResizeObserver queue is allowed to flush.
    virtualList.invalidateMeasurements();
    syncDemoState();
    return;
  }

  const previousTranscriptEnd = transcript.length;
  const previousWindowLength = messages.length;
  const bottomWasLoaded = loadedEnd() >= previousTranscriptEnd;

  parent.selectedChildIndex = nextSelected;

  virtualList.syncLayout({
    apply: () => {
      rebuildActiveTranscript();
      const windowEnd = bottomWasLoaded
        ? transcript.length
        : Math.min(loadedStart + previousWindowLength, transcript.length);
      messages = transcript.slice(loadedStart, windowEnd);
      // Only the swapped tail needs (re)measuring; the prefix is identical.
      if (localBranchIndex >= 0) {
        measureMessageRange(localBranchIndex, messages.length);
      } else {
        measureExistingMessages();
      }
      return true;
    },
    topSlot: boundarySlotFor("top"),
    after: () => {
      // syncLayout may defer apply() until an active scroll gesture settles.
      // Rebuild only after messages reflects the selected branch; otherwise
      // the row keeps the previous version's id and later navigation no-ops.
      virtualList.refreshFrom(Math.max(0, localBranchIndex));
      virtualList.invalidateMeasurements();
      updateRenderedBoundarySlots();
      syncDemoState();
    },
  });
}

// Whether a top boundary load has ever run for the current conversation. It
// keeps the slot mounted for the "At the top" state after scrollback exhausts,
// while conversations with nothing above (see shouldMountBoundarySlot) skip
// the slot entirely.
let topBoundaryLoadSeen = false;

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
  boundary: VirtualListBoundary,
): Exclude<BoundarySlotKind, "none"> {
  const kind = boundarySlotStates[boundary].kind;
  return kind === "none" ? "idle" : kind;
}

function boundarySlotLabel(
  boundary: VirtualListBoundary,
  kind: BoundarySlotKind,
): string {
  if (boundary !== "top") return "";
  if (kind === "loading") return "Loading older messages";
  if (kind === "no-more") return "At the top";
  return "";
}

function buildBoundarySlot(boundary: VirtualListBoundary): HTMLElement {
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
  boundary: VirtualListBoundary,
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
  boundary: VirtualListBoundary,
  context = currentBoundarySlotContext(),
): boolean {
  if (boundary === "bottom") return false;
  if (context.loadedCount === 0) return false;
  // The slot exists to serve scrollback loading. A conversation whose top is
  // loaded from the start (a fresh OpenAI chat) must not mount it: its height
  // would sit above item 0 and turn the first send's scroll-to-top into a
  // visible hop right before the fly-in. Once a top load has run, the slot
  // stays for its "At the top" state.
  return context.loadedStart > 0 || context.loadingTop || topBoundaryLoadSeen;
}

function boundarySlotFor(
  boundary: VirtualListBoundary,
  context = currentBoundarySlotContext(),
): VirtualListBoundarySlot | null {
  if (!shouldMountBoundarySlot(boundary, context)) return null;

  return {
    key: `${boundary}:streaming-window-slot`,
    height: BOUNDARY_SLOT_HEIGHT,
    build: () => buildBoundarySlot(boundary),
  };
}

function setBoundarySlotState(
  boundary: VirtualListBoundary,
  kind: BoundarySlotKind,
): void {
  boundarySlotStates[boundary] = { kind };
}

function idleBoundarySlotState(
  boundary: VirtualListBoundary,
  context = currentBoundarySlotContext(),
): BoundarySlotKind {
  if (boundary === "bottom" || context.loadedCount === 0) return "none";
  return context.loadedStart <= 0 ? "no-more" : "none";
}

function setBoundarySlotIdleState(
  boundary: VirtualListBoundary,
  context = currentBoundarySlotContext(),
): void {
  setBoundarySlotState(boundary, idleBoundarySlotState(boundary, context));
}

function refreshBoundarySlot(boundary: VirtualListBoundary): void {
  const element = virtualList.getBoundaryElement(boundary);
  if (element) updateBoundarySlotElement(element, boundary);
}

function syncBoundarySlot(boundary: VirtualListBoundary): void {
  virtualList.setBoundarySlot(boundary, boundarySlotFor(boundary));
  refreshBoundarySlot(boundary);
}

function updateRenderedBoundarySlots(): void {
  refreshBoundarySlot("top");
}

function syncVirtualizerLayout(options?: { addedBefore?: number }): void {
  if (!loadingTop) setBoundarySlotIdleState("top");
  virtualList.syncLayout({
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
  topBoundaryLoadSeen = true;
  setBoundarySlotState("top", "loading");
  refreshBoundarySlot("top");
  syncDemoState();

  window.setTimeout(() => {
    const plan = planVirtualListPixelWindowFromEnd({
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

    virtualList.syncLayout({
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

function syncDemoState(state = virtualList.state): void {
  syncScrollButtons(state);
  syncMetrics(state);
}

function syncMetrics(state: VirtualListState): void {
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
  virtualListStatus.textContent = `dom ${formatCount(state.mountedCount)}/${formatCount(state.count)} · measured ${formatCount(state.measuredCount)} · mounted ${formatCount(state.range.start)}-${formatCount(mountedEnd)}`;
}

function cacheKey(message: Message): string {
  return String(message.id);
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
    templateHeights[templateId] = measureVirtualListItem({
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
  virtualList.invalidateMeasurements();
  syncDemoState();
}

function buildTemplateItem(index: number): HTMLElement {
  const sample = conversation[index];
  if (!sample) throw new Error(`missing template ${index}`);
  return buildChatItem(index, sample, renderMarkdown(sample.markdown));
}

function measureMessageHeight(index: number, message: Message): number {
  return measureVirtualListItem({
    viewport,
    canvasClassName: "chat-canvas",
    index,
    // Mirror buildItem so the version navigator is part of the measured height.
    buildItem: (itemIndex) => buildStaticItem(itemIndex, message),
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
  return messages[index]?.itemHeight ?? ESTIMATED_ITEM_HEIGHT;
}

function buildItem(index: number): HTMLElement {
  const message = messages[index];
  if (!message) throw new Error(`missing message ${index}`);
  // A streaming row is a live markdown-viewer (cursor + healing + morph); every
  // other row is a static HTML render. The status flips back to "done" on
  // completion, so this same path rebuilds the row as static when it remounts.
  if (message.status === "streaming") return buildStreamingItem(index, message);
  return buildStaticItem(index, message);
}

// A finished row: the static markdown render plus, when the message has sibling
// versions, the navigator that switches between them.
// The same markup markdown-viewer's finalize leaves behind; rendered by every
// static build of a message flagged trailingSpacer (see the Message field).
const CURSOR_SPACER_HTML =
  '<span class="cursor cursor-spacer" data-cursor-spacer aria-hidden="true"></span>';

function buildStaticItem(index: number, message: Message): HTMLElement {
  const row = buildChatItem(index, message, htmlForMessage(message));
  row.dataset.messageId = String(message.id);
  if (message.trailingSpacer) {
    row
      .querySelector<HTMLElement>(".markdown")
      ?.insertAdjacentHTML("beforeend", CURSOR_SPACER_HTML);
  }
  appendVersionNav(row, message);
  return row;
}

function versionNavButton(
  dir: "prev" | "next",
  enabled: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "version-nav-btn";
  button.dataset.dir = dir;
  button.disabled = !enabled;
  button.setAttribute(
    "aria-label",
    dir === "prev" ? "Previous version" : "Next version",
  );
  button.innerHTML =
    dir === "prev"
      ? '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return button;
}

function buildVersionNav(message: Message): HTMLElement | null {
  const info = versionInfo(message.id);
  if (!info) return null;
  const nav = document.createElement("div");
  nav.className = "version-nav";
  nav.dataset.messageId = String(message.id);
  const count = document.createElement("span");
  count.className = "version-nav-count";
  count.textContent = `${info.index + 1} / ${info.count}`;
  nav.append(
    versionNavButton("prev", info.index > 0),
    count,
    versionNavButton("next", info.index < info.count - 1),
  );
  return nav;
}

function appendVersionNav(row: HTMLElement, message: Message): void {
  const nav = buildVersionNav(message);
  if (!nav) return;
  const content = row.querySelector<HTMLElement>(".message-content") ?? row;
  content.appendChild(nav);
}

// Matches when the (trimmed) stream currently ends with an embedded image.
const TRAILING_IMAGE_RE = /!\[[^\]]*\]\(data:image\/[a-z.+-]+;base64,[^)]*\)$/;

// What the live viewer renders mid-stream. Trailing newlines (OpenAI replies
// end with one; embedded image blocks append two) would otherwise parse into
// an empty trailing paragraph hosting the typing cursor — a phantom line that
// vanishes when streaming finalizes, jumping the content bottom at the end of
// every reply (markdown-viewer's finalize spacer keeps the height only for
// line-owning cursors that are still displayed). The exception: when the
// stream ends with an image, keep one blank line so the cursor sits on its
// own line below it — glued to the image corner it reads wrong, and hidden it
// looks stalled. The finalize spacer keeps that line, so no end jump either
// way. The stored markdown stays raw; trailing whitespace renders to nothing
// in the final static parse, so finalize output is unchanged.
function streamingDisplayText(message: Message): string {
  const trimmed = message.markdown.trimEnd();
  return TRAILING_IMAGE_RE.test(trimmed) ? `${trimmed}\n\n` : trimmed;
}

function buildStreamingItem(index: number, message: Message): HTMLElement {
  const { row, content } = buildChatRow(index, message);
  row.dataset.messageId = String(message.id);
  // createMarkdownViewer takes over its host's children, so it gets a dedicated
  // wrapper rather than `content` (which also holds the role label / tool calls).
  const host = document.createElement("div");
  host.className = "streaming-host";
  // The live viewer binds its own copy / table-copy click handler to its root.
  // The chat viewport also delegates those clicks (for static rows), so stop the
  // bubble here to keep both from firing on this one row — otherwise a copy fires
  // twice and a table menu toggles open then shut. The viewer's handler is bound
  // deeper in the tree, so it has already run by the time the event reaches here.
  host.addEventListener("click", (event) => event.stopPropagation());
  content.appendChild(host);
  const handle = createMarkdownViewer(host, {
    text: streamingDisplayText(message),
    isStreaming: true,
    // The viewer root rarely holds focus inside the list (the composer does), so
    // keep a solid block cursor instead of dimming to a hollow frame.
    unfocusedCursorStyle: "block",
  });
  streamingViewers.set(row, handle);
  return row;
}

function syncRoleLabel(
  element: HTMLElement,
  message: Message,
  index: number,
): void {
  const label = element.querySelector<HTMLElement>(".role-label");
  if (label && label.dataset.status !== message.status) {
    setRoleLabel(label, message, index);
  }
}

function refreshItem(
  index: number,
  options: { refreshUnmounted?: boolean } = {},
): void {
  const message = messages[index];
  if (!message) return;

  htmlCache.delete(cacheKey(message));
  const element = virtualList.getMountedElement(index);

  if (message.status === "streaming") {
    if (element) {
      const handle = streamingViewers.get(element);
      if (handle) {
        syncRoleLabel(element, message, index);
        handle.update({
          text: streamingDisplayText(message),
          isStreaming: true,
        });
        return;
      }
      // Mounted but not yet live (the row just transitioned from "thinking"):
      // rebuild it as a live viewer.
      virtualList.refreshIndex(index);
      return;
    }
    // Offscreen rows are left alone — per-token updates skip them and the viewer
    // is built fresh when they remount.
    if (options.refreshUnmounted) virtualList.refreshIndex(index);
    return;
  }

  if (!element) {
    if (options.refreshUnmounted) virtualList.refreshIndex(index);
    return;
  }

  // Stream just ended on a still-live row: finalize the viewer in place
  // (isStreaming:false morphs the DOM rather than replacing it) instead of
  // swapping to a static row, so a text selection inside the message survives.
  // The row stays a live viewer until it unmounts, then remounts static.
  const liveHandle = streamingViewers.get(element);
  if (liveHandle) {
    syncRoleLabel(element, message, index);
    liveHandle.update({ text: message.markdown, isStreaming: false });
    // The finalize may have left the height-neutral cursor spacer; record it
    // so every future static render keeps the line (never reclaimed — see
    // Message.trailingSpacer).
    if (element.querySelector("[data-cursor-spacer]")) {
      message.trailingSpacer = true;
    }
    return;
  }

  const label = element.querySelector<HTMLElement>(".role-label");
  const markdown = element.querySelector<HTMLElement>(".md");
  if (!label || !markdown) {
    virtualList.refreshIndex(index);
    return;
  }

  if (label.dataset.status !== message.status) {
    setRoleLabel(label, message, index);
  }
  markdown.innerHTML = htmlForMessage(message);
}

function syncScrollButtons(state = virtualList.state): void {
  if (scrollButtonsTimer) {
    window.clearTimeout(scrollButtonsTimer);
    scrollButtonsTimer = 0;
  }
  // state.atTop is the top of the loaded pixel window, not necessarily the
  // transcript. Keep the jump visible while older rows still exist so it does
  // not blink off at the local top and back on after the prepend is anchored.
  scrollTopBtn.hidden = state.atTop && !canLoadOlderMessages();
  scrollBottomBtn.hidden =
    state.atBottom ||
    scrollTurnInProgress ||
    bottomFollowArmed ||
    bottomFollowPending;
}

function scheduleScrollButtons(): void {
  if (scrollButtonsTimer) window.clearTimeout(scrollButtonsTimer);
  scrollButtonsTimer = window.setTimeout(() => {
    scrollButtonsTimer = 0;
    syncDemoState();
  }, SCROLL_BUTTONS_DEBOUNCE_MS);
}

// Advances the response rotation and returns the variant to stream.
function advanceResponse(prompt = ""): ReplyVariant {
  // The fast long-form variant is the last sample. Force it via the ?fast-long
  // URL param, or by sending a message that starts with "f" — a shortcut for
  // testing fast streaming on demand. Deliberately pinned outside the rotation:
  // it returns without advancing nextResponse.
  if (forceFastLongReply || /^f/i.test(prompt)) {
    return at(SAMPLE_RESPONSES, SAMPLE_RESPONSES.length - 1);
  }

  const response = at(SAMPLE_RESPONSES, nextResponse % SAMPLE_RESPONSES.length);
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

// The active transcript, oldest → newest, as API turns — sliced per the
// context setting (0 = full history). This reads `transcript`, the complete
// in-memory conversation, never the virtualizer's loaded window: what is
// rendered depends on viewport height and scroll position, which should not
// decide what the model gets to see. The just-appended assistant placeholder
// is still empty, so the markdown filter drops it.
function openAIContext(contextTurns: number): ChatTurn[] {
  const tail = contextTurns > 0 ? transcript.slice(-contextTurns) : transcript;
  const turns: ChatTurn[] = [];
  for (const message of tail) {
    if (message.markdown === "") continue;
    // Embedded generated images would go back to the API as base64 text —
    // megabytes of tokens per image; a placeholder marks where they were.
    turns.push({
      role: message.role,
      content: stripGeneratedImages(message.markdown),
    });
  }
  return turns;
}

// Role, markdown, and settled tool calls persist; ids are reassigned and
// heights remeasured on the next load.
function persistOpenAIConversation(): void {
  const turns: StoredTurn[] = [];
  for (const message of transcript) {
    if (message.markdown === "") continue;
    // A cancel can leave a call mid-flight; store it as errored.
    const toolCalls = message.toolCalls?.map((toolCall) => ({
      ...toolCall,
      status:
        toolCall.status === "running" ? ("error" as const) : toolCall.status,
    }));
    turns.push({
      role: message.role,
      markdown: message.markdown,
      ...(toolCalls?.length ? { toolCalls } : {}),
    });
  }
  saveOpenAIHistory(turns);
}

async function streamOpenAIResponse(
  messageId: number,
  abort: StreamAbort,
): Promise<void> {
  const { apiKey, model, contextTurns, tools, reasoningSummary } =
    getAISettings();
  const abortLink = linkedAbortSignal(abort);
  // Live tool calls by event id: where each sits in message.toolCalls and
  // when it started, so tool-end can settle the right entry with a real
  // duration — and so a failed stream can settle whatever was still running.
  const liveToolCalls = new Map<string, { slot: number; startedAt: number }>();
  try {
    let started = false;
    // The partial preview currently embedded per image call, so each next
    // frame (and the final image) swaps it in place instead of stacking up.
    const partialImages = new Map<string, string>();
    for await (const chunk of streamOpenAIChat(
      openAIContext(contextTurns),
      { apiKey, model, tools, reasoningSummary },
      abortLink.signal,
    )) {
      if (abort.cancelled) return;
      // Tool chunks change row structure (the tool-call panels are built at
      // row construction), so they need a rebuild, not just a text update.
      const rebuildRow =
        chunk.kind === "tool-start" || chunk.kind === "tool-end";
      mutateMessageById(messageId, (message) => {
        // The row stays "thinking" until the first real activity arrives.
        if (!started) message.status = "streaming";
        switch (chunk.kind) {
          case "text":
            message.markdown += chunk.text;
            break;
          case "image-partial":
          case "image": {
            // Progressive frames refine the same embedded block; the final
            // image takes the partial's place. Blank lines keep the image a
            // block of its own regardless of surrounding text.
            const previous = partialImages.get(chunk.id);
            if (previous && message.markdown.includes(previous)) {
              message.markdown = message.markdown.replace(
                previous,
                chunk.markdown,
              );
            } else {
              message.markdown += `\n\n${chunk.markdown}\n\n`;
            }
            if (chunk.kind === "image-partial") {
              partialImages.set(chunk.id, chunk.markdown);
            } else {
              partialImages.delete(chunk.id);
            }
            break;
          }
          case "tool-start": {
            const toolCalls = message.toolCalls ?? [];
            liveToolCalls.set(chunk.id, {
              slot: toolCalls.length,
              startedAt: performance.now(),
            });
            message.toolCalls = [
              ...toolCalls,
              {
                name: chunk.name,
                status: "running",
                durationMs: 0,
                input: chunk.input,
                output: "",
              },
            ];
            break;
          }
          case "tool-end": {
            const live = liveToolCalls.get(chunk.id);
            const entry: ChatToolCall = {
              name: chunk.name,
              status: chunk.ok ? "done" : "error",
              durationMs: live
                ? Math.max(1, Math.round(performance.now() - live.startedAt))
                : 0,
              input: chunk.input,
              output: chunk.output,
            };
            const toolCalls = [...(message.toolCalls ?? [])];
            if (live && toolCalls[live.slot]) toolCalls[live.slot] = entry;
            else toolCalls.push(entry);
            message.toolCalls = toolCalls;
            break;
          }
        }
      });
      if (rebuildRow) {
        const index = findLoadedMessageIndex(messageId);
        if (index >= 0) virtualList.refreshIndex(index);
      }
      started = true;
    }
  } catch (error) {
    // A cancelled stream rejects the fetch with an AbortError; that is the
    // user's Stop, not a failure to surface.
    if (abort.cancelled) return;
    // fetch rejects with a TypeError when the response was unreadable
    // (Safari: "Load failed", Chrome: "Failed to fetch"). Two very different
    // causes share that shape: a network/blocker problem, or an auth error —
    // OpenAI omits CORS headers on 401s, so a rejected key is unreadable too
    // (the real status is visible in the browser console). Settings are kept
    // per browser, so a key pasted in another browser does not exist here.
    const detail =
      error instanceof TypeError
        ? `${error.message} — the response was unreadable. If the browser console shows a 401, the API rejected the key (re-paste it in the AI settings — keys are stored per browser); otherwise check content blockers, VPN/proxy, or the network tab.`
        : error instanceof Error
          ? error.message
          : String(error);
    mutateMessageById(
      messageId,
      (message) => {
        const alert = `> [!CAUTION]\n> **OpenAI request failed** — ${detail}`;
        // A stream can die inside an open code fence; close it first or the
        // alert is swallowed into the fence as raw monospace text. An odd
        // fence count means the last one opened a block — close with its own
        // marker (a ``` cannot close a ~~~ or a longer backtick run).
        const fences = message.markdown.match(/^\s{0,3}(`{3,}|~{3,})/gm);
        const fenceClose =
          fences && fences.length % 2 === 1
            ? `\n\n${fences[fences.length - 1]?.trim()}`
            : "";
        message.markdown = message.markdown
          ? `${message.markdown}${fenceClose}\n\n${alert}`
          : alert;
        // Panels still mid-flight would pulse "running" forever; settle them.
        if (liveToolCalls.size > 0 && message.toolCalls) {
          message.toolCalls = message.toolCalls.map((toolCall) =>
            toolCall.status === "running"
              ? { ...toolCall, status: "error" as const }
              : toolCall,
          );
        }
      },
      { refreshUnmounted: true },
    );
    if (liveToolCalls.size > 0) {
      const index = findLoadedMessageIndex(messageId);
      if (index >= 0) virtualList.refreshIndex(index);
    }
  } finally {
    abortLink.cleanup();
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

    const element = virtualList.getMountedElement(index);
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

function beginStreamingBottomFollow(abort: StreamAbort, force = false): void {
  if (abort.cancelled) return;
  // Auto-following on send only engages if the user is at the bottom when the
  // response begins — if they've scrolled away, leave them there. An explicit
  // jump-to-bottom passes force, since the user just asked to follow (and the
  // stream may have grown past the bottom during the jump's smooth scroll).
  if (!force && !virtualList.state.atBottom) {
    dearmStreamingBottomFollow();
    return;
  }

  bottomFollowCleanup?.();
  const followAbort = linkedAbortSignal(abort);
  bottomFollowPending = false;
  bottomFollowArmed = true;
  bottomFollowCleanup = followAbort.cleanup;
  virtualList.followBottom({
    behavior: "smooth",
    duration: BOTTOM_FOLLOW_DURATION_MS,
    signal: followAbort.signal,
  });
}

function startStreamingBottomFollow(abort: StreamAbort, force = false): void {
  if (abort.cancelled) return;
  if (!virtualListScrollActive) {
    beginStreamingBottomFollow(abort, force);
    return;
  }

  bottomFollowPending = true;
  void waitForVirtualizerScrollEnd(abort).then(() => {
    if (bottomFollowPending && !abort.cancelled)
      beginStreamingBottomFollow(abort, force);
  });
}

function dearmStreamingBottomFollow(): void {
  bottomFollowPending = false;
  bottomFollowArmed = false;
  bottomFollowCleanup?.();
  bottomFollowCleanup = null;
}

function stopStreamingBottomFollow(): void {
  virtualList.stopFollowBottom();
  dearmStreamingBottomFollow();
}

async function handleScrollBottomClick(): Promise<void> {
  const activeStream = streamAbort;
  const scrollAbort = activeStream ? linkedAbortSignal(activeStream) : null;

  try {
    const completed = await virtualList.scrollToBottom({
      behavior: "smooth",
      signal: scrollAbort?.signal,
    });
    syncDemoState();

    if (
      completed &&
      activeStream &&
      streamAbort === activeStream &&
      !activeStream.cancelled
    ) {
      startStreamingBottomFollow(activeStream, true);
      syncDemoState();
    }
  } finally {
    scrollAbort?.cleanup();
  }
}

function getMountedMessageContent(index: number): HTMLElement | null {
  const element = virtualList.getMountedElement(index);
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
  virtualListScrollActive = true;
  if (!bottomFollowArmed && !bottomFollowPending) return;
  dearmStreamingBottomFollow();
}

function finishVirtualizerScrollTracking(): void {
  virtualListScrollActive = false;
  for (const resolve of virtualListScrollEndWaiters) resolve();
  virtualListScrollEndWaiters.clear();
}

function handleVirtualizerScrollEnd(): void {
  finishVirtualizerScrollTracking();
  syncDemoState();
}

function waitForVirtualizerScrollEnd(abort: StreamAbort): Promise<void> {
  if (!virtualListScrollActive || abort.cancelled) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      virtualListScrollEndWaiters.delete(finish);
      abort.onCancel.delete(finish);
      resolve();
    };

    virtualListScrollEndWaiters.add(finish);
    abort.onCancel.add(finish);
    if (!virtualListScrollActive || abort.cancelled) finish();
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
    const scroll = virtualList.scrollToIndex(index, "top", {
      behavior: "smooth",
      duration: SEND_SCROLL_DURATION_MS,
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
  const useOpenAI = getAISettings().provider === "openai";
  const sendEpoch = conversationEpoch;
  const persistTurns = () => {
    if (useOpenAI && sendEpoch === conversationEpoch) {
      persistOpenAIConversation();
    }
  };

  try {
    const userMessage = createMessage({
      role: "user",
      markdown: text,
      itemHeight: ESTIMATED_ITEM_HEIGHT,
    });
    const assistantMessage = createMessage({
      role: "assistant",
      markdown: "",
      status: "thinking",
      itemHeight: ESTIMATED_ITEM_HEIGHT,
      // Real replies have no tool phase; the simulated set stays a prop of the
      // canned rotation only.
      ...(useOpenAI ? {} : { toolCalls: createSimulatedToolCalls() }),
    });
    assistantId = assistantMessage.id;
    // Both rows land before the glide starts: every structural cost (row
    // builds, clone measurement, layout sync) is paid up front, so no long
    // task hits the animation's delicate ease-out tail. The buttons' scrolls
    // carry no payload — this is what made the send scroll feel rougher than
    // them despite sharing the same animator and easing.
    const appendResult = appendMessagesToLoadedBottom([
      userMessage,
      assistantMessage,
    ]);
    // Persist the user turn immediately so a reload mid-stream keeps it (the
    // still-empty assistant placeholder is filtered out).
    persistTurns();
    syncVirtualizerLayout();
    refreshLoadedWindowIfReplaced(appendResult);
    const userIndex = appendResult.startIndex;
    virtualList.setStickyIndex(userIndex);
    await scrollMessageToTop(
      userIndex,
      abort,
      shouldFlyIn
        ? undefined
        : () => fadeInMountedItems([userIndex, userIndex + 1], abort),
    );
    scheduleScrollButtons();
    if (abort.cancelled) return;
    if (shouldFlyIn) {
      await flyInMountedItems([userIndex], abort);
      if (abort.cancelled) return;
    }

    startStreamingBottomFollow(abort);

    if (useOpenAI) {
      await streamOpenAIResponse(assistantId, abort);
    } else {
      const reply = advanceResponse(text);
      await wait(instantReplies ? 0 : reply.thinkingDelayMs, abort);
      if (abort.cancelled) return;

      mutateMessageById(assistantId, (message) => {
        message.status = "streaming";
      });
      await streamResponse(reply, assistantId, abort);
    }
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
    // The finished (or cancelled-partial) assistant turn joins the history;
    // empty turns are filtered out during serialization.
    persistTurns();
    if (!abort.cancelled) {
      await settleVirtualizerFrames();
      if (bottomFollowArmed) {
        await virtualList.scrollToBottom();
      }
    }
    stopStreamingBottomFollow();
    streamAbort = null;
    setStreamingUI(false);
    scheduleScrollButtons();
    // Focusing the composer collapses any text selection, so skip it while the
    // user is selecting text in a message — otherwise stream end clears it.
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) promptInput.focus();
  }
}

bindThemeButtons(refreshTheme);
initAISettingsPanel({
  onProviderChange: (provider) => {
    if (provider === "openai") {
      // Fence languages must be loaded before the history's static render.
      void prepareOpenAILanguages().then(() => reloadConversation());
    } else {
      reloadConversation();
    }
  },
  onClearHistory: () => {
    // Only the OpenAI conversation is rendered from that history; a clear
    // while the simulated transcript is showing needs no repaint.
    if (getAISettings().provider === "openai") reloadConversation();
  },
});

scrollTopBtn.addEventListener("click", () => {
  // At the top of a partial loaded window the button stays visible while the
  // boundary load runs; do not let a redundant click force deferred rows into
  // a live native gesture through scrollToTop's programmatic flush path.
  if (virtualList.state.atTop) return;
  void virtualList.scrollToTop({ behavior: "smooth" }).then(() => {
    syncDemoState();
  });
});

scrollBottomBtn.addEventListener("click", () => {
  void handleScrollBottomClick();
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
if (getAISettings().provider === "openai") await prepareOpenAILanguages();
seedActiveConversation();

const virtualList = createVirtualList({
  viewport,
  canvasClassName: "chat-canvas",
  getCount: () => messages.length,
  getItemHeight,
  buildItem,
  destroyItem: (_index, element) => {
    const handle = streamingViewers.get(element);
    if (!handle) return;
    handle.destroy();
    streamingViewers.delete(element);
  },
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
// One delegated listener powers copy buttons across every mounted row.
attachInteractions(viewport);
// A second delegated listener drives the per-message version navigators; it
// survives row rebuilds because it lives on the viewport, not the rows.
viewport.addEventListener("click", (event) => {
  // The chevron is an inline SVG, so the click target may be an SVGElement;
  // match on Element (closest is defined there) rather than HTMLElement.
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>(".version-nav-btn");
  if (!button || button.hasAttribute("disabled")) return;
  const messageId = Number(
    button.closest<HTMLElement>(".version-nav")?.dataset.messageId,
  );
  if (!Number.isFinite(messageId)) return;
  switchMessageVersion(messageId, button.dataset.dir === "prev" ? -1 : 1);
});
// Toggling a tool-call <details> changes the row's height inside the click's
// own task, but ResizeObserver corrections flush a frame later — so the
// browser would paint the toggle against stale canvas geometry and the
// correction then shifts everything a frame after (a visible flash/jump).
// A microtask runs after the details' default toggle action but before
// paint: committing that one row's real height there (remeasureIndex uses
// the same anchored-correction path the observer flush uses) keeps the
// toggle, the canvas resize, and the scroll correction in a single frame.
viewport.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const summary = event.target.closest(".tool-call-summary");
  if (!summary) return;
  const row = summary.closest<HTMLElement>("article.message");
  if (!row) return;
  // The summary's activation behavior — the actual open/close mutation — runs
  // after event dispatch completes, which is later than any microtask queued
  // here (a microtask checkpoint still measures the pre-toggle height on a
  // real click). A rAF callback runs in the same rendering update that will
  // paint the toggled layout, after the mutation but before paint, so
  // committing there folds the row's height change, the canvas resize, and
  // the scroll correction into one painted frame.
  requestAnimationFrame(() => {
    // Resolve the row's index by element identity at commit time — dataset
    // indexes can be stale across loaded-window shifts.
    const { range } = virtualList.state;
    for (let index = range.start; index < range.end; index++) {
      if (virtualList.getMountedElement(index) === row) {
        virtualList.remeasureIndex(index);
        return;
      }
    }
  });
});

await virtualList.scrollToBottom();
syncDemoState();
document.documentElement.classList.remove("booting");
promptInput.focus();

watchSystemTheme(refreshTheme);
