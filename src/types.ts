import type { FollowMode } from "./follow";
import type {
  AnchorPolicy,
  ExplicitAnchor,
  GeometryViewport,
} from "./geometry";
import type { ItemPosition } from "./positioned-geometry";
import type { Edge, ReachContext } from "./reach";
import type { VirtualListScrollSettleStrategy } from "./scroll-settle";

export type { FollowMode } from "./follow";
export type {
  AnchorPolicy,
  ExplicitAnchor,
  GeometryViewport,
} from "./geometry";
export type { ItemPosition } from "./positioned-geometry";
export type { Edge, ReachContext } from "./reach";

/** How a snapshot resolves the viewport: a policy, or a host-named anchor. */
export type AnchorRequest = AnchorPolicy | ExplicitAnchor;

/** A fixed-height host row kept at an edge of the surface: geometry, never the anchor. */
export interface EdgeSlot {
  key: string;
  height: number;
  render: () => HTMLElement;
}

export interface VirtualListOptions<T> {
  items: readonly T[];
  /** Stable identity. Keys beginning with NUL are reserved for edge slots. */
  key: (item: T) => string;
  /** Build a row, or update `existing` in place (return it) or replace it. */
  render: (item: T, existing?: HTMLElement) => HTMLElement;
  /** Declared heights: never measured; only the overscan window is rendered. */
  height?: (item: T) => number;
  /** Declared placement (masonry). Requires `height`; all items or none. */
  position?: (item: T) => ItemPosition | null;
  /** Where the list opens: at its end (default, following) or its start. */
  boot?: "start" | "end";
  /** Command pins (true, default), none (false), or a declarative pin. */
  pinning?: boolean | { match: (item: T) => boolean; offset?: number };
  overscanPx?: number;
  /** Whether an item may be the reading anchor (separators say no). */
  anchorable?: (item: T) => boolean;
  edgeSlots?: { start?: EdgeSlot | null; end?: EdgeSlot | null };
  followBehavior?: "instant" | "smooth";
  followMode?: FollowMode;
  followInset?: number;
  /**
   * Start element inside a measured row for `keep-content`; null
   * follows the end until a start exists. Read-only: runs with height reads,
   * never in the scroll sampler. Not available with declared `height`.
   */
  followStart?: (item: T, element: HTMLElement) => HTMLElement | null;
  settleStrategy?: VirtualListScrollSettleStrategy;
  /**
   * Who keeps the reading position still when content above it changes.
   * "auto" (default): the engine's CSS scroll anchoring where supported,
   * otherwise the runtime. "native" forces the engine, "runtime" forces
   * settle-gated runtime writes. Positioned layouts always use the runtime.
   */
  anchoring?: "auto" | "native" | "runtime";
  onState?: (
    state: VirtualListState,
    viewport: Readonly<GeometryViewport>,
  ) => void;
  onViewport?: (viewport: Readonly<GeometryViewport>) => void;
  onReachStart?: (context: ReachContext) => void;
  onReachEnd?: (context: ReachContext) => void;
  onMount?: (element: HTMLElement, item: T) => void;
  onUnmount?: (element: HTMLElement, item: T) => void;
  onDestroy?: (element: HTMLElement, item: T) => void;
}

export interface VirtualListState {
  count: number;
  start: number;
  end: number;
  atStart: boolean;
  atEnd: boolean;
  following: boolean;
  totalSize: number;
  /** Work is waiting for the scroll phase to settle. */
  held: boolean;
}

export type ScrollTarget = string | "start" | "end";

export interface ScrollOptions {
  align?: "start";
  behavior?: "auto" | "smooth";
  /** An explicit duration uses the custom glide; otherwise smooth is native. */
  duration?: number;
  offset?: number;
  pin?: { key: string; offset?: number };
}

export interface RemeasureOptions {
  anchor?: AnchorPolicy;
}

export interface WindowUpdateContext<T> {
  items: readonly T[];
  protectedItems: readonly T[];
}

export interface WindowUpdate<T> {
  items: readonly T[];
  anchor?: AnchorRequest;
  edgeSlots?: { start?: EdgeSlot | null; end?: EdgeSlot | null };
  onCommit?: () => void;
}

export interface VirtualList<T> {
  setItems(
    items: readonly T[],
    options?: { anchor?: AnchorRequest; interrupt?: boolean },
  ): void;
  updateItem(key: string, item: T, options?: { anchor?: AnchorRequest }): void;
  updateWindow(
    update: (context: WindowUpdateContext<T>) => WindowUpdate<T> | null,
    signal?: AbortSignal,
    options?: {
      /** `commit` keeps existing motion during preparation, then takes over. */
      interrupt?: boolean | "commit";
      protectPin?: boolean;
    },
  ): Promise<boolean>;
  scrollTo(target: ScrollTarget, options?: ScrollOptions): Promise<boolean>;
  remeasure(key: string, options?: RemeasureOptions): void;
  setEdgeSlot(edge: Edge, slot: EdgeSlot | null): void;
  setFollowMode(mode: FollowMode, inset?: number): void;
  positionOf(key: string): { top: number; height: number } | null;
  elementOf(key: string): HTMLElement | null;
  readonly state: VirtualListState;
  dispose(): void;
}
