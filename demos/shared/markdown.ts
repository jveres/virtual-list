import {
  attachInteractions,
  createMarkdownViewer,
  initMarkdownViewer,
  loadLanguages,
  type MarkdownViewerHandle,
  preloadKaTeX,
  renderToHtml,
} from "markdown-viewer";
import "markdown-viewer/styles.css";
import "katex/dist/katex.css";

// Languages used in the demo conversation content. Preloaded so renderMarkdown
// (a synchronous string render) emits fully highlighted code on first paint and
// produces stable measured heights — there is no live component to re-highlight
// a static row after the fact.
const DEMO_LANGUAGES = ["typescript", "rust", "python", "bash"];

export async function initMarkdown(): Promise<void> {
  await initMarkdownViewer();
  await Promise.all([loadLanguages(DEMO_LANGUAGES), preloadKaTeX()]);
}

export function renderMarkdown(markdown: string): string {
  return renderToHtml(markdown);
}

// Re-export the markdown-viewer primitives a host wires up directly:
// - attachInteractions: one delegated listener (copy buttons, table-copy menus)
//   on the scroll viewport, covering every mounted row.
// - createMarkdownViewer / MarkdownViewerHandle: the live component for streaming
//   rows — heals partial markdown, shows a typing cursor, morphs the DOM in place.
export type { MarkdownViewerHandle };
// loadLanguages: hosts with dynamic content (the OpenAI history) load the
// fence languages it actually uses before the synchronous static render.
export { attachInteractions, createMarkdownViewer, loadLanguages };
