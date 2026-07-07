/**
 * Fenwick (binary-indexed) tree over row heights — the virtualizer's offset
 * engine. `prefix(i)` is the content-space top of index i, `total()` the full
 * item height, `indexAt(offset)` maps a pixel offset back to the row that
 * owns it, and `append`/`add` keep the model current as rows stream in and
 * measurements land. Backed by capacity headroom so pure appends are
 * O(log capacity) without a rebuild.
 */

export class FenwickTree {
  private readonly tree: Float64Array;
  private logicalSize: number;
  private searchBit: number;

  /** Backing slot count; `append` may grow `size` up to this without a rebuild. */
  readonly capacity: number;

  /** Logical element count — `prefix`/`indexAt` operate on `[0, size)`. */
  get size(): number {
    return this.logicalSize;
  }

  /** Largest power of two <= size (1 when empty); `indexAt`'s first probe. */
  get maxBit(): number {
    return this.searchBit;
  }

  constructor(values: Float64Array, capacity = values.length) {
    this.logicalSize = values.length;
    this.capacity = Math.max(capacity, values.length);
    this.tree = new Float64Array(this.capacity + 1);
    // O(n) build over the full capacity (slots past values.length are zero):
    // seed each node with its value, then fold each node's partial sum into its
    // parent — same result as n add() calls, one log factor cheaper.
    for (let i = 1; i <= this.capacity; i++) {
      this.tree[i] = (this.tree[i] ?? 0) + (values[i - 1] ?? 0);
      const parent = i + (i & -i);
      if (parent <= this.capacity) {
        this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[i] ?? 0);
      }
    }
    let maxBit = 1;
    while (maxBit << 1 <= this.logicalSize) maxBit <<= 1;
    this.searchBit = maxBit;
  }

  add(index: number, delta: number): void {
    // Walk to capacity, not size, so the zero-padding slots stay consistent and
    // append() can activate them later without touching the tree.
    for (let i = index + 1; i <= this.capacity; i += i & -i) {
      this.tree[i] = (this.tree[i] ?? 0) + delta;
    }
  }

  /**
   * The stored value at `index`, as the difference of adjacent prefix sums —
   * O(log n). Float rounding across the partial sums bounds the error at
   * ~1e-7 of the total, far below the library's 0.5px measure epsilon.
   */
  valueAt(index: number): number {
    return this.prefix(index + 1) - this.prefix(index);
  }

  /**
   * Extract all logical values in O(n) by inverting the linear build on a
   * scratch copy: descending, remove each node's contribution from its
   * parent; what remains at node i is the raw value of element i-1.
   */
  toValues(): Float64Array {
    const scratch = this.tree.slice();
    for (let i = this.capacity; i >= 1; i--) {
      const parent = i + (i & -i);
      if (parent <= this.capacity) {
        scratch[parent] = (scratch[parent] ?? 0) - (scratch[i] ?? 0);
      }
    }
    const values = new Float64Array(this.logicalSize);
    for (let i = 0; i < this.logicalSize; i++) values[i] = scratch[i + 1] ?? 0;
    return values;
  }

  /** Grow the logical size by one, assigning `value` to the new last index. */
  append(value: number): void {
    if (this.logicalSize >= this.capacity) {
      throw new Error("FenwickTree.append: no spare capacity");
    }
    this.logicalSize++;
    if (this.searchBit << 1 <= this.logicalSize) this.searchBit <<= 1;
    this.add(this.logicalSize - 1, value);
  }

  prefix(count: number): number {
    let sum = 0;
    const safeCount = Math.max(0, Math.min(this.logicalSize, count));
    for (let i = safeCount; i > 0; i -= i & -i) {
      sum += this.tree[i] ?? 0;
    }
    return sum;
  }

  total(): number {
    return this.prefix(this.logicalSize);
  }

  indexAt(offset: number): number {
    if (this.logicalSize === 0) return 0;

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
}
