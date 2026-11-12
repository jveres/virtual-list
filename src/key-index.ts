const EMPTY_SLOTS = new Int32Array(0);

function capacityFor(count: number): number {
  if (count <= 0) return 0;
  let cap = 8;
  while (cap * 25 < count * 32) cap <<= 1;
  return cap;
}

function hashKey(key: string): number {
  let h = -2128831035;
  const len = key.length;
  for (let i = 0; i < len; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  }
  h = Math.imul(h ^ (h >>> 16), -2048144789);
  return h ^ (h >>> 13);
}

/**
 * Compact open-addressed string->index hash table backed by a single
 * `Int32Array` (`0` = empty, `index + 1` = occupied).
 */
export class KeyTable {
  private slots: Int32Array;
  private mask: number;
  private count = 0;
  keys: readonly string[];

  constructor(keys: readonly string[], expectedCount = keys.length) {
    const cap = capacityFor(expectedCount);
    this.slots = cap > 0 ? new Int32Array(cap) : EMPTY_SLOTS;
    this.mask = cap - 1;
    this.keys = keys;
  }

  get size(): number {
    return this.count;
  }

  get(key: string): number | undefined {
    const mask = this.mask;
    if (mask < 0) return undefined;
    const slots = this.slots;
    const keys = this.keys;
    let slot = hashKey(key) & mask;
    while (true) {
      const entry = slots[slot] as number;
      if (entry === 0) return undefined;
      const index = entry - 1;
      if (keys[index] === key) return index;
      slot = (slot + 1) & mask;
    }
  }

  /**
   * Insert `(key, index)` if absent; returns `false` without mutating the
   * table when `key` already exists in `lookupKeys`.
   */
  insertUnique(
    key: string,
    index: number,
    lookupKeys: readonly string[] = this.keys,
  ): boolean {
    if ((this.count + 1) * 32 > this.slots.length * 25) {
      this.grow(this.count + 1, lookupKeys);
    }
    const slots = this.slots;
    const mask = this.mask;
    let slot = hashKey(key) & mask;
    while (true) {
      const entry = slots[slot] as number;
      if (entry === 0) {
        slots[slot] = index + 1;
        this.count += 1;
        return true;
      }
      if (lookupKeys[entry - 1] === key) return false;
      slot = (slot + 1) & mask;
    }
  }

  /** Pre-sized table populated with a known-unique `[0, length)` prefix. */
  clonePrefix(
    keys: readonly string[],
    length: number,
    expectedCount: number,
  ): KeyTable {
    const table = new KeyTable(keys, Math.max(length, expectedCount));
    if (length === 0) return table;
    const slots = table.slots;
    const mask = table.mask;
    for (let index = 0; index < length; index++) {
      const key = keys[index] as string;
      let slot = hashKey(key) & mask;
      while (slots[slot] !== 0) slot = (slot + 1) & mask;
      slots[slot] = index + 1;
    }
    table.count = length;
    return table;
  }

  /** Knuth Algorithm R backward-shift deletion for rollback on failed extend. */
  deleteKey(key: string, lookupKeys: readonly string[]): void {
    const mask = this.mask;
    if (mask < 0) return;
    const slots = this.slots;
    let i = hashKey(key) & mask;
    while (true) {
      const entry = slots[i] as number;
      if (entry === 0) return;
      if (lookupKeys[entry - 1] === key) break;
      i = (i + 1) & mask;
    }
    let j = i;
    while (true) {
      j = (j + 1) & mask;
      const entry = slots[j] as number;
      if (entry === 0) break;
      const k = hashKey(lookupKeys[entry - 1] as string) & mask;
      const inRange = i <= j ? i < k && k <= j : i < k || k <= j;
      if (!inRange) {
        slots[i] = entry;
        i = j;
      }
    }
    slots[i] = 0;
    this.count -= 1;
  }

  private grow(minCount: number, lookupKeys: readonly string[]): void {
    const cap = Math.max(
      capacityFor(minCount),
      this.slots.length > 0 ? this.slots.length << 1 : 8,
    );
    const next = new Int32Array(cap);
    const nextMask = cap - 1;
    const oldSlots = this.slots;
    for (let s = 0; s < oldSlots.length; s++) {
      const entry = oldSlots[s] as number;
      if (entry === 0) continue;
      const key = lookupKeys[entry - 1] as string;
      let slot = hashKey(key) & nextMask;
      while (next[slot] !== 0) slot = (slot + 1) & nextMask;
      next[slot] = entry;
    }
    this.slots = next;
    this.mask = nextMask;
  }
}

/** Owned, immutable key order shared by desired state and committed geometry. */
export class KeyIndex {
  readonly keys: readonly string[];
  /**
   * Shared along a chain of appends or prefix trims. The newest order of the
   * chain owns every entry; an older or shorter one sees only the entries
   * below its own length.
   */
  private readonly positions: KeyTable;

  /** `positions` and `owned` are trusted: only internal factories pass them. */
  constructor(
    keys: readonly string[],
    positions?: Map<string, number> | KeyTable,
    owned = false,
  ) {
    const ownedKeys = owned ? keys : keys.slice();
    this.keys = ownedKeys;
    if (positions instanceof KeyTable) {
      this.positions = positions;
      return;
    }
    const table = new KeyTable(ownedKeys, ownedKeys.length);
    if (positions) {
      for (let index = 0; index < ownedKeys.length; index++) {
        table.insertUnique(ownedKeys[index] as string, index, ownedKeys);
      }
      this.positions = table;
      return;
    }
    for (let index = 0; index < ownedKeys.length; index++) {
      const key = ownedKeys[index] as string;
      if (!table.insertUnique(key, index, ownedKeys)) {
        throw new Error(`duplicate key: "${key}"`);
      }
    }
    this.positions = table;
  }

  /** Adopt pre-validated owned `keys` and `positions` without copying `keys`. */
  static fromOwned(
    keys: readonly string[],
    positions: Map<string, number> | KeyTable,
  ): KeyIndex {
    return new KeyIndex(keys, positions, true);
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

  /** `prefixes(next.keys)`, in constant time along a shared chain. */
  precedes(next: KeyIndex): boolean {
    return next.positions === this.positions
      ? this.keys.length < next.keys.length
      : this.prefixes(next.keys);
  }

  /**
   * Share `positions` when `keys` is a strict unchanged prefix of this order
   * (a trailing removal). Entries at or above `keys.length` remain invisible
   * through `get`.
   */
  truncate(keys: readonly string[], owned = false): KeyIndex | null {
    if (keys.length >= this.keys.length) return null;
    for (let index = 0; index < keys.length; index++)
      if (keys[index] !== this.keys[index]) return null;
    return new KeyIndex(keys, this.positions, owned);
  }

  /**
   * The index for `keys` when they strictly extend this order (the old keys
   * are an unchanged prefix); null otherwise. The newest order of a chain
   * adds only the new keys to the shared positions, so an append costs the
   * keys it adds. An order that was already extended copies its own entries
   * first unless the existing chain already matches `keys`. A duplicate among
   * the new keys throws, as in the constructor, and leaves the shared
   * positions as they were.
   */
  extend(keys: readonly string[], owned = false): KeyIndex | null {
    if (!this.prefixes(keys)) return null;
    return this.extendTrusted(keys, owned);
  }

  /** `extend` when the caller has already verified `keys` strictly prefixes `this.keys`. */
  extendTrusted(keys: readonly string[], owned = false): KeyIndex {
    const length = this.keys.length;
    const nextKeys = owned ? keys : keys.slice();
    let positions = this.positions;
    if (positions.size !== length) {
      const chainKeys = positions.keys;
      if (nextKeys.length <= chainKeys.length) {
        let sameChain = true;
        for (let index = length; index < nextKeys.length; index++) {
          if (chainKeys[index] !== nextKeys[index]) {
            sameChain = false;
            break;
          }
        }
        if (sameChain) return new KeyIndex(nextKeys, positions, true);
      }
      positions = positions.clonePrefix(nextKeys, length, nextKeys.length);
    }
    for (let index = length; index < nextKeys.length; index++) {
      const key = nextKeys[index] as string;
      if (positions.insertUnique(key, index, nextKeys)) continue;
      for (let added = length; added < index; added++) {
        positions.deleteKey(nextKeys[added] as string, nextKeys);
      }
      throw new Error(`duplicate key: "${key}"`);
    }
    positions.keys = nextKeys;
    return new KeyIndex(nextKeys, positions, true);
  }
}
