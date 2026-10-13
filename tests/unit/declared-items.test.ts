import { describe, expect, it } from "vitest";
import { DeclaredItems } from "../../src/declared-items";
import { KeyIndex } from "../../src/key-index";

describe("declared snapshot ownership", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "keeps committed and desired items independent (start=%s, end=%s)",
    (start, end) => {
      const original = [{ id: "a" }, { id: "b" }];
      const desired = [...original];
      const index = new KeyIndex([
        ...(start ? ["start-slot"] : []),
        "a",
        "b",
        ...(end ? ["end-slot"] : []),
      ]);
      const committed = new DeclaredItems(
        index,
        Number(start),
        desired,
        Float64Array.from([40, 50]),
      );
      const pending = new DeclaredItems(
        index,
        Number(start),
        desired,
        Float64Array.from([40, 50]),
      );
      const replacement = { id: "b" };

      desired[0] = { id: "a" };
      pending.set("b", { item: replacement, height: 70.5 });

      expect(committed.itemOf("a")).toBe(original[0]);
      expect(pending.itemOf("a")).toBe(original[0]);
      expect(committed.itemOf("b")).toBe(original[1]);
      expect(committed.heightOf("b")).toBe(50);
      expect(pending.itemOf("b")).toBe(replacement);
      expect(pending.heightOf("b")).toBe(70.5);
      expect(committed.has("start-slot")).toBe(false);
      expect(committed.has("end-slot")).toBe(false);
      const keys: string[] = [];
      pending.forEach((_, __, key) => {
        keys.push(key);
      });
      expect(keys).toEqual(["a", "b"]);
      expect(committed.holdsAt(1, "b", original[1] as { id: string }, 50)).toBe(
        true,
      );
      expect(pending.holdsAt(1, "b", original[1] as { id: string }, 50)).toBe(
        false,
      );
      expect(committed.holdsAt(2, "b", original[1] as { id: string }, 50)).toBe(
        false,
      );

      const changedKeys: string[] = [];
      pending.forEach((_, __, key) => {
        changedKeys.push(key);
      }, committed);
      expect(changedKeys).toEqual(["b"]);
    },
  );

  it("checks whether declared heights shift before an anchor index in snapshot and patch modes", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const index = new KeyIndex(["start-slot", "a", "b", "c"]);
    const snapshot = new DeclaredItems(
      index,
      1,
      items,
      Float64Array.from([40, 60, 80]),
    );
    const geometry = {
      indexOf: (key: string) => index.positions.get(key) ?? -1,
      heightAt: (at: number) => [24, 40, 50, 80][at] ?? 0,
    };

    expect(snapshot.shiftsBefore(0, geometry)).toBe(false);
    expect(snapshot.shiftsBefore(2, geometry)).toBe(false);
    expect(snapshot.shiftsBefore(3, geometry)).toBe(true);

    const patch = new DeclaredItems<{ id: string }>();
    patch.set("c", { item: items[2] as { id: string }, height: 90 });
    expect(patch.shiftsBefore(3, geometry)).toBe(false);
    patch.set("b", { item: items[1] as { id: string }, height: 60 });
    expect(patch.shiftsBefore(3, geometry)).toBe(true);
  });
});
