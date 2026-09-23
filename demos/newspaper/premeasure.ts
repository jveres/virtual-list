// Newspaper demo helper: measures built article elements before they mount.
//
// The elements go into a hidden, fixed-position root on document.body whose
// width follows the viewport, so text wraps as it will in the list. One
// layout serves every read in a batch, and every element is detached again
// before the heights are returned. The caller keeps ownership of the
// elements.
//
// Limit: a detached measure cannot see content that settles later, such as
// undecoded images or pending fonts. The demo keeps its article geometry
// fixed so that the measured height stays correct.

export interface ItemMeasurer {
  /** Measure elements together and hand them back detached. */
  measureMany(elements: readonly HTMLElement[]): number[];
  dispose(): void;
}

function positiveSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function positionElement(element: HTMLElement): HTMLElement {
  element.style.position = "absolute";
  element.style.transform = "none";
  element.style.top = "0";
  element.style.left = "0";
  element.style.right = "0";
  return element;
}

function syncRootWidth(root: HTMLDivElement, viewport: HTMLElement): void {
  const width = viewport.clientWidth || viewport.getBoundingClientRect().width;
  const next = width > 0 ? `${width}px` : "100%";
  if (root.style.width !== next) root.style.width = next;
}

export function createItemMeasurer({
  viewport,
}: {
  viewport: HTMLElement;
}): ItemMeasurer {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0 auto auto 0",
    minHeight: "0",
    height: "0",
    overflow: "visible",
    visibility: "hidden",
    opacity: "0",
    pointerEvents: "none",
  });
  // Descendants can override visibility, so also block interaction and
  // hide the subtree from accessibility.
  root.inert = true;
  root.setAttribute("aria-hidden", "true");
  syncRootWidth(root, viewport);
  document.body.appendChild(root);

  let disposed = false;

  return {
    measureMany(elements) {
      if (disposed) {
        throw new Error("cannot measure with a disposed item measurer");
      }
      if (elements.length === 0) return [];
      try {
        syncRootWidth(root, viewport);
        root.replaceChildren(...elements.map(positionElement));
        return elements.map((element) =>
          positiveSize(element.getBoundingClientRect().height),
        );
      } finally {
        root.replaceChildren();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
      root.replaceChildren();
    },
  };
}
