import type { ExplicitAnchor, VirtualList } from "../virtual-list";

type PositionedList = Pick<VirtualList<unknown>, "positionOf">;
type Viewport = { readonly scrollTop: number; readonly clientHeight: number };
export interface KeyReplacement {
  from: string;
  to: string;
}
export interface ItemPlacement {
  offset: number;
  above: boolean;
  visible: boolean;
  pinned: boolean;
}

/** Capture on a discrete action, before replacing data; never in a scroll sampler. */
export function captureItemPlacement(
  list: PositionedList,
  viewport: Viewport,
  key: string,
  inset = 0,
): ItemPlacement | null {
  const position = list.positionOf(key);
  if (!position) return null;
  const offset = position.top - viewport.scrollTop;
  return {
    offset,
    above: offset + position.height <= 0,
    visible: offset < viewport.clientHeight && offset + position.height > inset,
    pinned: Math.abs(offset - inset) < 1,
  };
}

/** Prefer a fully visible replacement; otherwise keep the first clipped row at the inset. */
export function replacementAnchor(
  list: PositionedList,
  viewport: Viewport,
  replacements: readonly KeyReplacement[],
  inset = 0,
): ExplicitAnchor | undefined {
  let clipped: ExplicitAnchor | undefined;
  // Snapshot once so every candidate is compared against the same viewport.
  const snapshot = {
    scrollTop: viewport.scrollTop,
    clientHeight: viewport.clientHeight,
  };
  for (const { from, to } of replacements) {
    const placement = captureItemPlacement(list, snapshot, from, inset);
    if (!placement?.visible) continue;
    if (placement.offset >= inset) return { key: to, offset: placement.offset };
    clipped ??= { key: to, offset: inset };
  }
  return clipped;
}
