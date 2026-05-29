import { conversation } from "../../src/chat-data.js";
import { buildChatItem } from "../../src/chat-ui.js";
import {
  createVirtualList,
  measureVirtualListItem,
  type VirtualList,
} from "../../src/virtual-list.js";
import {
  codeThemeName,
  hasHighlighter,
  initMarkdown,
  loadHighlighter,
  renderMarkdown,
} from "../demo-markdown.js";
import { applyDocumentTheme, watchSystemTheme } from "../demo-theme.js";
import { bindThemeButtons, mustGet, syncThemeButtons } from "../demo-utils.js";

import "../demo-styles.css";

const TOTAL_INITIAL = 10_000;

const viewport = mustGet("viewport");

let total = TOTAL_INITIAL;
let virtualList: VirtualList;
let measuredViewportWidth = viewport.clientWidth;

const templateHeights = new Float64Array(conversation.length);
templateHeights.fill(180);
const htmlCache = new Map<string, string>();

function templateIdForIndex(index: number): number {
  return index % conversation.length;
}

function htmlForTemplate(templateId: number): string {
  const themeKey = hasHighlighter() ? codeThemeName() : "plain";
  const cacheKey = `${themeKey}:${templateId}`;
  let html = htmlCache.get(cacheKey);
  if (html === undefined) {
    html = renderMarkdown(conversation[templateId]!.markdown);
    htmlCache.set(cacheKey, html);
  }
  return html;
}

function buildItem(index: number): HTMLElement {
  const templateId = templateIdForIndex(index);
  return buildChatItem(
    index,
    conversation[templateId]!,
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
  applyDocumentTheme();
  syncThemeButtons();
  htmlCache.clear();
  virtualList.refreshMounted();
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
  getItemHeight: (index) => templateHeights[templateIdForIndex(index)]!,
  buildItem,
  overscanPx: 900,
});
const viewportResizeObserver = new ResizeObserver(remeasureForViewportWidth);
viewportResizeObserver.observe(viewport);

await scrollToSettledBottom();
document.documentElement.classList.remove("booting");

watchSystemTheme(refreshTheme);
loadHighlighter()
  .then(async () => {
    const keepBottom = virtualList.state.atBottom;
    htmlCache.clear();
    virtualList.refreshMounted();
    if (keepBottom) await scrollToSettledBottom(2);
  })
  .catch(console.error);

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
