import {
  createVirtualList,
  measureVirtualListItem,
  type VirtualList,
} from "../../src/virtual-list.js";
import { conversation } from "../shared/chat-data.js";
import { buildChatItem, buildSectionHeader } from "../shared/chat-ui.js";
import {
  attachInteractions,
  initMarkdown,
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
  nextFrame,
  refreshTheme,
  syncThemeButtons,
} from "../shared/utils.js";

import "../shared/styles.css";

const TOTAL_INITIAL = 10_000;
const MESSAGES_PER_GROUP = 8;
const HEADER_HEIGHT = 44;
// Synthetic day labels: group 0 is oldest (top), each later group is one day on.
const GROUP_DATE_BASE = Date.UTC(2025, 0, 1);
const DAY_MS = 86_400_000;
// Layout repeats: one header followed by a full group of messages.
const STRIDE = MESSAGES_PER_GROUP + 1;

const viewport = mustGet("viewport");
const viewportWrap = mustGet("viewport-wrap");

let total = TOTAL_INITIAL;
let stickyEnabled = true;
let virtualList: VirtualList;
let stickyHeaders: StickyHeaders;
let measuredViewportWidth = viewport.clientWidth;

const templateHeights = new Float64Array(conversation.length);
templateHeights.fill(180);
const htmlCache = new Map<number, string>();
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function templateIdForDataIndex(dataIndex: number): number {
  return dataIndex % conversation.length;
}

function htmlForTemplate(templateId: number): string {
  let html = htmlCache.get(templateId);
  if (html === undefined) {
    html = renderMarkdown(at(conversation, templateId).markdown);
    htmlCache.set(templateId, html);
  }
  return html;
}

// --- Grouped layout (headers interleaved into the item index space) ----------
// Every group but the last is full, so the layout↔data mapping is arithmetic.

function groupCount(): number {
  return total === 0 ? 0 : Math.floor((total - 1) / MESSAGES_PER_GROUP) + 1;
}

function layoutCount(): number {
  return total + groupCount();
}

function groupLabel(group: number): string {
  return dateFormat.format(new Date(GROUP_DATE_BASE + group * DAY_MS));
}

type LayoutEntry =
  | { kind: "header"; group: number }
  | { kind: "message"; dataIndex: number };

function entryAt(layoutIndex: number): LayoutEntry {
  const group = Math.floor(layoutIndex / STRIDE);
  const positionInGroup = layoutIndex - group * STRIDE;
  if (positionInGroup === 0) return { kind: "header", group };
  return {
    kind: "message",
    dataIndex: group * MESSAGES_PER_GROUP + (positionInGroup - 1),
  };
}

function headerLayoutIndices(): number[] {
  const groups = groupCount();
  const indices = new Array<number>(groups);
  for (let group = 0; group < groups; group++) indices[group] = group * STRIDE;
  return indices;
}

// Layout index of a message's data index (its group's header + its slot).
function dataToLayoutIndex(dataIndex: number): number {
  return (
    Math.floor(dataIndex / MESSAGES_PER_GROUP) * STRIDE +
    1 +
    (dataIndex % MESSAGES_PER_GROUP)
  );
}

function buildMessageItem(dataIndex: number): HTMLElement {
  const templateId = templateIdForDataIndex(dataIndex);
  return buildChatItem(
    dataIndex,
    at(conversation, templateId),
    htmlForTemplate(templateId),
    { indexLabel: true },
  );
}

function buildItem(layoutIndex: number): HTMLElement {
  const entry = entryAt(layoutIndex);
  return entry.kind === "header"
    ? buildSectionHeader(groupLabel(entry.group))
    : buildMessageItem(entry.dataIndex);
}

function getItemHeight(layoutIndex: number): number {
  const entry = entryAt(layoutIndex);
  return entry.kind === "header"
    ? HEADER_HEIGHT
    : at(templateHeights, templateIdForDataIndex(entry.dataIndex));
}

// Measure each conversation template as a message row (not via the grouped
// buildItem, whose index is a layout index).
function buildTemplateMessage(templateId: number): HTMLElement {
  return buildChatItem(
    templateId,
    at(conversation, templateId),
    htmlForTemplate(templateId),
    { indexLabel: true },
  );
}

function measureTemplateHeights(): void {
  measuredViewportWidth = viewport.clientWidth;
  for (let templateId = 0; templateId < conversation.length; templateId++) {
    templateHeights[templateId] = measureVirtualListItem({
      viewport,
      canvasClassName: "chat-canvas",
      index: templateId,
      buildItem: buildTemplateMessage,
    });
  }
}

function remeasureForViewportWidth(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measureTemplateHeights();
  virtualList.invalidateMeasurements();
  stickyHeaders.refresh();
}

async function scrollToSettledBottom(passes = 3): Promise<void> {
  for (let pass = 0; pass < passes; pass++) {
    await virtualList.scrollToBottom();
    await nextFrame();
  }
  await virtualList.scrollToBottom();
}

bindThemeButtons(refreshTheme);

document.getElementById("top-btn")?.addEventListener("click", () => {
  void virtualList.scrollToTop();
});

document.getElementById("bottom-btn")?.addEventListener("click", () => {
  void virtualList.scrollToBottom();
});

document.getElementById("add-btn")?.addEventListener("click", () => {
  total += 100;
  virtualList.setCount();
  stickyHeaders.refresh();
});

const stickyToggle = mustGet("sticky-toggle", HTMLButtonElement);
function syncStickyToggle(): void {
  stickyToggle.classList.toggle("active", stickyEnabled);
  stickyToggle.setAttribute("aria-pressed", String(stickyEnabled));
}
stickyToggle.addEventListener("click", () => {
  stickyEnabled = !stickyEnabled;
  stickyHeaders.setEnabled(stickyEnabled);
  syncStickyToggle();
});

const indexInput = mustGet("index-input", HTMLInputElement);
const alignSelect = mustGet("align-select", HTMLSelectElement);
const behaviorSelect = mustGet("behavior-select", HTMLSelectElement);

function isAlign(value: string): value is "top" | "center" | "bottom" {
  return value === "top" || value === "center" || value === "bottom";
}

function isScrollBehavior(value: string): value is ScrollBehavior {
  return value === "smooth" || value === "instant" || value === "auto";
}

function scrollToTypedIndex(): void {
  const parsed = Number.parseInt(indexInput.value, 10);
  // The field is a message number (matching the "#N" row label); map it to its
  // layout index so the grouped headers don't offset the target.
  const dataIndex = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 0), total - 1)
    : 0;
  indexInput.value = String(dataIndex);
  const align = isAlign(alignSelect.value) ? alignSelect.value : "top";
  // A top-aligned goto reserves one header height above the message when the
  // floating pill occupies that band (sticky on — the analog of
  // scroll-margin-top), or when the message opens its group (its own date
  // header rides along, so "go to the first message" lands at the exact
  // content top with no leftover scroll room). Mid-group gotos with sticky
  // off land flush: the row above them is a message, not a label.
  const headerAbove = stickyEnabled || dataIndex % MESSAGES_PER_GROUP === 0;
  void virtualList.scrollToIndex(
    dataToLayoutIndex(dataIndex),
    align === "top" && headerAbove ? HEADER_HEIGHT : align,
    {
      behavior: isScrollBehavior(behaviorSelect.value)
        ? behaviorSelect.value
        : "smooth",
    },
  );
}

mustGet("goto-btn").addEventListener("click", scrollToTypedIndex);
indexInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    scrollToTypedIndex();
  }
});

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
syncStickyToggle();
measureTemplateHeights();

virtualList = createVirtualList({
  viewport,
  canvasClassName: "chat-canvas",
  getCount: layoutCount,
  getItemHeight,
  buildItem,
  overscanPx: 900,
});

stickyHeaders = createStickyHeaders({
  container: viewportWrap,
  viewport,
  headerIndices: headerLayoutIndices,
  itemOffset: (index) => virtualList.getItemOffset(index),
  headerElement: (index) => virtualList.getMountedElement(index),
  renderHeader: (slot, ordinal) => {
    slot.replaceChildren(buildSectionHeader(groupLabel(ordinal)));
  },
});
stickyHeaders.setEnabled(stickyEnabled);

const viewportResizeObserver = new ResizeObserver(remeasureForViewportWidth);
viewportResizeObserver.observe(viewport);
// One delegated listener powers copy buttons across every mounted row.
attachInteractions(viewport);

await scrollToSettledBottom();
stickyHeaders.refresh();
document.documentElement.classList.remove("booting");

watchSystemTheme(refreshTheme);

declare global {
  interface Window {
    chatHistory: {
      virtualList: VirtualList;
      append: (count?: number) => void;
      total: () => number;
    };
  }
}

window.chatHistory = {
  virtualList,
  append: (count = 100) => {
    total += count;
    virtualList.setCount();
    stickyHeaders.refresh();
  },
  total: () => total,
};
