/**
 * Safari can retain the old scrolling layer after a native file drop replaces
 * a list: DOM rows, scrollTop, and rAF callbacks are correct, but the viewport
 * paints blank until input. Rebuild that layer once after the replacement,
 * without changing the runtime's scroll position or persistent CSS.
 */
export function scheduleReplacementRepaint(
  viewport: HTMLElement,
  isCurrent: () => boolean,
): () => void {
  let frame = requestAnimationFrame(() => {
    frame = 0;
    if (!isCurrent() || !viewport.isConnected) return;
    const overflow = viewport.style.getPropertyValue("overflow-y");
    const priority = viewport.style.getPropertyPriority("overflow-y");
    try {
      viewport.style.setProperty("overflow-y", "hidden", "important");
      // A style toggle without layout is coalesced away by the browser.
      void viewport.offsetHeight;
    } finally {
      if (overflow)
        viewport.style.setProperty("overflow-y", overflow, priority);
      else viewport.style.removeProperty("overflow-y");
    }
  });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
}
