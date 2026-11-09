/** Owned, immutable key order shared by desired state and committed geometry. */
export class KeyIndex {
  readonly keys: readonly string[];
  /**
   * Shared along a chain of appends. The newest order of the chain owns every
   * entry; an older one sees only the entries below its own length.
   */
  private readonly positions: Map<string, number>;

  /** `positions` is trusted: only `extend` passes it. */
  constructor(keys: readonly string[], positions?: Map<string, number>) {
    this.keys = [...keys];
    if (positions) {
      this.positions = positions;
      return;
    }
    this.positions = new Map<string, number>();
    for (let index = 0; index < this.keys.length; index++)
      this.positions.set(this.keys[index] as string, index);
    if (this.positions.size !== this.keys.length) {
      const seen = new Set<string>();
      for (const key of this.keys) {
        if (seen.has(key)) throw new Error(`duplicate key: "${key}"`);
        seen.add(key);
      }
    }
  }

  /** The key's index in this order; undefined when it has none. */
  get(key: string): number | undefined {
    const index = this.positions.get(key);
    return index !== undefined && index < this.keys.length ? index : undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  matches(keys: readonly string[]): boolean {
    if (keys === this.keys) return true;
    if (keys.length !== this.keys.length) return false;
    for (let index = 0; index < keys.length; index++)
      if (keys[index] !== this.keys[index]) return false;
    return true;
  }

  /** Whether `keys` strictly extend this order: it is their unchanged prefix. */
  private prefixes(keys: readonly string[]): boolean {
    if (keys.length <= this.keys.length) return false;
    for (let index = 0; index < this.keys.length; index++)
      if (keys[index] !== this.keys[index]) return false;
    return true;
  }

  /** `prefixes(next.keys)`, in constant time along a chain of appends. */
  precedes(next: KeyIndex): boolean {
    return next.positions === this.positions
      ? this.keys.length < next.keys.length
      : this.prefixes(next.keys);
  }

  /**
   * The index for `keys` when they strictly extend this order (the old keys
   * are an unchanged prefix); null otherwise. The newest order of a chain
   * adds only the new keys to the shared positions, so an append costs the
   * keys it adds. An order that was already extended copies its own entries
   * first. A duplicate among the new keys throws, as in the constructor, and
   * leaves the shared positions as they were.
   */
  extend(keys: readonly string[]): KeyIndex | null {
    if (!this.prefixes(keys)) return null;
    const length = this.keys.length;
    let positions = this.positions;
    if (positions.size !== length) {
      positions = new Map<string, number>();
      for (let index = 0; index < length; index++)
        positions.set(this.keys[index] as string, index);
    }
    for (let index = length; index < keys.length; index++) {
      const key = keys[index] as string;
      positions.set(key, index);
      if (positions.size === index + 1) continue;
      // A repeated key overwrote its first position: restore the entries.
      for (let added = length; added < index; added++)
        positions.delete(keys[added] as string);
      const first = keys.indexOf(key);
      if (first < length) positions.set(key, first);
      throw new Error(`duplicate key: "${key}"`);
    }
    return new KeyIndex(keys, positions);
  }
}
