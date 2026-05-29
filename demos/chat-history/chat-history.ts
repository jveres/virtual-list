import { conversation } from "../../src/chat-data.js";
import { buildChatItem } from "../../src/chat-ui.js";
import {
  createVirtualList,
  measureVirtualListItem,
  type VirtualList,
} from "../../src/virtual-list.js";
import {
  attachInteractions,
  initMarkdown,
  renderMarkdown,
} from "../demo-markdown.js";
import { applyDocumentTheme, watchSystemTheme } from "../demo-theme.js";
import {
  at,
  bindThemeButtons,
  mustGet,
  syncThemeButtons,
} from "../demo-utils.js";

import "../demo-styles.css";

const TOTAL_INITIAL = 10_000;

const viewport = mustGet("viewport");

let total = TOTAL_INITIAL;
let virtualList: VirtualList;
let measuredViewportWidth = viewport.clientWidth;

const templateHeights = new Float64Array(conversation.length);
templateHeights.fill(180);
const htmlCache = new Map<number, string>();

function templateIdForIndex(index: number): number {
  return index % conversation.length;
}

function htmlForTemplate(templateId: number): string {
  let html = htmlCache.get(templateId);
  if (html === undefined) {
    html = renderMarkdown(at(conversation, templateId).markdown);
    htmlCache.set(templateId, html);
  }
  return html;
}

function buildItem(index: number): HTMLElement {
  const templateId = templateIdForIndex(index);
  return buildChatItem(
    index,
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
      buildItem,
    });
  }
}

function remeasureForViewportWidth(): void {
  if (Math.abs(viewport.clientWidth - measuredViewportWidth) <= 0.5) return;
  measureTemplateHeights();
  virtualList.invalidateMeasurements();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function scrollToSettledBottom(passes = 3): Promise<void> {
  for (let pass = 0; pass < passes; pass++) {
    await virtualList.scrollToBottom();
    await nextFrame();
  }
  await virtualList.scrollToBottom();
}

function refreshTheme(): void {
  // markdown-viewer styling is CSS-driven via the [data-theme] attribute, so a
  // theme switch needs no re-render — just flip the document attribute.
  applyDocumentTheme();
  syncThemeButtons();
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
});

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
measureTemplateHeights();

virtualList = createVirtualList({
  viewport,
  canvasClassName: "chat-canvas",
  getCount: () => total,
  getItemHeight: (index) => at(templateHeights, templateIdForIndex(index)),
  buildItem,
  overscanPx: 900,
});
const viewportResizeObserver = new ResizeObserver(remeasureForViewportWidth);
viewportResizeObserver.observe(viewport);
// One delegated listener powers copy buttons across every mounted row.
attachInteractions(viewport);

await scrollToSettledBottom();
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
  },
  total: () => total,
};
