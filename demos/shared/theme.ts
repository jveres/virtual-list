const THEMES = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof THEMES)[number];

export function isThemeChoice(value: string | undefined): value is ThemeChoice {
  return value !== undefined && (THEMES as readonly string[]).includes(value);
}

let themeChoice: ThemeChoice = "system";

export function setThemeChoice(next: ThemeChoice): void {
  themeChoice = next;
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
  document.documentElement.setAttribute(
    "data-theme",
    isDark() ? "dark" : "light",
  );
}

export function watchSystemTheme(onChange: () => void): void {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeChoice !== "system") return;
    applyDocumentTheme();
    onChange();
  });
}
