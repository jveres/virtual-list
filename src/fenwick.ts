/**
 * Fenwick (binary-indexed) tree over row heights — the geometry kernel's
 * offset engine. `prefix(i)` is the content-space top of index i, `total()`
 * the full item height, `indexAt(offset)` maps a pixel offset back to the row
 * that owns it, `add` applies a measured height delta, `append` grows the tree
 * for a pure append, `truncate` shrinks it for a pure trailing removal, and
 * `rebuild` folds new values in place when the length is unchanged.
 */

export class FenwickTree {
  private tree: Float64Array;
  private logicalSize = 0;
  private searchBit = 1;
  private totalValue = 0;

  /** Logical element count — searches operate on `[0, size)`. */
  get size(): number {
    return this.logicalSize;
  }

  constructor(values: Float64Array) {
    this.tree = new Float64Array(values.length + 1);
    this.rebuild(values);
  }

  /**
   * Rebuild the tree from `values` in O(size), reusing the existing backing
   * `Float64Array` in place when `values.length === size`. Non-finite inputs
   * throw before mutating existing state.
   */
  rebuild(values: Float64Array): void {
    const size = values.length;
    for (let i = 0; i < size; i++) {
      if (!Number.isFinite(values[i] as number)) {
        throw new RangeError("FenwickTree: values must be finite");
      }
    }
    let tree = this.tree;
    if (tree.length === size + 1) {
      tree.fill(0);
    } else {
      tree = new Float64Array(size + 1);
      this.tree = tree;
    }
    let total = 0;
    // O(size) build: seed each node with its value, then fold each partial
    // sum into its parent.
    for (let i = 1; i <= size; i++) {
      const value = values[i - 1] as number;
      const node = (tree[i] as number) + value;
      tree[i] = node;
      total += value;
      const parent = i + (i & -i);
      if (parent <= size) {
        tree[parent] = (tree[parent] as number) + node;
      }
    }
    this.logicalSize = size;
    this.totalValue = total;
    let maxBit = 1;
    while (maxBit << 1 <= size) maxBit <<= 1;
    this.searchBit = maxBit;
  }

  /**
   * Extend the tree with new trailing values in O(added + log size): the
   * constructor's linear fold, continued. Old nodes are complete; those whose
   * parent is new lie on the old size's prefix path, and fold in first.
   */
  append(values: Float64Array): void {
    const added = values.length;
    for (let i = 0; i < added; i++) {
      if (!Number.isFinite(values[i] as number))
        throw new RangeError("FenwickTree: values must be finite");
    }
    if (added === 0) return;
    const oldSize = this.logicalSize;
    const size = oldSize + added;
    const tree = new Float64Array(size + 1);
    tree.set(this.tree);
    for (let i = oldSize; i > 0; i -= i & -i) {
      const parent = i + (i & -i);
      if (parent <= size)
        tree[parent] = (tree[parent] as number) + (tree[i] as number);
    }
    let total = this.totalValue;
    for (let i = oldSize + 1; i <= size; i++) {
      const value = values[i - oldSize - 1] as number;
      const node = (tree[i] as number) + value;
      tree[i] = node;
      total += value;
      const parent = i + (i & -i);
      if (parent <= size) tree[parent] = (tree[parent] as number) + node;
    }
    this.tree = tree;
    this.logicalSize = size;
    this.totalValue = total;
    while (this.searchBit << 1 <= size) this.searchBit <<= 1;
  }

  /**
   * Shrink the tree to a prefix `[0, newSize)`. Every Fenwick node `i <= newSize`
   * depends only on indices `<= i`, so `tree[0 .. newSize]` is already complete.
   */
  truncate(newSize: number): void {
    if (newSize < 0 || newSize >= this.logicalSize) return;
    this.totalValue = this.prefix(newSize);
    this.tree = this.tree.slice(0, newSize + 1);
    this.logicalSize = newSize;
    let maxBit = 1;
    while (maxBit << 1 <= newSize) maxBit <<= 1;
    this.searchBit = maxBit;
  }

  add(index: number, delta: number): void {
    const size = this.logicalSize;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= size ||
      !Number.isFinite(delta) ||
      delta === 0
    ) {
      return;
    }
    const tree = this.tree;
    for (let i = index + 1; i <= size; i += i & -i) {
      tree[i] = (tree[i] as number) + delta;
    }
    this.totalValue += delta;
  }

  prefix(count: number): number {
    let sum = 0;
    const safeCount = Math.max(
      0,
      Math.min(this.logicalSize, Math.floor(count)),
    );
    const tree = this.tree;
    for (let i = safeCount; i > 0; i -= i & -i) {
      sum += tree[i] as number;
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
    const size = this.logicalSize;
    const tree = this.tree;
    let index = 0;
    let sum = 0;
    if (inclusive) {
      for (let bit = this.searchBit; bit > 0; bit >>= 1) {
        const next = index + bit;
        if (next <= size) {
          const nextSum = sum + (tree[next] as number);
          if (nextSum <= offset) {
            index = next;
            sum = nextSum;
          }
        }
      }
    } else {
      for (let bit = this.searchBit; bit > 0; bit >>= 1) {
        const next = index + bit;
        if (next <= size) {
          const nextSum = sum + (tree[next] as number);
          if (nextSum < offset) {
            index = next;
            sum = nextSum;
          }
        }
      }
    }
    return index;
  }
}
