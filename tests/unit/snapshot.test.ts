import { describe, expect, it } from "vitest";
import {
  createPrepared,
  indexItems,
  mergePrepared,
  slotKey,
  supersededRows,
} from "../../src/snapshot";

describe("snapshot bookkeeping", () => {
  it("inherits a named anchor until an explicit policy replaces it", () => {
    const target = { key: "a", offset: 20 };
    const previous = createPrepared(["a"], target);
    const inherited = createPrepared(["a"], undefined, previous, true);
    expect(inherited.anchor).toBe("viewport");
    expect(inherited.target).toEqual(target);
    const overridden = createPrepared(["a"], "end", inherited, true);
    expect(overridden.anchor).toBe("end");
    expect(overridden.target).toBeNull();
  });

  it("validates duplicate and reserved keys before row preparation", () => {
    expect(() => indexItems(["a", "a"], (key) => key, null)).toThrow(
      'duplicate key "a"',
    );
    expect(() =>
      indexItems([slotKey("start", "load")], (key) => key, null),
    ).toThrow("reserved edge-slot prefix");
  });

  it("indexes declared metadata without retaining another item array", () => {
    const indexed = indexItems(
      ["a", "bb"],
      (key) => key,
      (key) => key.length,
    );
    expect(indexed.itemKeys).toEqual(["a", "bb"]);
    expect([...indexed.itemByKey]).toEqual([
      ["a", "a"],
      ["bb", "bb"],
    ]);
    expect([...(indexed.declaredItems ?? [])]).toEqual([
      ["a", { item: "a", height: 1 }],
      ["bb", { item: "bb", height: 2 }],
    ]);
  });

  it("limits teardown to touched rows without changing ownership", () => {
    const previous = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(supersededRows(previous, new Set(["a"]), ["a", "b"])).toEqual([2]);
    expect(supersededRows(previous, new Set(["a"]))).toEqual([2, 3]);
    expect([...previous]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("merges a patch without dropping untouched rows or copying pending maps", () => {
    const keys = ["a", "b", "c"];
    const previous = createPrepared<string, number>(keys, "viewport");
    previous.newRows.set("a", 1).set("b", 2);
    previous.deferred.set("a", "old").set("c", "untouched");
    previous.declaredItems = new Map([
      ["a", { item: "old", height: 1 }],
      ["b", { item: "b", height: 2 }],
    ]);
    const patch = createPrepared(keys, undefined, previous, true);
    patch.newRows.set("a", 10);
    patch.declaredItems = new Map([["a", { item: "new", height: 10 }]]);

    const merged = mergePrepared(previous, patch, ["a"]);

    expect(merged.keys).toBe(keys);
    expect(merged.newRows).toBe(previous.newRows);
    expect([...merged.newRows]).toEqual([
      ["b", 2],
      ["a", 10],
    ]);
    expect([...merged.deferred]).toEqual([["c", "untouched"]]);
    expect(merged.declaredItems).toBe(previous.declaredItems);
    expect(merged.declaredItems?.get("a")).toEqual({ item: "new", height: 10 });
    expect(merged.declaredItems?.get("b")).toEqual({ item: "b", height: 2 });
    expect(merged.partial).toBe(false);
    expect(merged.anchor).toBe("viewport");
  });

  it("replaces a full snapshot without mutating its predecessor", () => {
    const previous = createPrepared<string, number>(["a"], "viewport");
    previous.newRows.set("a", 1);
    const replacement = createPrepared(["b"], undefined, previous);
    expect(mergePrepared(previous, replacement, ["b"])).toBe(replacement);
    expect([...previous.newRows]).toEqual([["a", 1]]);
    expect(mergePrepared(null, replacement, ["b"])).toBe(replacement);
  });
});
