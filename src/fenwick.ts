/**
 * Fenwick (binary-indexed) tree over row heights — the geometry kernel's
 * offset engine. `prefix(i)` is the content-space top of index i, `total()`
 * the full item height, `indexAt(offset)` maps a pixel offset back to the row
 * that owns it, `lowerBound(offset)` finds the exclusive item count at a
 * boundary, and `add` applies a measured height delta. The kernel rebuilds the
 * tree on every key change, so there is no append path.
 */

export class FenwickTree {
  private tree: Float64Array;
  private logicalSize: number;
  private searchBit: number;
  private totalValue: number;

  /** Logical element count — searches operate on `[0, size)`. */
  get size(): number {
    return this.logicalSize;
  }

  constructor(values: Float64Array) {
    this.logicalSize = values.length;
    this.tree = new Float64Array(this.logicalSize + 1);
    this.totalValue = 0;
    // O(size) build: seed each node with its value, then fold each partial
    // sum into its parent.
    for (let i = 1; i <= this.logicalSize; i++) {
      const value = values[i - 1] ?? 0;
      if (!Number.isFinite(value)) {
        throw new RangeError("FenwickTree: values must be finite");
      }
      this.tree[i] = (this.tree[i] ?? 0) + value;
      this.totalValue += value;
      const parent = i + (i & -i);
      if (parent <= this.logicalSize) {
        this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[i] ?? 0);
      }
    }
    let maxBit = 1;
    while (maxBit << 1 <= this.logicalSize) maxBit <<= 1;
    this.searchBit = maxBit;
  }

  /**
   * Extend the tree with new trailing values in O(added · log size). Existing
   * nodes cover ranges that end at or before the old size, so they stay
   * valid; each new node is the sum of its range, read from the old tree's
   * prefixes plus the new values' own prefix sums.
   */
  append(values: Float64Array): void {
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i]))
        throw new RangeError("FenwickTree: values must be finite");
    }
    if (values.length === 0) return;
    const oldSize = this.logicalSize;
    const newSize = oldSize + values.length;
    const oldTree = this.tree;
    const oldPrefix = (count: number): number => {
      let sum = 0;
      for (let i = Math.min(count, oldSize); i > 0; i -= i & -i)
        sum += oldTree[i] ?? 0;
      return sum;
    };
    const addedPrefix = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i++)
      addedPrefix[i + 1] = (addedPrefix[i] as number) + (values[i] as number);
    const tree = new Float64Array(newSize + 1);
    tree.set(oldTree);
    for (let index = oldSize + 1; index <= newSize; index++) {
      const rangeStart = index - (index & -index);
      const oldPart =
        oldPrefix(Math.min(index, oldSize)) - oldPrefix(rangeStart);
      const newPart =
        (addedPrefix[index - oldSize] as number) -
        (addedPrefix[Math.max(0, rangeStart - oldSize)] as number);
      tree[index] = oldPart + newPart;
    }
    this.tree = tree;
    this.logicalSize = newSize;
    this.totalValue += addedPrefix[values.length] as number;
    while (this.searchBit << 1 <= newSize) this.searchBit <<= 1;
  }

  add(index: number, delta: number): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.logicalSize ||
      !Number.isFinite(delta) ||
      delta === 0
    ) {
      return;
    }
    for (let i = index + 1; i <= this.logicalSize; i += i & -i) {
      this.tree[i] = (this.tree[i] ?? 0) + delta;
    }
    this.totalValue += delta;
  }

  prefix(count: number): number {
    let sum = 0;
    const safeCount = Math.max(
      0,
      Math.min(this.logicalSize, Math.floor(count)),
    );
    for (let i = safeCount; i > 0; i -= i & -i) {
      sum += this.tree[i] ?? 0;
    }
    return sum;
  }

  total(): number {
    return this.totalValue;
  }

  indexAt(offset: number): number {
    const index = this.descend(offset, true);
    return Math.max(0, Math.min(this.logicalSize - 1, index));
  }

  /** Smallest item count whose prefix reaches `offset` (lower bound). */
  lowerBound(offset: number): number {
    if (this.logicalSize === 0 || Number.isNaN(offset) || offset <= 0) return 0;
    const index = this.descend(offset, false);
    return Math.min(this.logicalSize, index + 1);
  }

  /** Largest item count whose prefix is below the inclusive/exclusive bound. */
  private descend(offset: number, inclusive: boolean): number {
    let index = 0;
    let sum = 0;
    for (let bit = this.searchBit; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next > this.logicalSize) continue;
      const nextValue = this.tree[next] ?? 0;
      const nextSum = sum + nextValue;
      if (inclusive ? nextSum <= offset : nextSum < offset) {
        index = next;
        sum = nextSum;
      }
    }
    return index;
  }
}
