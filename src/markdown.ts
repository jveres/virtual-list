import init, {
  mdToHtml,
  mdToHtmlWithPlugins,
  SyntaxHighlighter,
} from "@typefm/comrak-wasm";
import type { HighlighterCore } from "shiki/core";

const THEMES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEMES)[number];

export function isThemeChoice(value: string | undefined): value is ThemeChoice {
  return value !== undefined && (THEMES as readonly string[]).includes(value);
}

const comrakOptions = {
  extension: {
    strikethrough: true,
    table: true,
    tasklist: true,
    autolink: true,
    alerts: true,
    footnotes: true,
    mathDollars: true,
    mathCode: true,
    superscript: true,
    subscript: true,
    underline: true,
    highlight: true,
    insert: true,
    descriptionLists: true,
  },
  render: { unsafe: true },
};

let themeChoice: ThemeChoice = "system";
let shiki: HighlighterCore | null = null;
let shikiLoad: Promise<void> | null = null;

export function setThemeChoice(next: ThemeChoice): void {
  themeChoice = next;
  applyDocumentTheme();
}

export function getThemeChoice(): ThemeChoice {
  return themeChoice;
}

export function isDark(): boolean {
  if (themeChoice === "dark") return true;
  if (themeChoice === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function codeThemeName(): "github-dark" | "github-light" {
  return isDark() ? "github-dark" : "github-light";
}

export function applyDocumentTheme(): void {
  document.documentElement.setAttribute(
    "data-theme",
    isDark() ? "dark" : "light",
  );
}

export async function initMarkdown(): Promise<void> {
  await init();
}

// SyntaxHighlighter is a wasm-bindgen class; mdToHtmlWithPlugins consumes the
// instance, so a fresh adapter must be built per render.
function createShikiAdapter(): SyntaxHighlighter | null {
  if (!shiki) return null;
  const themeName = codeThemeName();
  const bg = themeName === "github-dark" ? "#161920" : "#fafbfc";
  const fg = themeName === "github-dark" ? "#e1e4e8" : "#1f2328";
  return new SyntaxHighlighter(
    (code: string, lang: string | undefined) => {
      if (!lang || !shiki) return code;
      try {
        const html = shiki.codeToHtml(code, { lang, theme: themeName });
        const match = html.match(
          /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/,
        );
        return match?.[1] ?? code;
      } catch {
        return code;
      }
    },
    () =>
      `<pre class="shiki ${themeName}" style="background-color:${bg};color:${fg}">`,
    () => "<code>",
  );
}

export function renderMarkdown(markdown: string): string {
  const highlighter = createShikiAdapter();
  return highlighter
    ? mdToHtmlWithPlugins(markdown, comrakOptions, highlighter)
    : mdToHtml(markdown, comrakOptions);
}

export function hasHighlighter(): boolean {
  return shiki !== null;
}

export function loadHighlighter(): Promise<void> {
  if (shiki) return Promise.resolve();
  if (shikiLoad) return shikiLoad;

  shikiLoad = Promise.all([
    import("shiki/core"),
    import("@shikijs/engine-oniguruma").then(async (m) => {
      const wasm = await import("shiki/onig.wasm?init");
      return m.createOnigurumaEngine(wasm.default);
    }),
    import("@shikijs/themes/github-dark"),
    import("@shikijs/themes/github-light"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/bash"),
  ])
    .then(
      ([
        { createHighlighterCore },
        engine,
        themeDark,
        themeLight,
        ...langs
      ]) => {
        return createHighlighterCore({
          engine,
          themes: [themeDark.default, themeLight.default],
          langs: langs.map((m) => m.default),
        }).then((highlighter) => {
          shiki = highlighter;
        });
      },
    )
    .catch((error: unknown) => {
      shikiLoad = null;
      throw error;
    });
  return shikiLoad;
}

export function watchSystemTheme(onChange: () => void): void {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeChoice !== "system") return;
    applyDocumentTheme();
    onChange();
  });
}
