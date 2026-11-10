import { describe, expect, it } from "vitest";
import { KeyIndex } from "../../src/key-index";

describe("key index", () => {
  it("should index its keys and reject duplicates", () => {
    const index = new KeyIndex(["a", "b", "c"]);

    expect(index.get("b")).toBe(1);
    expect(index.has("c")).toBe(true);
    expect(index.get("d")).toBeUndefined();
    expect(() => new KeyIndex(["a", "b", "a"])).toThrow('duplicate key: "a"');
  });

  it("should own a copy of the key array", () => {
    const keys = ["a", "b"];
    const index = new KeyIndex(keys);

    keys.push("c");

    expect(index.keys).toEqual(["a", "b"]);
  });

  it("should extend only an unchanged prefix", () => {
    const index = new KeyIndex(["a", "b"]);

    expect(index.extend(["a", "b"])).toBeNull();
    expect(index.extend(["a", "x", "c"])).toBeNull();
    expect(index.extend(["a"])).toBeNull();
    expect(index.extend(["a", "b", "c"])?.keys).toEqual(["a", "b", "c"]);
  });

  it("should keep an extended order unaware of the keys appended to it", () => {
    const base = new KeyIndex(["a", "b"]);

    const extended = base.extend(["a", "b", "c", "d"]) as KeyIndex;

    expect(extended.get("d")).toBe(3);
    expect(extended.get("a")).toBe(0);
    expect(base.get("c")).toBeUndefined();
    expect(base.has("d")).toBe(false);
    expect(base.keys).toEqual(["a", "b"]);
  });

  it("should keep two extensions of one order independent", () => {
    const base = new KeyIndex(["a", "b"]);
    const first = base.extend(["a", "b", "x", "y"]) as KeyIndex;

    const second = base.extend(["a", "b", "y", "z", "x"]) as KeyIndex;

    expect(first.get("x")).toBe(2);
    expect(first.get("y")).toBe(3);
    expect(first.has("z")).toBe(false);
    expect(second.get("y")).toBe(2);
    expect(second.get("z")).toBe(3);
    expect(second.get("x")).toBe(4);
    expect(base.has("x")).toBe(false);
  });

  it("should recognize extensions with and without shared positions", () => {
    const base = new KeyIndex(["a", "b"]);
    const extended = base.extend(["a", "b", "c"]) as KeyIndex;
    const forked = base.extend(["a", "b", "d"]) as KeyIndex;

    expect(base.precedes(extended)).toBe(true);
    expect(base.precedes(forked)).toBe(true);
    expect(base.precedes(new KeyIndex(["a", "b", "c"]))).toBe(true);
    expect(extended.precedes(base)).toBe(false);
    expect(base.precedes(base)).toBe(false);
    expect(extended.precedes(forked)).toBe(false);
    expect(base.precedes(new KeyIndex(["a", "x", "c"]))).toBe(false);
  });

  it("should follow a chain of appends", () => {
    let index = new KeyIndex([]);
    const keys: string[] = [];

    for (let at = 0; at < 50; at++) {
      keys.push(`k${at}`);
      index = index.extend(keys) as KeyIndex;
    }

    expect(keys.map((key) => index.get(key))).toEqual(keys.map((_, at) => at));
  });

  it.each([
    ["an existing key", ["a", "b", "c", "a"], "a"],
    ["a new key", ["a", "b", "c", "d", "c"], "c"],
  ])(
    "should reject an extension repeating %s and stay extendable",
    (_, keys, duplicate) => {
      const base = new KeyIndex(["a", "b"]);

      expect(() => base.extend(keys)).toThrow(`duplicate key: "${duplicate}"`);

      expect(base.has("c")).toBe(false);
      const extended = base.extend(["a", "b", "d", "c"]) as KeyIndex;
      expect(extended.get("d")).toBe(2);
      expect(extended.get("c")).toBe(3);
    },
  );

  it("should adopt owned key arrays and pre-validated position maps", () => {
    const keys = ["a", "b"];
    const positions = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    const base = KeyIndex.fromOwned(keys, positions);
    const extendedKeys = ["a", "b", "c"];
    const extended = base.extend(extendedKeys, true) as KeyIndex;

    expect(base.keys).toBe(keys);
    expect(extended.keys).toBe(extendedKeys);
    expect(extended.get("c")).toBe(2);
    expect(base.has("c")).toBe(false);
    expect(base.precedes(extended)).toBe(true);
  });
});
