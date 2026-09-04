/** The render state needed for failure recovery, independent of geometry. */
export interface RenderState<T> {
  item: T;
  renderedItem: T;
  renderUnknown: boolean;
  element: HTMLElement;
  destroyed: boolean;
}

type Render<T> = (item: T, existing: HTMLElement) => HTMLElement;

/** A renderer may mutate the existing element before throwing. */
export function renderInto<T>(
  row: RenderState<T>,
  item: T,
  render: Render<T>,
): HTMLElement {
  row.renderedItem = item;
  try {
    const element = render(item, row.element);
    row.renderUnknown = false;
    return element;
  } catch (error) {
    row.renderUnknown = true;
    throw error;
  }
}

/**
 * One preparation's in-place render journal. Fresh row ownership and
 * measurement stay with the caller; only successful preparation accepts
 * item changes. Rollback restores DOM best-effort and marks uncertain rows.
 */
export class RenderJournal<T, R extends RenderState<T>> {
  private readonly touched: R[] = [];
  private readonly inPlace: { row: R; item: T }[] = [];

  constructor(
    private readonly render: Render<T>,
    private readonly markDirty: (row: R) => void,
    private readonly destroy?: (element: HTMLElement, item: T) => void,
  ) {}

  renderRow(row: R, item: T): HTMLElement {
    // Register before calling host code, including code that mutates then throws.
    this.touched.push(row);
    const previouslyRendered = row.renderedItem;
    const element = renderInto(row, item, this.render);
    if (element === row.element) this.inPlace.push({ row, item });
    else row.renderedItem = previouslyRendered;
    return element;
  }

  accept(): void {
    for (const { row, item } of this.inPlace) {
      row.item = item;
      this.markDirty(row);
    }
  }

  rollback(): unknown[] {
    const failures: unknown[] = [];
    for (const row of this.touched) {
      if (row.destroyed) continue;
      try {
        const restored = this.render(row.item, row.element);
        if (restored === row.element) {
          row.renderedItem = row.item;
          row.renderUnknown = false;
        } else {
          // A replacement cannot restore the original element's DOM.
          row.renderUnknown = true;
          try {
            this.destroy?.(restored, row.item);
          } catch (error) {
            failures.push(error);
          }
        }
      } catch {
        row.renderUnknown = true;
      }
      this.markDirty(row);
    }
    return failures;
  }
}
