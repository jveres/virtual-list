import { afterEach, beforeEach, expect, vi } from "vitest";
import type { VirtualListScrollSettleStrategy } from "../../src/scroll-settle";
import {
  createVirtualList,
  type VirtualList,
  type VirtualListOptions,
  type VirtualListState,
} from "../../src/virtual-list";

// A list on a stubbed viewport under jsdom. jsdom has no layout engine, so
// every measured height comes from a per-element getBoundingClientRect mock
// the test controls (`heights`, ROW_H by default), and ResizeObserver
// deliveries are fired by hand through a controllable stub. Gestures are
// driven through the real settle controller ("default" strategy: an
// unmatched scroll starts a gesture, scrollend plus the 140ms cooldown
// settles it).

export interface Msg {
  id: number;
  body: string;
}

export const VIEWPORT_H = 600;
export const ROW_H = 100;

export const message = (id: number, body = `msg ${id}`): Msg => ({ id, body });
export const range = (from: number, to: number): Msg[] =>
  Array.from({ length: to - from }, (_, i) => message(from + i));

// --- Controllable ResizeObserver ---------------------------------------------
type ROCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;
export const roInstances: { callback: ROCallback; observed: Set<Element> }[] =
  [];

export class ControlledResizeObserver {
  private readonly record: { callback: ROCallback; observed: Set<Element> };
  constructor(callback: ROCallback) {
    this.record = { callback, observed: new Set() };
    roInstances.push(this.record);
  }
  observe(element: Element): void {
    this.record.observed.add(element);
  }
  unobserve(element: Element): void {
    this.record.observed.delete(element);
  }
  disconnect(): void {
    this.record.observed.clear();
  }
}

/** Fake timers and the controllable ResizeObserver for every test in the file. */
export function useHarness(): void {
  beforeEach(() => {
    roInstances.length = 0;
    (globalThis as { ResizeObserver: unknown }).ResizeObserver =
      ControlledResizeObserver;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
  });
}

/** Advance 16ms frames until `done()` holds, or the frame budget runs out. */
export function advanceFramesUntil(done: () => boolean, maxFrames = 200): void {
  for (let frame = 0; frame < maxFrames && !done(); frame += 1) {
    vi.advanceTimersByTime(16);
  }
}

/** Instance 0 observes rows, instance 1 the viewport (construction order). */
export function fireResize(
  instance: number,
  target: Element,
  height: number,
): void {
  fireResizes(instance, [[target, height]]);
}

/** One delivery carrying several entries, as an engine batches them. */
export function fireResizes(
  instance: number,
  sizes: readonly (readonly [Element, number])[],
): void {
  const entries = sizes.map(
    ([target, height]) =>
      ({
        target,
        borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
      }) as unknown as ResizeObserverEntry,
  );
  roInstances[instance]?.callback(entries, null as never);
}

/** The native flow's height: spacers plus in-flow slots (hidden ones have none). */
export function flowHeight(canvas: HTMLElement): number {
  let total = 0;
  for (const child of canvas.children)
    total += Number.parseFloat((child as HTMLElement).style.height) || 0;
  return total;
}

// --- Harness ---------------------------------------------------------------
export interface Harness {
  list: VirtualList<Msg>;
  viewport: HTMLElement;
  canvas: () => HTMLElement;
  heights: Map<number, number>;
  destroyed: number[];
  destroyedElements: HTMLElement[];
  states: VirtualListState[];
  reaches: { edge: "start" | "end"; signal: AbortSignal }[];
  rowElement: (body: string) => HTMLElement;
  slotOf: (element: HTMLElement) => HTMLElement;
  userScroll: (top: number) => void;
  settle: () => void;
}

export interface MountHooks {
  replaceOnRerender?: boolean;
  onState?: VirtualListOptions<Msg>["onState"];
  onViewport?: VirtualListOptions<Msg>["onViewport"];
  onDestroy?: (element: HTMLElement) => void;
  followBehavior?: VirtualListOptions<Msg>["followBehavior"];
  settleStrategy?: VirtualListScrollSettleStrategy;
  /** Runtime by default: jsdom claims native support but never anchors. */
  anchoring?: VirtualListOptions<Msg>["anchoring"];
  edgeSlots?: VirtualListOptions<Msg>["edgeSlots"];
  anchorable?: (m: Msg) => boolean;
  followMode?: VirtualListOptions<Msg>["followMode"];
  followInset?: number;
  overscanPx?: number;
  itemHeight?: (m: Msg) => number;
  position?: VirtualListOptions<Msg>["position"];
  boot?: "start" | "end";
  pinning?: VirtualListOptions<Msg>["pinning"];
  onMount?: (element: HTMLElement, m: Msg) => void;
  onUnmount?: (element: HTMLElement, m: Msg) => void;
  /** Runs at the start of every render (probe hook). */
  onRender?: (m: Msg, existing?: HTMLElement) => void;
  onKey?: (m: Msg) => void;
  /** Runs at every height read of a row. */
  onMeasure?: (m: Msg) => void;
  reach?: boolean | "start-only";
  width?: () => number;
  height?: () => number;
  /** Observes every scrollTop write — where an engine forces layout. */
  onScrollWrite?: (top: number) => void;
  /** Lets the position leave the range, as an iOS rubber-band bounce does. */
  overscroll?: boolean;
  /** render() throws for items with this body. */
  throwOn?: string;
  /** getBoundingClientRect throws for items with this body (post-build). */
  measureFailOn?: string;
}

export function mount(items: Msg[], hooks: MountHooks = {}): Harness {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  // Positioned rows size the canvas; native anchoring sizes the flow.
  const contentHeight = (): number => {
    const canvas = viewport.firstElementChild as HTMLElement | null;
    if (!canvas) return 0;
    return canvas.dataset.anchoring === "native"
      ? flowHeight(canvas)
      : Number.parseFloat(canvas.style.height) || 0;
  };
  const maxScrollTop = (): number =>
    Math.max(0, contentHeight() - (hooks.height?.() ?? VIEWPORT_H));
  Object.defineProperties(viewport, {
    clientHeight: { get: () => hooks.height?.() ?? VIEWPORT_H },
    clientWidth: { get: () => hooks.width?.() ?? 300 },
    offsetWidth: { get: () => 315 },
    scrollHeight: { get: () => Math.max(VIEWPORT_H, contentHeight()) },
    // A shrinking range clamps the position for good, as layout does in an
    // engine: growing the range back later does not restore it.
    scrollTop: {
      get: () => {
        if (hooks.overscroll) return scrollTop;
        scrollTop = Math.max(0, Math.min(maxScrollTop(), scrollTop));
        return scrollTop;
      },
      set: (next: number) => {
        hooks.onScrollWrite?.(next);
        if (hooks.overscroll) {
          scrollTop = next;
          return;
        }
        scrollTop = Math.max(0, Math.min(maxScrollTop(), next));
      },
    },
  });
  document.body.appendChild(viewport);

  const heights = new Map<number, number>();
  const destroyed: number[] = [];
  const destroyedElements: HTMLElement[] = [];
  const states: VirtualListState[] = [];
  const reaches: { edge: "start" | "end"; signal: AbortSignal }[] = [];

  const stamp = (element: HTMLElement, m: Msg): HTMLElement => {
    element.dataset.id = String(m.id);
    element.getBoundingClientRect = () => {
      hooks.onMeasure?.(m);
      if (hooks.measureFailOn !== undefined && m.body === hooks.measureFailOn) {
        throw new Error(`measure failed: ${m.body}`);
      }
      return { height: heights.get(m.id) ?? ROW_H } as DOMRect;
    };
    return element;
  };

  const list = createVirtualList<Msg>(viewport, {
    items,
    key: (m) => {
      hooks.onKey?.(m);
      return `m${m.id}`;
    },
    settleStrategy: hooks.settleStrategy ?? "default",
    anchoring: hooks.anchoring ?? "runtime",
    followBehavior: hooks.followBehavior,
    edgeSlots: hooks.edgeSlots,
    anchorable: hooks.anchorable,
    followMode: hooks.followMode,
    followInset: hooks.followInset,
    overscanPx: hooks.overscanPx,
    height: hooks.itemHeight,
    position: hooks.position,
    boot: hooks.boot,
    pinning: hooks.pinning,
    onMount: hooks.onMount,
    onUnmount: hooks.onUnmount,
    render: (m, existing) => {
      hooks.onRender?.(m, existing);
      if (hooks.throwOn !== undefined && m.body === hooks.throwOn) {
        throw new Error(`render failed: ${m.body}`);
      }
      if (existing && !hooks.replaceOnRerender) {
        existing.textContent = m.body;
        return existing;
      }
      const element = document.createElement("div");
      element.textContent = m.body;
      return stamp(element, m);
    },
    onState: (state, viewport) => {
      states.push(state);
      hooks.onState?.(state, viewport);
    },
    onViewport: hooks.onViewport,
    onDestroy: (element) => {
      destroyed.push(Number(element.dataset.id));
      destroyedElements.push(element);
      hooks.onDestroy?.(element);
    },
    onReachStart: hooks.reach
      ? ({ signal }) => reaches.push({ edge: "start", signal })
      : undefined,
    onReachEnd:
      hooks.reach === true
        ? ({ signal }) => reaches.push({ edge: "end", signal })
        : undefined,
  });

  return {
    list,
    viewport,
    canvas: () => viewport.firstElementChild as HTMLElement,
    heights,
    destroyed,
    destroyedElements,
    states,
    reaches,
    rowElement: (body) => {
      const canvas = viewport.firstElementChild as HTMLElement;
      const found = [...canvas.querySelectorAll("div")].find(
        (el) => el.textContent === body && el.dataset.id !== undefined,
      );
      expect(found, `row "${body}" should be mounted`).toBeDefined();
      return found as HTMLElement;
    },
    slotOf: (element) => element.parentElement as HTMLElement,
    // An unmatched scroll event is a user gesture (≥2px off any write).
    userScroll: (top) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
    },
    settle: () => {
      viewport.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(200);
    },
  };
}
