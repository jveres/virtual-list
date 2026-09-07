/**
 * Safari can retain the old scrolling layer after a native file drop replaces
 * a chat: DOM rows, scrollTop, and rAF callbacks are correct, but the viewport
 * paints blank until input. Rebuild that layer once after the replacement,
 * without changing the runtime's scroll position or persistent CSS.
 */
export function repaintAfterReplacement(
  viewport: HTMLElement,
  isCurrent: () => boolean,
): void {
  requestAnimationFrame(() => {
    if (!isCurrent() || !viewport.isConnected) return;
    const overflow = viewport.style.getPropertyValue("overflow-y");
    const priority = viewport.style.getPropertyPriority("overflow-y");
    try {
      viewport.style.setProperty("overflow-y", "hidden");
      // A style toggle without layout is coalesced away by the browser.
      void viewport.offsetHeight;
    } finally {
      if (overflow)
        viewport.style.setProperty("overflow-y", overflow, priority);
      else viewport.style.removeProperty("overflow-y");
    }
  });
}
