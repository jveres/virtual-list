import { conversation } from "../../src/chat-data.js";
import { buildChatItem } from "../../src/chat-ui.js";
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

import "../demo-styles.css";

const TOTAL_INITIAL = 10_000;

const viewport = mustGet("viewport");

let total = TOTAL_INITIAL;
let virtualizer: DynamicVirtualizer;
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
    templateHeights[templateId] = measureDynamicVirtualizerItem({
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
  virtualizer.invalidateMeasurements();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function scrollToSettledBottom(passes = 3): Promise<void> {
  for (let pass = 0; pass < passes; pass++) {
    await virtualizer.scrollToBottom();
    await nextFrame();
  }
  await virtualizer.scrollToBottom();
}

function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
  htmlCache.clear();
  virtualizer.refreshMounted();
}

bindThemeButtons(refreshTheme);

document.getElementById("top-btn")?.addEventListener("click", () => {
  void virtualizer.scrollToTop();
});

document.getElementById("bottom-btn")?.addEventListener("click", () => {
  void virtualizer.scrollToBottom();
});

document.getElementById("add-btn")?.addEventListener("click", () => {
  total += 100;
  virtualizer.setCount();
});

await Promise.all([initMarkdown(), document.fonts.ready]);
applyDocumentTheme();
syncThemeButtons();
measureTemplateHeights();

virtualizer = createDynamicVirtualizer({
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
    const keepBottom = virtualizer.state.atBottom;
    htmlCache.clear();
    virtualizer.refreshMounted();
    if (keepBottom) await scrollToSettledBottom(2);
  })
  .catch(console.error);

declare global {
  interface Window {
    chatHistory: {
      virtualizer: DynamicVirtualizer;
      append: (count?: number) => void;
      total: () => number;
    };
  }
}

window.chatHistory = {
  virtualizer,
  append: (count = 100) => {
    total += count;
    virtualizer.setCount();
  },
  total: () => total,
};
