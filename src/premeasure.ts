// Detached premeasurement — measures the runtime's elements before commit.
//
// Items are built and measured OFF-scroller: a hidden, fixed-position
// measurement root appended to document.body, width-synced to the viewport
// so wrapping matches the real canvas. The scroll surface is never touched;
// heights are real before anything mounts (core contract, cornerstone 2).
//
// Measurement limit: a detached measure cannot see
// what only materializes later — undecoded images, late syntax
// highlighting, pending font loads. Premeasure is the commit-time truth for
// everything layout can compute synchronously; late growers must be
// dimensionally stabilized by the host (fixed-extent boxes) or re-enter
// through the settle-gated update pipeline.

interface ItemMeasurerConfig {
  viewport: HTMLElement;
  /** Host-provided ancestor with the same inherited and scoped row styles. */
  container?: HTMLElement;
  /** Class names applied to the measurement root so item CSS that keys off
   * the canvas (e.g. `.chat-canvas .message`) matches during measurement.
   * (Tests only; the runtime does not forward one.) */
  canvasClassName?: string;
  /**
   * The width to measure at. Supplied by a host that already tracks the
   * viewport width (a ResizeObserver) so a measurement never forces a
   * layout just to read `clientWidth`; defaults to reading the viewport.
   */
  viewportWidth?: () => number;
}

export interface ItemMeasurer {
  /**
   * Measure already-built, retained elements together: all are appended
   * to the root (each is absolutely positioned at its top, so they overlay
   * independently), one layout serves every read, all are detached again.
   * The caller keeps ownership; nothing is destroyed here.
   */
  measureMany(elements: readonly HTMLElement[]): number[];
  dispose(): void;
}

export interface ItemMeasurementStage {
  /** Append a bounded group and warm its layout without detaching earlier groups. */
  append(elements: readonly HTMLElement[]): void;
  /** Read every staged height together immediately before the atomic commit. */
  measure(): number[];
  dispose(): void;
}

function positiveSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function addClassNames(
  element: HTMLElement,
  classNames: string | undefined,
): void {
  if (!classNames) return;
  for (const className of classNames.split(/\s+/)) {
    if (className) element.classList.add(className);
  }
}

/**
 * The row-element positioning convention: absolute, pinned to its slot's
 * edges, no transform. Applied to every measured element, and by the
 * runtime to the elements it never measures (edge slots).
 */
export function positionRowElement(element: HTMLElement): HTMLElement {
  element.style.position = "absolute";
  element.style.transform = "none";
  element.style.top = "0";
  element.style.left = "0";
  element.style.right = "0";
  return element;
}

function syncMeasurementRootWidth(
  measureRoot: HTMLDivElement,
  viewport: HTMLElement,
  viewportWidth: (() => number) | undefined,
): void {
  const width =
    viewportWidth?.() ||
    viewport.clientWidth ||
    viewport.getBoundingClientRect().width;
  const next = width > 0 ? `${width}px` : "100%";
  if (measureRoot.style.width !== next) measureRoot.style.width = next;
}

function createMeasurementRoot(
  viewport: HTMLElement,
  canvasClassName: string | undefined,
  viewportWidth: (() => number) | undefined,
  container: HTMLElement,
): HTMLDivElement {
  const measureRoot = document.createElement("div");
  addClassNames(measureRoot, canvasClassName);
  Object.assign(measureRoot.style, {
    position: "fixed",
    inset: "0 auto auto 0",
    minHeight: "0",
    height: "0",
    overflow: "visible",
    visibility: "hidden",
    pointerEvents: "none",
  });
  syncMeasurementRootWidth(measureRoot, viewport, viewportWidth);
  container.appendChild(measureRoot);
  return measureRoot;
}

/**
 * A private root for an incremental window preparation. Keeping the rows
 * connected between batches preserves the browser's layout work. The final
 * read is still authoritative: an image, font, or host style that changed
 * between frames is reflected before any row reaches the scroller.
 */
export function createItemMeasurementStage(
  config: ItemMeasurerConfig,
): ItemMeasurementStage {
  const root = createMeasurementRoot(
    config.viewport,
    config.canvasClassName,
    config.viewportWidth,
    config.container ?? document.body,
  );
  const staged: HTMLElement[] = [];
  let disposed = false;
  const assertActive = (): void => {
    if (disposed) throw new Error("cannot use a disposed measurement stage");
  };
  return {
    append(elements) {
      assertActive();
      if (elements.length === 0) return;
      root.append(...elements.map(positionRowElement));
      staged.push(...elements);
      // One read warms the entire new group. Do not read every retained
      // row after each append; their authoritative pass is measure().
      elements[elements.length - 1]?.getBoundingClientRect();
    },
    measure() {
      assertActive();
      syncMeasurementRootWidth(root, config.viewport, config.viewportWidth);
      return staged.map((element) =>
        positiveSize(element.getBoundingClientRect().height),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
      root.replaceChildren();
      staged.length = 0;
    },
  };
}

export function createItemMeasurer(config: ItemMeasurerConfig): ItemMeasurer {
  const {
    viewport,
    canvasClassName,
    viewportWidth,
    container = document.body,
  } = config;
  const measureRoot = createMeasurementRoot(
    viewport,
    canvasClassName,
    viewportWidth,
    container,
  );

  let disposed = false;

  return {
    measureMany(elements) {
      if (disposed) {
        throw new Error("cannot measure with a disposed item measurer");
      }
      if (elements.length === 0) return [];
      syncMeasurementRootWidth(measureRoot, viewport, viewportWidth);
      measureRoot.replaceChildren(...elements.map(positionRowElement));
      try {
        return elements.map((element) =>
          positiveSize(element.getBoundingClientRect().height),
        );
      } finally {
        measureRoot.replaceChildren();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      measureRoot.remove();
    },
  };
}
