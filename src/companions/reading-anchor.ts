import type {
  ExplicitAnchor,
  VirtualList,
  VirtualListState,
} from "../virtual-list";

type PositionedList = Pick<VirtualList<unknown>, "positionOf"> & {
  readonly state?: Pick<VirtualListState, "totalSize">;
};
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
  // The browser's physical end can exceed the modeled range by a fraction
  // (clientHeight rounds, CSS percentage heights do not). Capturing that
  // extra distance as a reading offset would grow reserve on each swap.
  const maxTop = list.state
    ? Math.max(0, list.state.totalSize - viewport.clientHeight)
    : Number.POSITIVE_INFINITY;
  const scrollTop = Math.max(0, Math.min(viewport.scrollTop, maxTop));
  const offset = position.top - scrollTop;
  return {
    offset,
    above: offset + position.height <= 0,
    visible: offset < viewport.clientHeight && offset + position.height > inset,
    pinned: Math.abs(offset - inset) < 1,
  };
}

/** Preserve the first visible replacement; reveal it when hidden or its clipped tail fits. */
export function replacementAnchor(
  list: PositionedList,
  viewport: Viewport,
  replacements: readonly KeyReplacement[],
  inset = 0,
): ExplicitAnchor | undefined {
  // Snapshot once so every candidate is compared against the same viewport.
  const snapshot = {
    scrollTop: viewport.scrollTop,
    clientHeight: viewport.clientHeight,
  };
  for (const { from, to } of replacements) {
    const placement = captureItemPlacement(list, snapshot, from, inset);
    if (!placement?.visible) continue;
    // Visibility, not the top crossing an inset or zero, determines ownership.
    // Resolve a shorter replacement's visibility after its height is measured.
    return {
      key: to,
      offset: placement.pinned ? inset : placement.offset,
      visibilityInset: Math.max(0, inset),
    };
  }
  return undefined;
}
