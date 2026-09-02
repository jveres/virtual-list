import {
  applyDocumentTheme,
  getThemeChoice,
  isThemeChoice,
  setThemeChoice,
} from "./theme.js";

type HTMLElementConstructor<T extends HTMLElement> = {
  new (): T;
};

/**
 * Indexed access that asserts the element is present. Replaces non-null `!`
 * and `as` casts on array/tuple lookups that are known to be in range, turning
 * an out-of-range mistake into a clear error instead of a propagating
 * `undefined`.
 */
export function at<T>(items: ArrayLike<T>, index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new RangeError(
      `index ${index} out of range (length ${items.length})`,
    );
  }
  return value;
}

export function mustGet(id: string): HTMLElement;
export function mustGet<T extends HTMLElement>(
  id: string,
  elementType: HTMLElementConstructor<T>,
): T;
export function mustGet<T extends HTMLElement>(
  id: string,
  elementType?: HTMLElementConstructor<T>,
): HTMLElement | T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  if (elementType && !(element instanceof elementType)) {
    throw new Error(`unexpected element type for #${id}`);
  }
  return element;
}

export function syncThemeButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".theme-btn[data-theme-choice]",
  )) {
    button.classList.toggle(
      "active",
      button.dataset.themeChoice === getThemeChoice(),
    );
  }
}

export function bindThemeButtons(onChange: () => void): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".theme-btn[data-theme-choice]",
  )) {
    button.addEventListener("click", () => {
      const choice = button.dataset.themeChoice;
      if (!isThemeChoice(choice)) return;
      setThemeChoice(choice);
      onChange();
    });
  }
}

/**
 * Re-apply the document theme and sync the header buttons after a choice or
 * system change. Demo content restyles via CSS on [data-theme], so no
 * re-render is needed.
 */
export function refreshTheme(): void {
  applyDocumentTheme();
  syncThemeButtons();
}
