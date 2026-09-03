/**
 * Fenwick (binary-indexed) tree over row heights — the geometry kernel's
 * offset engine. `prefix(i)` is the content-space top of index i, `total()`
 * the full item height, `indexAt(offset)` maps a pixel offset back to the row
 * that owns it, `lowerBound(offset)` finds the exclusive item count at a
 * boundary, and `add` applies a measured height delta. The kernel rebuilds the
 * tree on every key change, so there is no append path.
 */

export class FenwickTree {
  private readonly tree: Float64Array;
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
    let index = 0;
    let sum = 0;

    for (let bit = this.searchBit; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next > this.logicalSize) continue;
      const nextValue = this.tree[next] ?? 0;
      if (sum + nextValue <= offset) {
        index = next;
        sum += nextValue;
      }
    }

    return Math.max(0, Math.min(this.logicalSize - 1, index));
  }

  /** Smallest item count whose prefix reaches `offset` (lower bound). */
  lowerBound(offset: number): number {
    if (this.logicalSize === 0 || Number.isNaN(offset) || offset <= 0) return 0;

    let index = 0;
    let sum = 0;
    for (let bit = this.searchBit; bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next > this.logicalSize) continue;
      const nextValue = this.tree[next] ?? 0;
      if (sum + nextValue < offset) {
        index = next;
        sum += nextValue;
      }
    }
    return Math.min(this.logicalSize, index + 1);
  }
}
