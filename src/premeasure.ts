// Detached premeasurement — the second preserved primitive from `main`
// (its createVirtualListItemMeasurer), behavior kept intact; the keyed v2
// runtime hands it elements instead of indexes.
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
   * Build the element, measure its border-box height in the detached root,
   * detach it, and hand it back LIVE with its height.
   *
   * Ownership rule (the retained-node contract):
   * - Success: the caller owns the returned element — `destroy` is NOT
   *   invoked; per-element resources (live viewers, observers) survive to
   *   mount.
   * - Measurement failure after a successful build: `destroy` runs so the
   *   never-returned element's resources are torn down; a teardown failure
   *   aggregates with the measurement failure.
   * - Abort, supersession, disposal, or eventual unmount of a returned
   *   element: the CALLER destroys it, exactly once.
   */
  measure(
    build: () => HTMLElement,
    destroy?: (element: HTMLElement) => void,
  ): { element: HTMLElement; height: number };
  /**
   * Measure already-built, retained elements together: all are appended
   * to the root (each is absolutely positioned at its top, so they overlay
   * independently), one layout serves every read, all are detached again.
   * The caller keeps ownership; nothing is destroyed here.
   */
  measureMany(elements: readonly HTMLElement[]): number[];
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
  document.body.appendChild(measureRoot);
  return measureRoot;
}

export function createItemMeasurer(config: ItemMeasurerConfig): ItemMeasurer {
  const { viewport, canvasClassName, viewportWidth } = config;
  const measureRoot = createMeasurementRoot(
    viewport,
    canvasClassName,
    viewportWidth,
  );

  let disposed = false;

  return {
    measure(build, destroy) {
      if (disposed) {
        throw new Error("cannot measure with a disposed item measurer");
      }

      syncMeasurementRootWidth(measureRoot, viewport, viewportWidth);
      measureRoot.replaceChildren();
      let element: HTMLElement | null = null;
      try {
        element = prepareMeasuredItem(build());
        measureRoot.appendChild(element);
        const height = positiveSize(element.getBoundingClientRect().height);
        measureRoot.replaceChildren();
        // Success: the caller owns the live element (see the ownership rule).
        return { element, height };
      } catch (measurementError) {
        measureRoot.replaceChildren();
        // The element will never be returned: tear its resources down here
        // (a build throw leaves no element to destroy).
        if (element && destroy) {
          try {
            destroy(element);
          } catch (teardownError) {
            throw new AggregateError(
              [measurementError, teardownError],
              "item measurement and teardown failed",
            );
          }
        }
        throw measurementError;
      }
    },
    measureMany(elements) {
      if (disposed) {
        throw new Error("cannot measure with a disposed item measurer");
      }
      if (elements.length === 0) return [];
      syncMeasurementRootWidth(measureRoot, viewport, viewportWidth);
      measureRoot.replaceChildren(...elements.map(prepareMeasuredItem));
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
