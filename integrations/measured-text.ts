/** Border-box size of the measured text, in CSS pixels. */
export type TextBounds = { width: number; height: number };

type MeasuredText = {
  content: HTMLElement;
  apply: (bounds: TextBounds) => void;
  width: number;
  height: number;
  observer?: ResizeObserver;
  frame?: number;
};

const measured = new WeakMap<HTMLElement, MeasuredText>();

function run(text: MeasuredText, size?: ResizeObserverSize): void {
  if (!text.content.isConnected) return;
  const bounds = size
    ? { width: size.inlineSize, height: size.blockSize }
    : text.content.getBoundingClientRect();
  text.width = bounds.width;
  text.height = bounds.height;
  text.apply(bounds);
}

/**
 * Decide collapse state from laid-out text before the list measures the row.
 * `row` is attached to a hidden, fixed-width probe in `probeContainer` while
 * `apply` runs once, then left detached. `apply` receives the border-box size
 * of `content` and runs again on sync and when a mounted row's text resizes.
 */
export function prepareMeasuredText(
  row: HTMLElement,
  content: HTMLElement,
  apply: (bounds: TextBounds) => void,
  width: number,
  probeContainer: HTMLElement = document.body,
): void {
  const text: MeasuredText = { content, apply, width: 0, height: 0 };
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${width}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  probe.append(row);
  probeContainer.append(probe);
  try {
    run(text);
  } finally {
    row.remove();
    probe.remove();
  }
  measured.set(row, text);
}

/** Re-apply from the current layout, for state changes outside a resize. */
export function syncMeasuredText(row: HTMLElement): void {
  const text = measured.get(row);
  if (text) run(text);
}

export function mountMeasuredText(row: HTMLElement): void {
  const text = measured.get(row);
  if (!text) return;
  text.observer?.disconnect();
  // Retained rows keep their prepared size. Initial notifications on mount or
  // remount need no layout reads or writes when that size is unchanged.
  text.observer = new ResizeObserver((entries) => {
    const size = entries[0]?.borderBoxSize[0];
    if (text.frame !== undefined) cancelAnimationFrame(text.frame);
    text.frame = undefined;
    if (
      size &&
      Math.abs(size.inlineSize - text.width) < 0.1 &&
      Math.abs(size.blockSize - text.height) < 0.1
    )
      return;
    // ResizeObserver delivery must not mutate an observed ancestor's size in
    // the same delivery (WebKit reports an undelivered-notifications loop).
    // Defer, using the delivered size rather than flushing layout again.
    text.frame = requestAnimationFrame(() => {
      text.frame = undefined;
      run(text, size);
    });
  });
  text.observer.observe(text.content, { box: "border-box" });
}

export function unmountMeasuredText(row: HTMLElement): void {
  const text = measured.get(row);
  if (!text) return;
  text.observer?.disconnect();
  text.observer = undefined;
  if (text.frame !== undefined) cancelAnimationFrame(text.frame);
  text.frame = undefined;
}
