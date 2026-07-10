/**
 * Fenwick (binary-indexed) tree over row heights — the virtualizer's offset
 * engine. `prefix(i)` is the content-space top of index i, `total()` the full
 * item height, `indexAt(offset)` maps a pixel offset back to the row that
 * owns it, and `append`/`add` keep the model current as rows stream in and
 * measurements land. Backed by lazy capacity headroom: inactive slots cost no
 * build or update work, and activating them is amortized O(1).
 */

export class FenwickTree {
  private readonly tree: Float64Array;
  private logicalSize: number;
  private searchBit: number;
  private totalValue: number;

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
    const normalizedCapacity =
      Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
    this.capacity = Math.max(normalizedCapacity, values.length);
    this.tree = new Float64Array(this.capacity + 1);
    this.totalValue = 0;
    // O(size) build: seed each active node with its value, then fold each
    // partial sum into its active parent. Capacity headroom stays untouched
    // until append() activates a slot.
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

  /**
   * The stored value at `index`, recovered directly from its Fenwick node.
   * This visits only the earlier nodes inside that node's low-bit block instead
   * of performing two complete prefix traversals.
   */
  valueAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.logicalSize) {
      return 0;
    }

    let cursor = index + 1;
    let value = this.tree[cursor] ?? 0;
    const blockStart = cursor - (cursor & -cursor);
    cursor--;
    while (cursor !== blockStart) {
      value -= this.tree[cursor] ?? 0;
      cursor -= cursor & -cursor;
    }
    return value;
  }

  /**
   * Extract all logical values in O(size) by copying only the active nodes and
   * inverting the linear build in place: descending, remove each node's
   * contribution from its parent; what remains is the raw value.
   */
  toValues(): Float64Array {
    const values = this.tree.slice(1, this.logicalSize + 1);
    for (let i = this.logicalSize; i >= 1; i--) {
      const parent = i + (i & -i);
      if (parent <= this.logicalSize) {
        values[parent - 1] = (values[parent - 1] ?? 0) - (values[i - 1] ?? 0);
      }
    }
    return values;
  }

  /** Grow the logical size by one, assigning `value` to the new last index. */
  append(value: number): void {
    if (this.logicalSize >= this.capacity) {
      throw new Error("FenwickTree.append: no spare capacity");
    }
    if (!Number.isFinite(value)) {
      throw new RangeError("FenwickTree.append: value must be finite");
    }

    const nextSize = this.logicalSize + 1;
    const blockStart = nextSize - (nextSize & -nextSize);
    let nodeValue = value;
    // Build the newly active node from the already-current nodes in its block.
    // Most appends visit no prior node; powers of two visit O(log size), making
    // a sequence of appends amortized O(1).
    for (
      let cursor = this.logicalSize;
      cursor > blockStart;
      cursor -= cursor & -cursor
    ) {
      nodeValue += this.tree[cursor] ?? 0;
    }
    this.tree[nextSize] = nodeValue;
    this.logicalSize = nextSize;
    this.totalValue += value;
    if (this.searchBit << 1 <= this.logicalSize) this.searchBit <<= 1;
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
