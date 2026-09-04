/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { RenderJournal, type RenderState } from "../../src/render-state";

function row(): RenderState<string> {
  const element = document.createElement("div");
  element.textContent = "before";
  return {
    item: "before",
    renderedItem: "before",
    renderUnknown: false,
    element,
    destroyed: false,
  };
}

function render(item: string, element: HTMLElement): HTMLElement {
  element.textContent = item;
  return element;
}

describe("render journal", () => {
  it("accepts successful in-place data only after preparation succeeds", () => {
    const current = row();
    const dirty: RenderState<string>[] = [];
    const journal = new RenderJournal<string, RenderState<string>>(
      render,
      (entry) => dirty.push(entry),
    );
    expect(journal.renderRow(current, "after")).toBe(current.element);
    expect(current.element.textContent).toBe("after");
    expect(current.item).toBe("before");
    expect(dirty).toEqual([]);

    journal.accept();

    expect(current.item).toBe("after");
    expect(current.renderedItem).toBe("after");
    expect(dirty).toEqual([current]);
  });

  it("leaves replacement ownership and committed data with the caller", () => {
    const current = row();
    const replacement = document.createElement("div");
    const dirty: RenderState<string>[] = [];
    const journal = new RenderJournal<string, RenderState<string>>(
      () => replacement,
      (entry) => dirty.push(entry),
    );
    expect(journal.renderRow(current, "after")).toBe(replacement);
    journal.accept();
    expect(current.item).toBe("before");
    expect(current.renderedItem).toBe("before");
    expect(current.element.textContent).toBe("before");
    expect(dirty).toEqual([]);
  });

  it("restores an element mutated by a throwing render", () => {
    const current = row();
    const dirty: RenderState<string>[] = [];
    const journal = new RenderJournal<string, RenderState<string>>(
      (item, element) => {
        render(item, element);
        if (item === "after") throw new Error("render failed");
        return element;
      },
      (entry) => dirty.push(entry),
    );

    expect(() => journal.renderRow(current, "after")).toThrow("render failed");
    expect(current.renderUnknown).toBe(true);
    expect(journal.rollback()).toEqual([]);
    expect(current.element.textContent).toBe("before");
    expect(current.renderedItem).toBe("before");
    expect(current.renderUnknown).toBe(false);
    expect(dirty).toEqual([current]);
  });

  it("continues rollback when a row cannot be restored", () => {
    const first = row();
    const second = row();
    const dirty: RenderState<string>[] = [];
    const journal = new RenderJournal<string, RenderState<string>>(
      (item, element) => {
        if (item === "before" && element === first.element)
          throw new Error("restore failed");
        return render(item, element);
      },
      (entry) => dirty.push(entry),
    );
    journal.renderRow(first, "changed first");
    journal.renderRow(second, "changed second");

    expect(journal.rollback()).toEqual([]);
    expect(first.renderUnknown).toBe(true);
    expect(second.renderUnknown).toBe(false);
    expect(second.element.textContent).toBe("before");
    expect(dirty).toEqual([first, second]);
  });

  it("destroys unwanted rollback replacements and reports teardown failures", () => {
    const current = row();
    const replacement = document.createElement("div");
    const failure = new Error("destroy failed");
    const destroyed: HTMLElement[] = [];
    const journal = new RenderJournal<string, RenderState<string>>(
      (item, element) =>
        item === "before" ? replacement : render(item, element),
      () => {},
      (element) => {
        destroyed.push(element);
        throw failure;
      },
    );
    journal.renderRow(current, "after");

    expect(journal.rollback()).toEqual([failure]);
    expect(destroyed).toEqual([replacement]);
    expect(current.renderUnknown).toBe(true);
  });

  it("does not restore rows destroyed during preparation", () => {
    const current = row();
    const dirty: RenderState<string>[] = [];
    const journal = new RenderJournal<string, RenderState<string>>(
      render,
      (entry) => dirty.push(entry),
    );
    journal.renderRow(current, "after");
    current.destroyed = true;

    expect(journal.rollback()).toEqual([]);
    expect(current.element.textContent).toBe("after");
    expect(dirty).toEqual([]);
  });
});
