import type { Photo } from "./layout.js";

/** Layout state immediately before the first retained photo. No photo objects. */
export interface LayoutCheckpoint {
  readonly rowAspect: number;
  readonly weights: readonly number[];
  readonly counts: readonly number[];
}

export function assignColumn(
  weights: number[],
  counts: number[],
  aspect: number,
): number {
  let column = 0;
  for (let i = 1; i < weights.length; i++) {
    if ((weights[i] as number) < (weights[column] as number)) column = i;
  }
  weights[column] = (weights[column] as number) + 1 / aspect;
  counts[column] = (counts[column] as number) + 1;
  return column;
}

/**
 * Indexed-source adapter: advance all supported densities together, retaining
 * a bounded set of page checkpoints. Forward paging visits each prefix photo
 * once; resize/density changes reuse its checkpoint. A backward cache miss
 * reconstructs from the source, which must provide stable aspects by index.
 * Remote sources can instead restore LayoutCheckpoint with their page cursor.
 */
export function createLayoutHistory(
  photoAt: (index: number) => Photo,
  maxDensity: number,
  pageSize = 120,
  maxCheckpoints = 16,
): (photos: readonly Photo[], density: number) => LayoutCheckpoint {
  for (const value of [maxDensity, pageSize, maxCheckpoints]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("layout history limits must be positive safe integers");
  }
  const empty = (): LayoutCheckpoint[] =>
    Array.from({ length: maxDensity }, (_, i) => ({
      rowAspect: 0,
      weights: new Array<number>(i + 1).fill(0),
      counts: new Array<number>(i + 1).fill(0),
    }));
  const checkpoints = new Map<number, LayoutCheckpoint[]>();
  const remember = (index: number, states: LayoutCheckpoint[]): void => {
    checkpoints.delete(index);
    checkpoints.set(index, states);
    if (checkpoints.size > maxCheckpoints) {
      const oldest = checkpoints.keys().next().value;
      if (oldest !== undefined) checkpoints.delete(oldest);
    }
  };
  return (photos, density) => {
    if (!Number.isSafeInteger(density) || density < 1 || density > maxDensity)
      throw new Error("density exceeds configured layout history");
    const end = photos[0]?.id ?? 0;
    let from = 0;
    let seed: LayoutCheckpoint[] | undefined;
    for (const [index, states] of checkpoints) {
      if (index <= end && index >= from) {
        from = index;
        seed = states;
      }
    }
    seed ??= empty();
    if (from === end) {
      remember(end, seed);
      return seed[density - 1] as LayoutCheckpoint;
    }
    let states = seed.map((state) => ({
      ...state,
      weights: [...state.weights],
      counts: [...state.counts],
    }));
    for (let index = from; index < end; index++) {
      const { aspect } = photoAt(index);
      for (let i = 0; i < states.length; i++) {
        const state = states[i];
        if (!state) continue;
        state.rowAspect += aspect;
        if (state.rowAspect >= i + 1) state.rowAspect = 0;
        assignColumn(state.weights, state.counts, aspect);
      }
      if ((index + 1) % pageSize === 0 || index + 1 === end) {
        remember(index + 1, states);
        if (index + 1 < end)
          states = states.map((state) => ({
            ...state,
            weights: [...state.weights],
            counts: [...state.counts],
          }));
      }
    }
    return states[density - 1] as LayoutCheckpoint;
  };
}
