const THEMES = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof THEMES)[number];

export function isThemeChoice(value: string | undefined): value is ThemeChoice {
  return value !== undefined && (THEMES as readonly string[]).includes(value);
}

const THEME_STORAGE_KEY = "virtual-list-theme";

function restoreThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) ?? undefined;
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

let themeChoice: ThemeChoice = restoreThemeChoice();

export function setThemeChoice(next: ThemeChoice): void {
  themeChoice = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // The current-page choice still works when browser storage is unavailable.
  }
  applyDocumentTheme();
}

export function getThemeChoice(): ThemeChoice {
  return themeChoice;
}

function isDark(): boolean {
  if (themeChoice === "dark") return true;
  if (themeChoice === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyDocumentTheme(): void {
  const theme = isDark() ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
  // Keep the browser canvas and controls in sync with the parser-time scheme.
  document.documentElement.style.colorScheme = theme;
}

export function watchSystemTheme(onChange: () => void): void {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeChoice !== "system") return;
    applyDocumentTheme();
    onChange();
  });
}
