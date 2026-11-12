/** Border-box size of the measured text, in CSS pixels. */
export type TextBounds = { width: number; height: number };

type MeasuredText = {
  content: HTMLElement;
  apply: (bounds: TextBounds) => void;
  width: number;
  height: number;
  mounted: boolean;
  frame?: number;
};

const measured = new WeakMap<HTMLElement, MeasuredText>();
const observedContent = new WeakMap<Element, MeasuredText>();
let sharedProbe: HTMLDivElement | null = null;
let sharedProbeWidth = -1;
let sharedObserver: ResizeObserver | null = null;

function getSharedObserver(): ResizeObserver {
  if (sharedObserver) return sharedObserver;
  sharedObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const text = observedContent.get(entry.target);
      if (!text?.mounted) continue;
      const size = entry.borderBoxSize?.[0];
      if (text.frame !== undefined) cancelAnimationFrame(text.frame);
      text.frame = undefined;
      if (
        size &&
        Math.abs(size.inlineSize - text.width) < 0.1 &&
        Math.abs(size.blockSize - text.height) < 0.1
      )
        continue;
      // ResizeObserver delivery must not mutate an observed ancestor's size in
      // the same delivery (WebKit reports an undelivered-notifications loop).
      // Defer, using the delivered size rather than flushing layout again.
      text.frame = requestAnimationFrame(() => {
        text.frame = undefined;
        if (text.mounted) run(text, size);
      });
    }
  });
  return sharedObserver;
}

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
  const previous = measured.get(row);
  if (previous?.mounted) unmountMeasuredText(row);
  const text: MeasuredText = {
    content,
    apply,
    width: 0,
    height: 0,
    mounted: false,
  };
  let probe = sharedProbe;
  if (!probe || probe.ownerDocument !== probeContainer.ownerDocument) {
    probe = probeContainer.ownerDocument.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;";
    sharedProbe = probe;
    sharedProbeWidth = -1;
  }
  if (sharedProbeWidth !== width) {
    probe.style.width = `${width}px`;
    sharedProbeWidth = width;
  }
  probe.appendChild(row);
  probeContainer.appendChild(probe);
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
  if (text.mounted) getSharedObserver().unobserve(text.content);
  text.mounted = true;
  observedContent.set(text.content, text);
  // Retained rows keep their prepared size. Initial notifications on mount or
  // remount need no layout reads or writes when that size is unchanged.
  getSharedObserver().observe(text.content, { box: "border-box" });
}

export function unmountMeasuredText(row: HTMLElement): void {
  const text = measured.get(row);
  if (!text) return;
  if (text.mounted) {
    text.mounted = false;
    sharedObserver?.unobserve(text.content);
    if (observedContent.get(text.content) === text) {
      observedContent.delete(text.content);
    }
  }
  if (text.frame !== undefined) cancelAnimationFrame(text.frame);
  text.frame = undefined;
}
