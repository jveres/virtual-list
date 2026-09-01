// Detached premeasurement — the second preserved primitive from `main`
// (its createVirtualListItemMeasurer), behavior kept intact, signature
// generalized from index-coupling to a build callback so the keyed v2
// runtime can use it unchanged.
//
// Items are built and measured OFF-scroller: a hidden, fixed-position
// measurement root appended to document.body, width-synced to the viewport
// so wrapping matches the real canvas. The scroll surface is never touched;
// heights are real before anything mounts (core contract, cornerstone 2).
//
// Known bound, carried from `main` as law: a detached measure cannot see
// what only materializes later — undecoded images, late syntax
// highlighting, pending font loads. Premeasure is the commit-time truth for
// everything layout can compute synchronously; late growers must be
// dimensionally stabilized by the host (fixed-extent boxes) or re-enter
// through the settle-gated update pipeline.

export interface ItemMeasurerConfig {
  viewport: HTMLElement;
  /** Class names applied to the measurement root so item CSS that keys off
   * the canvas (e.g. `.chat-canvas .message`) matches during measurement. */
  canvasClassName?: string;
}

export interface ItemMeasurer {
  /**
   * Build the element, measure its border-box height in the detached root,
   * detach it, and hand it back with its height. `destroy` (optional)
   * mirrors the build's lifecycle for transient per-element resources; it
   * runs even when measurement throws, with errors aggregated.
   */
  measure(
    build: () => HTMLElement,
    destroy?: (element: HTMLElement) => void,
  ): { element: HTMLElement; height: number };
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

function prepareMeasuredItem(element: HTMLElement): HTMLElement {
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
): void {
  const viewportWidth =
    viewport.clientWidth || viewport.getBoundingClientRect().width;
  measureRoot.style.width = viewportWidth > 0 ? `${viewportWidth}px` : "100%";
}

function createMeasurementRoot(
  viewport: HTMLElement,
  canvasClassName: string | undefined,
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
  syncMeasurementRootWidth(measureRoot, viewport);
  document.body.appendChild(measureRoot);
  return measureRoot;
}

export function createItemMeasurer(config: ItemMeasurerConfig): ItemMeasurer {
  const { viewport, canvasClassName } = config;
  const measureRoot = createMeasurementRoot(viewport, canvasClassName);

  let disposed = false;

  return {
    measure(build, destroy) {
      if (disposed) {
        throw new Error("cannot measure with a disposed item measurer");
      }

      syncMeasurementRootWidth(measureRoot, viewport);
      measureRoot.replaceChildren();
      let element: HTMLElement | null = null;
      let height = 0;
      let measurementFailed = false;
      let measurementError: unknown;
      try {
        element = prepareMeasuredItem(build());
        measureRoot.appendChild(element);
        height = positiveSize(element.getBoundingClientRect().height);
      } catch (error) {
        measurementFailed = true;
        measurementError = error;
      }

      measureRoot.replaceChildren();
      if (element && destroy) {
        try {
          destroy(element);
        } catch (teardownError) {
          if (measurementFailed) {
            throw new AggregateError(
              [measurementError, teardownError],
              "item measurement and teardown failed",
            );
          }
          throw teardownError;
        }
      }
      if (measurementFailed) throw measurementError;
      if (!element) {
        throw new Error("item build returned no element");
      }
      return { element, height };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      measureRoot.remove();
    },
  };
}
