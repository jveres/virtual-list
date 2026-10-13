import type { Photo } from "./layout.js";

interface LayoutStrategy<Plan, Result> {
  minimumDensity: number;
  plan(photos: readonly Photo[], density: number, complete: boolean): Plan;
  place(plan: Plan, width: number, target: number, gap: number): Result;
}

export function layoutDensity(
  width: number,
  target: number,
  minimum = 1,
): number {
  return Math.max(minimum, Math.round(width / target));
}

/**
 * Group only at responsive density breakpoints or when the photos change.
 * Every width still gets fresh geometry: no debounce, frozen pixels, or
 * layout-specific resize state. Placement must preserve fractional sizes.
 */
export function createLayoutManager<Plan, Result>(
  strategy: LayoutStrategy<Plan, Result>,
): (
  photos: readonly Photo[],
  width: number,
  target: number,
  gap: number,
  complete: boolean,
) => Result {
  let cached: {
    photos: readonly Photo[];
    density: number;
    complete: boolean;
    plan: Plan;
  } | null = null;
  return (photos, width, target, gap, complete) => {
    const density = layoutDensity(width, target, strategy.minimumDensity);
    if (
      !cached ||
      cached.photos !== photos ||
      cached.density !== density ||
      cached.complete !== complete
    ) {
      cached = {
        photos,
        density,
        complete,
        plan: strategy.plan(photos, density, complete),
      };
    }
    return strategy.place(cached.plan, width, target, gap);
  };
}
