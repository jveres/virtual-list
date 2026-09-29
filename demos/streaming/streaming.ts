import {
  autosizeTextarea,
  mountUserMessageCollapse,
  prepareUserMessageCollapse,
  streamingMarkdownText,
  syncUserMessageCollapse,
  unmountUserMessageCollapse,
} from "../../integrations/index.js";
import {
  captureItemPlacement,
  replacementAnchor as captureReplacementAnchor,
  createPagedWindow,
  createStickyHeaders,
  type Page,
  type PagedWindow,
  type StickyHeaders,
} from "../../src/companions/index.js";
import {
  type AnchorRequest,
  createVirtualList,
  type EdgeSlot,
  type FollowMode,
  type ReachContext,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { conversation } from "../shared/chat-data.js";
import {
  type AssistantStatus,
  buildChatItem,
  buildChatRow,
  buildSectionHeader,
  type ChatToolCall,
  chevronIcon,
  setRoleLabel,
} from "../shared/chat-ui.js";
import {
  attachInteractions,
  initMarkdown,
  loadLanguages,
  renderMarkdown,
} from "../shared/markdown.js";
import { replaceMessageMarkdown } from "../shared/message-order.js";
import { applyDocumentTheme, watchSystemTheme } from "../shared/theme.js";
import {
  at,
  bindThemeButtons,
  downloadBlob,
  mustGet,
  refreshTheme,
  setHiddenIfChanged,
  setTextIfChanged,
  syncThemeButtons,
} from "../shared/utils.js";
import {
  ATTACHMENT_ACCEPT,
  attachmentChip,
  type ChatAttachment,
  disposeAttachmentChips,
  readAttachments,
} from "./attachments.js";
import {
  branchingTranscriptMarkdown,
  type ImportedTranscript,
  parseBranchingTranscript,
  selectTranscriptBranches,
  type TranscriptSelection,
  type TranscriptTree,
} from "./branching-transcript.js";
import { createConversationTree } from "./conversation-tree.js";
import { adoptDisplayCopies, readyDisplayCopy } from "./display-copies.js";
import { storedGeneratedFiles, syncGeneratedFiles } from "./generated-files.js";
import { resumeRowImages, suspendRowImages } from "./image-lifecycle.js";
import {
  createChatImagePreview,
  messageImageSources,
} from "./image-preview.js";
import {
  appendStaticMessageContent,
  type CursorMode,
  createMessageContent,
  type MessageContentHandle,
  type TrailMode,
} from "./message-content.js";
import {
  clearMessageCopyFeedback,
  copyMessageText,
  MESSAGE_COPY_PATH,
} from "./message-copy.js";
import {
  buildResponseContext,
  getAISettings,
  initAISettingsPanel,
  loadOpenAIConversation,
  loadSimulatedHistory,
  type StoredTurn,
  saveOpenAIHistory,
  saveSimulatedHistory,
  saveSimulatedSelection,
  streamOpenAIChat,
} from "./openai.js";
import { type ResponseHeading, responseHeadings } from "./response-headings.js";
import { sampleTimestamp } from "./sample-time.js";
import {
  createTranscriptFile,
  shareChatFile,
  supportsChatSharing,
} from "./share.js";
import { stageMessageLayout } from "./staged-message.js";

import "../shared/styles.css";

// The demo is the runtime's API pressure test: the full streaming chat —
// send flow with pin-to-top, end-follow through streams, scrollback loading,
// version branches, live tool panels — hosted on the runtime's public
// surface (setItems / scrollTo / remeasure / setEdgeSlot / positionOf /
// elementOf / state, plus the paged window's updateItemLive) with no escape
// hatch into its internals.
//
// The message data is immutable-by-replacement: every change clones the
// message object and sends it through the paged window's updateItemLive.
// Structural changes use setItems. The one
// in-place exception is a tool panel's open state, which the runtime never
// needs to know about (it is excluded from the panel signature). The runtime's
// keyed renderer re-renders exactly the changed rows (render(item, existing)),
// and end-compatible snapshots keep end-follow engaged while streaming.
//
// On the runtime (docs/architecture.md): every row is measured where it
// mounts before it commits; a change above the reader lands mid-gesture
// where the browser anchors natively, otherwise when the scroll phase
// settles, and one below it (a new turn, a version switch) at once. The
// streaming reply's tokens render in place and its height commits at once
// whenever no anchor-preserving scroll write is needed, so the reply keeps
// flowing under a scroll. Scrollback loads are
// wired to the reach signal: reaching the other edge aborts them.
//
// Two presentation options, both in the settings dialog:
// - the scrollback loader is a runtime EDGE SLOT in the flow (default;
//   "Scrollback loader: Floating pill" restores the pill). In the flow, the slot's strip
//   turns into the loaded messages while the reading position holds — the
//   visible "more to scroll" feedback — and it never competes with the
//   sticky header for the top strip;
// - day separators are rows, and a STICKY companion pins the current day at
//   the top ("Sticky day headers" in settings turns it off). It reads
//   the runtime's committed positions, which move only at commits — each
//   of which refreshes it — never under a native scroll write.

interface Message {
  attachments?: ChatAttachment[];
  generatedFiles?: StoredTurn["generatedFiles"];
  responseState?: StoredTurn["responseState"];
  id: number;
  role: "user" | "assistant";
  markdown: string;
  status?: AssistantStatus;
  toolCalls?: ChatToolCall[];
  /** When the message was sent (epoch ms). Real turns only; the canned
   * transcript is undated and falls into synthetic days. */
  sentAt?: number;
}

/** A day separator row, interleaved into the runtime's items. Never the
 * reading anchor (see `anchorable`): a scrollback load that extends a dated
 * day upward moves the header above the newly loaded messages, and the
 * message under it must keep its place. */
interface DayHeader {
  kind: "day";
  day: number;
  runStart: number;
  label: string;
}

type ChatRow = Message | DayHeader;

function isDayHeader(row: ChatRow): row is DayHeader {
  return "kind" in row && row.kind === "day";
}

function rowKey(row: ChatRow): string {
  return isDayHeader(row) ? `day:${row.day}:${row.runStart}` : String(row.id);
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
  pause?: { everyWords: number; durationMs: number };
}

const COMPOSER_FALLBACK_MIN_HEIGHT = 42;
const COMPOSER_MAX_HEIGHT = 160;
const DEFAULT_THINKING_DELAY_MS = 1200;
const DEFAULT_TOKEN_DELAY_MS = { min: 18, max: 54 };
const FAST_THINKING_DELAY_MS = 240;
const FAST_TOKEN_DELAY_MS = { min: 4, max: 12 };
// Synthetic days over the transcript: one separator per this many messages.
const MESSAGES_PER_DAY = 12;
// The in-flow scrollback slot's fixed height.
const EDGE_SLOT_HEIGHT = 52;
// The day pill's row height; a send pins its message this far below the
// viewport top when the sticky header is on, so the pill never covers it.
const DAY_HEADER_HEIGHT = 40;
const INITIAL_TRANSCRIPT_COUNT = 100;
// The loaded data window over the transcript: how much is handed to the
// virtualizer, and how much each scrollback load prepends.
const DATA_WINDOW_FACTOR = 5;
const LOAD_OLDER_DELAY_MS = 180;
// How long the "At the top" overlay lingers before fading.
const EDGE_NO_MORE_HIDE_MS = 1400;
// After a chunk loads with more history remaining, the loader (slot or pill) lingers
// briefly instead of hiding — a user still scrolling back re-enters the
// edge zone within this window, and hiding between chunks reads as a
// flashing loader.
const EDGE_HIDE_LINGER_MS = 400;

// Test and debug flags only (?instant, ?stream=, ?fast-long); every product
// choice lives in the settings dialog and persists in this browser.
const demoParams = new URLSearchParams(location.search);
// General options live in the settings dialog and persist in this browser
// (the browser matrix seeds the store before a load).
const OPTIONS_KEY = "virtual-list:chat-options";
const DRAFT_KEY = "virtual-list:chat-draft";
/** Where a loaded conversation lands: its last prompt pinned to the top, or its end. */
type LandingMode = "prompt" | "end";
// One parse per chat option: stored settings and the settings dialog share it.
const parseEdge = (value: unknown): "slot" | "pill" =>
  value === "pill" ? "pill" : "slot";
const parseFollow = (value: unknown): FollowMode =>
  value === "keep-start" || value === "keep-content" ? value : "end";
const parseLanding = (value: unknown): LandingMode =>
  value === "end" ? "end" : "prompt";
const parseCursor = (value: unknown): CursorMode =>
  value === "none" || value === "idle" ? value : "bar";
const parseTrail = (value: unknown): TrailMode =>
  value === "short" || value === "long" ? value : "off";
interface ChatOptions {
  edge: "slot" | "pill";
  sticky: boolean;
  follow: FollowMode;
  landing: LandingMode;
  cursor: CursorMode;
  trail: TrailMode;
}
function loadChatOptions(): ChatOptions {
  const stored: { [K in keyof ChatOptions]?: unknown } = (() => {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(OPTIONS_KEY) ?? "{}",
      );
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  })();
  const trail = demoParams.get("trail") ?? stored.trail;
  return {
    edge: parseEdge(stored.edge),
    sticky: stored.sticky !== false,
    follow: parseFollow(stored.follow),
    landing: parseLanding(stored.landing),
    cursor: parseCursor(stored.cursor),
    trail: parseTrail(trail),
  };
}
function saveChatOptions(): void {
  try {
    localStorage.setItem(
      OPTIONS_KEY,
      JSON.stringify({
        edge: edgeLoaderMode,
        sticky: stickyEnabled,
        follow: followMode,
        landing: landingMode,
        cursor: cursorMode,
        trail: trailMode,
      }),
    );
  } catch {
    // Storage may be unavailable; the session keeps its choices.
  }
}
const chatOptions = loadChatOptions();
let edgeLoaderMode: "slot" | "pill" = chatOptions.edge;
let stickyEnabled = chatOptions.sticky;
/** The follow and scroll inset under the sticky day header, when shown. */
const stickyInset = (): number => (stickyEnabled ? DAY_HEADER_HEIGHT : 0);
let followMode: FollowMode = chatOptions.follow;
let landingMode: LandingMode = chatOptions.landing;
let cursorMode: CursorMode = chatOptions.cursor;
let trailMode = chatOptions.trail;
const instantReplies =
  demoParams.has("instant") || demoParams.get("stream") === "instant";
const forceFastLongReply =
  demoParams.has("fast-long") || demoParams.get("stream") === "fast-long";
const viewport = mustGet("viewport");
const debugCompositing = demoParams
  .get("debug-compositing")
  ?.split(",")
  .filter((value) => ["no-message-layers", "no-canvas-layer"].includes(value));
if (debugCompositing?.length)
  viewport.dataset.debugCompositing = debugCompositing.join(" ");
const viewportWrap = viewport.parentElement as HTMLElement;
const promptInput = mustGet("prompt", HTMLTextAreaElement);
const largePasteDialog = mustGet("large-paste-dialog", HTMLDialogElement);
const largePasteAttach = mustGet("large-paste-attach", HTMLButtonElement);
let pendingPaste: {
  text: string;
  draft: string;
  start: number;
  end: number;
  epoch: number;
} | null = null;
const attachmentInput = mustGet("attachment-files", HTMLInputElement);
const attachBtn = mustGet("attach-btn", HTMLButtonElement);
const pendingAttachmentList = mustGet("pending-attachments", HTMLDivElement);
const attachmentStatus = mustGet("attachment-status", HTMLDivElement);
let pendingAttachments: ChatAttachment[] = [];
let readingAttachments = false;
let preparingConversation = false;
let attachmentEpoch = 0;
const sendBtn = mustGet("send-btn", HTMLButtonElement);
const scrollTopBtn = mustGet("scroll-top-btn", HTMLButtonElement);
const scrollBottomBtn = mustGet("scroll-bottom-btn", HTMLButtonElement);
const edgeLoaderSelect = mustGet("edge-loader-mode", HTMLSelectElement);
const autoscrollSelect = mustGet("autoscroll-mode", HTMLSelectElement);
const landingSelect = mustGet("landing-mode", HTMLSelectElement);
const cursorSelect = mustGet("cursor-mode", HTMLSelectElement);
const trailSelect = mustGet("trail-mode", HTMLSelectElement);
const windowStatus = mustGet("window-status");
const virtualListStatus = mustGet("virtual-list-status");
const composerMinHeight = Math.max(
  COMPOSER_FALLBACK_MIN_HEIGHT,
  promptInput.getBoundingClientRect().height,
);

let nextMessageId = 1;
let streamAbort: StreamAbort | null = null;
let nextResponse = 0;
let loadedStart = 0;
let loadedEnd = 0;
let latestPromptId: number | undefined;
let paging: PagedWindow<Message, number> | undefined;
let loadingTop = false;
let loadingBottom = false;
let sendGlideActive = false;
const htmlCache = new Map<string, string>();
// Live markdown-viewer instances for streaming rows, keyed by row element so
// remounts and replacements never collide; the runtime's onDestroy callback
// tears a viewer down when it is done with the element for good (a retained
// row that merely leaves the window keeps its viewer).
const streamingViewers = new WeakMap<HTMLElement, MessageContentHandle>();
// Row elements by message id, for the send animations. Pruned by the same
// onDestroy callback.
const rowById = new Map<string, HTMLElement>();
const expandedUserMessages = new Set<number>();
// The transcript is the *active path* through the message tree: the linear
// list the virtualizer renders. `messages` is the loaded window over its tail.
const transcript: Message[] = [];
let messages: Message[] = [];
// Bumped by in-place writes to `messages`; replacing the array needs none.
let messagesVersion = 0;
const transcriptIndexById = new Map<number, number>();

// Branching messages. Each turn is a tree node; a node's `childrenIds` are the
// versions that follow it (a regenerated response, an edited prompt) and
// `selectedChildIndex` marks the active one. Walking `selectedChildIndex` from
// the root sentinel yields the active path. Switching a version only rewrites
// the path from that node down — everything above keeps its keys, so the
// runtime's keyed renderer reuses the prefix DOM untouched.
interface TreeNode {
  message: Message | null; // null only for the root sentinel
  parentId: number;
  childrenIds: number[];
  selectedChildIndex: number;
}

// Message ids start at 1, so 0 is free for the root sentinel.
const TREE_ROOT_ID = 0;
const rootNode = (): TreeNode => ({
  message: null,
  parentId: TREE_ROOT_ID,
  childrenIds: [],
  selectedChildIndex: 0,
});
const tree = new Map<number, TreeNode>([[TREE_ROOT_ID, rootNode()]]);
let conversationTree: ReturnType<typeof createConversationTree> | undefined;
// Tree jumps and tail restoration share ownership of staged window changes.
let windowNavigation: AbortController | null = null;

function cancelWindowNavigation(): void {
  const navigation = windowNavigation;
  if (!navigation) return;
  windowNavigation = null;
  navigation.abort();
  latestPromptId = lastPromptId(transcript);
  if (!paging) resetPaging();
}

function refreshConversationTree(): void {
  windowNavigation?.abort();
  windowNavigation = null;
  // Structural operations finish updating the loaded window in this task.
  queueMicrotask(() => conversationTree?.refresh());
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

// A repeatable cursor demo: slow words with pauses long enough to blink.
const SLOW_RESPONSE: ReplyVariant = {
  markdown: at(BULK_RESPONSES, 0),
  thinkingDelayMs: 600,
  tokenDelayMs: { min: 90, max: 140 },
  pause: { everyWords: 8, durationMs: 2400 },
};

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
  // Imported IDs can be sparse or reach the safe-integer limit. Allocate
  // unused IDs without allowing a new version to overwrite an imported node.
  while (tree.has(nextMessageId)) {
    nextMessageId =
      nextMessageId === Number.MAX_SAFE_INTEGER ? 1 : nextMessageId + 1;
  }
  const id = nextMessageId;
  nextMessageId = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
  return { id, ...message };
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

/** The whole version tree with its selections; `toMessage` maps each message
 * and drops a node when it returns undefined. */
function treeSnapshot<M extends StoredTurn>(
  toMessage: (message: Message) => M | undefined,
): TranscriptTree<M> {
  return {
    selectedRootId:
      selectedChildId(tree.get(TREE_ROOT_ID) ?? rootNode()) ?? null,
    nodes: [...tree.entries()].flatMap(([id, node]) => {
      const message = node.message && toMessage(node.message);
      return message
        ? [
            {
              id,
              parentId: node.parentId,
              selectedChildId: selectedChildId(node) ?? null,
              message,
            },
          ]
        : [];
    }),
  };
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
  refreshConversationTree();
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
  return {
    index: parent.childrenIds.indexOf(messageId),
    count: parent.childrenIds.length,
  };
}

// New sends extend the active branch: each appended message becomes the
// selected child of the current leaf, keeping the tree and `transcript` in
// sync without a full rebuild.
function appendToActiveBranch(nextMessages: readonly Message[]): void {
  for (const message of nextMessages) {
    addTreeChild(activeLeafId(), message, { select: true });
    transcript.push(message);
  }
  refreshConversationTree();
}

function currentTreeMessage(): number | null {
  const inset = stickyInset();
  const top = viewport.scrollTop + inset;
  // Committed runtime positions, read only when the panel opens or scrolling
  // ends. No row layout reads and no new work in the scroll-frame path.
  for (const message of messages) {
    const position = virtualList?.positionOf(String(message.id));
    if (position && position.top + position.height > top) return message.id;
  }
  return null;
}

/** The row's visible response headings, in the order the tree lists them. */
function renderedHeadings(row: HTMLElement): HTMLElement[] {
  return Array.from(
    row.querySelectorAll<HTMLElement>(".message-content .markdown :is(h1, h2)"),
  ).filter((heading) => !heading.closest(".tool-calls, [hidden]"));
}

function currentTreeHeading(messageId: number): number | undefined {
  const row = virtualList?.elementOf(String(messageId));
  if (!row) return undefined;
  const headings = renderedHeadings(row);
  if (!headings.length) return undefined;
  // Read only on tree interaction or scroll end, never in the scroll frame.
  // The active section begins at the last heading above the reading edge.
  const top = viewport.getBoundingClientRect().top + stickyInset();
  let current: number | undefined;
  for (const [index, heading] of headings.entries()) {
    if (heading.getBoundingClientRect().top > top + 1) break;
    current = index;
  }
  return current;
}

// Selection semantics and runtime references: docs/conversation-tree-navigation.md.
async function scrollToTreeTarget(
  list: VirtualList<ChatRow>,
  messageId: number,
  headingIndex?: number,
): Promise<boolean> {
  const key = String(messageId);
  const inset = stickyInset();
  const epoch = conversationEpoch;
  const reached = await list.scrollTo(key, { behavior: "auto", offset: inset });
  if (!reached || headingIndex === undefined) return reached;
  if (epoch !== conversationEpoch || streamAbort) return false;
  const row = list.elementOf(key);
  const heading = row && renderedHeadings(row)[headingIndex];
  if (!row || !heading) return false;
  // One click-time measurement within the mounted row. The runtime owns
  // the scroll destination, clamping, and reserve; this requests no pin.
  const withinRow =
    heading.getBoundingClientRect().top - row.getBoundingClientRect().top;
  return list.scrollTo(key, { behavior: "auto", offset: inset - withinRow });
}

async function navigateTreeMessage(
  messageId: number,
  headingIndex?: number,
): Promise<boolean> {
  const list = virtualList;
  if (
    !list ||
    streamAbort ||
    preparingConversation ||
    !tree.get(messageId)?.message
  )
    return false;
  cancelUserEdit();
  cancelWindowNavigation();
  const activeIndex = transcriptIndexById.get(messageId);
  if (
    activeIndex !== undefined &&
    activeIndex >= loadedStart &&
    activeIndex < loadedEnd &&
    !(activeIndex === 0 && edgeSlotRequested)
  ) {
    return scrollToTreeTarget(list, messageId, headingIndex);
  }
  const controller = new AbortController();
  windowNavigation = controller;
  // Invalidate any older fetch before it can supersede this explicit jump.
  const epoch = ++conversationEpoch;
  activeLoad = null;
  loadingTop = false;
  paging?.dispose();
  paging = undefined;
  setEdgeState("hidden");
  setBottomLoading(false);
  const ancestors: number[] = [];
  let id = messageId;
  while (id !== TREE_ROOT_ID) {
    const node = tree.get(id);
    if (!node) return false;
    ancestors.push(id);
    id = node.parentId;
  }
  ancestors.reverse();
  const path = [...ancestors];
  let tail = tree.get(messageId);
  while (tail) {
    const childId = selectedChildId(tail);
    if (childId === undefined) break;
    path.push(childId);
    tail = tree.get(childId);
  }
  const nextTranscript = path.flatMap((key) => {
    const message = tree.get(key)?.message;
    return message ? [message] : [];
  });
  const branchChanged =
    path.length !== transcript.length ||
    path.some((key, index) => transcript[index]?.id !== key);
  const { start: nextStart, end: nextEnd } = windowAround(
    ancestors.length - 1,
    nextTranscript.length,
  );
  const previousPin = latestPromptId;
  latestPromptId = lastPromptId(nextTranscript);
  const needsScrollbackSlot = edgeLoaderMode === "slot" && nextStart > 0;
  try {
    const committed = await list.updateWindow(
      () => {
        if (epoch !== conversationEpoch || controller.signal.aborted)
          return null;
        return {
          items: rowsForTreeNavigation(nextTranscript, nextStart, nextEnd),
          edgeSlots: {
            start: needsScrollbackSlot ? edgeSlotSpec : null,
            end:
              edgeLoaderMode === "slot" && nextEnd < nextTranscript.length
                ? bottomEdgeSlotSpec
                : null,
          },
          // Stage the branch without forcing the selected row to the top:
          // an explicit keyed anchor can create trailing reserve even when
          // the subsequent scrollTo omits align/pin. Navigation below
          // owns selection; the snapshot only preserves the current view.
          anchor: "viewport",
          onCommit: () => {
            let parentId = TREE_ROOT_ID;
            for (const childId of ancestors) {
              const parent = tree.get(parentId);
              if (parent)
                parent.selectedChildIndex = parent.childrenIds.indexOf(childId);
              parentId = childId;
            }
            transcript.length = 0;
            transcript.push(...nextTranscript);
            loadedStart = nextStart;
            loadedEnd = nextEnd;
            topBoundaryLoadSeen = false;
            edgeSlotRequested = needsScrollbackSlot;
            if (!needsScrollbackSlot) edgeSlotElement = null;
            bottomEdgeSlotRequested =
              edgeLoaderMode === "slot" && nextEnd < nextTranscript.length;
            if (!bottomEdgeSlotRequested) bottomEdgeSlotElement = null;
            refreshLoadedWindow();
            resetPaging();
            stickyHeaders?.refresh();
            if (branchChanged) {
              markConversationChanged();
              if (getAISettings().provider !== "simulated")
                persistOpenAIConversation();
              else persistSimulatedBranchSelection();
            }
            syncMetrics();
          },
        };
      },
      controller.signal,
      { interrupt: true },
    );
    if (
      !committed ||
      controller.signal.aborted ||
      epoch !== conversationEpoch ||
      windowNavigation !== controller
    ) {
      if (epoch === conversationEpoch && windowNavigation === controller)
        latestPromptId = previousPin;
      return false;
    }
    return await scrollToTreeTarget(list, messageId, headingIndex);
  } finally {
    if (windowNavigation === controller) {
      windowNavigation = null;
      if (epoch === conversationEpoch && !paging) {
        latestPromptId = previousPin;
        resetPaging();
      }
    }
  }
}

// --- The loaded window and the virtualizer bridge ---------------------------

// Nominal average row height for sizing scrollback chunks (data windowing
// only; the runtime never estimates — it measures every row before it
// commits).
const NOMINAL_ROW_HEIGHT = 200;

function loadChunkCount(): number {
  return Math.max(
    20,
    Math.ceil(
      (viewport.clientHeight * DATA_WINDOW_FACTOR) / NOMINAL_ROW_HEIGHT,
    ),
  );
}

function canLoadOlderMessages(): boolean {
  return loadedStart > 0;
}

function pageSize(): number {
  return Math.ceil(loadChunkCount() / MESSAGES_PER_DAY) * MESSAGES_PER_DAY;
}

function lastPromptId(items: readonly Message[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const message = items[index];
    if (message?.role === "user") return message.id;
  }
  return undefined;
}

// Source-window selection for explicit navigation, not viewport correction.
/** The loaded window around `index`: a day-aligned page before, three pages long. */
function windowAround(
  index: number,
  length: number,
): { start: number; end: number } {
  const page = pageSize();
  const before = Math.max(0, index - page);
  const start = before - (before % MESSAGES_PER_DAY);
  return { start, end: Math.min(length, start + page * 3) };
}

function selectWindowAround(index: number): void {
  ({ start: loadedStart, end: loadedEnd } = windowAround(
    index,
    transcript.length,
  ));
}

function sourcePage(
  start: number,
  end = Math.min(transcript.length, start + pageSize()),
): Page<Message, number> {
  return {
    items: transcript.slice(start, end),
    start:
      start > 0 ? { available: true, cursor: start } : { available: false },
    end:
      end < transcript.length
        ? { available: true, cursor: end }
        : { available: false },
  };
}

function reportPagingError(error: unknown): void {
  console.error("Could not update paged messages.", error);
}

function resetPaging(): void {
  paging?.dispose();
  paging = undefined;
  setBottomLoading(false);
  const list = virtualList;
  if (!list) return;
  const epoch = conversationEpoch;
  const retainedKeys = new Set(messages.map((message) => String(message.id)));
  for (const key of htmlCache.keys()) {
    if (!retainedKeys.has(key)) htmlCache.delete(key);
  }
  paging = createPagedWindow({
    list,
    initial: sourcePage(loadedStart, loadedEnd),
    maxItems: pageSize() * 3,
    trim: { offscreenPin: "evict" },
    key: (message) => String(message.id),
    project: rowsForRuntime,
    live: { project: (message) => message, key: rowKey },
    keysOf: (row) => {
      if (!isDayHeader(row)) return [String(row.id)];
      // A separator belongs to the first retained source message of its run.
      const first = messages.find(
        (message) =>
          (dayRunStartById.get(message.id) ?? message.id) === row.runStart,
      );
      return first ? [String(first.id)] : [];
    },
    load: async ({ edge, cursor, signal }) => {
      await new Promise<void>((resolve) => {
        const finish = () => {
          window.clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = window.setTimeout(finish, LOAD_OLDER_DELAY_MS);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
      // A start cursor is the retained boundary, not an old page's size.
      // Rotation can change pageSize() between fetches; always end the
      // previous page at that boundary so history stays contiguous.
      return edge === "start"
        ? sourcePage(Math.max(0, cursor - pageSize()), cursor)
        : sourcePage(cursor);
    },
    edgeSlots: ({ start, end }) => ({
      start:
        edgeLoaderMode === "slot" && (start.available || topBoundaryLoadSeen)
          ? edgeSlotSpec
          : null,
      end:
        edgeLoaderMode === "slot" && end.available ? bottomEdgeSlotSpec : null,
    }),
    onChange: (items) => {
      if (epoch !== conversationEpoch) return;
      messages = [...items];
      loadedStart = transcriptIndexById.get(items[0]?.id ?? -1) ?? 0;
      loadedEnd = loadedStart + items.length;
      // The archive may receive final tokens after a reload was fetched but
      // before it committed. Reconcile source freshness, not scroll geometry.
      for (const [index, message] of items.entries()) {
        const current = tree.get(message.id)?.message;
        if (current && current !== message) {
          messages[index] = current;
          messagesVersion++;
          void paging
            ?.updateItemLive(String(message.id), () => current)
            .catch(reportPagingError);
        }
      }
      edgeSlotRequested = shouldMountEdgeSlot();
      bottomEdgeSlotRequested = shouldMountBottomEdgeSlot();
      if (!bottomEdgeSlotRequested) bottomEdgeSlotElement = null;
      stickyHeaders?.refresh();
      conversationTree?.refreshLoaded();
      syncMetrics();
      syncScrollButtons(list.state);
    },
    onEvict: (items) => {
      for (const message of items) htmlCache.delete(String(message.id));
    },
  });
}

// Recomputes `messages` (the window handed to the virtualizer — always the
// retained interval) and the id → transcript index lookup.
let refreshMessageId: number | undefined;
const dayRunStartById = new Map<number, number>();

function refreshLoadedWindow(): void {
  const last = transcript.at(-1);
  const nextRefreshId = last?.role === "assistant" ? last.id : undefined;
  if (nextRefreshId !== refreshMessageId) {
    // Action eligibility is part of row rendering: invalidate both endpoints
    // so the virtualizer also measures the footer appearing/disappearing.
    for (let i = 0; i < transcript.length; i++) {
      const message = transcript[i];
      if (
        message &&
        (message.id === refreshMessageId || message.id === nextRefreshId)
      ) {
        // A staged tree snapshot is rendered before onCommit updates this
        // flag. Refresh retained/prepared footers too; visibility is paint
        // only, so it does not invalidate the runtime's measured geometry.
        rowById
          .get(String(message.id))
          ?.querySelector(".message-actions")
          ?.toggleAttribute("data-latest", message.id === nextRefreshId);
        const next = { ...message };
        transcript[i] = next;
        const node = tree.get(message.id);
        if (node) node.message = next;
      }
    }
    refreshMessageId = nextRefreshId;
  }
  loadedStart = Math.min(Math.max(0, loadedStart), transcript.length);
  // The window starts on a day boundary: a scrollback load then prepends
  // whole days above the first loaded day's header, never between a header
  // and its messages.
  loadedStart -= loadedStart % MESSAGES_PER_DAY;
  loadedEnd = Math.max(loadedStart, Math.min(loadedEnd, transcript.length));
  messages = transcript.slice(loadedStart, loadedEnd);
  latestPromptId = lastPromptId(transcript);
  transcriptHasDates = hasDates(transcript);
  transcriptIndexById.clear();
  for (const [index, message] of transcript.entries())
    transcriptIndexById.set(message.id, index);
  dayRunStartById.clear();
  const runs = dayRuns(transcript, dayOf);
  for (const [index, message] of transcript.entries())
    dayRunStartById.set(message.id, at(runs, index).runStart);
  conversationTree?.refreshLoaded();
}

// Assigned at boot; callbacks that can fire during the boot transaction
// (onReachStart on a short conversation) must tolerate it being unset.
let virtualList: VirtualList<ChatRow> | undefined;
// Assigned right after the list; onState may fire before then.
let stickyHeaders: StickyHeaders | undefined;

// --- Day separators --------------------------------------------------------

const dayHeaders = new Map<string, DayHeader>();
let labeledFor = "";
let transcriptHasDates = false;

// Two kinds of day share one number space, ordered along the transcript:
// - a dated message (including the built-in sample) belongs to its calendar day, keyed
//   by that day's local midnight in epoch ms;
// - an undated message belongs to a synthetic bucket of MESSAGES_PER_DAY
//   consecutive messages (an undated import), or — in a dated
//   conversation whose older turns were stored before dates existed — to
//   one "Earlier" day that precedes every dated one.
const DAY_MS = 86_400_000;
const UNDATED_DAY = -1;

function localMidnight(when: number): number {
  const date = new Date(when);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

function isDatedDay(day: number): boolean {
  return day >= DAY_MS;
}

function hasDates(path: readonly Message[]): boolean {
  return path.some((message) => message.sentAt !== undefined);
}

/** Real providers date their messages; so does any conversation with a date. */
function isDatedConversation(pathHasDates: boolean): boolean {
  return getAISettings().provider !== "simulated" || pathHasDates;
}

/**
 * The day of `message` at `index` in its path. Keep an exchange together
 * when an old prompt gets a fresh reply: a prompt takes its selected reply's
 * day without rewriting its own timestamp, so returning to an older version
 * restores its original day.
 */
function messageDay(
  message: Message,
  reply: Message | null | undefined,
  index: number,
  dated: boolean,
): number {
  const replySentAt =
    message.role === "user" && reply?.role === "assistant"
      ? reply.sentAt
      : undefined;
  const sentAt = replySentAt ?? message.sentAt;
  if (sentAt !== undefined) return localMidnight(sentAt);
  return dated ? UNDATED_DAY : Math.floor(index / MESSAGES_PER_DAY);
}

/** Each message's day, and the id of the first message of its day run. */
function dayRuns(
  path: readonly Message[],
  dayAt: (message: Message, index: number) => number,
): { day: number; runStart: number }[] {
  let previousDay: number | undefined;
  let runStart = 0;
  return path.map((message, index) => {
    const day = dayAt(message, index);
    if (day !== previousDay) runStart = message.id;
    previousDay = day;
    return { day, runStart };
  });
}

function dayOf(message: Message): number {
  const node = message.role === "user" ? tree.get(message.id) : undefined;
  const replyId = node && selectedChildId(node);
  return messageDay(
    message,
    replyId === undefined ? undefined : tree.get(replyId)?.message,
    transcriptIndexOf(message),
    isDatedConversation(transcriptHasDates),
  );
}

function lastDay(): number {
  return Math.max(0, Math.floor((transcript.length - 1) / MESSAGES_PER_DAY));
}

function relativeDayLabel(back: number, date: Date): string {
  if (back === 0) return "Today";
  if (back === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function dayLabel(day: number, finalDay = lastDay()): string {
  if (day === UNDATED_DAY) return "Earlier";
  if (isDatedDay(day)) {
    const back = Math.round((localMidnight(Date.now()) - day) / DAY_MS);
    return relativeDayLabel(back, new Date(day));
  }
  const back = finalDay - day;
  const date = new Date();
  date.setDate(date.getDate() - back);
  return relativeDayLabel(back, date);
}

/** Header objects are cached per contiguous day run so their identity is stable across
 * snapshots; labels are relative to the last synthetic day and to today, so
 * a new day re-labels. */
function dayHeader(day: number, firstMessage: Message): DayHeader {
  const labelBasis = `${lastDay()}:${localMidnight(Date.now())}`;
  if (labeledFor !== labelBasis) {
    dayHeaders.clear();
    labeledFor = labelBasis;
  }
  // The loaded window can begin inside a run. Use its true first message
  // so prepending older messages does not change the existing header key.
  const runStart = dayRunStartById.get(firstMessage.id) ?? firstMessage.id;
  const key = `${day}:${runStart}`;
  let header = dayHeaders.get(key);
  if (!header) {
    header = { kind: "day", day, runStart, label: dayLabel(day) };
    dayHeaders.set(key, header);
  }
  return header;
}

/** The loaded window with a day separator before each day's first message. */
function rowsForRuntime(
  windowMessages: readonly Message[] = messages,
): ChatRow[] {
  const rows: ChatRow[] = [];
  let current: number | undefined;
  for (const message of windowMessages) {
    const day = dayOf(message);
    if (day !== current) {
      current = day;
      rows.push(dayHeader(day, message));
    }
    rows.push(message);
  }
  return rows;
}

// A staged branch is not the active transcript yet. Derive its day runs
// from that snapshot without changing the still-interactive old branch.
function rowsForTreeNavigation(
  path: readonly Message[],
  start: number,
  end = path.length,
): ChatRow[] {
  const rows: ChatRow[] = [];
  const dated = isDatedConversation(hasDates(path));
  const finalDay = Math.max(
    0,
    Math.floor((path.length - 1) / MESSAGES_PER_DAY),
  );
  const runs = dayRuns(path, (message, index) =>
    messageDay(message, path[index + 1], index, dated),
  );
  for (let index = start; index < Math.min(end, path.length); index++) {
    const message = at(path, index);
    const { day, runStart } = at(runs, index);
    if (runStart === message.id || index === start)
      rows.push({ kind: "day", day, runStart, label: dayLabel(day, finalDay) });
    rows.push(message);
  }
  return rows;
}

// The sticky header asks for these on every mounted-range change while
// scrolling. Rebuild them only when the loaded messages, the dating mode, or
// the label day change, not per message on every ask.
let dayHeaderCache: {
  source: Message[];
  version: number;
  basis: string;
  rows: DayHeader[];
  keys: string[];
} | null = null;

function cachedDayHeaders(): { rows: DayHeader[]; keys: string[] } {
  const basis = `${lastDay()}:${localMidnight(Date.now())}:${transcriptHasDates}:${getAISettings().provider}`;
  const cache = dayHeaderCache;
  if (
    cache?.source === messages &&
    cache.version === messagesVersion &&
    cache.basis === basis
  )
    return cache;
  const rows = rowsForRuntime().filter(isDayHeader);
  dayHeaderCache = {
    source: messages,
    version: messagesVersion,
    basis,
    rows,
    keys: rows.map(rowKey),
  };
  return dayHeaderCache;
}

function dayHeaderRows(): DayHeader[] {
  return cachedDayHeaders().rows;
}

function dayHeaderKeys(): string[] {
  return cachedDayHeaders().keys;
}

/** Submit a snapshot for conversation changes; scrollback uses updateWindow.
 * Returns the number of rows handed over (day separators included). */
function pushItems(anchor?: AnchorRequest, interrupt = false): number {
  paging?.dispose();
  paging = undefined;
  refreshLoadedWindow();
  syncEdgeSlot();
  const rows = rowsForRuntime();
  virtualList?.setItems(rows, { anchor, interrupt });
  resetPaging();
  return rows.length;
}

// The single mutation path: clones the message (the runtime re-renders rows
// whose item identity changed), writes the clone back into the tree,
// transcript, and window, and updates only that runtime row.
function updateMessage(id: number, mutate: (message: Message) => void): void {
  const node = tree.get(id);
  if (!node?.message) return;
  const previousDay = dayOf(node.message);
  const next = { ...node.message };
  mutate(next);
  node.message = next;
  const index = transcriptIndexById.get(id);
  if (index !== undefined) transcript[index] = next;
  htmlCache.delete(String(id));
  if (dayOf(next) !== previousDay) {
    pushItems();
  } else if (index !== undefined && index >= loadedStart && index < loadedEnd) {
    messages[index - loadedStart] = next;
    messagesVersion++;
    void paging
      ?.updateItemLive(rowKey(next), () => next)
      .catch(reportPagingError);
  }
}

// --- Scrollback loading (an in-flow edge slot by default, a pill overlay) ---

// Whether a top load has ever run for the current conversation — a fresh
// conversation with nothing above must not flash "At the top".
let topBoundaryLoadSeen = false;
let edgeHideTimer = 0;

const edgeOverlay = document.createElement("div");
edgeOverlay.className = "edge-overlay";
edgeOverlay.dataset.state = "hidden";
const edgePill = document.createElement("div");
edgePill.className = "edge-pill";
edgePill.setAttribute("role", "status");
const edgeSpinner = document.createElement("span");
edgeSpinner.className = "boundary-spinner";
edgeSpinner.setAttribute("aria-hidden", "true");
const edgeLabel = document.createElement("span");
edgePill.append(edgeSpinner, edgeLabel);
edgeOverlay.appendChild(edgePill);
viewportWrap.appendChild(edgeOverlay);

const bottomEdgeOverlay = edgeOverlay.cloneNode(true) as HTMLElement;
bottomEdgeOverlay.classList.add("edge-overlay-end");
const bottomEdgeLabel = (() => {
  const label = bottomEdgeOverlay.querySelector(".edge-pill")?.lastElementChild;
  if (!label) throw new Error("Bottom loading label missing");
  return label;
})();
viewportWrap.appendChild(bottomEdgeOverlay);

type EdgeState = "hidden" | "loading" | "no-more";
let edgeState: EdgeState = "hidden";

function edgeLabelFor(state: EdgeState): string {
  return state === "loading"
    ? "Loading older messages"
    : state === "no-more"
      ? "No older messages"
      : "";
}

// --- The in-flow scrollback slot (edge loader "slot" mode) -------------------

let edgeSlotElement: HTMLElement | null = null;
let edgeSlotRequested = false;
let bottomEdgeSlotElement: HTMLElement | null = null;
let bottomEdgeSlotRequested = false;

function createBoundarySlot(): HTMLElement {
  const element = document.createElement("div");
  element.className = "boundary-slot";
  element.setAttribute("role", "status");
  const spinner = document.createElement("span");
  spinner.className = "boundary-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "boundary-slot-label";
  element.append(spinner, label);
  return element;
}

function applyBottomSlotState(element: HTMLElement): void {
  element.dataset.state = loadingBottom ? "loading" : "idle";
  const label = element.querySelector(".boundary-slot-label");
  if (label) label.textContent = loadingBottom ? "Loading newer messages" : "";
}

const bottomEdgeSlotSpec: EdgeSlot = {
  key: "scrollforward",
  height: EDGE_SLOT_HEIGHT,
  render: () => {
    const element = createBoundarySlot();
    element.dataset.edge = "end";
    applyBottomSlotState(element);
    bottomEdgeSlotElement = element;
    return element;
  },
};

function shouldMountBottomEdgeSlot(): boolean {
  return (
    edgeLoaderMode === "slot" &&
    messages.length > 0 &&
    loadedEnd < transcript.length
  );
}

/** Slot spinners take their angle from the wrapper while a load runs. */
function syncEdgeLoading(): void {
  viewportWrap.toggleAttribute(
    "data-edge-loading",
    edgeState === "loading" || loadingBottom,
  );
}

function setBottomLoading(loading: boolean): void {
  loadingBottom = loading;
  syncEdgeLoading();
  if (bottomEdgeSlotElement) applyBottomSlotState(bottomEdgeSlotElement);
  bottomEdgeOverlay.dataset.state =
    loading && edgeLoaderMode === "pill" ? "loading" : "hidden";
  bottomEdgeLabel.textContent = loading ? "Loading newer messages" : "";
}

function applyEdgeSlotState(element: HTMLElement, state: EdgeState): void {
  // In the flow, "hidden" is an invisible strip; "At the
  // top" stays until the conversation changes.
  element.dataset.state = state === "hidden" ? "idle" : state;
  const label = element.querySelector<HTMLElement>(".boundary-slot-label");
  if (label) label.textContent = edgeLabelFor(state);
}

const edgeSlotSpec: EdgeSlot = {
  key: "scrollback",
  height: EDGE_SLOT_HEIGHT,
  render: () => {
    const element = createBoundarySlot();
    applyEdgeSlotState(element, edgeState);
    edgeSlotElement = element;
    return element;
  },
};

// The slot exists to serve scrollback. A conversation whose top is loaded
// from the start (a fresh OpenAI chat) must not mount it: its strip would
// sit above the first message and turn the first send's pin into a visible
// hop. Once a top load has run, the slot stays for its "At the top" state.
function shouldMountEdgeSlot(): boolean {
  if (edgeLoaderMode !== "slot" || messages.length === 0) return false;
  return loadedStart > 0 || loadingTop || topBoundaryLoadSeen;
}

/** Mount or unmount the slot when its need changes (a structural change). */
function syncEdgeSlot(): void {
  const wanted = shouldMountEdgeSlot();
  if (wanted !== edgeSlotRequested) {
    edgeSlotRequested = wanted;
    if (!wanted) edgeSlotElement = null;
    virtualList?.setEdgeSlot("start", wanted ? edgeSlotSpec : null);
  }
  const bottomWanted = shouldMountBottomEdgeSlot();
  if (bottomWanted !== bottomEdgeSlotRequested) {
    bottomEdgeSlotRequested = bottomWanted;
    if (!bottomWanted) bottomEdgeSlotElement = null;
    virtualList?.setEdgeSlot("end", bottomWanted ? bottomEdgeSlotSpec : null);
  }
}

function setEdgeState(state: EdgeState): void {
  window.clearTimeout(edgeHideTimer);
  edgeHideTimer = 0;
  edgeState = state;
  syncEdgeLoading();
  if (edgeLoaderMode === "slot") {
    // In place, at the slot's fixed height: no structural change.
    if (edgeSlotElement) applyEdgeSlotState(edgeSlotElement, state);
    return;
  }
  edgeOverlay.dataset.state = state;
  edgeLabel.textContent = edgeLabelFor(state);
  if (state === "no-more") {
    edgeHideTimer = window.setTimeout(
      () => setEdgeState("hidden"),
      EDGE_NO_MORE_HIDE_MS,
    );
  }
}

function syncEdgeLoaderMode(): void {
  syncEdgeSlot();
  setBottomLoading(loadingBottom);
  const inFlow = edgeLoaderMode === "slot";
  edgeLoaderSelect.value = edgeLoaderMode;
  edgeOverlay.dataset.state = inFlow ? "hidden" : edgeState;
  edgeLabel.textContent = edgeLabelFor(edgeState);
  if (edgeSlotElement) applyEdgeSlotState(edgeSlotElement, edgeState);
}

function scheduleEdgeHide(): void {
  window.clearTimeout(edgeHideTimer);
  edgeHideTimer = window.setTimeout(
    () => setEdgeState("hidden"),
    EDGE_HIDE_LINGER_MS,
  );
}

// The in-flight scrollback load, so concurrent reach-start signals share
// one load instead of racing.
let activeLoad: Promise<void> | null = null;
// Loads one older chunk; resolves once the prepend has actually been
// COMMITTED by the runtime — which may hold it until the active scroll
// phase settles. The prepend preserves the reading position (I1), and the
// runtime re-arms the reach-start signal once the viewport is past the
// exit zone.
// Called by loadOlderMessages alone, which has already checked that no load
// is active and that older messages remain.
function loadOlderChunk(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  loadingTop = true;
  topBoundaryLoadSeen = true;
  setEdgeState("loading");
  syncMetrics();

  const epoch = conversationEpoch;
  const load = (
    paging?.load("start", { signal, complete: () => {} }) ??
    Promise.resolve(false)
  )
    .then(() => {})
    .finally(() => {
      if (activeLoad !== load) return;
      activeLoad = null;
      if (epoch === conversationEpoch) {
        loadingTop = false;
        // History exhausted: the in-flow slot keeps its marker at the top
        // of the conversation, where it belongs; the floating pill would
        // announce it over whatever the user is reading (the load kept
        // their place), so it only hides — the marker shows at the top.
        if (!canLoadOlderMessages() && edgeLoaderMode === "slot") {
          setEdgeState("no-more");
        } else if (!canLoadOlderMessages()) {
          setEdgeState("hidden");
        } else {
          scheduleEdgeHide(); // Linger: the next chunk may follow at once.
        }
        syncMetrics();
      }
    });
  activeLoad = load;
  return load;
}

// Fetch during scrolling; prepare and commit through the runtime's idle
// window-update queue. The loader stays visible until that commit completes.
function loadOlderMessages({ signal, complete }: ReachContext): void {
  if (windowNavigation) {
    complete();
    return;
  }
  if (activeLoad) {
    complete();
    return;
  }
  if (!canLoadOlderMessages()) {
    complete();
    if (topBoundaryLoadSeen) setEdgeState("no-more");
    return;
  }
  void loadOlderChunk(signal)
    .catch((error: unknown) => {
      console.error("Could not load older messages.", error);
    })
    .finally(complete);
}

function loadNewerMessages(context: ReachContext): void {
  const owner = paging;
  if (
    !owner ||
    windowNavigation ||
    owner.loading ||
    !owner.canLoad("end") ||
    context.signal.aborted
  ) {
    context.complete();
    return;
  }
  setBottomLoading(true);
  syncMetrics();
  // Keep the indicator until the fetched page commits, including time held
  // behind a native gesture. Never insert a new slot under that gesture.
  void owner
    .load("end", { signal: context.signal, complete: () => {} })
    .catch(reportPagingError)
    .finally(() => {
      if (paging === owner) {
        setBottomLoading(false);
        syncMetrics();
      }
      context.complete();
    });
}

// --- Conversations ----------------------------------------------------------

// Synthetic branches seeded onto the tail so version switching is testable
// without first having to edit or regenerate anything.
const BRANCH_BRIDGE_REPLY =
  "Sure — what would you like to dig into next? I can compare rendering strategies, walk through the windowing math, or sketch an API.";
const BRANCH_USER_V1 = `Can you summarize the trade-offs between **virtual scrolling** and **pagination** for a long chat log?

Here is the context for our project: conversations can run for months, and people often return to an earlier message while a new response is still streaming. Some prompts are only a sentence, but others contain a complete project brief like this one.

Please consider these requirements:

- Keep scrolling natural on desktop, iPhone, and iPad.
- Let readers expand long prompts without losing their place.
- Preserve the full original text when editing, copying, or exporting a chat.
- Make it easy to switch between edited prompts and regenerated replies.
- Keep memory bounded even when the conversation contains thousands of messages.

Finish with a recommendation for a small team and explain which implementation details you would prioritize first.`;
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

function createTemplateMessages(
  count: number,
  timestampForIndex: (index: number) => number,
): Message[] {
  const start = transcript.length;
  const nextMessages: Message[] = [];
  for (let offset = 0; offset < count; offset++) {
    const templateId = (start + offset) % conversation.length;
    const sample = at(conversation, templateId);
    nextMessages.push(
      createMessage({ ...sample, sentAt: timestampForIndex(start + offset) }),
    );
  }
  return nextMessages;
}

// Builds the linear spine from the conversation template, then grafts on the
// synthetic version branches above. The active path becomes the transcript.
function seedConversationTree(count: number): void {
  const bridge =
    at(conversation, (count - 1) % conversation.length).role === "user";
  const lastIndex = count + (bridge ? 2 : 1);
  const now = Date.now();
  const timestampForIndex = (index: number): number =>
    sampleTimestamp(index, lastIndex, now);
  for (const message of createTemplateMessages(count, timestampForIndex)) {
    addTreeChild(activeLeafId(), message, { select: true });
  }
  seedSyntheticBranches(count, timestampForIndex);
}

function seedSyntheticBranches(
  nextIndex: number,
  timestampForIndex: (index: number) => number,
): void {
  // A user prompt has to follow an assistant turn; bridge if the spine ended
  // on a user message so the seeded turn always reads naturally.
  let anchorId = activeLeafId();
  if (tree.get(anchorId)?.message?.role === "user") {
    anchorId = addTreeChild(
      anchorId,
      createMessage({
        role: "assistant",
        markdown: BRANCH_BRIDGE_REPLY,
        sentAt: timestampForIndex(nextIndex++),
      }),
      { select: true },
    );
  }

  // Edit scenario: one prompt, two versions, each with its own reply branch.
  const userSentAt = timestampForIndex(nextIndex++);
  const replySentAt = timestampForIndex(nextIndex);
  const userV1 = createMessage({
    role: "user",
    markdown: BRANCH_USER_V1,
    sentAt: userSentAt,
  });
  const userV2 = createMessage({
    role: "user",
    markdown: BRANCH_USER_V2,
    sentAt: userSentAt,
  });
  addTreeChild(anchorId, userV1, { select: true });
  addTreeChild(anchorId, userV2, { select: false });

  // userV2 → a single reply.
  addTreeChild(
    userV2.id,
    createMessage({
      role: "assistant",
      markdown: BRANCH_REPLY_V2,
      sentAt: replySentAt,
    }),
    { select: true },
  );

  // userV1 → a reply with three regenerations (the regenerate scenario).
  BRANCH_REGEN_REPLIES.forEach((markdown, index) => {
    addTreeChild(
      userV1.id,
      createMessage({ role: "assistant", markdown, sentAt: replySentAt }),
      {
        select: index === 0,
      },
    );
  });
}

// Each provider owns a separate persisted conversation. The simulated side
// seeds its template only when no saved history exists or Restore is requested.
// Bumped on every conversation swap so an in-flight send's finally block can
// tell it is finishing against a conversation that no longer exists — its
// persistence must not write the other provider's transcript into the history.
let conversationEpoch = 0;

function resetConversationState(): void {
  paging?.dispose();
  paging = undefined;
  setBottomLoading(false);
  userEdit = null;
  expandedUserMessages.clear();
  conversationEpoch++;
  // An old load's promise may finish after the replacement runtime mounts.
  // Its identity/epoch guards must not clear or block the new chat's loader.
  activeLoad = null;
  topBoundaryLoadSeen = false;
  tree.clear();
  tree.set(TREE_ROOT_ID, rootNode());
  transcript.length = 0;
  loadedStart = 0;
  loadedEnd = 0;
  loadingTop = false;
  htmlCache.clear();
  // Message ids restart, so a stale entry would mark a new chat's message.
  freshStreams.clear();
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

// The seed-time snapshot of the persisted history. Seeding is synchronous, so
// the async IndexedDB read happens up front — at boot and before a provider
// switch — into this cache; an import replaces it outright.
let openAIHistory: readonly StoredTurn[] = [];
let openAIHistoryTree: TranscriptTree | null = null;
// The latest saved or imported simulated conversation, including all versions.
let importedConversation: ImportedTranscript | null = null;
let simulatedNextResponse = 0;
let simulatedConversationChanged = false;
let userEdit: { id: number; epoch: number; text: string } | null = null;

function markConversationChanged(): void {
  if (getAISettings().provider === "simulated")
    simulatedConversationChanged = true;
}

async function prepareSimulatedConversation(): Promise<void> {
  const history = await loadSimulatedHistory();
  if (!history) return;
  try {
    const parsed = history.tree
      ? selectTranscriptBranches(history.tree, history.tree)
      : parseBranchingTranscript(history.markdown);
    if (!parsed) return;
    const imported =
      parsed.tree && history.selection
        ? (selectTranscriptBranches(parsed.tree, history.selection) ?? parsed)
        : parsed;
    await loadLanguages(
      historyFenceLanguages(
        imported.tree?.nodes.map((node) => node.message) ?? imported.turns,
      ),
    );
    importedConversation = imported;
    simulatedNextResponse = history.nextResponse;
    simulatedConversationChanged = history.changed;
  } catch {
    // An invalid saved transcript must not prevent the demo from opening.
  }
}

function persistSimulatedConversation(): void {
  if (getAISettings().provider !== "simulated") return;
  // These messages are already validated. Keep a structured snapshot instead
  // of exporting and reparsing every body and embedded image on each send.
  const snapshot = treeSnapshot(
    (message) => storedConversation([message], true)[0],
  );
  importedConversation = {
    tree: snapshot,
    turns: storedConversation(transcript, true),
  };
  simulatedNextResponse = nextResponse;
  saveSimulatedHistory({
    tree: snapshot,
    nextResponse,
    changed: simulatedConversationChanged,
  });
}

function persistSimulatedBranchSelection(): void {
  if (getAISettings().provider !== "simulated") return;
  const { selectedRootId, nodes } = treeSnapshot((message) => message);
  const selection: TranscriptSelection = {
    selectedRootId,
    nodes: nodes.map(({ id, selectedChildId }) => ({ id, selectedChildId })),
  };
  const selected = importedConversation?.tree
    ? selectTranscriptBranches(importedConversation.tree, selection)
    : null;
  if (
    !selected ||
    !saveSimulatedSelection(
      selection,
      nextResponse,
      simulatedConversationChanged,
    )
  ) {
    persistSimulatedConversation();
    return;
  }
  importedConversation = selected;
  simulatedNextResponse = nextResponse;
}

// Loads the history snapshot and the fence languages its static render needs
// (loadLanguages ignores unknown names, so the raw info strings are safe to
// feed through).
async function prepareOpenAIConversation(
  epoch = conversationEpoch,
): Promise<boolean> {
  const history = await loadOpenAIConversation();
  if (epoch !== conversationEpoch) return false;
  const languages = historyFenceLanguages(
    history.tree?.nodes.map((node) => node.message) ?? history.turns,
  );
  if (languages.length > 0) await loadLanguages(languages);
  if (epoch !== conversationEpoch) return false;
  openAIHistory = history.turns;
  openAIHistoryTree = history.tree;
  return true;
}

function seedStoredTurns(turns: readonly StoredTurn[]): void {
  for (const turn of turns) {
    addTreeChild(
      activeLeafId(),
      createMessage({
        role: turn.role,
        markdown: turn.markdown,
        ...(turn.stopped ? { status: "cancelled" as const } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
        ...(turn.responseState ? { responseState: turn.responseState } : {}),
        ...(turn.generatedFiles?.length
          ? { generatedFiles: turn.generatedFiles }
          : {}),
        ...(turn.toolCalls
          ? { toolCalls: cloneToolCalls(turn.toolCalls) }
          : {}),
        ...(turn.sentAt !== undefined ? { sentAt: turn.sentAt } : {}),
      }),
      { select: true },
    );
  }
}

function seedTranscriptTree(snapshot: TranscriptTree): void {
  // Parsing validated connectivity and selections before the old chat changed.
  // Restore nodes before their links so parents need not appear first in the file.
  for (const node of snapshot.nodes) {
    tree.set(node.id, {
      message: {
        ...node.message,
        id: node.id,
        ...(node.message.stopped ? { status: "cancelled" as const } : {}),
      },
      parentId: node.parentId,
      childrenIds: [],
      selectedChildIndex: 0,
    });
    nextMessageId = Math.max(nextMessageId, node.id + 1);
  }
  if (!Number.isSafeInteger(nextMessageId)) nextMessageId = 1;
  for (const node of snapshot.nodes) {
    tree.get(node.parentId)?.childrenIds.push(node.id);
  }
  for (const node of snapshot.nodes) {
    const restored = tree.get(node.id);
    if (restored && node.selectedChildId !== null)
      restored.selectedChildIndex = restored.childrenIds.indexOf(
        node.selectedChildId,
      );
  }
  const root = tree.get(TREE_ROOT_ID);
  if (root && snapshot.selectedRootId !== null)
    root.selectedChildIndex = root.childrenIds.indexOf(snapshot.selectedRootId);
}

function seedActiveConversation(importedTree?: TranscriptTree | null): void {
  resetConversationState();
  const simulated = getAISettings().provider === "simulated";
  const snapshot =
    importedTree ??
    (simulated ? importedConversation?.tree : openAIHistoryTree);
  if (snapshot) {
    seedTranscriptTree(snapshot);
  } else if (!simulated) {
    seedStoredTurns(openAIHistory);
  } else if (importedConversation !== null) {
    seedStoredTurns(importedConversation.turns);
  } else {
    simulatedConversationChanged = false;
    seedConversationTree(INITIAL_TRANSCRIPT_COUNT);
  }
  if (simulated && importedConversation !== null)
    nextResponse = simulatedNextResponse;
  rebuildActiveTranscript();
  loadedStart = Math.max(0, transcript.length - loadChunkCount());
  loadedEnd = transcript.length;
  refreshLoadedWindow();
}

// Swaps the rendered conversation after a provider change, an import, a
// restore, or a history clear: cancel any live stream, rebuild the state,
// and present it exactly as the boot does.
function reloadConversation(importedTree?: TranscriptTree | null): void {
  if (streamAbort) cancelStream(streamAbort);
  streamAbort = null;
  preparingConversation = false;
  clearPendingAttachments();
  endSendGlide();
  seedActiveConversation(importedTree);
  setEdgeState("hidden");
  mountConversation();
  syncMetrics();
  conversationTree?.reset();
  persistSimulatedConversation();
}

// Name the visible row's replacement, not a surviving prefix or a removed
// descendant. When a prompt is clipped but its reply is visible, the reply
// is the reading anchor. Otherwise a clipped long row starts its shorter
// version below the pill; a fully visible row retains its current position.
function replacementAnchor(
  messageId: number,
  replacementId: number | undefined,
): AnchorRequest | undefined {
  if (replacementId === undefined) return undefined;
  const list = virtualList;
  if (!list) return undefined;
  const inset = stickyInset();
  const replacements = [{ from: String(messageId), to: String(replacementId) }];
  const previous = tree.get(messageId);
  const replacement = tree.get(replacementId);
  if (previous?.message?.role === "user" && replacement) {
    const previousReplyId = selectedChildId(previous);
    const nextReplyId = selectedChildId(replacement);
    const previousReply =
      previousReplyId === undefined ? undefined : tree.get(previousReplyId);
    const nextReply =
      nextReplyId === undefined ? undefined : tree.get(nextReplyId);
    if (
      previousReply?.message?.role === "assistant" &&
      nextReply?.message?.role === "assistant"
    ) {
      replacements.push({
        from: String(previousReply.message.id),
        to: String(nextReply.message.id),
      });
    }
  }
  return captureReplacementAnchor(list, viewport, replacements, inset);
}

// Switch the active path while retaining the branch point's reading anchor.
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

  cancelUserEdit();
  markConversationChanged();
  const branchIndex = transcriptIndexById.get(messageId) ?? -1;
  const replacementId = parent.childrenIds[nextSelected];
  const anchor = replacementAnchor(messageId, replacementId);
  parent.selectedChildIndex = nextSelected;
  rebuildActiveTranscript();
  if (branchIndex >= 0) selectWindowAround(branchIndex);
  pushItems(anchor, true);
  syncMetrics();
  if (getAISettings().provider !== "simulated") persistOpenAIConversation();
  else persistSimulatedBranchSelection();
}

// Remove the selected version and descendants, preserving sibling versions.
// Version deletion is a branch swap, like version navigation, and keeps the
// live runtime's reading anchor. Removing an entire tail uses a fresh boot.
function deleteMessagesFrom(messageId: number, epoch: number): void {
  if (epoch !== conversationEpoch || streamAbort) return;
  const index = transcriptIndexById.get(messageId);
  const node = tree.get(messageId);
  const parent = node && tree.get(node.parentId);
  if (index === undefined || !node?.message || !parent) return;
  const isVersion = parent.childrenIds.length > 1;
  if (node.message.role === "assistant" && !isVersion) return;
  cancelUserEdit();
  markConversationChanged();

  const removedCount = transcript.length - index;
  conversationEpoch++;
  const abort = streamAbort;
  streamAbort = null;
  if (abort) cancelStream(abort);
  endSendGlide();
  activeLoad = null;
  loadingTop = false;
  topBoundaryLoadSeen = false;

  const removed = [messageId];
  parent.childrenIds = parent.childrenIds.filter((id) => id !== messageId);
  parent.selectedChildIndex = Math.max(
    0,
    Math.min(parent.selectedChildIndex, parent.childrenIds.length - 1),
  );
  const anchor = isVersion
    ? replacementAnchor(
        messageId,
        parent.childrenIds[parent.selectedChildIndex],
      )
    : undefined;
  while (removed.length > 0) {
    const id = removed.pop();
    if (id === undefined) break;
    const child = tree.get(id);
    if (child) removed.push(...child.childrenIds);
    tree.delete(id);
    htmlCache.delete(String(id));
  }
  rebuildActiveTranscript();
  if (isVersion) selectWindowAround(index);
  else {
    loadedStart = Math.max(0, transcript.length - loadChunkCount());
    loadedEnd = transcript.length;
  }
  refreshLoadedWindow();
  const turns = storedConversation();
  if (getAISettings().provider !== "simulated") {
    openAIHistory = turns;
    persistOpenAIConversation();
  } else {
    persistSimulatedConversation();
  }
  setEdgeState("hidden");
  if (isVersion) pushItems(anchor, true);
  else mountConversation();
  setStreamingUI(false);
  syncMetrics();
  promptInput.focus({ preventScroll: true });
  deletionStatus.textContent = isVersion
    ? "Message version deleted."
    : `${removedCount} ${removedCount === 1 ? "message" : "messages"} deleted.`;
}

// --- Rendering --------------------------------------------------------------

function htmlForMessage(message: Message): string {
  const key = String(message.id);
  let html = htmlCache.get(key);
  if (html === undefined) {
    html = renderMarkdown(message.markdown);
    htmlCache.set(key, html);
  }
  return html;
}

function transcriptIndexOf(message: Message): number {
  return transcriptIndexById.get(message.id) ?? 0;
}

// Structural fingerprint of a row's tool panels: a change refreshes a live
// row's panel in place and rebuilds any other row (see updateRow).
function toolSignature(message: Message): string {
  return (message.toolCalls ?? [])
    .map((toolCall) => `${toolCall.name}:${toolCall.status}`)
    .join("|");
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
  button.innerHTML = chevronIcon(dir === "prev" ? "left" : "right");
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

// What the live viewer renders mid-stream. Trailing newlines (OpenAI replies
// end with one; embedded image blocks append two) would otherwise parse into
// an empty trailing paragraph hosting the typing cursor — a phantom line that
// vanishes when streaming finalizes, jumping the content bottom at the end of
// every reply. The exception: when the stream ends with an image, keep one
// blank line so the cursor sits on its own line below it — glued to the
// image corner it reads wrong, and hidden it looks stalled; the finalized
// row keeps that line's height (see the streaming rules in styles.css), so
// no end jump either way. The stored markdown stays raw; trailing whitespace
// renders to nothing in the final static parse, so finalize output is
// unchanged.
function streamingDisplayText(message: Message): string {
  return streamingMarkdownText(message.markdown);
}

// A finished row: the static markdown render plus, when the message has
// sibling versions, the navigator that switches between them.
function buildStaticRow(message: Message): HTMLElement {
  // Tool calls use the streaming segment layout, including legacy/simulated
  // calls without offsets, so a finished row matches its streamed layout.
  const ordered =
    message.role === "assistant" && Boolean(message.toolCalls?.length);
  const row = ordered
    ? buildChatRow(message).row
    : buildChatItem(message, htmlForMessage(message));
  if (ordered) {
    const content = row.querySelector<HTMLElement>(".message-content");
    if (content) appendStaticMessageContent(content, message);
  }
  if (message.attachments?.length) {
    const list = document.createElement("div");
    list.className = "message-attachments";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Attached files");
    list.append(...message.attachments.map(attachmentChip));
    row.querySelector(".message-content")?.append(list);
  }
  if (message.role === "user") appendVersionNav(row, message);
  return row;
}

// Messages whose stream started since their row was last built. Their
// first streaming row treats its text as new, so the trail fades it.
const freshStreams = new Set<Message["id"]>();

function buildLiveRow(message: Message): HTMLElement {
  const { row, content } = buildChatRow(message);
  const handle = createMessageContent(
    content,
    cursorMode,
    trailMode,
    freshStreams.delete(message.id),
  );
  handle.update(
    message,
    streamingDisplayText(message),
    message.status === "streaming",
  );
  streamingViewers.set(row, handle);
  return row;
}

const MESSAGE_DELETE_PATH = "M3 5h14M8 2.5h4M5 5l.8 12h8.4L15 5M8 8v6M12 8v6";

function buildRow(message: Message): HTMLElement {
  const row =
    message.status === "streaming" ||
    (message.status === "thinking" && Boolean(message.toolCalls?.length))
      ? buildLiveRow(message)
      : buildStaticRow(message);
  if (message.role === "user") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-delete-btn";
    button.title = "Delete this message version and its replies";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "dialog");
    button.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="${MESSAGE_DELETE_PATH}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const actions = document.createElement("div");
    actions.className = "message-user-actions";
    row.prepend(actions);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-edit-btn";
    edit.title = "Edit message";
    edit.setAttribute("aria-label", edit.title);
    edit.innerHTML =
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="m12.5 3.5 4 4M3 17l4.5-1 9-9a2.8 2.8 0 0 0-4-4l-9 9L3 17Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-copy-btn";
    copy.title = "Copy message";
    copy.setAttribute("aria-label", copy.title);
    copy.disabled = message.markdown.length === 0;
    copy.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="${MESSAGE_COPY_PATH}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    actions.append(button, copy, edit);
    // Include the action column in the probe's width budget, especially on
    // phones; the prepared collapse state must match the eventual row layout.
    prepareUserMessageCollapse(
      row,
      message.id,
      expandedUserMessages.has(message.id),
      (expanded) => {
        if (expanded) expandedUserMessages.add(message.id);
        else expandedUserMessages.delete(message.id);
        // A reader expanding text is explicit viewport intent, not a stream
        // appending content. Stop end-follow before the bubble changes size.
        virtualList?.remeasure(String(message.id), { anchor: "viewport" });
      },
      viewport.clientWidth,
    );
    if (userEdit?.id === message.id && userEdit.epoch === conversationEpoch)
      buildUserEditor(row, message);
  }
  row.dataset.key = String(message.id);
  row.dataset.toolsig = toolSignature(message);
  syncMessageActions(row, message);
  syncStoppedMarker(row, message);
  syncGeneratedFiles(row, message.generatedFiles ?? [], generatedFileApiKey);
  rowById.set(String(message.id), row);
  return row;
}

function cancelUserEdit(focus = false): void {
  const edit = userEdit;
  userEdit = null;
  const row = edit && rowById.get(String(edit.id));
  if (!row) return;
  row.querySelector(".message-edit-controls")?.remove();
  const editor = row.querySelector<HTMLElement>(".message-edit-input");
  const message = edit && tree.get(edit.id)?.message;
  if (editor && message) {
    editor.removeAttribute("contenteditable");
    editor.removeAttribute("role");
    editor.removeAttribute("aria-label");
    editor.removeAttribute("aria-multiline");
    editor.classList.remove("message-edit-input");
    editor.oninput = null;
    editor.onkeydown = null;
    editor.innerHTML = htmlForMessage(message);
  }
  row.classList.remove("is-editing");
  syncUserMessageCollapse(row);
  if (focus)
    row
      .querySelector<HTMLButtonElement>(".message-edit-btn")
      ?.focus({ preventScroll: true });
}

function buildUserEditor(row: HTMLElement, message: Message): HTMLElement {
  const editor = row.querySelector<HTMLElement>(
    ".message-content > .markdown-viewer > .markdown",
  );
  if (!editor) throw new Error("User message content is missing");
  row.classList.add("is-editing");
  editor.classList.add("message-edit-input");
  editor.contentEditable = "plaintext-only";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "Edit user message");
  editor.setAttribute("aria-multiline", "true");
  editor.textContent = userEdit?.text ?? message.markdown;
  syncUserMessageCollapse(row);
  const submit = () => {
    if (userEdit?.id !== message.id || userEdit.epoch !== conversationEpoch)
      return;
    if (!editor.innerText.trim() && !message.attachments?.length) return;
    handleSend({
      kind: "edit",
      messageId: message.id,
      text: editor.innerText.trim(),
    });
  };
  const controls = document.createElement("div");
  controls.className = "message-edit-controls";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelUserEdit(true));
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.addEventListener("click", submit);
  controls.append(cancel, save);
  editor.closest(".markdown-viewer")?.after(controls);
  editor.oninput = () => {
    if (userEdit?.id === message.id) userEdit.text = editor.innerText;
  };
  editor.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelUserEdit(true);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };
  return editor;
}

function beginUserEdit(row: HTMLElement): void {
  if (streamAbort || preparingConversation) return;
  const id = Number(row.dataset.key);
  const message = tree.get(id)?.message;
  if (message?.role !== "user" || !transcriptIndexById.has(id)) return;
  if (userEdit?.id === id) {
    row
      .querySelector<HTMLElement>(".message-edit-input")
      ?.focus({ preventScroll: true });
    return;
  }
  // Editing expands the bubble just like its disclosure control. Stop
  // end-follow before changing its height so the prompt stays in place.
  virtualList?.remeasure(String(id), { anchor: "viewport" });
  cancelUserEdit();
  userEdit = { id, epoch: conversationEpoch, text: message.markdown };
  const editor = buildUserEditor(row, message);
  editor.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

function syncMessageActionState(
  row: HTMLElement,
  message: Message,
  streaming = streamAbort !== null,
): void {
  if (message.role !== "assistant") return;
  for (const button of row.querySelectorAll<HTMLButtonElement>(
    ":scope > .message-actions > button",
  )) {
    const disabled =
      streaming ||
      preparingConversation ||
      (button.classList.contains("message-copy-btn") && !message.markdown);
    if (button.disabled !== disabled) button.disabled = disabled;
  }
}

function syncMessageActions(row: HTMLElement, message: Message): void {
  if (message.role !== "assistant") return;
  let actions = row.querySelector<HTMLElement>(".message-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "message-actions";
    const nav = buildVersionNav(message);
    if (nav) actions.append(nav);
    row.append(actions);
  }
  actions.toggleAttribute("data-latest", message.id === refreshMessageId);
  const definitions = [
    {
      className: "message-refresh-btn",
      label: "Regenerate response",
      path: "M16.5 8a6.5 6.5 0 1 0 .1 3M16.5 3.5V8H12",
    },
    {
      className: "message-copy-btn",
      label: "Copy message",
      path: MESSAGE_COPY_PATH,
    },
    {
      className: "message-delete-btn",
      label: "Delete this response version and its replies",
      path: MESSAGE_DELETE_PATH,
      visible: versionInfo(message.id) !== null,
    },
  ];
  for (const action of definitions) {
    const existing = actions.querySelector<HTMLButtonElement>(
      `.${action.className}`,
    );
    if (action.visible === false) {
      existing?.remove();
      continue;
    }
    const button = existing ?? document.createElement("button");
    if (!existing) {
      button.type = "button";
      button.className = action.className;
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      if (action.className === "message-delete-btn")
        button.setAttribute("aria-haspopup", "dialog");
      button.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="${action.path}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      actions.append(button);
    }
  }
  syncMessageActionState(row, message);
}

function syncRoleLabel(element: HTMLElement, message: Message): void {
  const label = element.querySelector<HTMLElement>(".role-label");
  if (label && label.dataset.status !== message.status) {
    setRoleLabel(label, message);
  }
}

function syncStoppedMarker(row: HTMLElement, message: Message): void {
  row.querySelector(".message-stopped")?.remove();
  if (message.role !== "assistant" || message.status !== "cancelled") return;
  const content = row.querySelector<HTMLElement>(".message-content");
  if (!content) return;
  const marker = document.createElement("span");
  marker.className = "message-stopped";
  marker.textContent = "...stopped";
  marker.setAttribute("role", "status");
  // Stay outside inline formatting/links, but inside the final text block.
  // Responses without any text get a standalone marker.
  const markdown = Array.from(
    content.querySelectorAll<HTMLElement>(".markdown"),
  )
    .filter((element) => !element.closest("[hidden]"))
    .at(-1);
  const blocks = markdown?.querySelectorAll<HTMLElement>(
    "p, li, pre, td, th, h1, h2, h3, h4, h5, h6",
  );
  const lastBlock = blocks?.item(blocks.length - 1);
  if (lastBlock?.tagName === "PRE") {
    (lastBlock.querySelector("code") ?? lastBlock).append(marker);
  } else {
    (lastBlock ?? markdown ?? content).append(marker);
  }
}

// In-place update for a mounted row whose message changed; returns null when
// the row must be rebuilt (structure changed, or no live viewer to feed).
function updateRow(element: HTMLElement, message: Message): HTMLElement | null {
  syncMessageActions(element, message);
  const handle = streamingViewers.get(element);
  const signature = toolSignature(message);
  if (element.dataset.toolsig !== signature) {
    // A tool call changed on a live row: refresh its panel in place — a
    // rebuild would replace the viewer and its streaming cursor. Without a
    // live viewer, a static row must be rebuilt.
    if (!handle) return null;
    element.dataset.toolsig = signature;
  }
  if (message.status === "streaming") {
    // Static rows need a live viewer. Thinking rows with tool calls already
    // have one, so their visible panels survive the first streamed token.
    if (!handle) return null;
    freshStreams.delete(message.id);
    syncRoleLabel(element, message);
    handle.update(message, streamingDisplayText(message), true);
    syncGeneratedFiles(
      element,
      message.generatedFiles ?? [],
      generatedFileApiKey,
    );
    return element;
  }
  // Stream just ended on a still-live row: finalize the viewer in place
  // (isStreaming:false morphs the DOM rather than replacing it), so a text
  // selection inside the message survives. The row stays a live viewer until
  // it unmounts, then remounts static.
  if (handle) {
    syncRoleLabel(element, message);
    handle.update(message, message.markdown, false);
    syncGeneratedFiles(
      element,
      message.generatedFiles ?? [],
      generatedFileApiKey,
    );
    syncStoppedMarker(element, message);
    return element;
  }
  return null;
}

// Live viewers are torn down when the runtime is done with the element for
// good (its key removed, the row replaced, the snapshot superseded, or the
// list disposed) via onDestroy; the animation lookup is pruned there too.
function handleRowDestroy(element: HTMLElement): void {
  disposeAttachmentChips(element);
  clearMessageCopyFeedback(element);
  if (touchActionRow === element) touchActionRow = null;
  const handle = streamingViewers.get(element);
  if (handle) {
    handle.destroy();
    streamingViewers.delete(element);
  }
  const key = element.dataset.key;
  if (key && rowById.get(key) === element) rowById.delete(key);
}

// --- Demo chrome ------------------------------------------------------------

const countFormatter = new Intl.NumberFormat();

function formatCount(value: number): string {
  return countFormatter.format(Math.round(value));
}

function syncScrollButtons(state: VirtualListState): void {
  setHiddenIfChanged(scrollTopBtn, state.atStart && !canLoadOlderMessages());
  // Hide while following can still reach the end, including native catch-up
  // between lines. Bounded follow reveals the button once its limit leaves
  // content below the viewport.
  const headedToEnd = state.followingEnd;
  setHiddenIfChanged(
    scrollBottomBtn,
    (state.atEnd && loadedEnd === transcript.length) ||
      headedToEnd ||
      sendGlideActive,
  );
}

function syncMetrics(state = virtualList?.state): void {
  if (!state) return;
  const loadedRange =
    messages.length === 0
      ? "loaded 0-0/0"
      : `loaded ${formatCount(loadedStart + 1)}-${formatCount(loadedEnd)}/${formatCount(transcript.length)}`;
  const topStatus = loadingTop
    ? "loading top"
    : canLoadOlderMessages()
      ? "top"
      : "none";
  const mountedEnd = Math.max(state.start, state.end - 1);

  const windowText = `${loadedRange} · load ${topStatus}${loadingBottom ? " · loading bottom" : ""}`;
  const listText = `dom ${formatCount(state.end - state.start)}/${formatCount(state.count)} · mounted ${formatCount(state.start)}-${formatCount(mountedEnd)} · height ${formatCount(state.totalSize)}px`;
  // Streaming commits can publish new content without changing these labels.
  setTextIfChanged(windowStatus, windowText);
  setTextIfChanged(virtualListStatus, listText);
}

function endSendGlide(): void {
  if (!sendGlideActive) return;
  sendGlideActive = false;
  if (virtualList) syncScrollButtons(virtualList.state);
}

// --- Simulated streaming ----------------------------------------------------

// The reply to stream for a prompt: the next of the rotation, or a pinned
// slow/fast variant. Explicit shortcuts do not advance the rotation.
function replyFor(prompt = ""): ReplyVariant {
  if (prompt.trim().toLowerCase() === "slow") return SLOW_RESPONSE;
  // The fast long-form variant is the last sample. Force it via the
  // ?fast-long URL param, or by sending a message that starts with "f" — a
  // shortcut for testing fast streaming on demand. Deliberately pinned
  // outside the rotation: it returns without advancing nextResponse.
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
  return waitUntil(performance.now() + ms, abort);
}

async function streamResponse(
  reply: ReplyVariant,
  messageId: number,
  abort: StreamAbort,
): Promise<void> {
  if (instantReplies) {
    if (abort.cancelled) return;
    updateMessage(messageId, (message) => {
      message.markdown = reply.markdown;
    });
    return;
  }

  // Tokens are due on a wall-clock timeline, like a network stream that
  // keeps arriving while the tab is in the background: a throttled timer
  // wakes late and the overdue tokens land at once, and a return to the
  // tab flushes them right away.
  const delayRange = reply.tokenDelayMs;
  let due = performance.now();
  let wordsSincePause = 0;
  for (const token of tokenize(reply.markdown)) {
    if (abort.cancelled) return;
    updateMessage(messageId, (message) => {
      message.markdown += token;
    });
    due += delayRange.min + Math.random() * (delayRange.max - delayRange.min);
    if (reply.pause && /\S/.test(token)) {
      wordsSincePause++;
      if (wordsSincePause >= reply.pause.everyWords) {
        due += reply.pause.durationMs;
        wordsSincePause = 0;
      }
    }
    await waitUntil(due, abort);
  }
}

/** Resolves at `due` (a performance.now() time), or on cancel; a return to the tab resolves an overdue wait at once. */
function waitUntil(due: number, abort: StreamAbort): Promise<void> {
  const remaining = due - performance.now();
  if (remaining <= 0 || abort.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      abort.onCancel.delete(finish);
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && performance.now() >= due)
        finish();
    };
    const timer = window.setTimeout(finish, remaining);
    abort.onCancel.add(finish);
    document.addEventListener("visibilitychange", onVisible);
    if (abort.cancelled) finish();
  });
}

// --- OpenAI streaming -------------------------------------------------------

function generatedFileApiKey(): string {
  if (getAISettings().provider === "chatgpt") {
    throw new Error(
      "Generated-file downloads are not supported by the ChatGPT OAuth demo. No API-key request was made.",
    );
  }
  return getAISettings().apiKey;
}

/** A call still "running" when its stream ended never finished: errored. */
function settledToolCall(toolCall: ChatToolCall): ChatToolCall {
  return toolCall.status === "running"
    ? { ...toolCall, status: "error" }
    : toolCall;
}

// Preserve API state and settle unfinished tool calls in each stored branch.
function storedConversation(
  messages: readonly Message[] = transcript,
  preserveEmpty = false,
): StoredTurn[] {
  const turns: StoredTurn[] = [];
  for (const message of messages) {
    if (
      !preserveEmpty &&
      message.markdown === "" &&
      message.status !== "cancelled" &&
      !message.responseState &&
      !message.generatedFiles?.length &&
      !message.attachments?.length &&
      !message.toolCalls?.length
    )
      continue;
    // A cancel can leave a call mid-flight; store it as errored.
    const toolCalls = message.toolCalls?.map(settledToolCall);
    turns.push({
      role: message.role,
      markdown: message.markdown,
      ...(message.role === "assistant" && message.status === "cancelled"
        ? { stopped: true as const }
        : {}),
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(message.responseState
        ? { responseState: message.responseState }
        : {}),
      ...(message.generatedFiles?.length
        ? { generatedFiles: message.generatedFiles }
        : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(message.sentAt !== undefined ? { sentAt: message.sentAt } : {}),
    });
  }
  return turns;
}

function persistOpenAIConversation(): void {
  const snapshot = treeSnapshot(
    (message) => storedConversation([message], true)[0],
  );
  openAIHistory = storedConversation();
  openAIHistoryTree = snapshot;
  saveOpenAIHistory(openAIHistory, undefined, snapshot);
}

async function streamOpenAIResponse(
  messageId: number,
  abort: StreamAbort,
): Promise<void> {
  const {
    apiKey,
    provider,
    chatgptModel,
    model: apiModel,
    contextTurns,
    tools,
    reasoningSummary,
  } = getAISettings();
  const model = provider === "chatgpt" ? chatgptModel : apiModel;
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
      buildResponseContext(transcript, contextTurns, model),
      { apiKey, model, tools, reasoningSummary, provider },
      abortLink.signal,
    )) {
      if (abort.cancelled) return;
      updateMessage(messageId, (message) => {
        // The row stays "thinking" until the first real activity arrives.
        if (!started) {
          message.status = "streaming";
          freshStreams.add(message.id);
        }
        switch (chunk.kind) {
          case "files":
            message.generatedFiles = storedGeneratedFiles([
              ...(message.generatedFiles ?? []),
              ...chunk.files,
            ]);
            break;
          case "response-completed":
            message.responseState = chunk.state;
            break;
          case "text":
            message.markdown += chunk.text;
            break;
          case "image-partial":
          case "image": {
            // Progressive frames refine the same embedded block; the final
            // image takes the partial's place. Blank lines keep the image a
            // block of its own regardless of surrounding text.
            const previous = partialImages.get(chunk.id);
            if (
              !previous ||
              !replaceMessageMarkdown(message, previous, chunk.markdown)
            ) {
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
                markdownOffset: message.markdown.length,
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
              markdownOffset: live
                ? (message.toolCalls?.[live.slot]?.markdownOffset ??
                  message.markdown.length)
                : message.markdown.length,
            };
            const toolCalls = [...(message.toolCalls ?? [])];
            if (live && toolCalls[live.slot]) toolCalls[live.slot] = entry;
            else toolCalls.push(entry);
            message.toolCalls = toolCalls;
            break;
          }
        }
      });
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
      error instanceof TypeError && provider === "openai"
        ? `${error.message} — the response was unreadable. If the browser console shows a 401, the API rejected the key (re-paste it in the AI settings — keys are stored per browser); otherwise check content blockers, VPN/proxy, or the network tab.`
        : error instanceof Error
          ? error.message
          : String(error);
    updateMessage(messageId, (message) => {
      const alert = `> [!CAUTION]\n> **${provider === "chatgpt" ? "ChatGPT" : "OpenAI"} request failed** — ${detail}`;
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
        message.toolCalls = message.toolCalls.map(settledToolCall);
      }
    });
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

// --- Composer and send flow -------------------------------------------------

function restoreDraft(): void {
  try {
    promptInput.value = localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    // Storage may be unavailable; the composer still works in memory.
  }
}

function saveDraft(): void {
  try {
    if (promptInput.value) localStorage.setItem(DRAFT_KEY, promptInput.value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // A full or disabled store must not interrupt typing or sending.
  }
}

function autosize(): void {
  autosizeTextarea(promptInput, {
    minHeight: composerMinHeight,
    maxHeight: COMPOSER_MAX_HEIGHT,
  });
}

function setStreamingUI(streaming: boolean): void {
  if (!streaming) conversationTree?.refresh();
  viewport.classList.toggle("is-streaming", streaming);
  for (const row of viewport.querySelectorAll<HTMLElement>(
    ".message.assistant",
  )) {
    const message = tree.get(Number(row.dataset.key))?.message;
    if (message) syncMessageActionState(row, message, streaming);
  }
  sendBtn.textContent = streaming ? "Stop" : "Send";
  sendBtn.classList.toggle("stop-btn", streaming);
  sendBtn.disabled =
    !streaming && (readingAttachments || preparingConversation);
  attachBtn.disabled = streaming || readingAttachments || preparingConversation;
  largePasteAttach.disabled = attachBtn.disabled;
}

function renderPendingAttachments(): void {
  disposeAttachmentChips(pendingAttachmentList);
  pendingAttachmentList.replaceChildren(
    ...pendingAttachments.map((attachment, index) => {
      const chip = attachmentChip(attachment);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${attachment.name}`);
      remove.disabled = readingAttachments;
      remove.addEventListener("click", () => {
        pendingAttachments.splice(index, 1);
        if (pendingAttachments.length === 0) attachmentStatus.textContent = "";
        renderPendingAttachments();
        attachBtn.focus();
      });
      chip.append(remove);
      return chip;
    }),
  );
  setHiddenIfChanged(pendingAttachmentList, pendingAttachments.length === 0);
}

function clearPendingAttachments(): void {
  attachmentEpoch++;
  pendingAttachments = [];
  readingAttachments = false;
  attachmentInput.value = "";
  attachmentStatus.textContent = "";
  renderPendingAttachments();
  setStreamingUI(streamAbort !== null);
}

async function selectAttachments(files: File[]): Promise<void> {
  if (
    preparingConversation ||
    readingAttachments ||
    streamAbort ||
    files.length === 0
  )
    return;
  const epoch = ++attachmentEpoch;
  readingAttachments = true;
  attachmentStatus.textContent = "Reading files…";
  setStreamingUI(false);
  renderPendingAttachments();
  try {
    const attachments = await readAttachments(files, pendingAttachments);
    if (epoch !== attachmentEpoch) return;
    pendingAttachments.push(...attachments);
    attachmentStatus.textContent =
      "Files stay local until you send. Up to 10 files, 10 MB each, 20 MB total.";
  } catch (error) {
    if (epoch !== attachmentEpoch) return;
    attachmentStatus.textContent =
      error instanceof Error
        ? error.message
        : "Could not read the selected files.";
  } finally {
    if (epoch === attachmentEpoch) {
      readingAttachments = false;
      setStreamingUI(streamAbort !== null);
      renderPendingAttachments();
    }
  }
}

function animateRowsClass(
  ids: readonly number[],
  className: string,
  abort: StreamAbort,
): Promise<void> {
  const targets = ids
    .map((id) => rowById.get(String(id)))
    .filter((row): row is HTMLElement => row !== undefined)
    .map((row) => row.querySelector<HTMLElement>(".message-content") ?? row);
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

function flyInRows(ids: readonly number[], abort: StreamAbort): Promise<void> {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }
  return animateRowsClass(ids, "fly", abort);
}

function fadeInRows(ids: readonly number[], abort: StreamAbort): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  void animateRowsClass(ids, "fade", abort);
}

type SendAction =
  | { kind: "regenerate"; messageId: number }
  | { kind: "edit"; messageId: number; text: string };

function handleSend(action?: SendAction): void {
  void sendMessage(action).catch((error: unknown) => {
    console.error("Could not send message.", error);
  });
}

async function sendMessage(action?: SendAction): Promise<void> {
  if (preparingConversation) return;
  const previous = action ? tree.get(action.messageId) : undefined;
  const originalPrompt =
    action?.kind === "edit"
      ? previous?.message
      : previous
        ? tree.get(previous.parentId)?.message
        : undefined;
  if (
    action !== undefined &&
    (streamAbort ||
      !transcriptIndexById.has(action.messageId) ||
      previous?.message?.role !==
        (action.kind === "edit" ? "user" : "assistant") ||
      originalPrompt?.role !== "user")
  )
    return;
  if (streamAbort) {
    cancelStream(streamAbort);
    return;
  }

  const text =
    action?.kind === "edit"
      ? action.text
      : (originalPrompt?.markdown ?? promptInput.value.trim());
  const attachments =
    originalPrompt?.attachments ?? (originalPrompt ? [] : pendingAttachments);
  if (readingAttachments || (!text && attachments.length === 0)) return;
  cancelUserEdit();
  markConversationChanged();

  const promptInset = stickyInset();
  const regenerating = action?.kind === "regenerate";
  const placement =
    originalPrompt && !regenerating && virtualList
      ? captureItemPlacement(
          virtualList,
          viewport,
          String(originalPrompt.id),
          promptInset,
        )
      : null;
  const originalOffset = placement?.offset;
  const pinInstantly = placement?.pinned === true || placement?.above === true;

  if (!originalPrompt) {
    clearPendingAttachments();
    promptInput.value = "";
    saveDraft();
    autosize();
  }

  const abort: StreamAbort = { cancelled: false, onCancel: new Set() };
  streamAbort = abort;
  setStreamingUI(true);
  let assistantId: number | null = null;
  const shouldFlyIn = transcript.length === 0;
  const useOpenAI = getAISettings().provider !== "simulated";
  const sendEpoch = conversationEpoch;
  const persistTurns = () => {
    if (sendEpoch === conversationEpoch) {
      if (useOpenAI) persistOpenAIConversation();
      else persistSimulatedConversation();
    }
  };

  try {
    if (regenerating && originalPrompt) {
      // Keep the existing reply intact for the entire scroll. Refresh has
      // one path regardless of where its prompt starts in the viewport.
      sendGlideActive = true;
      const landed = await virtualList?.scrollTo(String(originalPrompt.id), {
        align: "start",
        behavior: "smooth",
        offset: promptInset,
      });
      if (!landed || abort.cancelled || sendEpoch !== conversationEpoch) return;
    }
    // New turns use the real clock in both providers. The built-in sample
    // ends yesterday, so the first simulated send opens a Today section.
    const sentAt = Date.now();
    const editUnanswered =
      action?.kind === "edit" && previous?.childrenIds.length === 0;
    const userMessage =
      (editUnanswered && originalPrompt
        ? { ...originalPrompt, markdown: text }
        : undefined) ??
      (action?.kind === "regenerate" ? originalPrompt : undefined) ??
      createMessage({
        role: "user",
        markdown: text,
        ...(attachments.length ? { attachments } : {}),
        sentAt,
      });
    const assistantMessage = createMessage({
      role: "assistant",
      markdown: "",
      status: "thinking",
      // Real replies get no pre-seeded tool calls (theirs arrive from the
      // stream); the simulated set is a prop of the canned rotation.
      ...(useOpenAI ? {} : { toolCalls: createSimulatedToolCalls() }),
      sentAt,
    });
    assistantId = assistantMessage.id;
    if (action?.kind === "edit" && previous && originalPrompt) {
      if (editUnanswered) {
        // No reply branch exists to preserve: edit this prompt in place.
        previous.message = userMessage;
        htmlCache.delete(String(userMessage.id));
      } else {
        addTreeChild(previous.parentId, userMessage);
      }
      addTreeChild(userMessage.id, assistantMessage);
      loadedStart = Math.min(
        loadedStart,
        transcriptIndexById.get(originalPrompt.id) ?? loadedStart,
      );
      rebuildActiveTranscript();
    } else if (originalPrompt) {
      addTreeChild(originalPrompt.id, assistantMessage);
      loadedStart = Math.min(
        loadedStart,
        transcriptIndexById.get(originalPrompt.id) ?? loadedStart,
      );
      rebuildActiveTranscript();
    } else {
      appendToActiveBranch([userMessage, assistantMessage]);
    }
    // Persist the user turn immediately so a reload mid-stream keeps it (the
    // still-empty assistant placeholder is filtered out).
    persistTurns();
    if (transcript.length - loadedStart <= pageSize() * 3) {
      // A normal send need not replace history that still fits the budget.
      loadedEnd = transcript.length;
    } else {
      selectWindowAround(
        Math.max(
          0,
          transcript.findIndex((message) => message.id === userMessage.id),
        ),
      );
    }
    // Refresh has already landed; preserve that pin while replacing its reply.
    // Edits keep their existing policy: pin an offscreen prompt immediately,
    // or retain its visible coordinate until the subsequent glide.
    pushItems(
      regenerating
        ? { key: String(userMessage.id), offset: promptInset }
        : originalOffset !== undefined
          ? {
              key: String(userMessage.id),
              offset: pinInstantly ? promptInset : originalOffset,
            }
          : "viewport",
      originalOffset !== undefined,
    );
    if (!shouldFlyIn) {
      fadeInRows(
        originalPrompt
          ? [assistantMessage.id]
          : [userMessage.id, assistantMessage.id],
        abort,
      );
    }
    // Pin-to-top (I5): the reserve holds scrollable space below the prompt
    // until the streamed reply consumes it, and the glide lands the prompt
    // exactly at the viewport top. End-follow engages on landing, so the
    // reply keeps the bottom pinned once it outgrows the reserve — and a
    // user scroll during the stream disengages it (their intent wins).
    // The bottom button stays hidden until the glide settles either way.
    sendGlideActive = true;
    const pinCommand = regenerating
      ? Promise.resolve(true)
      : (virtualList?.scrollTo(String(userMessage.id), {
          align: "start",
          behavior: pinInstantly ? "auto" : "smooth",
          // Under the floating day pill, not behind it.
          offset: promptInset,
        }) ?? Promise.resolve(false));
    // Streaming begins only after the pin command resolves. An interrupted
    // command (the user took ownership mid-glide) still resolves — the
    // stream then proceeds without follow, which is exactly their intent.
    await Promise.all([
      pinCommand.then(() => {
        if (sendEpoch === conversationEpoch && streamAbort === abort)
          endSendGlide();
      }),
      shouldFlyIn ? flyInRows([userMessage.id], abort) : undefined,
    ]);
    if (abort.cancelled) return;

    if (useOpenAI) {
      await streamOpenAIResponse(assistantId, abort);
    } else {
      const reply = replyFor(text);
      await wait(instantReplies ? 0 : reply.thinkingDelayMs, abort);
      if (abort.cancelled) return;

      updateMessage(assistantId, (message) => {
        message.status = "streaming";
        freshStreams.add(message.id);
      });
      await streamResponse(reply, assistantId, abort);
    }
  } finally {
    try {
      if (sendEpoch === conversationEpoch && assistantId !== null) {
        freshStreams.delete(assistantId);
        updateMessage(assistantId, (message) => {
          message.status = abort.cancelled ? "cancelled" : "done";
        });
      }
      // The finished (or cancelled-partial) assistant turn joins the history;
      // empty turns are filtered out during serialization.
      persistTurns();
    } finally {
      if (streamAbort === abort) {
        endSendGlide();
        streamAbort = null;
        setStreamingUI(false);
        if (virtualList) syncScrollButtons(virtualList.state);
      }
    }
  }
}

// --- Boot -------------------------------------------------------------------

bindThemeButtons(refreshTheme);
initAISettingsPanel({
  onProviderChange: (provider) => {
    if (provider !== "simulated") {
      // Stop the old provider immediately; sending its still-mounted history
      // under the newly selected provider would cross conversation ownership.
      openAIHistory = [];
      openAIHistoryTree = null;
      reloadConversation();
      const epoch = conversationEpoch;
      preparingConversation = true;
      setStreamingUI(false);
      // Fence languages must be loaded before the history's static render.
      void prepareOpenAIConversation(epoch)
        .then((loaded) => {
          if (loaded) reloadConversation();
        })
        .catch((error: unknown) => {
          if (epoch !== conversationEpoch) return;
          preparingConversation = false;
          setStreamingUI(false);
          window.alert(
            error instanceof Error
              ? error.message
              : "Could not load the conversation.",
          );
        });
    } else {
      reloadConversation();
    }
  },
  onClearHistory: () => {
    openAIHistory = [];
    openAIHistoryTree = null;
    // Only the OpenAI conversation is rendered from that history; a clear
    // while the simulated transcript is showing needs no repaint.
    if (getAISettings().provider !== "simulated") reloadConversation();
  },
  canRestoreConversation: () => simulatedConversationChanged,
  onRestoreConversation: () => {
    importedConversation = null;
    simulatedNextResponse = 0;
    simulatedConversationChanged = false;
    reloadConversation();
  },
});

/**
 * The key of the user message before or after the viewport top: the
 * nearest one whose committed top lies above it (previous) or below it
 * (next), among the loaded rows. A jump lands it at the top, under the
 * day pill when it is on.
 */
function neighbourPrompt(direction: "previous" | "next"): string | null {
  const scrollTop = viewport.scrollTop;
  const inset = stickyInset();
  let best: { key: string; top: number } | null = null;
  for (const message of transcript) {
    if (message.role !== "user") continue;
    const key = String(message.id);
    const position = virtualList?.positionOf(key);
    if (!position) continue;
    // Where the viewport top would sit with this message landed.
    const landing = position.top - inset;
    const beyond =
      direction === "previous"
        ? landing < scrollTop - 1
        : landing > scrollTop + 1;
    if (!beyond) continue;
    const nearer =
      best === null ||
      (direction === "previous" ? landing > best.top : landing < best.top);
    if (nearer) best = { key, top: landing };
  }
  return best?.key ?? null;
}

function jumpToPrompt(direction: "previous" | "next"): boolean {
  const key = neighbourPrompt(direction);
  if (key === null) return false;
  void virtualList?.scrollTo(key, {
    align: "start",
    behavior: "smooth",
    offset: stickyInset(),
  });
  return true;
}

/** A modifier click (⌘ on a Mac, Ctrl elsewhere) steps by prompt instead of jumping to the edge. */
function stepsByPrompt(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

scrollTopBtn.addEventListener("click", (event) => {
  cancelWindowNavigation();
  if (stepsByPrompt(event) && jumpToPrompt("previous")) return;
  // Targets the currently committed snapshot only. If older history loads
  // while the glide runs, the prepend commits — without movement — when
  // the phase settles; another press continues from there.
  void virtualList?.scrollTo("start", {
    behavior: "smooth",
  });
});

async function scrollToLatest(): Promise<boolean> {
  const list = virtualList;
  if (!list) return false;
  if (loadedEnd < transcript.length) {
    const controller = new AbortController();
    windowNavigation = controller;
    const epoch = conversationEpoch;
    paging?.dispose();
    paging = undefined;
    activeLoad = null;
    loadingTop = false;
    setEdgeState("hidden");
    setBottomLoading(true);
    syncMetrics();
    try {
      // Start moving through the loaded window while the evicted tail is
      // prepared. Its replacement takes over only when ready to animate.
      void list
        .scrollTo("end", { behavior: "smooth" })
        .catch(reportPagingError);
      const committed = await list.updateWindow(
        () => {
          if (controller.signal.aborted || epoch !== conversationEpoch)
            return null;
          const { start, end } = windowAround(
            transcript.length - 1,
            transcript.length,
          );
          const snapshot = transcript.slice(start, end);
          const first = snapshot[0];
          if (!first) return null;
          const topSlot =
            edgeLoaderMode === "slot" && (start > 0 || topBoundaryLoadSeen);
          return {
            items: rowsForRuntime(snapshot),
            // Keep room for the native end animation after restoration.
            anchor: { key: String(first.id), offset: 0 },
            edgeSlots: { start: topSlot ? edgeSlotSpec : null, end: null },
            onCommit: () => {
              loadedStart = start;
              loadedEnd = end;
              edgeSlotRequested = topSlot;
              if (!topSlot) edgeSlotElement = null;
              bottomEdgeSlotRequested = false;
              bottomEdgeSlotElement = null;
              refreshLoadedWindow();
              resetPaging();
              // Tokens or stop can change an evicted reply during staging.
              // The new pager already has the archive's latest objects; only
              // the prepared runtime rows still need those replacements.
              for (const [index, message] of messages.entries()) {
                if (message !== snapshot[index])
                  list.updateItem(String(message.id), message);
              }
              stickyHeaders?.refresh();
              syncMetrics();
            },
          };
        },
        controller.signal,
        { interrupt: "commit" },
      );
      if (
        !committed ||
        controller.signal.aborted ||
        epoch !== conversationEpoch ||
        virtualList !== list
      )
        return false;
    } finally {
      if (windowNavigation === controller) {
        windowNavigation = null;
        if (epoch === conversationEpoch) {
          if (!paging) resetPaging();
          setBottomLoading(false);
          syncMetrics();
        }
      }
    }
  }
  // Landing at the end resumes automatic stream following.
  return list.scrollTo("end", { behavior: "smooth" });
}

scrollBottomBtn.addEventListener("click", (event) => {
  cancelWindowNavigation();
  if (stepsByPrompt(event) && jumpToPrompt("next")) return;
  void scrollToLatest().catch(reportPagingError);
});

restoreDraft();
promptInput.addEventListener("input", () => {
  saveDraft();
  autosize();
});
promptInput.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (files.length === 0) {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length <= 500) return;
    event.preventDefault();
    if (largePasteDialog.open) return;
    pendingPaste = {
      text,
      draft: promptInput.value,
      start: promptInput.selectionStart,
      end: promptInput.selectionEnd,
      epoch: conversationEpoch,
    };
    largePasteAttach.disabled =
      readingAttachments || preparingConversation || streamAbort !== null;
    largePasteDialog.returnValue = "";
    largePasteDialog.showModal();
    return;
  }
  event.preventDefault();
  // Clipboard images can have no filename; validation still uses the same
  // supported formats and limits as the file picker.
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  void selectAttachments(
    files.map((file) => {
      const extension = extensions[file.type];
      return extension && !/\.(png|jpe?g|webp)$/i.test(file.name)
        ? new File([file], `pasted-image.${extension}`, { type: file.type })
        : file;
    }),
  );
});
largePasteDialog.addEventListener("close", () => {
  const paste = pendingPaste;
  pendingPaste = null;
  if (
    !paste ||
    paste.epoch !== conversationEpoch ||
    paste.draft !== promptInput.value
  )
    return;
  promptInput.focus({ preventScroll: true });
  promptInput.setSelectionRange(paste.start, paste.end);
  if (largePasteDialog.returnValue === "paste") {
    promptInput.setRangeText(paste.text, paste.start, paste.end, "end");
    promptInput.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (largePasteDialog.returnValue === "attach") {
    void selectAttachments([
      new File([paste.text], "pasted-text.txt", { type: "text/plain" }),
    ]);
  }
});
attachmentInput.accept = ATTACHMENT_ACCEPT;
attachBtn.addEventListener("click", () => attachmentInput.click());
attachmentInput.addEventListener("change", () => {
  const files = Array.from(attachmentInput.files ?? []);
  attachmentInput.value = "";
  void selectAttachments(files);
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
});
sendBtn.addEventListener("click", () => {
  handleSend();
});
document.addEventListener("keydown", (event) => {
  if (deleteDialog.open || largePasteDialog.open) return;
  if (event.key === "Escape" && streamAbort) {
    event.preventDefault();
    cancelStream(streamAbort);
  }
});

const deleteDialog = mustGet("delete-message-dialog", HTMLDialogElement);
const deletionStatus = mustGet("deletion-status", HTMLElement);
const copyStatus = mustGet("message-copy-status", HTMLElement);
let pendingDeletion: { id: number; epoch: number } | null = null;
let touchActionRow: HTMLElement | null = null;

document.addEventListener(
  "pointerdown",
  (event) => {
    if (!userEdit || !(event.target instanceof Node)) return;
    const content = rowById
      .get(String(userEdit.id))
      ?.querySelector(".message-content");
    if (!content?.contains(event.target)) cancelUserEdit();
  },
  { capture: true },
);

viewport.addEventListener("click", (event) => {
  if (
    !(event.target instanceof Element) ||
    streamAbort ||
    preparingConversation
  )
    return;
  const copy = event.target.closest<HTMLButtonElement>(".message-copy-btn");
  if (copy && !copy.disabled) {
    const id = Number(copy.closest<HTMLElement>(".message")?.dataset.key);
    const message = tree.get(id)?.message;
    if (message && transcriptIndexById.has(id))
      void copyMessageText(copy, message.markdown, copyStatus);
    return;
  }
  const refresh = event.target.closest<HTMLButtonElement>(
    ".message-refresh-btn",
  );
  if (refresh && !refresh.disabled) {
    const row = refresh.closest<HTMLElement>(".message.assistant");
    if (row)
      handleSend({
        kind: "regenerate",
        messageId: Number(row.dataset.key),
      });
    return;
  }
  const edit = event.target.closest<HTMLButtonElement>(".message-edit-btn");
  if (edit) {
    const row = edit.closest<HTMLElement>(".message.user");
    if (row) beginUserEdit(row);
    return;
  }
  const button = event.target.closest<HTMLButtonElement>(".message-delete-btn");
  const row = button?.closest<HTMLElement>(".message");
  if (!row || deleteDialog.open) return;
  const id = Number(row.dataset.key);
  const index = transcriptIndexById.get(id);
  if (index === undefined) return;
  const message = transcript[index];
  if (!message) return;
  const isVersion = versionInfo(id) !== null;
  if (message.role === "assistant" && !isVersion) return;
  pendingDeletion = { id, epoch: conversationEpoch };
  const later = transcript.length - index - 1;
  mustGet("delete-message-title", HTMLElement).textContent = isVersion
    ? "Delete this version?"
    : "Delete from here?";
  deleteDialog
    .querySelector<HTMLButtonElement>(".delete-message-confirm")
    ?.replaceChildren(isVersion ? "Delete version" : "Delete messages");
  mustGet("delete-message-description", HTMLElement).textContent = isVersion
    ? "This deletes this message version and any messages following it on this branch. Other versions are kept. This cannot be undone."
    : later > 0
      ? `This deletes your message and the ${later} ${later === 1 ? "message" : "messages"} after it, including any alternate versions below this point. This cannot be undone.`
      : "This deletes your message and any alternate versions below this point. This cannot be undone.";
  deleteDialog.returnValue = "";
  deleteDialog.showModal();
  mustGet("delete-message-cancel", HTMLButtonElement).focus();
});

deleteDialog.addEventListener("close", () => {
  const pending = pendingDeletion;
  pendingDeletion = null;
  if (deleteDialog.returnValue === "delete" && pending)
    deleteMessagesFrom(pending.id, pending.epoch);
});

// A Pencil or mouse can hover even when the primary input is touch. Track
// input changes only; pointer movement does not read layout or rewrite styles.
let actionHoverInput = false;
function syncActionHoverInput(event: PointerEvent): void {
  const hover = event.pointerType === "mouse" || event.pointerType === "pen";
  if (hover === actionHoverInput) return;
  actionHoverInput = hover;
  viewport.toggleAttribute("data-hover-input", hover);
}
document.addEventListener("pointerover", syncActionHoverInput, {
  passive: true,
});
document.addEventListener("pointermove", syncActionHoverInput, {
  passive: true,
});

// Touch has no hover: reveal the tapped bubble's actions, but not when
// operating its version navigator. Do not prevent gestures or text selection.
document.addEventListener(
  "pointerdown",
  (event) => {
    syncActionHoverInput(event);
    if (event.pointerType === "mouse") return;
    const row =
      event.target instanceof Element && !event.target.closest(".version-nav")
        ? (event.target
            .closest(
              ".message-content, .message-user-actions, .message-actions",
            )
            ?.closest<HTMLElement>(".message") ?? null)
        : null;
    if (row === touchActionRow) return;
    touchActionRow?.removeAttribute("data-actions-visible");
    touchActionRow = row;
    row?.setAttribute("data-actions-visible", "");
  },
  { passive: true },
);

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
autosize();
if (getAISettings().provider !== "simulated") await prepareOpenAIConversation();
await prepareSimulatedConversation();
seedActiveConversation();
persistSimulatedConversation();

/**
 * The one way a conversation is presented: a fresh runtime over the seeded
 * transcript — the boot, and every reload (a provider switch, an import, a
 * restore, a history clear) after disposing the previous one — landing
 * where the setting says. Reloading through the live runtime instead left
 * it carrying the old conversation's pin, follow intent, and held work.
 */
function mountConversation(): void {
  paging?.dispose();
  paging = undefined;
  setBottomLoading(false);
  virtualList?.dispose();
  // A replacement owns its loader state: do not inherit the old chat's
  // invisible scrollback strip when all imported turns are already loaded.
  edgeSlotRequested = shouldMountEdgeSlot();
  edgeSlotElement = null;
  bottomEdgeSlotRequested = shouldMountBottomEdgeSlot();
  bottomEdgeSlotElement = null;
  // Boot publishes synchronously, before the assignment below completes.
  // Defer header queries until they can read the replacement list, not the
  // disposed list's geometry paired with the new transcript's day keys.
  let mounting = true;
  let bootScrollTop = 0;
  virtualList = createVirtualList<ChatRow>(viewport, {
    items: rowsForRuntime(),
    key: rowKey,
    // Reserve is a runtime invariant, independent of how a row is reached.
    pinning:
      landingMode === "prompt"
        ? {
            match: (row) => !isDayHeader(row) && row.id === latestPromptId,
            get offset() {
              return stickyInset();
            },
          }
        : false,
    anchorable: (row) => !isDayHeader(row),
    render: (row, existing) => {
      if (isDayHeader(row)) {
        // A day row: static; a re-label (a new day arrived) updates in place.
        if (existing) {
          const pill = existing.querySelector<HTMLElement>(
            ".section-header-pill",
          );
          if (pill) pill.textContent = row.label;
          return existing;
        }
        return buildSectionHeader(row.label);
      }
      if (existing) {
        const updated = updateRow(existing, row);
        if (updated) return updated;
      }
      const element = adoptDisplayCopies(buildRow(row));
      suspendRowImages(element);
      return element;
    },
    edgeSlots: {
      start: edgeSlotRequested ? edgeSlotSpec : null,
      end: bottomEdgeSlotRequested ? bottomEdgeSlotSpec : null,
    },
    stage: (row, element) =>
      !isDayHeader(row) &&
      row.role === "assistant" &&
      (row.status === "done" || row.status === "cancelled") &&
      row.markdown.length >= 16384
        ? stageMessageLayout(element)
        : undefined,
    followBehavior: "smooth",
    followMode,
    followInset: stickyInset(),
    followStart: (message, element) => {
      if (isDayHeader(message) || message.role !== "assistant") return element;
      // Empty text viewers host the typing cursor. Tool disclosures can also
      // contain markdown, but neither is the start of the answer.
      if (!message.markdown.trim()) return null;
      return element.querySelector<HTMLElement>(
        ".message-content > :not(.tool-calls):not([hidden]) .markdown",
      );
    },
    onState: (state, snapshot) => {
      syncScrollButtons(state);
      syncMetrics(state);
      // Publications also report mounted-range changes during scrolling.
      // Reuse the runtime's read instead of flushing layout after DOM writes.
      if (mounting) bootScrollTop = snapshot.scrollTop;
      else stickyHeaders?.refresh(snapshot.scrollTop);
      void paging?.reconcile()?.catch(reportPagingError);
    },
    // State can stay unchanged through a glide. Keep the header in the
    // same frame as each scroll write, including its release above the slot.
    onViewport: (snapshot) => {
      if (!mounting) stickyHeaders?.update(snapshot.scrollTop);
    },
    onReachStart: loadOlderMessages,
    onReachEnd: loadNewerMessages,
    onMount: (element, row) => {
      resumeRowImages(element);
      adoptDisplayCopies(element);
      // Retained/prepared rows can miss setStreamingUI while offscreen.
      // Refresh only action state; mounting must not rebuild their content.
      if (!isDayHeader(row)) syncMessageActionState(element, row);
      mountUserMessageCollapse(element);
      streamingViewers.get(element)?.setMounted(true);
    },
    onUnmount: (element) => {
      suspendRowImages(element);
      streamingViewers.get(element)?.setMounted(false);
      unmountUserMessageCollapse(element);
    },
    onDestroy: handleRowDestroy,
  });
  mounting = false;
  stickyHeaders?.refresh(bootScrollTop);
  resetPaging();
}

mountConversation();

// The sticky day header: a companion on the runtime's read queries.
stickyHeaders = createStickyHeaders({
  container: viewportWrap,
  viewport,
  headerKeys: dayHeaderKeys,
  positionOf: (key) => virtualList?.positionOf(key) ?? null,
  // Suppress only the duplicate pill, keeping the scrolling row visible.
  elementOf: (key) =>
    virtualList
      ?.elementOf(key)
      ?.querySelector<HTMLElement>(".section-header-pill") ?? null,
  renderHeader: (slot, ordinal) => {
    const label = dayHeaderRows()[ordinal]?.label ?? "";
    slot.replaceChildren(buildSectionHeader(label));
  },
});
// --- Export ------------------------------------------------------------------
// The readable active branch plus all other versions in hidden tree metadata.
function transcriptMarkdown(): string {
  const snapshot = treeSnapshot((message) => message);
  // A file is read later: a dated day gets its full date, not "Today".
  return branchingTranscriptMarkdown(snapshot, {
    dayOf,
    dayLabel: (day) =>
      isDatedDay(day)
        ? new Date(day).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : dayLabel(day),
  });
}

function downloadTranscript(): void {
  const file = createTranscriptFile(transcriptMarkdown());
  downloadBlob(file, file.name, 1000);
}

mustGet("download-btn", HTMLButtonElement).addEventListener(
  "click",
  downloadTranscript,
);

const shareBtn = mustGet("share-btn", HTMLButtonElement);
shareBtn.hidden = !supportsChatSharing();
shareBtn.addEventListener("click", async () => {
  if (shareBtn.disabled) return;
  shareBtn.disabled = true;
  try {
    const result = await shareChatFile(
      createTranscriptFile(transcriptMarkdown()),
    );
    if (result === "unsupported")
      window.alert(
        "This chat cannot be shared as a file in this browser. Use Download to save it instead.",
      );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Sharing failed.";
    window.alert(`${detail}\nUse Download to save the chat instead.`);
  } finally {
    shareBtn.disabled = false;
  }
});

// Import replaces the conversation: the stored OpenAI history in this
// browser, or the separately stored simulated transcript.
// One import at a time: a second file dropped while the first is being
// read, confirmed, or having its languages loaded is ignored, never
// interleaved with it.
let importing = false;
async function importTranscript(file: File): Promise<void> {
  if (importing) return;
  importing = true;
  try {
    await importTranscriptNow(file);
  } catch (error) {
    window.alert(
      error instanceof Error
        ? error.message
        : "Could not import the transcript.",
    );
  } finally {
    importing = false;
  }
}

async function importTranscriptNow(file: File): Promise<void> {
  const epoch = conversationEpoch;
  const imported = parseBranchingTranscript(await file.text());
  const { turns, tree: importedTree } = imported;
  if (epoch !== conversationEpoch) return;
  if (turns.length === 0) {
    window.alert(`${file.name} holds no chat turns.`);
    return;
  }
  const useOpenAI = getAISettings().provider !== "simulated";
  const target = useOpenAI
    ? "the selected provider's history stored in this browser"
    : "the simulated history stored in this browser";
  if (
    !window.confirm(
      `Replace ${target} with the ${importedTree?.nodes.length ?? turns.length} turns${importedTree ? " (including all versions)" : ""} in ${file.name}?`,
    )
  ) {
    return;
  }
  await loadLanguages(
    historyFenceLanguages(
      importedTree?.nodes.map((node) => node.message) ?? turns,
    ),
  );
  if (epoch !== conversationEpoch) return;
  if (useOpenAI) {
    openAIHistory = turns;
    openAIHistoryTree = importedTree;
    saveOpenAIHistory(turns, undefined, importedTree ?? undefined);
  } else {
    importedConversation = imported;
    simulatedNextResponse = 0;
    simulatedConversationChanged = true;
  }
  reloadConversation(importedTree);
}

const importInput = mustGet("import-file", HTMLInputElement);
mustGet("import-btn", HTMLButtonElement).addEventListener("click", () =>
  importInput.click(),
);
importInput.addEventListener("change", () => {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (file) void importTranscript(file);
});

// Only external file drags are imports. Native image drags can also expose
// "Files", so remember drags originating anywhere in this document.
let internalDrag = false;
let dragDepth = 0;
function resetImportDrag(): void {
  internalDrag = false;
  dragDepth = 0;
  viewportWrap.classList.remove("drop-target");
}
document.addEventListener(
  "dragstart",
  (event) => {
    resetImportDrag();
    internalDrag = true;
    // A prevented dragstart has no dragend (for example, preview swipe guards).
    window.setTimeout(() => {
      if (event.defaultPrevented) resetImportDrag();
    });
  },
  true,
);
document.addEventListener("dragend", resetImportDrag, true);
document.addEventListener(
  "drop",
  () => {
    // Keep the origin flag through the target's drop handler, including when
    // another target stops propagation, then clear it for the next file drag.
    window.setTimeout(resetImportDrag);
  },
  true,
);
function draggedFile(event: DragEvent): boolean {
  return !internalDrag && event.dataTransfer?.types.includes("Files") === true;
}
function transcriptFile(event: DragEvent): File | null {
  const file = event.dataTransfer?.files[0] ?? null;
  return file && /\.(md|markdown|txt)$/i.test(file.name) ? file : null;
}
viewportWrap.addEventListener("dragenter", (event) => {
  if (!draggedFile(event)) return;
  event.preventDefault();
  dragDepth += 1;
  viewportWrap.classList.add("drop-target");
});
viewportWrap.addEventListener("dragover", (event) => {
  if (!draggedFile(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
viewportWrap.addEventListener("dragleave", (event) => {
  if (!draggedFile(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) viewportWrap.classList.remove("drop-target");
});
viewportWrap.addEventListener("drop", (event) => {
  if (!draggedFile(event)) return;
  event.preventDefault();
  dragDepth = 0;
  viewportWrap.classList.remove("drop-target");
  const file = transcriptFile(event);
  if (file) void importTranscript(file);
  else window.alert("Drop a Markdown transcript (.md) to import it.");
});

const stickyToggle = mustGet("sticky-toggle", HTMLInputElement);
function syncSticky(): void {
  stickyHeaders?.setEnabled(stickyEnabled);
  stickyToggle.checked = stickyEnabled;
  viewportWrap.classList.toggle("sticky-on", stickyEnabled);
  // The sticky header covers the top of the viewport: keep it clear of
  // the reply's start under "keep-start".
  virtualList?.setFollowMode(followMode, stickyInset());
}
stickyToggle.addEventListener("change", () => {
  stickyEnabled = stickyToggle.checked;
  syncSticky();
  // Snapshot the new inset through the runtime's declarative pin policy.
  pushItems("viewport");
  saveChatOptions();
});
syncSticky();

edgeLoaderSelect.addEventListener("change", () => {
  edgeLoaderMode = parseEdge(edgeLoaderSelect.value);
  syncEdgeLoaderMode();
  saveChatOptions();
});
syncEdgeLoaderMode();

cursorSelect.value = cursorMode;
trailSelect.value = trailMode;
trailSelect.addEventListener("change", () => {
  trailMode = parseTrail(trailSelect.value);
  saveChatOptions();
  syncStreamingViewerOptions();
});
cursorSelect.addEventListener("change", () => {
  cursorMode = parseCursor(cursorSelect.value);
  saveChatOptions();
  syncStreamingViewerOptions();
});
// A live reply takes a changed cursor choice at once.
function syncStreamingViewerOptions(): void {
  for (const row of rowById.values()) {
    streamingViewers.get(row)?.setCursor(cursorMode);
    streamingViewers.get(row)?.setTrail(trailMode);
  }
}
landingSelect.value = landingMode;
landingSelect.addEventListener("change", () => {
  landingMode = parseLanding(landingSelect.value);
  saveChatOptions();
});
autoscrollSelect.value = followMode;
autoscrollSelect.addEventListener("change", () => {
  followMode = parseFollow(autoscrollSelect.value);
  virtualList?.setFollowMode(followMode, stickyInset());
  saveChatOptions();
});

// One delegated listener powers copy buttons across every mounted row.
attachInteractions(viewport);
// The per-message version navigators, driven by delegated listeners on the
// viewport so they survive row rebuilds.
//
// A tap that lands while the scroller is still decelerating or bouncing
// doubles as "stop the animation" on iOS: pointer and touch events arrive,
// the click never does. So a pointer tap that starts and ends on the same
// navigator button activates it at pointerup, and the click that other
// engines fire right after — possibly on the rebuilt row's button — is a
// duplicate and ignored. Keyboard activation still comes through click.
const NAV_CLICK_SUPPRESS_MS = 700;
let navPointerTap: { button: HTMLElement; pointerId: number } | null = null;
let navClickSuppressedUntil = 0;

function versionNavButtonAt(target: EventTarget | null): HTMLElement | null {
  // The chevron is an inline SVG, so the target may be an SVGElement; match
  // on Element (closest is defined there) rather than HTMLElement.
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".version-nav-btn");
}

function activateVersionNav(button: HTMLElement): void {
  if (button.hasAttribute("disabled")) return;
  const messageId = Number(
    button.closest<HTMLElement>(".version-nav")?.dataset.messageId,
  );
  if (!Number.isFinite(messageId)) return;
  switchMessageVersion(messageId, button.dataset.dir === "prev" ? -1 : 1);
}

viewport.addEventListener("pointerdown", (event) => {
  const button = versionNavButtonAt(event.target);
  navPointerTap = button ? { button, pointerId: event.pointerId } : null;
});
viewport.addEventListener("pointercancel", () => {
  navPointerTap = null;
});
viewport.addEventListener("pointerup", (event) => {
  const tap = navPointerTap;
  navPointerTap = null;
  if (!tap || tap.pointerId !== event.pointerId) return;
  if (versionNavButtonAt(event.target) !== tap.button) return;
  navClickSuppressedUntil = performance.now() + NAV_CLICK_SUPPRESS_MS;
  activateVersionNav(tap.button);
});
viewport.addEventListener("click", (event) => {
  const button = versionNavButtonAt(event.target);
  if (!button) return;
  if (performance.now() < navClickSuppressedUntil) return;
  activateVersionNav(button);
});
// A tool panel is user-driven growth, not streaming growth: preserve the
// clicked viewport rather than re-gluing an end-positioned transcript. The
// runtime measures on the next frame, after <details>' default action.
viewport.addEventListener(
  "click",
  (event) => {
    if (!(event.target instanceof Element)) return;
    const summary = event.target.closest(".tool-call-summary");
    const row = summary?.closest<HTMLElement>("article.message");
    const key = row?.dataset.key;
    if (key !== undefined) {
      virtualList?.remeasure(key, { anchor: "viewport" });
    }
  },
  { capture: true },
);

syncMetrics();
document.documentElement.classList.remove("booting");
performance.mark("chat:visible");

const imagePreview = createChatImagePreview(viewport, () => transcript);
const headingCache = new WeakMap<Message, readonly ResponseHeading[]>();
const treeImageCache = new WeakMap<
  Message,
  {
    markdown: string;
    attachments: Message["attachments"];
    sources: ReturnType<typeof messageImageSources>;
  }
>();
conversationTree = createConversationTree({
  host: mustGet("scroll-jump-layer"),
  viewport,
  tree,
  isLoaded: (id) => {
    const index = transcriptIndexById.get(id);
    return index !== undefined && index >= loadedStart && index < loadedEnd;
  },
  currentMessage: currentTreeMessage,
  currentHeading: currentTreeHeading,
  headings: (id) => {
    const message = tree.get(id)?.message;
    if (message?.role !== "assistant") return [];
    let headings = headingCache.get(message);
    if (!headings) {
      headings = responseHeadings(message);
      headingCache.set(message, headings);
    }
    return headings;
  },
  navigate: navigateTreeMessage,
  images: (id) => {
    const message = tree.get(id)?.message;
    if (!message) return [];
    let cached = treeImageCache.get(message);
    // A streaming reply keeps its object while its Markdown grows.
    if (
      cached?.markdown !== message.markdown ||
      cached.attachments !== message.attachments
    ) {
      cached = {
        markdown: message.markdown,
        attachments: message.attachments,
        sources: messageImageSources(message),
      };
      treeImageCache.set(message, cached);
    }
    // Prefer the display copy the chat row already decoded.
    return cached.sources.map(({ url, label }) => ({
      src: readyDisplayCopy(url) ?? url,
      label,
    }));
  },
});
window.addEventListener("pagehide", () => {
  disposeAttachmentChips(pendingAttachmentList);
  if (streamAbort) cancelStream(streamAbort);
  paging?.dispose();
  virtualList?.dispose();
  stickyHeaders?.destroy();
  windowNavigation?.abort();
  conversationTree?.dispose();
});
window.addEventListener("pagehide", () => imagePreview.dispose());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

watchSystemTheme(refreshTheme);
