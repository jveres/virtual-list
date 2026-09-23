import { afterEach, beforeEach, vi } from "vitest";
import {
  createVirtualList,
  type VirtualList,
  type VirtualListOptions,
  type VirtualListState,
} from "../../src/virtual-list";

// jsdom has no layout: the viewport's geometry is stubbed, and each row
// reports its height from `heights` (ROW_H by default).

export interface Msg {
  id: number;
  body?: string;
}

export const VIEWPORT_H = 600;
export const ROW_H = 100;

export const message = (id: number, body = `msg ${id}`): Msg => ({ id, body });
export const range = (from: number, to: number): Msg[] =>
  Array.from({ length: to - from }, (_, i) => message(from + i));

class ControlledResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Fake timers and a silent ResizeObserver for every test in the file. */
export function useHarness(): void {
  beforeEach(() => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver =
      ControlledResizeObserver;
    vi.useFakeTimers();
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });
}

/** The native flow's height: spacers plus in-flow slots (hidden ones have none). */
export function flowHeight(canvas: HTMLElement): number {
  let total = 0;
  for (const child of canvas.children)
    total += Number.parseFloat((child as HTMLElement).style.height) || 0;
  return total;
}

export interface Harness {
  list: VirtualList<Msg>;
  viewport: HTMLElement;
  canvas: HTMLElement;
  heights: Map<number, number>;
  states: VirtualListState[];
  /** The runtime's own scrollTop writes, never the user's. */
  writes: number[];
  element: (id: number) => HTMLElement | undefined;
  userScroll: (top: number) => void;
  settle: () => void;
}

/** A list on a stubbed viewport; runtime anchoring unless `options` says otherwise. */
export function mount(
  items: Msg[],
  options: Partial<VirtualListOptions<Msg>> = {},
): Harness {
  const viewport = document.createElement("div");
  let scrollTop = 0;
  const writes: number[] = [];
  const content = (): number => {
    const canvas = viewport.firstElementChild as HTMLElement | null;
    if (!canvas) return 0;
    return canvas.dataset.anchoring === "native"
      ? flowHeight(canvas)
      : Number.parseFloat(canvas.style.height) || 0;
  };
  const clamp = (top: number): number =>
    Math.max(0, Math.min(Math.max(0, content() - VIEWPORT_H), top));
  Object.defineProperties(viewport, {
    clientHeight: { get: () => VIEWPORT_H },
    clientWidth: { get: () => 300 },
    scrollHeight: { get: () => Math.max(VIEWPORT_H, content()) },
    scrollTop: {
      get: () => scrollTop,
      set: (next: number) => {
        writes.push(next);
        scrollTop = clamp(next);
      },
    },
  });
  document.body.appendChild(viewport);
  const heights = new Map<number, number>();
  const states: VirtualListState[] = [];
  const elements = new Map<number, HTMLElement>();
  const list = createVirtualList<Msg>(viewport, {
    items,
    key: (m) => `m${m.id}`,
    settleStrategy: "default",
    anchoring: "runtime",
    render: (m, existing) => {
      const element = existing ?? document.createElement("div");
      element.textContent = m.body ?? `msg ${m.id}`;
      element.getBoundingClientRect = () =>
        ({ height: heights.get(m.id) ?? ROW_H }) as DOMRect;
      elements.set(m.id, element);
      return element;
    },
    onState: (state) => states.push(state),
    ...options,
  });
  return {
    list,
    viewport,
    canvas: viewport.firstElementChild as HTMLElement,
    heights,
    states,
    writes,
    element: (id) => elements.get(id),
    userScroll: (top) => {
      scrollTop = clamp(top);
      viewport.dispatchEvent(new Event("scroll"));
    },
    settle: () => {
      viewport.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(200);
    },
  };
}
