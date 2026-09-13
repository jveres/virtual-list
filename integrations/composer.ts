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
    const height = Math.min(
      maxHeight,
      Math.max(minHeight, input.scrollHeight + borders),
    );
    input.style.height = `${height}px`;
    input.style.overflowY = height >= maxHeight ? "auto" : "hidden";
  } catch (error) {
    input.style.height = previousHeight;
    throw error;
  } finally {
    if (container) container.style.minHeight = previousMinHeight;
  }
}
