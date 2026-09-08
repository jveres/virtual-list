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
  setRoleLabel,
} from "../shared/chat-ui.js";
import {
  attachInteractions,
  initMarkdown,
  loadLanguages,
  renderMarkdown,
} from "../shared/markdown.js";
import { replaceMessageMarkdown } from "../shared/message-order.js";
import {
  createStickyHeaders,
  type StickyHeaders,
} from "../shared/sticky-headers.js";
import { applyDocumentTheme, watchSystemTheme } from "../shared/theme.js";
import {
  at,
  bindThemeButtons,
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
  readAttachments,
} from "./attachments.js";
import {
  branchingTranscriptMarkdown,
  type ImportedTranscript,
  parseBranchingTranscript,
  type TranscriptTree,
} from "./branching-transcript.js";
import { createChatImagePreview } from "./image-preview.js";
import {
  appendStaticMessageContent,
  createMessageContent,
  type MessageContentHandle,
} from "./message-content.js";
import {
  buildResponseContext,
  GENERATED_IMAGE_PATTERN,
  getAISettings,
  initAISettingsPanel,
  loadOpenAIHistory,
  type StoredTurn,
  saveOpenAIHistory,
  streamOpenAIChat,
} from "./openai.js";
import { repaintAfterReplacement } from "./repaint.js";
import { sampleTimestamp } from "./sample-time.js";
import {
  createTranscriptFile,
  shareChatFile,
  supportsChatSharing,
} from "./share.js";

import "../shared/styles.css";

// The demo is the runtime's API pressure test: the full streaming chat —
// send flow with pin-to-top, end-follow through streams, scrollback loading,
// version branches, live tool panels — hosted on the runtime's public
// surface (setItems / updateItem / scrollTo / remeasure / setEdgeSlot / positionOf /
// elementOf / state) with no escape hatch into its internals.
//
// The message data is immutable-by-replacement: every change clones the
// message object and sends it through updateItem. Structural changes use
// setItems. The one
// in-place exception is a tool panel's open state, which the runtime never
// needs to know about (it is excluded from the panel signature). The runtime's
// keyed renderer re-renders exactly the changed rows (render(item, existing)),
// and end-compatible snapshots keep end-follow engaged while streaming.
//
// On the runtime (docs/core-contract.md): every row is premeasured
// off-scroller before it commits; a structural change above the anchor (a
// scrollback prepend) commits only when the scroll phase settles, one below
// it (a new turn, a version switch) at once; and the streaming reply runs
// under `scrollingUpdates: "live"` — its tokens render in place
// and its height commits at once whenever no anchor-preserving scroll write
// is needed, so the reply keeps flowing under a scroll. Scrollback loads are
// wired to the reach signal: reaching the other edge aborts them.
//
// Two presentation options, both configurable:
// - the scrollback loader is a runtime EDGE SLOT in the flow (default;
//   `?edge=pill` restores the floating pill). In the flow, the slot's strip
//   turns into the loaded messages while the reading position holds — the
//   visible "more to scroll" feedback — and it never competes with the
//   sticky header for the top strip;
// - day separators are rows, and a STICKY companion pins the current day at
//   the top (`?sticky=off`, or the header toggle, turns it off). It reads
//   the runtime's committed positions, which move only at commits — each
//   of which refreshes it — never under a native scroll write.

interface Message {
  attachments?: ChatAttachment[];
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
}

const COMPOSER_FALLBACK_MIN_HEIGHT = 42;
const COMPOSER_MAX_HEIGHT = 160;
const DEFAULT_THINKING_DELAY_MS = 1200;
const DEFAULT_TOKEN_DELAY_MS = { min: 18, max: 54 };
const FAST_THINKING_DELAY_MS = 240;
const FAST_TOKEN_DELAY_MS = { min: 4, max: 12 };
// Landing durations for pinning a new message and returning to the top.
// Longer trips add an approach of at most the chosen landing duration.
// The bottom button retains the runtime's quicker default landing.
const NEW_MESSAGE_SCROLL_DURATION_MS = 450;
const CHAT_SCROLL_DURATION_MS = 650;
// Synthetic days over the transcript: one separator per this many messages.
const MESSAGES_PER_DAY = 12;
// The in-flow scrollback slot's fixed height.
const EDGE_SLOT_HEIGHT = 52;
// The day pill's row height; a send pins its message this far below the
// viewport top when the sticky header is on, so the pill never covers it.
const DAY_HEADER_HEIGHT = 44;
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
type CursorMode = "bar" | "none";
interface ChatOptions {
  edge: "slot" | "pill";
  sticky: boolean;
  follow: FollowMode;
  landing: LandingMode;
  cursor: CursorMode;
}
function loadChatOptions(): ChatOptions {
  const stored: Partial<ChatOptions> = (() => {
    try {
      return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}");
    } catch {
      return {};
    }
  })();
  return {
    edge: stored.edge === "pill" ? "pill" : "slot",
    sticky: stored.sticky !== false,
    follow: stored.follow === "keep-start" ? "keep-start" : "end",
    landing: stored.landing === "end" ? "end" : "prompt",
    cursor: stored.cursor === "none" ? "none" : "bar",
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
      }),
    );
  } catch {
    // Storage may be unavailable; the session keeps its choices.
  }
}
const chatOptions = loadChatOptions();
let edgeLoaderMode: "slot" | "pill" = chatOptions.edge;
let stickyEnabled = chatOptions.sticky;
let followMode: FollowMode = chatOptions.follow;
let landingMode: LandingMode = chatOptions.landing;
let cursorMode: CursorMode = chatOptions.cursor;
const instantReplies =
  demoParams.has("instant") || demoParams.get("stream") === "instant";
const forceFastLongReply =
  demoParams.has("fast-long") || demoParams.get("stream") === "fast-long";
const viewport = mustGet("viewport");
const viewportWrap = viewport.parentElement as HTMLElement;
const promptInput = mustGet("prompt", HTMLTextAreaElement);
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
let loadingTop = false;
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
// The transcript is the *active path* through the message tree: the linear
// list the virtualizer renders. `messages` is the loaded window over its tail.
const transcript: Message[] = [];
let messages: Message[] = [];
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
// selected child of the current leaf, keeping the tree and `transcript` in
// sync without a full rebuild.
function appendToActiveBranch(nextMessages: readonly Message[]): void {
  for (const message of nextMessages) {
    addTreeChild(activeLeafId(), message, { select: true });
    transcript.push(message);
  }
}

// --- The loaded window and the virtualizer bridge ---------------------------

// Nominal average row height for sizing scrollback chunks (data windowing
// only; the runtime never estimates — every row is premeasured).
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

// Recomputes `messages` (the window handed to the virtualizer — always the
// transcript's tail from loadedStart) and the id → transcript index lookup.
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
  messages = transcript.slice(loadedStart);
  transcriptHasDates = transcript.some(
    (message) => message.sentAt !== undefined,
  );
  transcriptIndexById.clear();
  dayRunStartById.clear();
  let currentDay: number | undefined;
  let runStart = 0;
  transcript.forEach((message, index) => {
    transcriptIndexById.set(message.id, index);
    const day = dayOf(message);
    if (day !== currentDay) {
      currentDay = day;
      runStart = message.id;
    }
    dayRunStartById.set(message.id, runStart);
  });
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

function conversationIsDated(): boolean {
  return getAISettings().provider === "openai" || transcriptHasDates;
}

function dayOf(message: Message): number {
  // Keep an exchange together when an old prompt gets a fresh reply. Derive
  // its display day from the selected reply without rewriting the prompt's
  // timestamp, so returning to an older version restores its original day.
  if (message.role === "user") {
    const node = tree.get(message.id);
    const replyId = node && selectedChildId(node);
    const reply =
      replyId === undefined ? undefined : tree.get(replyId)?.message;
    if (reply?.role === "assistant" && reply.sentAt !== undefined)
      return localMidnight(reply.sentAt);
  }
  if (message.sentAt !== undefined) return localMidnight(message.sentAt);
  if (conversationIsDated()) return UNDATED_DAY;
  return Math.floor(transcriptIndexOf(message) / MESSAGES_PER_DAY);
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

function dayLabel(day: number): string {
  if (day === UNDATED_DAY) return "Earlier";
  if (isDatedDay(day)) {
    const back = Math.round((localMidnight(Date.now()) - day) / DAY_MS);
    return relativeDayLabel(back, new Date(day));
  }
  const back = lastDay() - day;
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

function dayHeaderRows(): DayHeader[] {
  return rowsForRuntime().filter(isDayHeader);
}

function dayHeaderKeys(): string[] {
  return dayHeaderRows().map(rowKey);
}

/** Submit a snapshot for conversation changes; scrollback uses updateWindow.
 * Returns the number of rows handed over (day separators included). */
function pushItems(anchor?: AnchorRequest): number {
  refreshLoadedWindow();
  syncEdgeSlot();
  const rows = rowsForRuntime();
  virtualList?.setItems(rows, anchor ? { anchor } : undefined);
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
  } else if (index !== undefined && index >= loadedStart) {
    messages[index - loadedStart] = next;
    virtualList?.updateItem(rowKey(next), next);
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
    const element = document.createElement("div");
    element.className = "boundary-slot";
    element.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "boundary-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "boundary-slot-label";
    element.append(spinner, label);
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
  if (wanted === edgeSlotRequested) return;
  edgeSlotRequested = wanted;
  if (!wanted) edgeSlotElement = null;
  virtualList?.setEdgeSlot("start", wanted ? edgeSlotSpec : null);
}

function setEdgeState(state: EdgeState): void {
  window.clearTimeout(edgeHideTimer);
  edgeHideTimer = 0;
  edgeState = state;
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

  // Simulated fetch latency; a real host would await its data source here.
  // The epoch check discards a load that outlives its conversation (a
  // provider switch or history clear mid-timeout).
  const epoch = conversationEpoch;
  const fetched = new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve(true);
    }, LOAD_OLDER_DELAY_MS);
    function cancel(): void {
      window.clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
  const load = fetched
    .then(async (ready) => {
      if (!ready || epoch !== conversationEpoch) return;
      // A boot-time reach callback can run before createVirtualList returns.
      const list = virtualList;
      if (!list) return;
      // Fetching may finish during a glide. Delay rendering and measurement,
      // not just the prepend commit: a large image-rich page can otherwise
      // block animation frames even though its DOM is off the scroll surface.
      await list.updateWindow(() => {
        if (epoch !== conversationEpoch) return null;
        const start = Math.max(0, loadedStart - loadChunkCount());
        const nextStart = start - (start % MESSAGES_PER_DAY);
        return {
          items: rowsForRuntime(transcript.slice(nextStart)),
          anchor: "viewport",
          onCommit: () => {
            loadedStart = nextStart;
            refreshLoadedWindow();
            stickyHeaders?.refresh();
          },
        };
      }, signal);
    })
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

// --- Conversations ----------------------------------------------------------

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

// Each provider owns a fully separate conversation: the simulated side reseeds
// the template spine + synthetic branches, the OpenAI side reloads the history
// persisted in IndexedDB as a linear chain. Switching swaps all of it.
// Bumped on every conversation swap so an in-flight send's finally block can
// tell it is finishing against a conversation that no longer exists — its
// persistence must not write the other provider's transcript into the history.
let conversationEpoch = 0;

function resetConversationState(): void {
  userEdit = null;
  conversationEpoch++;
  // An old load's promise may finish after the replacement runtime mounts.
  // Its identity/epoch guards must not clear or block the new chat's loader.
  activeLoad = null;
  topBoundaryLoadSeen = false;
  tree.clear();
  tree.set(TREE_ROOT_ID, rootNode());
  transcript.length = 0;
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

// The seed-time snapshot of the persisted history. Seeding is synchronous, so
// the async IndexedDB read happens up front — at boot and before a provider
// switch — into this cache; an import replaces it outright.
let openAIHistory: readonly StoredTurn[] = [];
// A transcript imported under the simulated provider; session-only.
let importedConversation: ImportedTranscript | null = null;
let simulatedConversationChanged = false;
let userEdit: { id: number; epoch: number; text: string } | null = null;

function markConversationChanged(): void {
  if (getAISettings().provider === "simulated")
    simulatedConversationChanged = true;
}

// Loads the history snapshot and the fence languages its static render needs
// (loadLanguages ignores unknown names, so the raw info strings are safe to
// feed through).
async function prepareOpenAIConversation(
  epoch = conversationEpoch,
): Promise<boolean> {
  const history = await loadOpenAIHistory();
  if (epoch !== conversationEpoch) return false;
  const languages = historyFenceLanguages(history);
  if (languages.length > 0) await loadLanguages(languages);
  if (epoch !== conversationEpoch) return false;
  openAIHistory = history;
  return true;
}

function seedStoredTurns(turns: readonly StoredTurn[]): void {
  for (const turn of turns) {
    addTreeChild(
      activeLeafId(),
      createMessage({
        role: turn.role,
        markdown: turn.markdown,
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
        ...(turn.responseState ? { responseState: turn.responseState } : {}),
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
      message: { ...node.message, id: node.id },
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
    importedTree ?? (simulated ? importedConversation?.tree : null);
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
  rebuildActiveTranscript();
  loadedStart = Math.max(0, transcript.length - loadChunkCount());
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
  const epoch = conversationEpoch;
  repaintAfterReplacement(viewport, () => epoch === conversationEpoch);
}

/**
 * Where a loaded conversation lands — at boot and after every reload (a
 * provider switch, an import, a restore, a history clear). The default is
 * the end of the last exchange as a finished stream leaves it: the last
 * prompt pinned (I5: the reserve holds space under a short reply, so the
 * end is the prompt at the top with its reply below), then the end — a
 * reply taller than the viewport needs no reserve, and the end is its
 * bottom, the prompt above. The alternative, and a conversation without
 * a prompt, land at the bare end.
 */
function landConversation(): void {
  let key: string | null = null;
  if (landingMode === "prompt") {
    for (let i = transcript.length - 1; i >= 0 && key === null; i--) {
      const message = transcript[i];
      if (message?.role === "user") key = String(message.id);
    }
  }
  if (key === null) {
    void virtualList?.scrollTo("end");
    return;
  }
  // The command settles held work before it resolves the key (a reload
  // during a glide holds its snapshot until then), so the key needs no
  // committed position here; a key outside the loaded window fails the
  // command and leaves the end landing the snapshot made.
  void virtualList?.scrollTo(key, {
    align: "start",
    offset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
  });
  void virtualList?.scrollTo("end");
}

// Switches the active version of a branched message: rewrites the active path
// from that message down. Prefix keys are unchanged, so the runtime reuses
// the DOM above the branch point and its surviving-anchor rule preserves the
// reading position through the swap.
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
  const promptInset = stickyEnabled ? DAY_HEADER_HEIGHT : 0;
  const position = virtualList?.positionOf(String(messageId));
  const pinnedPrompt =
    node.message?.role === "user" &&
    position != null &&
    Math.abs(position.top - viewport.scrollTop - promptInset) < 1;
  const replacementId = parent.childrenIds[nextSelected];
  parent.selectedChildIndex = nextSelected;
  rebuildActiveTranscript();
  // Keep the branch row inside the loaded window even if the new path is
  // shorter than the old loadedStart.
  if (branchIndex >= 0) loadedStart = Math.min(loadedStart, branchIndex);
  // A date-boundary change can remove the header directly above this prompt.
  // Keep its replacement below the sticky band instead of anchoring a prefix
  // row whose position no longer determines the prompt's visible offset.
  pushItems(
    pinnedPrompt && replacementId !== undefined
      ? { key: String(replacementId), offset: promptInset }
      : undefined,
  );
  syncMetrics();
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
  while (removed.length > 0) {
    const id = removed.pop();
    if (id === undefined) break;
    const child = tree.get(id);
    if (child) removed.push(...child.childrenIds);
    tree.delete(id);
    htmlCache.delete(String(id));
  }
  rebuildActiveTranscript();
  loadedStart = isVersion
    ? Math.min(loadedStart, index)
    : Math.max(0, transcript.length - loadChunkCount());
  refreshLoadedWindow();
  const turns = storedConversation();
  if (getAISettings().provider === "openai") {
    openAIHistory = turns;
    saveOpenAIHistory(turns);
  } else {
    importedConversation = { turns, tree: null };
  }
  setEdgeState("hidden");
  if (isVersion) pushItems();
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
const TRAILING_IMAGE_RE = new RegExp(`${GENERATED_IMAGE_PATTERN}$`);

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
  const trimmed = message.markdown.trimEnd();
  return TRAILING_IMAGE_RE.test(trimmed) ? `${trimmed}\n\n` : trimmed;
}

// A finished row: the static markdown render plus, when the message has
// sibling versions, the navigator that switches between them.
function buildStaticRow(message: Message): HTMLElement {
  // Use the streaming segment layout even for legacy/simulated calls without
  // offsets. A grouped tool grid has different spacing and shifts on first text.
  const ordered =
    message.role === "assistant" && Boolean(message.toolCalls?.length);
  const row = ordered
    ? buildChatRow({ ...message, toolCalls: undefined }).row
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

function buildStreamingRow(message: Message): HTMLElement {
  const { row, content } = buildChatRow({ ...message, toolCalls: undefined });
  const handle = createMessageContent(content, cursorMode);
  handle.update(message, streamingDisplayText(message), true);
  streamingViewers.set(row, handle);
  return row;
}

function buildRow(message: Message): HTMLElement {
  const row =
    message.status === "streaming"
      ? buildStreamingRow(message)
      : buildStaticRow(message);
  if (message.role === "user") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-delete-btn";
    button.title = "Delete this message version and its replies";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "dialog");
    button.innerHTML =
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="M3 5h14M8 2.5h4M5 5l.8 12h8.4L15 5M8 8v6M12 8v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const actions = document.createElement("div");
    actions.className = "message-user-actions";
    actions.append(button);
    row.prepend(actions);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-edit-btn";
    edit.title = "Edit message";
    edit.setAttribute("aria-label", edit.title);
    edit.innerHTML =
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="m12.5 3.5 4 4M3 17l4.5-1 9-9a2.8 2.8 0 0 0-4-4l-9 9L3 17Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.after(edit);
    if (userEdit?.id === message.id && userEdit.epoch === conversationEpoch)
      buildUserEditor(row, message);
  }
  row.dataset.key = String(message.id);
  row.dataset.toolsig = toolSignature(message);
  syncMessageActions(row, message);
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
  const submit = () => {
    if (userEdit?.id !== message.id || userEdit.epoch !== conversationEpoch)
      return;
    if (!editor.innerText.trim() && !message.attachments?.length) return;
    void handleSend({
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
    row.querySelector<HTMLElement>(".message-edit-input")?.focus();
    return;
  }
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

function syncMessageActions(row: HTMLElement, message: Message): void {
  if (message.role !== "assistant") return;
  const info = versionInfo(message.id);
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
      show: true,
      path: "M16.5 8a6.5 6.5 0 1 0 .1 3M16.5 3.5V8H12",
    },
    {
      className: "message-version-delete-btn",
      label: "Delete response version",
      show: info !== null,
      path: "M3 5h14M8 2.5h4M5 5l.8 12h8.4L15 5M8 8v6M12 8v6",
    },
  ];
  for (const action of definitions) {
    const existing = actions.querySelector<HTMLButtonElement>(
      `.${action.className}`,
    );
    if (!action.show) {
      existing?.remove();
      continue;
    }
    const button = existing ?? document.createElement("button");
    button.disabled = streamAbort !== null || preparingConversation;
    if (!existing) {
      button.type = "button";
      button.className = action.className;
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      if (action.className === "message-version-delete-btn")
        button.setAttribute("aria-haspopup", "dialog");
      button.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="${action.path}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      actions.append(button);
    }
  }
}

function syncRoleLabel(element: HTMLElement, message: Message): void {
  const label = element.querySelector<HTMLElement>(".role-label");
  if (label && label.dataset.status !== message.status) {
    setRoleLabel(label, message);
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
    // live viewer (a "thinking" row, a static one) rebuilding is cheap.
    if (!handle) return null;
    element.dataset.toolsig = signature;
  }
  if (message.status === "streaming") {
    // A row that was mounted as "thinking" has no live viewer yet: rebuild.
    if (!handle) return null;
    syncRoleLabel(element, message);
    handle.update(message, streamingDisplayText(message), true);
    return element;
  }
  // Stream just ended on a still-live row: finalize the viewer in place
  // (isStreaming:false morphs the DOM rather than replacing it), so a text
  // selection inside the message survives. The row stays a live viewer until
  // it unmounts, then remounts static.
  if (handle) {
    syncRoleLabel(element, message);
    handle.update(message, message.markdown, false);
    return element;
  }
  return null;
}

// Live viewers are torn down when the runtime is done with the element for
// good (its key removed, the row replaced, the snapshot superseded, or the
// list disposed) via onDestroy; the animation lookup is pruned there too.
function handleRowDestroy(element: HTMLElement): void {
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

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function syncScrollButtons(state: VirtualListState): void {
  setHiddenIfChanged(scrollTopBtn, state.atStart && !canLoadOlderMessages());
  // Following to the end will get there on its own; following under
  // "keep-start" stops at the reply's start, and the end may well be off
  // screen — the button is the way there.
  const headedToEnd = state.following && followMode === "end";
  setHiddenIfChanged(
    scrollBottomBtn,
    state.atEnd || headedToEnd || sendGlideActive,
  );
}

function syncMetrics(state = virtualList?.state): void {
  if (!state) return;
  const loadedRange =
    messages.length === 0
      ? "loaded 0-0/0"
      : `loaded ${formatCount(loadedStart + 1)}-${formatCount(transcript.length)}/${formatCount(transcript.length)}`;
  const topStatus = loadingTop
    ? "loading top"
    : canLoadOlderMessages()
      ? "top"
      : "none";
  const mountedEnd = Math.max(state.start, state.end - 1);

  const windowText = `${loadedRange} · load ${topStatus}`;
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

// The reply to stream for a prompt: the next of the rotation, or the pinned
// fast long-form variant.
function replyFor(prompt = ""): ReplyVariant {
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
  for (const token of tokenize(reply.markdown)) {
    if (abort.cancelled) return;
    updateMessage(messageId, (message) => {
      message.markdown += token;
    });
    due += delayRange.min + Math.random() * (delayRange.max - delayRange.min);
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

/** A call still "running" when its stream ended never finished: errored. */
function settledToolCall(toolCall: ChatToolCall): ChatToolCall {
  return toolCall.status === "running"
    ? { ...toolCall, status: "error" }
    : toolCall;
}

// Persist the whole active branch, including API state, not the virtualized
// window. Local message ids are reassigned on the next load.
function storedConversation(): StoredTurn[] {
  const turns: StoredTurn[] = [];
  for (const message of transcript) {
    if (
      message.markdown === "" &&
      !message.responseState &&
      !message.attachments?.length &&
      !message.toolCalls?.length
    )
      continue;
    // A cancel can leave a call mid-flight; store it as errored.
    const toolCalls = message.toolCalls?.map(settledToolCall);
    turns.push({
      role: message.role,
      markdown: message.markdown,
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(message.responseState
        ? { responseState: message.responseState }
        : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(message.sentAt !== undefined ? { sentAt: message.sentAt } : {}),
    });
  }
  return turns;
}

function persistOpenAIConversation(): void {
  saveOpenAIHistory(storedConversation());
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
      buildResponseContext(transcript, contextTurns, model),
      { apiKey, model, tools, reasoningSummary },
      abortLink.signal,
    )) {
      if (abort.cancelled) return;
      updateMessage(messageId, (message) => {
        // The row stays "thinking" until the first real activity arrives.
        if (!started) message.status = "streaming";
        switch (chunk.kind) {
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
      error instanceof TypeError
        ? `${error.message} — the response was unreadable. If the browser console shows a 401, the API rejected the key (re-paste it in the AI settings — keys are stored per browser); otherwise check content blockers, VPN/proxy, or the network tab.`
        : error instanceof Error
          ? error.message
          : String(error);
    updateMessage(messageId, (message) => {
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

function borderBlockSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0)
  );
}

function autosize(): void {
  // Measuring at the minimum textarea height must not temporarily expand the
  // chat viewport: WebKit clamps its bottom scroll position during that layout,
  // even when the textarea's final height is unchanged (no resize delivery).
  const composer = promptInput.parentElement;
  const previousMinHeight = composer?.style.minHeight ?? "";
  if (composer)
    composer.style.minHeight = `${composer.getBoundingClientRect().height}px`;
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
  if (composer) composer.style.minHeight = previousMinHeight;
}

function setStreamingUI(streaming: boolean): void {
  viewport.classList.toggle("is-streaming", streaming);
  for (const button of viewport.querySelectorAll<HTMLButtonElement>(
    ".message-refresh-btn, .message-version-delete-btn",
  )) {
    button.disabled = streaming || preparingConversation;
  }
  sendBtn.textContent = streaming ? "Stop" : "Send";
  sendBtn.classList.toggle("stop-btn", streaming);
  sendBtn.disabled =
    !streaming && (readingAttachments || preparingConversation);
  attachBtn.disabled = streaming || readingAttachments || preparingConversation;
}

function renderPendingAttachments(): void {
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

async function handleSend(action?: SendAction): Promise<void> {
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

  const promptInset = stickyEnabled ? DAY_HEADER_HEIGHT : 0;
  const originalPosition = originalPrompt
    ? virtualList?.positionOf(String(originalPrompt.id))
    : undefined;
  const alreadyPinned =
    originalPosition != null &&
    Math.abs(originalPosition.top - viewport.scrollTop - promptInset) < 1;

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
  const useOpenAI = getAISettings().provider === "openai";
  const sendEpoch = conversationEpoch;
  const persistTurns = () => {
    if (useOpenAI && sendEpoch === conversationEpoch) {
      persistOpenAIConversation();
    }
  };

  try {
    // New turns use the real clock in both providers. The built-in sample
    // ends yesterday, so the first simulated send opens a Today section.
    const sentAt = Date.now();
    const userMessage =
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
      addTreeChild(previous.parentId, userMessage);
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
    // A new date row may be inserted above a refreshed/edited prompt. If it
    // is already pinned, preserve that row rather than the preceding reply
    // behind the sticky band, which would move the prompt down by a header.
    pushItems(
      alreadyPinned
        ? { key: String(userMessage.id), offset: promptInset }
        : "viewport",
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
    const pinCommand =
      virtualList?.scrollTo(String(userMessage.id), {
        align: "start",
        behavior: alreadyPinned ? "auto" : "smooth",
        duration: NEW_MESSAGE_SCROLL_DURATION_MS,
        // Under the floating day pill, not behind it.
        offset: promptInset,
      }) ?? Promise.resolve(false);
    void pinCommand.then(() => {
      if (sendEpoch === conversationEpoch && streamAbort === abort)
        endSendGlide();
    });
    if (shouldFlyIn) {
      await flyInRows([userMessage.id], abort);
      if (abort.cancelled) return;
    }
    // Streaming begins only after the pin command resolves. An interrupted
    // command (the user took ownership mid-glide) still resolves — the
    // stream then proceeds without follow, which is exactly their intent.
    await pinCommand;
    if (abort.cancelled) return;

    if (useOpenAI) {
      await streamOpenAIResponse(assistantId, abort);
    } else {
      const reply = replyFor(text);
      await wait(instantReplies ? 0 : reply.thinkingDelayMs, abort);
      if (abort.cancelled) return;

      updateMessage(assistantId, (message) => {
        message.status = "streaming";
      });
      await streamResponse(reply, assistantId, abort);
    }
  } finally {
    if (sendEpoch === conversationEpoch && assistantId !== null) {
      updateMessage(assistantId, (message) => {
        message.status = abort.cancelled ? "cancelled" : "done";
      });
    }
    // The finished (or cancelled-partial) assistant turn joins the history;
    // empty turns are filtered out during serialization.
    persistTurns();
    if (streamAbort === abort) {
      endSendGlide();
      streamAbort = null;
      setStreamingUI(false);
      if (virtualList) syncScrollButtons(virtualList.state);
    }
  }
}

// --- Boot -------------------------------------------------------------------

bindThemeButtons(refreshTheme);
initAISettingsPanel({
  onProviderChange: (provider) => {
    if (provider === "openai") {
      // Stop the old provider immediately; sending its still-mounted history
      // under the newly selected provider would cross conversation ownership.
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
    // Only the OpenAI conversation is rendered from that history; a clear
    // while the simulated transcript is showing needs no repaint.
    if (getAISettings().provider === "openai") reloadConversation();
  },
  canRestoreConversation: () =>
    importedConversation !== null || simulatedConversationChanged,
  onRestoreConversation: () => {
    importedConversation = null;
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
  const inset = stickyEnabled ? DAY_HEADER_HEIGHT : 0;
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
    offset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
  });
  return true;
}

/** A modifier click (⌘ on a Mac, Ctrl elsewhere) steps by prompt instead of jumping to the edge. */
function stepsByPrompt(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

scrollTopBtn.addEventListener("click", (event) => {
  if (stepsByPrompt(event) && jumpToPrompt("previous")) return;
  // Targets the currently committed snapshot only. If older history loads
  // while the glide runs, the prepend commits — without movement — when
  // the phase settles; another press continues from there.
  void virtualList?.scrollTo("start", {
    behavior: "smooth",
    duration: CHAT_SCROLL_DURATION_MS,
  });
});

scrollBottomBtn.addEventListener("click", (event) => {
  if (stepsByPrompt(event) && jumpToPrompt("next")) return;
  // Landing at the end re-engages end-follow, so a click during a stream
  // resumes following (the runtime's follow state, not demo bookkeeping).
  void virtualList?.scrollTo("end", { behavior: "smooth" });
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
  if (files.length === 0) return;
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
    void handleSend();
  }
});
sendBtn.addEventListener("click", () => {
  void handleSend();
});
document.addEventListener("keydown", (event) => {
  if (deleteDialog.open) return;
  if (event.key === "Escape" && streamAbort) {
    event.preventDefault();
    cancelStream(streamAbort);
  }
});

const deleteDialog = mustGet("delete-message-dialog", HTMLDialogElement);
const deletionStatus = mustGet("deletion-status", HTMLElement);
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
  const refresh = event.target.closest<HTMLButtonElement>(
    ".message-refresh-btn",
  );
  if (refresh && !refresh.disabled) {
    const row = refresh.closest<HTMLElement>(".message.assistant");
    if (row)
      void handleSend({
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
  const button = event.target.closest<HTMLButtonElement>(
    ".message-delete-btn, .message-version-delete-btn",
  );
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
  mustGet("delete-message-dialog", HTMLDialogElement)
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

// Touch has no hover: reveal only the tapped message's action. Do not
// prevent the gesture, text selection, or links inside the bubble.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.pointerType === "mouse") return;
    const row =
      event.target instanceof Element
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
if (getAISettings().provider === "openai") await prepareOpenAIConversation();
seedActiveConversation();

/**
 * The one way a conversation is presented: a fresh runtime over the seeded
 * transcript — the boot, and every reload (a provider switch, an import, a
 * restore, a history clear) after disposing the previous one — landing
 * where the setting says. Reloading through the live runtime instead left
 * it carrying the old conversation's pin, follow intent, and held work.
 */
function mountConversation(): void {
  virtualList?.dispose();
  // A replacement owns its loader state: do not inherit the old chat's
  // invisible scrollback strip when all imported turns are already loaded.
  edgeSlotRequested = shouldMountEdgeSlot();
  edgeSlotElement = null;
  virtualList = createVirtualList<ChatRow>(viewport, {
    items: rowsForRuntime(),
    key: rowKey,
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
      return buildRow(row);
    },
    edgeSlots: { start: edgeSlotRequested ? edgeSlotSpec : null },
    // The product choice for a chat: the streaming reply keeps rendering under
    // a scroll (see the header). Structural changes above the anchor stay
    // settle-gated; one below it (a version switch) applies at once.
    scrollingUpdates: "live",
    followBehavior: "smooth",
    followMode,
    followInset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
    onState: (state, snapshot) => {
      syncScrollButtons(state);
      syncMetrics(state);
      // Publications also report mounted-range changes during scrolling.
      // Reuse the runtime's read instead of flushing layout after DOM writes.
      stickyHeaders?.refresh(snapshot.scrollTop);
    },
    // State can stay unchanged through a glide. Keep the header in the
    // same frame as each scroll write, including its release above the slot.
    onViewport: (snapshot) => stickyHeaders?.update(snapshot.scrollTop),
    onReachStart: loadOlderMessages,
    onDestroy: handleRowDestroy,
  });
  landConversation();
}

mountConversation();

// The sticky day header: a companion on the runtime's read queries.
stickyHeaders = createStickyHeaders({
  container: viewportWrap,
  viewport,
  headerKeys: dayHeaderKeys,
  positionOf: (key) => virtualList?.positionOf(key) ?? null,
  elementOf: (key) => virtualList?.elementOf(key) ?? null,
  renderHeader: (slot, ordinal) => {
    const label = dayHeaderRows()[ordinal]?.label ?? "";
    slot.replaceChildren(buildSectionHeader(label));
  },
});
// --- Export ------------------------------------------------------------------
// The readable active branch plus all other versions in hidden tree metadata.
function transcriptMarkdown(): string {
  const snapshot: TranscriptTree<Message> = {
    selectedRootId:
      selectedChildId(tree.get(TREE_ROOT_ID) ?? rootNode()) ?? null,
    nodes: [...tree.entries()].flatMap(([id, node]) =>
      node.message
        ? [
            {
              id,
              parentId: node.parentId,
              selectedChildId: selectedChildId(node) ?? null,
              message: node.message,
            },
          ]
        : [],
    ),
  };
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
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Safari needs the object URL alive past the click it is still handling.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
// browser, or the simulated transcript for this session.
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
  const useOpenAI = getAISettings().provider === "openai";
  const target = useOpenAI
    ? "the OpenAI history stored in this browser"
    : "the simulated conversation for this session";
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
    saveOpenAIHistory(turns);
  } else {
    importedConversation = imported;
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
  virtualList?.setFollowMode(followMode, stickyEnabled ? DAY_HEADER_HEIGHT : 0);
}
stickyToggle.addEventListener("change", () => {
  stickyEnabled = stickyToggle.checked;
  syncSticky();
  saveChatOptions();
});
syncSticky();

edgeLoaderSelect.addEventListener("change", () => {
  edgeLoaderMode = edgeLoaderSelect.value === "pill" ? "pill" : "slot";
  syncEdgeLoaderMode();
  saveChatOptions();
});
syncEdgeLoaderMode();

cursorSelect.value = cursorMode;
cursorSelect.addEventListener("change", () => {
  cursorMode = cursorSelect.value === "none" ? "none" : "bar";
  saveChatOptions();
  syncStreamingViewerOptions();
});
// A live reply takes a changed cursor choice at once.
function syncStreamingViewerOptions(): void {
  for (const row of rowById.values()) {
    streamingViewers.get(row)?.setCursor(cursorMode);
  }
}
landingSelect.value = landingMode;
landingSelect.addEventListener("change", () => {
  landingMode = landingSelect.value === "end" ? "end" : "prompt";
  saveChatOptions();
});
autoscrollSelect.value = followMode;
autoscrollSelect.addEventListener("change", () => {
  followMode = autoscrollSelect.value === "keep-start" ? "keep-start" : "end";
  virtualList?.setFollowMode(followMode, stickyEnabled ? DAY_HEADER_HEIGHT : 0);
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

const imagePreview = createChatImagePreview(viewport, () => transcript);
window.addEventListener("pagehide", () => imagePreview.dispose());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

watchSystemTheme(refreshTheme);
