import {
  createVirtualList,
  type EdgeSlot,
  type VirtualList,
  type VirtualListState,
} from "../../src/virtual-list.js";
import { conversation } from "../shared/chat-data.js";
import {
  type AssistantStatus,
  buildChatItem,
  buildChatRow,
  buildSectionHeader,
  syncToolCalls,
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

// The demo is the runtime's API pressure test: the full streaming chat —
// send flow with pin-to-top, end-follow through streams, scrollback loading,
// version branches, live tool panels — hosted on the runtime's public
// surface (setItems / scrollTo / remeasure / setEdgeSlot / positionOf /
// elementOf / state) with no escape hatch into its internals.
//
// The message data is immutable-by-replacement: every change clones the
// message object and pushes a fresh snapshot through setItems. The runtime's
// keyed renderer re-renders exactly the changed rows (render(item, existing)),
// and end-compatible snapshots keep end-follow engaged while streaming.
//
// On the v2 runtime (docs/lean-core.md): every row is premeasured
// off-scroller before it commits, structural changes (scrollback prepends,
// new turns) commit only when the scroll phase settles, and the streaming
// reply runs under `scrollingUpdates: "live"` — its tokens render in place
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
//   the runtime's committed positions, which never move under a gesture.

interface Message {
  id: number;
  role: "user" | "assistant";
  markdown: string;
  status?: AssistantStatus;
  toolCalls?: ChatToolCall[];
  /** When the message was sent (epoch ms). Real turns only; the canned
   * transcript is undated and falls into synthetic days. */
  sentAt?: number;
}

/** A day separator row, interleaved into the runtime's items. */
interface DayHeader {
  kind: "day";
  day: number;
  label: string;
}

type ChatRow = Message | DayHeader;

function isDayHeader(row: ChatRow): row is DayHeader {
  return "kind" in row && row.kind === "day";
}

function rowKey(row: ChatRow): string {
  return isDayHeader(row) ? `day:${row.day}` : String(row.id);
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
// The send's pace: a one-viewport hop (a send from the bottom) lands in this
// time, and a send from anywhere else — across the whole list — decelerates
// through that very same landing after an approach of at most this long.
// The buttons' glides use the runtime's quicker default landing.
const SEND_SCROLL_DURATION_MS = 650;
// Synthetic days over the transcript: one separator per this many messages.
const MESSAGES_PER_DAY = 12;
// The in-flow scrollback slot's fixed height (main's boundary slot).
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
// After a chunk loads with more history remaining, the loading pill lingers
// briefly instead of hiding — a user still scrolling back re-enters the
// edge zone within this window, and hiding between chunks reads as a
// flashing loader.
const EDGE_HIDE_LINGER_MS = 400;

const demoParams = new URLSearchParams(location.search);
let edgeLoaderMode: "slot" | "pill" =
  demoParams.get("edge") === "pill" ? "pill" : "slot";
let stickyEnabled = demoParams.get("sticky") !== "off";
const instantReplies =
  demoParams.has("instant") || demoParams.get("stream") === "instant";
const forceFastLongReply =
  demoParams.has("fast-long") || demoParams.get("stream") === "fast-long";
const viewport = mustGet("viewport");
const viewportWrap = viewport.parentElement as HTMLElement;
const promptInput = mustGet("prompt", HTMLTextAreaElement);
const sendBtn = mustGet("send-btn", HTMLButtonElement);
const scrollTopBtn = mustGet("scroll-top-btn", HTMLButtonElement);
const scrollBottomBtn = mustGet("scroll-bottom-btn", HTMLButtonElement);
const edgeLoaderToggle = mustGet("edge-loader-toggle", HTMLButtonElement);
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
const streamingViewers = new WeakMap<HTMLElement, MarkdownViewerHandle>();
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
function refreshLoadedWindow(): void {
  loadedStart = Math.min(Math.max(0, loadedStart), transcript.length);
  // The window starts on a day boundary: a scrollback load then prepends
  // whole days above the first loaded day's header, never between a header
  // and its messages.
  loadedStart -= loadedStart % MESSAGES_PER_DAY;
  messages = transcript.slice(loadedStart);
  transcriptIndexById.clear();
  transcript.forEach((message, index) => {
    transcriptIndexById.set(message.id, index);
  });
}

// Assigned at boot; callbacks that can fire during the boot transaction
// (onReachStart on a short conversation) must tolerate it being unset.
let virtualList: VirtualList<ChatRow> | undefined;
// Assigned right after the list; onState may fire before then.
let stickyHeaders: StickyHeaders | undefined;

// --- Day separators --------------------------------------------------------

const dayHeaders = new Map<number, DayHeader>();
let labeledFor = "";

// Two kinds of day share one number space, ordered along the transcript:
// - a dated message (a real OpenAI turn) belongs to its calendar day, keyed
//   by that day's local midnight in epoch ms;
// - an undated message belongs to a synthetic bucket of MESSAGES_PER_DAY
//   consecutive messages (the canned transcript), or — in a real
//   conversation whose older turns were stored before dates existed — to
//   one "Earlier" day that precedes every dated one.
const DAY_MS = 86_400_000;
const UNDATED_DAY = -1;

function localMidnight(at: number): number {
  const date = new Date(at);
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
  return getAISettings().provider === "openai";
}

function dayOf(message: Message): number {
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

/** Header objects are cached per day so their identity is stable across
 * snapshots; labels are relative to the last synthetic day and to today, so
 * a new day re-labels. */
function dayHeader(day: number): DayHeader {
  const labelBasis = `${lastDay()}:${localMidnight(Date.now())}`;
  if (labeledFor !== labelBasis) {
    dayHeaders.clear();
    labeledFor = labelBasis;
  }
  let header = dayHeaders.get(day);
  if (!header) {
    header = { kind: "day", day, label: dayLabel(day) };
    dayHeaders.set(day, header);
  }
  return header;
}

/** The loaded window with a day separator before each day's first message. */
function rowsForRuntime(): ChatRow[] {
  const rows: ChatRow[] = [];
  let current: number | undefined;
  for (const message of messages) {
    const day = dayOf(message);
    if (day !== current) {
      current = day;
      rows.push(dayHeader(day));
    }
    rows.push(message);
  }
  return rows;
}

function dayHeaderKeys(): string[] {
  return rowsForRuntime().filter(isDayHeader).map(rowKey);
}

/** One snapshot to the runtime; all data changes flow through here.
 * Returns the number of rows handed over (day separators included). */
function pushItems(anchor?: "auto" | "viewport" | "end" | "none"): number {
  refreshLoadedWindow();
  syncEdgeSlot();
  const rows = rowsForRuntime();
  virtualList?.setItems(rows, anchor ? { anchor } : undefined);
  return rows.length;
}

// The single mutation path: clones the message (the runtime re-renders rows
// whose item identity changed), writes the clone back into the tree,
// transcript, and window, and pushes the new snapshot.
function updateMessage(id: number, mutate: (message: Message) => void): void {
  const node = tree.get(id);
  if (!node?.message) return;
  const next = { ...node.message };
  mutate(next);
  node.message = next;
  const index = transcriptIndexById.get(id);
  if (index !== undefined) transcript[index] = next;
  htmlCache.delete(String(id));
  pushItems();
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
      ? "At the top"
      : "";
}

// --- The in-flow scrollback slot (edge loader "slot" mode) -------------------

let edgeSlotElement: HTMLElement | null = null;
let edgeSlotRequested = false;

function applyEdgeSlotState(element: HTMLElement, state: EdgeState): void {
  // In the flow, "hidden" is an invisible strip (main's idle slot); "At the
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
  edgeLoaderToggle.classList.toggle("active", inFlow);
  edgeLoaderToggle.setAttribute("aria-pressed", String(inFlow));
  const label = inFlow ? "Edge loader: in flow" : "Edge loader: floating pill";
  edgeLoaderToggle.title = label;
  edgeLoaderToggle.setAttribute("aria-label", label);
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
// A prepend handed to the runtime but not yet committed (the runtime
// defers structural updates while a scroll phase is active). The loader —
// pill included — stays up until onState confirms the committed count, or
// the user reaches the old top with no loader in sight and rubber-bands
// against a ghost end.
let pendingPrepend: { count: number; finish: () => void } | null = null;

// Loads one older chunk; resolves once the prepend has actually been
// COMMITTED by the runtime — which may hold it until the active scroll
// phase settles. The prepend preserves the reading position (I1), and the
// runtime re-arms the reach-start signal once the viewport is past the
// exit zone.
function loadOlderChunk(signal?: AbortSignal): Promise<void> {
  if (activeLoad) return activeLoad;
  if (!canLoadOlderMessages()) return Promise.resolve();
  loadingTop = true;
  topBoundaryLoadSeen = true;
  setEdgeState("loading");
  syncMetrics();

  // Simulated fetch latency; a real host would await its data source here.
  // The epoch check discards a load that outlives its conversation (a
  // provider switch or history clear mid-timeout).
  const epoch = conversationEpoch;
  activeLoad = new Promise((resolve) => {
    const finish = () => {
      pendingPrepend = null;
      loadingTop = false;
      activeLoad = null;
      if (epoch === conversationEpoch) {
        if (!canLoadOlderMessages()) setEdgeState("no-more");
        else scheduleEdgeHide(); // Linger: the next chunk may follow at once.
        syncMetrics();
      }
      resolve();
    };
    const timer = window.setTimeout(() => {
      if (epoch !== conversationEpoch) {
        finish();
        return;
      }
      loadedStart = Math.max(0, loadedStart - loadChunkCount());
      // A page load preserves the reading position — never an end-follow,
      // even when the viewport happens to sit at the bottom.
      const handed = pushItems("viewport");
      if (virtualList && virtualList.state.count < handed) {
        // Deferred by the runtime: stay in the loading state until the
        // commit is confirmed through onState.
        pendingPrepend = { count: handed, finish };
      } else {
        finish();
      }
    }, LOAD_OLDER_DELAY_MS);
    // The runtime aborts a reach's signal when the user reaches the other
    // edge (or on dispose): the simulated fetch dies with it, exactly as a
    // real fetch(url, { signal }) would, and the loader state clears.
    signal?.addEventListener("abort", () => {
      if (activeLoad === null) return;
      window.clearTimeout(timer);
      finish();
    });
  });
  return activeLoad;
}

// onReachStart initiates loading; the prepend itself flows through
// setItems, which the runtime defers while a scroll phase (gesture or
// glide) is active and commits — anchored, without movement — when the
// phase truly settles. The demo never orchestrates scroll phases.
function loadOlderMessages(signal?: AbortSignal): void {
  if (activeLoad) return;
  if (!canLoadOlderMessages()) {
    if (topBoundaryLoadSeen) setEdgeState("no-more");
    return;
  }
  void loadOlderChunk(signal);
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

function createTemplateMessages(count: number): Message[] {
  const start = transcript.length;
  const nextMessages: Message[] = [];
  for (let offset = 0; offset < count; offset++) {
    const templateId = (start + offset) % conversation.length;
    const sample = at(conversation, templateId);
    nextMessages.push(createMessage({ ...sample }));
  }
  return nextMessages;
}

// Builds the linear spine from the conversation template, then grafts on the
// synthetic version branches above. The active path becomes the transcript.
function seedConversationTree(count: number): void {
  for (const message of createTemplateMessages(count)) {
    addTreeChild(activeLeafId(), message, { select: true });
  }
  seedSyntheticBranches();
}

function seedSyntheticBranches(): void {
  // A user prompt has to follow an assistant turn; bridge if the spine ended
  // on a user message so the seeded turn always reads naturally.
  let anchorId = activeLeafId();
  if (tree.get(anchorId)?.message?.role === "user") {
    anchorId = addTreeChild(
      anchorId,
      createMessage({ role: "assistant", markdown: BRANCH_BRIDGE_REPLY }),
      { select: true },
    );
  }

  // Edit scenario: one prompt, two versions, each with its own reply branch.
  const userV1 = createMessage({ role: "user", markdown: BRANCH_USER_V1 });
  const userV2 = createMessage({ role: "user", markdown: BRANCH_USER_V2 });
  addTreeChild(anchorId, userV1, { select: true });
  addTreeChild(anchorId, userV2, { select: false });

  // userV2 → a single reply.
  addTreeChild(
    userV2.id,
    createMessage({ role: "assistant", markdown: BRANCH_REPLY_V2 }),
    { select: true },
  );

  // userV1 → a reply with three regenerations (the regenerate scenario).
  BRANCH_REGEN_REPLIES.forEach((markdown, index) => {
    addTreeChild(userV1.id, createMessage({ role: "assistant", markdown }), {
      select: index === 0,
    });
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
  conversationEpoch++;
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
// switch — into this cache.
let openAIHistory: readonly StoredTurn[] = [];

// Loads the history snapshot and the fence languages its static render needs
// (loadLanguages ignores unknown names, so the raw info strings are safe to
// feed through).
async function prepareOpenAIConversation(): Promise<void> {
  openAIHistory = await loadOpenAIHistory();
  const languages = historyFenceLanguages(openAIHistory);
  if (languages.length > 0) await loadLanguages(languages);
}

function seedOpenAIConversation(): void {
  for (const turn of openAIHistory) {
    addTreeChild(
      activeLeafId(),
      createMessage({
        role: turn.role,
        markdown: turn.markdown,
        ...(turn.toolCalls
          ? { toolCalls: cloneToolCalls(turn.toolCalls) }
          : {}),
        ...(turn.sentAt !== undefined ? { sentAt: turn.sentAt } : {}),
      }),
      { select: true },
    );
  }
}

function seedActiveConversation(): void {
  resetConversationState();
  if (getAISettings().provider === "openai") {
    seedOpenAIConversation();
  } else {
    seedConversationTree(INITIAL_TRANSCRIPT_COUNT);
  }
  rebuildActiveTranscript();
  loadedStart = Math.max(0, transcript.length - loadChunkCount());
  refreshLoadedWindow();
}

// Swaps the rendered conversation after a provider change or a history clear:
// cancel any live stream, rebuild the state, and land at the bottom of the
// other conversation with one explicitly end-anchored snapshot.
function reloadConversation(): void {
  if (streamAbort) cancelStream(streamAbort);
  // The end command below cancels any in-flight glide so it cannot keep
  // scrolling into the new conversation.
  seedActiveConversation();
  setEdgeState("hidden");
  pushItems("end");
  void virtualList?.scrollTo("end");
  syncMetrics();
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

  const branchIndex = transcriptIndexById.get(messageId) ?? -1;
  parent.selectedChildIndex = nextSelected;
  rebuildActiveTranscript();
  // Keep the branch row inside the loaded window even if the new path is
  // shorter than the old loadedStart.
  if (branchIndex >= 0) loadedStart = Math.min(loadedStart, branchIndex);
  pushItems();
  syncMetrics();
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

// A finished row: the static markdown render plus, when the message has
// sibling versions, the navigator that switches between them.
function buildStaticRow(message: Message): HTMLElement {
  const row = buildChatItem(message, htmlForMessage(message));
  appendVersionNav(row, message);
  return row;
}

function buildStreamingRow(message: Message): HTMLElement {
  const { row, content } = buildChatRow(message);
  // createMarkdownViewer takes over its host's children, so it gets a
  // dedicated wrapper rather than `content` (which also holds the role label
  // and tool calls).
  const host = document.createElement("div");
  host.className = "streaming-host";
  // The live viewer binds its own copy / table-copy click handler to its
  // root. The chat viewport also delegates those clicks (for static rows), so
  // stop the bubble here to keep both from firing on this one row. The
  // viewer's handler is bound deeper in the tree, so it has already run by
  // the time the event reaches here.
  host.addEventListener("click", (event) => event.stopPropagation());
  content.appendChild(host);
  const handle = createMarkdownViewer(host, {
    text: streamingDisplayText(message),
    isStreaming: true,
    // The viewer root rarely holds focus inside the list (the composer does),
    // so keep a solid block cursor instead of dimming to a hollow frame.
    unfocusedCursorStyle: "block",
  });
  streamingViewers.set(row, handle);
  return row;
}

function buildRow(message: Message): HTMLElement {
  const row =
    message.status === "streaming"
      ? buildStreamingRow(message)
      : buildStaticRow(message);
  row.dataset.key = String(message.id);
  row.dataset.toolsig = toolSignature(message);
  rowById.set(String(message.id), row);
  return row;
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
  const handle = streamingViewers.get(element);
  const signature = toolSignature(message);
  if (element.dataset.toolsig !== signature) {
    // A tool call changed on a live row: refresh its panel in place — a
    // rebuild would replace the viewer and its streaming cursor. Without a
    // live viewer (a "thinking" row, a static one) rebuilding is cheap.
    if (!handle) return null;
    syncToolCalls(element, message);
    element.dataset.toolsig = signature;
  }
  if (message.status === "streaming") {
    // A row that was mounted as "thinking" has no live viewer yet: rebuild.
    if (!handle) return null;
    syncRoleLabel(element, message);
    handle.update({ text: streamingDisplayText(message), isStreaming: true });
    return element;
  }
  // Stream just ended on a still-live row: finalize the viewer in place
  // (isStreaming:false morphs the DOM rather than replacing it), so a text
  // selection inside the message survives. The row stays a live viewer until
  // it unmounts, then remounts static.
  if (handle) {
    syncRoleLabel(element, message);
    handle.update({ text: message.markdown, isStreaming: false });
    return element;
  }
  return null;
}

// Live viewers are torn down when the runtime is done with the element for
// good (its key removed, the row replaced, the snapshot superseded, or the
// list disposed) via onDestroy; the animation lookup is pruned there too.
function handleRowDestroy(element: HTMLElement): void {
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
  scrollTopBtn.hidden = state.atStart && !canLoadOlderMessages();
  scrollBottomBtn.hidden = state.atEnd || state.following || sendGlideActive;
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

  windowStatus.textContent = `${loadedRange} · load ${topStatus}`;
  virtualListStatus.textContent = `dom ${formatCount(state.end - state.start)}/${formatCount(state.count)} · mounted ${formatCount(state.start)}-${formatCount(mountedEnd)} · height ${formatCount(state.totalSize)}px`;
}

function endSendGlide(): void {
  if (!sendGlideActive) return;
  sendGlideActive = false;
  if (virtualList) syncScrollButtons(virtualList.state);
}

// --- Simulated streaming ----------------------------------------------------

// Advances the response rotation and returns the variant to stream.
function advanceResponse(prompt = ""): ReplyVariant {
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

  const delayRange = reply.tokenDelayMs;
  for (const token of tokenize(reply.markdown)) {
    if (abort.cancelled) return;
    updateMessage(messageId, (message) => {
      message.markdown += token;
    });
    await wait(
      delayRange.min + Math.random() * (delayRange.max - delayRange.min),
      abort,
    );
  }
}

// --- OpenAI streaming -------------------------------------------------------

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

// Role, markdown, and settled tool calls persist; ids are reassigned on the
// next load.
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
      ...(message.sentAt !== undefined ? { sentAt: message.sentAt } : {}),
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
      updateMessage(messageId, (message) => {
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
        message.toolCalls = message.toolCalls.map((toolCall) =>
          toolCall.status === "running"
            ? { ...toolCall, status: "error" as const }
            : toolCall,
        );
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
    // Real turns are dated (the day separators show their calendar day);
    // the canned rotation stays undated in its synthetic days.
    const sentAt = useOpenAI ? { sentAt: Date.now() } : {};
    const userMessage = createMessage({
      role: "user",
      markdown: text,
      ...sentAt,
    });
    const assistantMessage = createMessage({
      role: "assistant",
      markdown: "",
      status: "thinking",
      // Real replies have no tool phase; the simulated set stays a prop of
      // the canned rotation only.
      ...(useOpenAI ? {} : { toolCalls: createSimulatedToolCalls() }),
      ...sentAt,
    });
    assistantId = assistantMessage.id;
    appendToActiveBranch([userMessage, assistantMessage]);
    // Persist the user turn immediately so a reload mid-stream keeps it (the
    // still-empty assistant placeholder is filtered out).
    persistTurns();
    // The append itself keeps the viewport put; the pinned glide below owns
    // the motion.
    pushItems("viewport");
    if (!shouldFlyIn) {
      fadeInRows([userMessage.id, assistantMessage.id], abort);
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
        behavior: "smooth",
        duration: SEND_SCROLL_DURATION_MS,
        // Under the floating day pill, not behind it.
        offset: stickyEnabled ? DAY_HEADER_HEIGHT : 0,
      }) ?? Promise.resolve(false);
    void pinCommand.then(endSendGlide);
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
      const reply = advanceResponse(text);
      await wait(instantReplies ? 0 : reply.thinkingDelayMs, abort);
      if (abort.cancelled) return;

      updateMessage(assistantId, (message) => {
        message.status = "streaming";
      });
      await streamResponse(reply, assistantId, abort);
    }
  } finally {
    if (assistantId !== null) {
      updateMessage(assistantId, (message) => {
        if (message.role === "assistant") {
          message.status = abort.cancelled ? "cancelled" : "done";
        }
      });
    }
    // The finished (or cancelled-partial) assistant turn joins the history;
    // empty turns are filtered out during serialization.
    persistTurns();
    endSendGlide();
    streamAbort = null;
    setStreamingUI(false);
    if (virtualList) syncScrollButtons(virtualList.state);
    // Focusing the composer collapses any text selection, so skip it while
    // the user is selecting text in a message — otherwise stream end clears
    // it.
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) promptInput.focus();
  }
}

// --- Boot -------------------------------------------------------------------

bindThemeButtons(refreshTheme);
initAISettingsPanel({
  onProviderChange: (provider) => {
    if (provider === "openai") {
      // Fence languages must be loaded before the history's static render.
      void prepareOpenAIConversation().then(() => reloadConversation());
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
});

scrollTopBtn.addEventListener("click", () => {
  // Targets the currently committed snapshot only. If older history loads
  // while the glide runs, the prepend commits — without movement — when
  // the phase settles; another press continues from there.
  void virtualList?.scrollTo("start", { behavior: "smooth" });
});

scrollBottomBtn.addEventListener("click", () => {
  // Landing at the end re-engages end-follow, so a click during a stream
  // resumes following (the runtime's follow state, not demo bookkeeping).
  void virtualList?.scrollTo("end", { behavior: "smooth" });
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
if (getAISettings().provider === "openai") await prepareOpenAIConversation();
seedActiveConversation();

edgeSlotRequested = shouldMountEdgeSlot();
virtualList = createVirtualList<ChatRow>(viewport, {
  items: rowsForRuntime(),
  key: rowKey,
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
  onState: (state) => {
    // A deferred prepend committed: close out the load it belongs to.
    if (pendingPrepend && state.count >= pendingPrepend.count) {
      pendingPrepend.finish();
    }
    syncScrollButtons(state);
    syncMetrics(state);
    // Positions change only at commits: re-read them for the sticky header.
    stickyHeaders?.refresh();
  },
  onReachStart: ({ signal }) => loadOlderMessages(signal),
  onDestroy: handleRowDestroy,
});

// The sticky day header: a companion on the runtime's read queries.
stickyHeaders = createStickyHeaders({
  container: viewportWrap,
  viewport,
  headerKeys: dayHeaderKeys,
  positionOf: (key) => virtualList?.positionOf(key) ?? null,
  elementOf: (key) => virtualList?.elementOf(key) ?? null,
  renderHeader: (slot, ordinal) => {
    const key = dayHeaderKeys()[ordinal];
    const day = Number(key?.slice("day:".length));
    slot.replaceChildren(buildSectionHeader(dayHeader(day).label));
  },
});
// --- Export ------------------------------------------------------------------
// The whole active branch (not just the loaded window) as one Markdown
// document: day separators become headings, a tool call a one-line note, a
// reply that never finished its status.
function transcriptMarkdown(): string {
  const lines: string[] = ["# streaming-chat transcript", ""];
  let currentDay: number | undefined;
  for (const message of transcript) {
    const day = dayOf(message);
    if (day !== currentDay) {
      currentDay = day;
      // A file is read later: a dated day gets its full date, not "Today".
      const label = isDatedDay(day)
        ? new Date(day).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : dayLabel(day);
      lines.push(`## ${label}`, "");
    }
    lines.push(`**${message.role === "user" ? "User" : "Assistant"}**`, "");
    for (const call of message.toolCalls ?? []) {
      lines.push(
        `> Tool call \`${call.name}\` (${call.status}, ${Math.round(call.durationMs)}ms)`,
        "",
      );
    }
    const body = message.markdown.trim();
    if (body) lines.push(body, "");
    else if (message.status && message.status !== "done") {
      lines.push(`_(${message.status})_`, "");
    }
  }
  return lines.join("\n");
}

function downloadTranscript(): void {
  const blob = new Blob([transcriptMarkdown()], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
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

const stickyToggle = mustGet("sticky-toggle", HTMLButtonElement);
function syncSticky(): void {
  stickyHeaders?.setEnabled(stickyEnabled);
  stickyToggle.classList.toggle("active", stickyEnabled);
  stickyToggle.setAttribute("aria-pressed", String(stickyEnabled));
  viewportWrap.classList.toggle("sticky-on", stickyEnabled);
}
stickyToggle.addEventListener("click", () => {
  stickyEnabled = !stickyEnabled;
  syncSticky();
});
syncSticky();

edgeLoaderToggle.addEventListener("click", () => {
  edgeLoaderMode = edgeLoaderMode === "slot" ? "pill" : "slot";
  syncEdgeLoaderMode();
});
syncEdgeLoaderMode();

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
      virtualList.remeasure(key, { anchor: "viewport" });
    }
  },
  { capture: true },
);

syncMetrics();
document.documentElement.classList.remove("booting");
promptInput.focus();

watchSystemTheme(refreshTheme);
