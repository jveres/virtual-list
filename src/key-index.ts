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
}
