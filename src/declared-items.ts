import type { KeyIndex } from "./key-index";

interface Declared<T> {
  item: T;
  height: number;
}

interface Snapshot<T> {
  index: KeyIndex;
  leading: number;
  items: T[];
  heights: Float64Array;
}

/** Full snapshots share the key index; small update patches own only touched keys. */
export class DeclaredItems<T> {
  private snapshot: Snapshot<T> | null = null;
  private readonly patch = new Map<string, Declared<T>>();

  /** Own the fresh height buffer; copy items independently of desired state. */
  constructor(
    index?: KeyIndex,
    leading = 0,
    items: readonly T[] = [],
    heights = new Float64Array(0),
  ) {
    if (index) this.snapshot = { index, leading, items: [...items], heights };
  }

  get size(): number {
    return this.snapshot?.items.length ?? this.patch.size;
  }

  heightOf(key: string): number | undefined {
    const data = this.snapshot;
    if (!data) return this.patch.get(key)?.height;
    const position = data.index.positions.get(key);
    return position === undefined
      ? undefined
      : data.heights[position - data.leading];
  }

  itemOf(key: string): T | undefined {
    const data = this.snapshot;
    if (!data) return this.patch.get(key)?.item;
    const position = data.index.positions.get(key);
    return position === undefined
      ? undefined
      : data.items[position - data.leading];
  }

  get(key: string): Declared<T> | undefined {
    if (!this.snapshot) return this.patch.get(key);
    const height = this.heightOf(key);
    return height === undefined
      ? undefined
      : { item: this.itemOf(key) as T, height };
  }

  has(key: string): boolean {
    return this.heightOf(key) !== undefined;
  }

  set(key: string, entry: Declared<T>): void {
    const data = this.snapshot;
    if (!data) {
      this.patch.set(key, entry);
      return;
    }
    const position = data.index.positions.get(key);
    const at = position === undefined ? -1 : position - data.leading;
    if (at < 0 || at >= data.items.length)
      throw new Error("declared snapshot cannot add an item");
    data.items[at] = entry.item;
    data.heights[at] = entry.height;
  }

  forEach(
    visit: (item: T, height: number, key: string) => void,
    unchanged?: DeclaredItems<T>,
  ): void {
    const data = this.snapshot;
    if (!data) {
      for (const [key, entry] of this.patch)
        visit(entry.item, entry.height, key);
      return;
    }
    const prev = unchanged?.snapshot ?? null;
    const sameOrder =
      prev !== null &&
      prev.index === data.index &&
      prev.leading === data.leading &&
      prev.items.length === data.items.length;
    for (let at = 0; at < data.items.length; at++) {
      const item = data.items[at] as T;
      const height = data.heights[at] as number;
      const key = data.index.keys[at + data.leading] as string;
      if (
        prev !== null &&
        at < prev.items.length &&
        prev.items[at] === item &&
        prev.heights[at] === height &&
        (sameOrder || prev.index.keys[at + prev.leading] === key)
      )
        continue;
      visit(item, height, key);
    }
  }

  /**
   * Whether any declared height before `anchorIndex` differs from `geometry`'s
   * current height. Snapshot mode uses indexed lookups without Map probes.
   */
  shiftsBefore(
    anchorIndex: number,
    geometry: {
      indexOf(key: string): number;
      heightAt(index: number): number;
    },
  ): boolean {
    if (anchorIndex <= 0) return false;
    const data = this.snapshot;
    if (!data) {
      for (const [key, entry] of this.patch) {
        const index = geometry.indexOf(key);
        if (
          index >= 0 &&
          index < anchorIndex &&
          geometry.heightAt(index) !== entry.height
        )
          return true;
      }
      return false;
    }
    const limit = Math.min(data.items.length, anchorIndex - data.leading);
    for (let at = 0; at < limit; at++) {
      if (geometry.heightAt(at + data.leading) !== data.heights[at])
        return true;
    }
    return false;
  }

  clear(): void {
    this.snapshot = null;
    this.patch.clear();
  }
}
