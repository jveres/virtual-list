export interface TextareaSizeOptions {
  minHeight: number;
  maxHeight: number;
  /** Hold this layout box while probing, so an adjacent scroller cannot expand transiently. */
  container?: HTMLElement | null;
}

/** Size the input without temporarily changing its sibling viewport in WebKit. */
export function autosizeTextarea(
  input: HTMLTextAreaElement,
  options: TextareaSizeOptions,
): void {
  const { minHeight, maxHeight } = options;
  if (
    !Number.isFinite(minHeight) ||
    !Number.isFinite(maxHeight) ||
    minHeight <= 0 ||
    maxHeight < minHeight
  ) {
    throw new RangeError(
      "textarea heights must be finite, positive, and ordered",
    );
  }
  const container =
    options.container === undefined ? input.parentElement : options.container;
  const previousMinHeight = container?.style.minHeight ?? "";
  const previousHeight = input.style.height;
  try {
    if (container)
      container.style.minHeight = `${container.getBoundingClientRect().height}px`;
    input.style.height = `${minHeight}px`;
    const style = getComputedStyle(input);
    const borders =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    const padding =
      (Number.parseFloat(style.paddingTop) || 0) +
      (Number.parseFloat(style.paddingBottom) || 0);
    const lineHeight = Number.parseFloat(style.lineHeight);
    let content = input.scrollHeight;
    // Engines round scrollHeight differently (Firefox reports a pixel less
    // for an empty last line): snap overflowing text to whole lines of its
    // grid, so typing within a line never resizes the composer. Text that
    // fits the minimum box reports the box instead; leave that alone.
    if (lineHeight > 0 && content + borders > minHeight)
      content =
        Math.round((content - padding) / lineHeight) * lineHeight + padding;
    const height = Math.min(maxHeight, Math.max(minHeight, content + borders));
    input.style.height = `${height}px`;
    input.style.overflowY = height >= maxHeight ? "auto" : "hidden";
  } catch (error) {
    input.style.height = previousHeight;
    throw error;
  } finally {
    if (container) container.style.minHeight = previousMinHeight;
  }
}
