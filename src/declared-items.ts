import type { KeyIndex } from "./key-index";

export interface Declared<T> {
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

  /** Whether this snapshot holds exactly this entry at ordinal `at`. */
  holdsAt(at: number, key: string, item: T, height: number): boolean {
    const data = this.snapshot;
    return (
      data !== null &&
      at < data.items.length &&
      data.items[at] === item &&
      data.heights[at] === height &&
      data.index.keys[at + data.leading] === key
    );
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

  forEach(visit: (item: T, height: number, key: string) => void): void {
    const data = this.snapshot;
    if (!data) {
      for (const [key, entry] of this.patch)
        visit(entry.item, entry.height, key);
      return;
    }
    for (let at = 0; at < data.items.length; at++)
      visit(
        data.items[at] as T,
        data.heights[at] as number,
        data.index.keys[at + data.leading] as string,
      );
  }

  clear(): void {
    this.snapshot = null;
    this.patch.clear();
  }
}
