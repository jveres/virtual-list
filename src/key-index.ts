/** Owned, immutable key order shared by desired state and committed geometry. */
export class KeyIndex {
  readonly keys: readonly string[];
  readonly positions: ReadonlyMap<string, number>;

  constructor(keys: readonly string[]) {
    this.keys = [...keys];
    const positions = new Map<string, number>();
    for (let index = 0; index < this.keys.length; index++)
      positions.set(this.keys[index] as string, index);
    if (positions.size !== this.keys.length) {
      const seen = new Set<string>();
      for (const key of this.keys) {
        if (seen.has(key)) throw new Error(`duplicate key: "${key}"`);
        seen.add(key);
      }
    }
    this.positions = positions;
  }

  matches(keys: readonly string[]): boolean {
    if (keys === this.keys) return true;
    if (keys.length !== this.keys.length) return false;
    for (let index = 0; index < keys.length; index++)
      if (keys[index] !== this.keys[index]) return false;
    return true;
  }

  /** Whether `keys` strictly extend this order: it is their unchanged prefix. */
  prefixes(keys: readonly string[]): boolean {
    if (keys.length <= this.keys.length) return false;
    for (let index = 0; index < this.keys.length; index++)
      if (keys[index] !== this.keys[index]) return false;
    return true;
  }

  /**
   * The index for `keys` when they strictly extend this order (the old keys
   * are an unchanged prefix); null otherwise. The positions map is copied
   * natively and only the new keys are inserted, so appending to a large
   * order costs the copy, not a full rebuild. A duplicate among the new
   * keys throws, as in the constructor.
   */
  extend(keys: readonly string[]): KeyIndex | null {
    if (!this.prefixes(keys)) return null;
    const positions = new Map(this.positions);
    for (let index = this.keys.length; index < keys.length; index++) {
      const key = keys[index] as string;
      if (positions.has(key)) throw new Error(`duplicate key: "${key}"`);
      positions.set(key, index);
    }
    const extended = Object.create(KeyIndex.prototype) as KeyIndex;
    Object.assign(extended, { keys: [...keys], positions });
    return extended;
  }
}
