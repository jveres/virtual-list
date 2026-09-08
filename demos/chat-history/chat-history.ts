import { createPagedWindow, type PagedWindow } from "../../src/paging";
import {
  createVirtualList,
  type Edge,
  type ReachContext,
  type VirtualList,
} from "../../src/virtual-list";
import { buildChatItem, buildSectionHeader } from "../shared/chat-ui";
import {
  attachInteractions,
  initMarkdown,
  renderMarkdown,
} from "../shared/markdown";
import {
  createStickyHeaders,
  type StickyHeaders,
} from "../shared/sticky-headers";
import { applyDocumentTheme, watchSystemTheme } from "../shared/theme";
import {
  bindThemeButtons,
  mustGet,
  refreshTheme,
  setAttributeIfChanged,
  setTextIfChanged,
  syncThemeButtons,
} from "../shared/utils";
import {
  type HistoryMessage,
  type HistoryPage,
  type HistoryRow,
  HistorySource,
  MESSAGES_PER_DAY,
  PAGE_SIZE,
  projectHistory,
  RETAIN_MESSAGES,
} from "./source";
import "../shared/styles.css";
import "./history.css";

const HEADER_HEIGHT = 44;
const ENDPOINT_APPROACH_VIEWPORTS = 4;
const source = new HistorySource();
const viewport = mustGet("viewport");
const viewportWrap = mustGet("viewport-wrap");
const status = mustGet("history-status");
const indexInput = mustGet("index-input", HTMLInputElement);
const alignSelect = mustGet("align-select", HTMLSelectElement);
const behaviorSelect = mustGet("behavior-select", HTMLSelectElement);
const stickyToggle = mustGet("sticky-toggle", HTMLButtonElement);
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const groupLabel = (group: number): string =>
  dateFormat.format(Date.UTC(2025, 0, 1 + group));

let list: VirtualList<HistoryRow> | undefined;
let pager: PagedWindow<HistoryMessage, number> | undefined;
let sticky: StickyHeaders | undefined;
let rows: readonly HistoryRow[] = [];
let messages: readonly HistoryMessage[] = [];
let headerRows: readonly HistoryRow[] = [];
let navigation: AbortController | undefined;
let edgeRequests = new AbortController();
let stickyEnabled = true;
let loadingEdge: Edge | undefined;
let error = "";
let pageLoads = 0;
let liveElements = 0;
let createdElements = 0;
let disposed = false;
let pendingTailRefresh = false;

function render(row: HistoryRow): HTMLElement {
  const element =
    row.kind === "header"
      ? buildSectionHeader(groupLabel(row.group))
      : buildChatItem(row, renderMarkdown(row.markdown));
  if (row.kind === "message") {
    element.dataset.messageIndex = String(row.index);
    const label = document.createElement("span");
    label.className = "history-index";
    label.textContent = `#${row.index}`;
    element.querySelector(".role-label")?.append(label);
  }
  liveElements++;
  createdElements++;
  return element;
}

function makeEdge(edge: Edge): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-edge";
  button.dataset.edge = edge;
  button.addEventListener("click", () => {
    void load(edge);
  });
  return button;
}
const topLoader = makeEdge("start");
const bottomLoader = makeEdge("end");
function edgeSlots(page: Pick<HistoryPage, "start" | "end">) {
  return {
    start: page.start.available
      ? { key: "history-start", height: 48, render: () => topLoader }
      : null,
    end: page.end.available
      ? { key: "history-end", height: 48, render: () => bottomLoader }
      : null,
  };
}

function sync(): void {
  if (disposed) return;
  for (const [edge, button] of [
    ["start", topLoader],
    ["end", bottomLoader],
  ] as const) {
    const direction = edge === "start" ? "earlier" : "later";
    setTextIfChanged(
      button,
      loadingEdge === edge
        ? `Loading ${direction} messages…`
        : `Load ${direction} messages`,
    );
    const disabled = Boolean(navigation || loadingEdge);
    if (button.disabled !== disabled) button.disabled = disabled;
  }
  setAttributeIfChanged(indexInput, "max", String(source.total - 1));
  const text = `${source.total.toLocaleString()} messages · loaded #${messages[0]?.index ?? "–"}–${messages.at(-1)?.index ?? "–"} (${messages.length}/${RETAIN_MESSAGES}) · ${list ? list.state.end - list.state.start : 0} mounted${navigation ? " · locating…" : loadingEdge ? " · loading…" : ""}${error ? ` · ${error}` : ""}`;
  setTextIfChanged(status, text);
  setAttributeIfChanged(status, "title", text);
  setAttributeIfChanged(
    viewport,
    "aria-busy",
    String(Boolean(navigation || loadingEdge)),
  );
}

function adopt(
  nextMessages: readonly HistoryMessage[],
  nextRows: readonly HistoryRow[],
): void {
  messages = nextMessages;
  rows = nextRows;
  headerRows = rows.filter((row) => row.kind === "header");
  sticky?.refresh();
  sync();
}

function installPager(initial: HistoryPage): void {
  if (!list) return;
  pager?.dispose();
  pager = createPagedWindow({
    list,
    initial,
    key: (message) => message.key,
    maxItems: RETAIN_MESSAGES,
    project: (items) => projectHistory(items, rows),
    keysOf: (row) => (row.kind === "message" ? [row.key] : []),
    load: (request) => source.load(request),
    edgeSlots,
    onChange: adopt,
  });
}

async function load(edge: Edge, context?: ReachContext): Promise<boolean> {
  const active = pager;
  if (
    disposed ||
    !active ||
    navigation ||
    loadingEdge ||
    !active.canLoad(edge)
  ) {
    context?.complete();
    return false;
  }
  const lifetime = edgeRequests;
  loadingEdge = edge;
  error = "";
  sync();
  try {
    const committed = await active.load(edge, {
      signal: context
        ? AbortSignal.any([context.signal, lifetime.signal])
        : lifetime.signal,
      complete: () => context?.complete(),
    });
    if (committed) pageLoads++;
    return committed;
  } catch (reason) {
    if (lifetime.signal.aborted) return false;
    error = reason instanceof Error ? reason.message : String(reason);
    return false;
  } finally {
    if (edgeRequests === lifetime) {
      loadingEdge = undefined;
      sync();
    }
  }
}

type JumpOptions = {
  align?: "top" | "center" | "bottom";
  behavior?: "smooth" | "instant";
  edge?: Edge;
  /** Preserve a reading point when the simulated archive grows. */
  offset?: number;
  reload?: boolean;
};

async function jump(
  index: number,
  options: JumpOptions = {},
): Promise<boolean> {
  if (!list || disposed || !Number.isSafeInteger(index)) return false;
  index = Math.max(0, Math.min(index, source.total - 1));
  navigation?.abort();
  const active = new AbortController();
  navigation = active;
  edgeRequests.abort();
  edgeRequests = new AbortController();
  loadingEdge = undefined;
  error = "";
  sync();
  const current = (): boolean =>
    navigation === active && !active.signal.aborted && !disposed;
  const key = `message:${index}`;
  const topOffset =
    stickyEnabled || index % MESSAGES_PER_DAY === 0 ? HEADER_HEIGHT : 0;
  const smooth =
    options.behavior === "smooth" &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const oldTop = viewport.scrollTop;
  const reading = messages.find((message) => {
    const position = list?.positionOf(message.key);
    return position && position.top + position.height > oldTop;
  });
  const direction = index >= (reading?.index ?? index) ? 1 : -1;
  try {
    // Cancel any older glide immediately, before waiting for the source.
    await list.updateWindow(() => null, active.signal, { interrupt: true });
    if (!current()) return false;
    const missing = options.reload || !list.positionOf(key);
    if (missing) {
      const page = await source.around(index, active.signal);
      if (!current()) return false;
      const nextRows = projectHistory(page.items, rows);
      const approach = smooth
        ? direction *
          viewport.clientHeight *
          (options.edge ? ENDPOINT_APPROACH_VIEWPORTS : 1)
        : 0;
      const committed = await list.updateWindow(
        () => ({
          items: nextRows,
          // Stage within the fetched page, without materializing the gap.
          // Endpoint navigation needs several viewports of travel so the
          // shared glide includes its approach, not just its landing leg.
          // Indexed jumps retain their shorter, one-viewport approach.
          anchor: {
            key,
            offset: options.offset ?? topOffset + approach,
          },
          edgeSlots: edgeSlots(page),
          onCommit: () => {
            installPager(page);
            pageLoads++;
            adopt(page.items, nextRows);
          },
        }),
        active.signal,
        { interrupt: true },
      );
      if (!committed || !current()) return false;
    }
    const position = list.positionOf(key);
    if (!position || !current()) return false;
    const align = options.align ?? "top";
    const offset =
      options.offset ??
      (align === "center"
        ? (viewport.clientHeight - position.height) / 2
        : align === "bottom"
          ? viewport.clientHeight - position.height
          : topOffset);
    if (!options.edge && options.offset !== undefined) {
      return await list.updateWindow(
        ({ items }) => ({ items, anchor: { key, offset } }),
        active.signal,
        { interrupt: true },
      );
    }
    return await list.scrollTo(options.edge ?? key, {
      align: options.edge ? undefined : "start",
      offset,
      behavior: smooth ? "smooth" : "auto",
    });
  } catch (reason) {
    if (!current()) return false;
    error = reason instanceof Error ? reason.message : String(reason);
    return false;
  } finally {
    if (navigation === active) {
      navigation = undefined;
      sync();
      if (pendingTailRefresh) {
        pendingTailRefresh = false;
        await refreshTail();
      }
    }
  }
}

async function append(count = 100): Promise<void> {
  if (!list || disposed) return;
  source.append(count);
  sync();
  if (navigation) {
    pendingTailRefresh = true;
    return;
  }
  await refreshTail();
}

async function refreshTail(): Promise<void> {
  if (!list || disposed) return;
  // Earlier windows already have a forward continuation. Nothing in them
  // changes when new messages arrive at the remote end of the archive.
  if (pager?.canLoad("end") || messages.at(-1)?.index === source.total - 1)
    return;
  if (list.state.atEnd) {
    await jump(source.total - 1, { edge: "end", reload: true });
    return;
  }
  const top = viewport.scrollTop;
  for (const message of messages) {
    const position = list.positionOf(message.key);
    if (position && position.top + position.height > top) {
      await jump(message.index, { offset: position.top - top, reload: true });
      return;
    }
  }
}

function typedJump(): void {
  const index = indexInput.valueAsNumber;
  indexInput.setCustomValidity(
    Number.isSafeInteger(index) ? "" : "Enter a whole message number.",
  );
  if (!indexInput.reportValidity()) return;
  const align =
    alignSelect.value === "center" || alignSelect.value === "bottom"
      ? alignSelect.value
      : "top";
  void jump(index, {
    align,
    behavior: behaviorSelect.value === "smooth" ? "smooth" : "instant",
  });
}

bindThemeButtons(refreshTheme);
indexInput.addEventListener("input", () => indexInput.setCustomValidity(""));
mustGet("goto-btn").addEventListener("click", typedJump);
indexInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    typedJump();
  }
});
mustGet("top-btn").addEventListener("click", () => {
  void jump(0, { edge: "start", behavior: "smooth" });
});
mustGet("bottom-btn").addEventListener("click", () => {
  void jump(source.total - 1, { edge: "end", behavior: "smooth" });
});
mustGet("add-btn").addEventListener("click", () => {
  void append();
});
stickyToggle.addEventListener("click", () => {
  stickyEnabled = !stickyEnabled;
  sticky?.setEnabled(stickyEnabled);
  stickyToggle.classList.toggle("active", stickyEnabled);
  stickyToggle.setAttribute("aria-pressed", String(stickyEnabled));
});

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
const initial = await source.around(
  source.total - 1,
  new AbortController().signal,
);
pageLoads++;
adopt(initial.items, projectHistory(initial.items));
list = createVirtualList(viewport, {
  items: rows,
  key: (row) => row.key,
  render,
  boot: "end",
  overscanPx: 900,
  scrollingUpdates: "freeze",
  anchorable: (row) => row.kind === "message",
  edgeSlots: edgeSlots(initial),
  onDestroy: () => {
    liveElements--;
  },
  onViewport: (geometry) => sticky?.update(geometry.scrollTop),
  onState: (_state, geometry) => {
    sticky?.refresh(geometry.scrollTop);
    sync();
    if (!navigation)
      void pager?.reconcile()?.catch((reason: unknown) => {
        error = reason instanceof Error ? reason.message : String(reason);
        sync();
      });
  },
  onReachStart: (context) => {
    void load("start", context);
  },
  onReachEnd: (context) => {
    void load("end", context);
  },
});
installPager(initial);
sticky = createStickyHeaders({
  container: viewportWrap,
  viewport,
  headerKeys: () => headerRows.map((row) => row.key),
  positionOf: (key) => list?.positionOf(key) ?? null,
  elementOf: (key) => list?.elementOf(key) ?? null,
  renderHeader: (slot, ordinal) => {
    const row = headerRows[ordinal];
    if (row) slot.replaceChildren(buildSectionHeader(groupLabel(row.group)));
  },
});
attachInteractions(viewport);
watchSystemTheme(refreshTheme);
sync();
document.documentElement.classList.remove("booting");

const debug = {
  virtualList: list,
  jump,
  load,
  append,
  total: () => source.total,
  get items() {
    return messages;
  },
  get rows() {
    return rows;
  },
  get stats() {
    return {
      pageLoads,
      liveElements,
      createdElements,
      retained: messages.length,
      pageSize: PAGE_SIZE,
      maxItems: RETAIN_MESSAGES,
      busy: Boolean(navigation || loadingEdge),
      error,
    };
  },
};
declare global {
  interface Window {
    chatHistory: typeof debug;
  }
}
window.chatHistory = debug;
window.addEventListener(
  "pagehide",
  () => {
    disposed = true;
    navigation?.abort();
    edgeRequests.abort();
    pager?.dispose();
    sticky?.destroy();
    list?.dispose();
  },
  { once: true },
);
