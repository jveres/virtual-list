import type {
  AnchorRequest,
  Edge,
  EdgeSlot,
  ReachContext,
  VirtualList,
} from "./virtual-list";

/** A source-owned continuation. Unavailable is explicit, not an empty page. */
export type PageBoundary<C> =
  | { available: true; cursor: C }
  | { available: false };

export interface Page<T, C> {
  items: readonly T[];
  /** Continuations immediately outside this page, not a head-refresh token. */
  start: PageBoundary<C>;
  end: PageBoundary<C>;
}

export interface PagedWindowOptions<T, C, Row> {
  list: Pick<VirtualList<Row>, "updateWindow" | "state">;
  initial: Page<T, C>;
  key: (item: T) => string;
  /** Soft item budget: whole pages containing protected rows cannot be evicted. */
  maxItems: number;
  load: (request: {
    edge: Edge;
    cursor: C;
    signal: AbortSignal;
  }) => Promise<Page<T, C>>;
  /** Layout adapter. Identity for a chat/feed; photos become rows or bands. */
  project: (items: readonly T[]) => readonly Row[];
  /** Source keys used by a runtime row, including fragments and separators. */
  keysOf: (row: Row) => Iterable<string>;
  /** Map a reading point when a layout changes an existing boundary row. */
  anchor?: (rows: readonly Row[]) => AnchorRequest;
  edgeSlots?: (window: { start: PageBoundary<C>; end: PageBoundary<C> }) => {
    start?: EdgeSlot | null;
    end?: EdgeSlot | null;
  };
  onChange?: (items: readonly T[], rows: readonly Row[]) => void;
  /** Committed data eviction, unlike per-element onDestroy. Release host caches here. */
  onEvict?: (items: readonly T[], edge: Edge) => void;
}

export interface PagedWindow<T> {
  readonly items: readonly T[];
  readonly loading: boolean;
  canLoad(edge: Edge): boolean;
  load(edge: Edge, context?: ReachContext): Promise<boolean>;
  /** Retry a protected, over-budget tail. Returns null without allocating when no work is needed. */
  reconcile(): Promise<boolean> | null;
  /** Cancels fetching AND fetched work waiting for settle. */
  dispose(): void;
}

/**
 * A bounded, contiguous sequence of source pages. Cursors live only on retained
 * pages; restoring a discarded page is the source's job. A feed refresh is not
 * a continuation: dispose/recreate on a source reset, or merge it separately.
 */
export function createPagedWindow<T, C, Row>(
  options: PagedWindowOptions<T, C, Row>,
): PagedWindow<T> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1)
    throw new Error("maxItems must be a positive safe integer");
  const unique = (items: readonly T[], seen = new Set<string>()): T[] =>
    items.filter((item) => {
      const key = options.key(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let pages: Page<T, C>[] = [
    { ...options.initial, items: unique(options.initial.items) },
  ];
  let items: readonly T[] = pages[0]?.items ?? [];
  let disposed = false;
  let request: AbortController | null = null;
  let trimEdge: Edge = "start";
  let trimming = false;
  let lastRange = "";
  const lifetime = new AbortController();

  function boundary(edge: Edge): PageBoundary<C> {
    return (
      (edge === "start" ? pages[0]?.start : pages.at(-1)?.end) ?? {
        available: false,
      }
    );
  }

  async function apply(
    candidate: Page<T, C>[],
    edge: Edge,
    signal: AbortSignal,
  ): Promise<boolean> {
    return options.list.updateWindow(({ protectedItems }) => {
      if (disposed || signal.aborted) return null;
      const protectedKeys = new Set(
        protectedItems.flatMap((row) => [...options.keysOf(row)]),
      );
      const retained = [...candidate];
      let count = retained.reduce((sum, page) => sum + page.items.length, 0);
      const evicted: T[] = [];
      // Keep at least one page, even when a source returns a large page.
      while (count > options.maxItems && retained.length > 1) {
        const page = edge === "start" ? retained[0] : retained.at(-1);
        if (
          !page ||
          page.items.some((item) => protectedKeys.has(options.key(item)))
        )
          break;
        if (edge === "start") retained.shift();
        else retained.pop();
        count -= page.items.length;
        evicted.push(...page.items);
      }
      if (candidate === pages && evicted.length === 0) return null;
      const nextItems = retained.flatMap((page) => page.items);
      const rows = options.project(nextItems);
      return {
        items: rows,
        anchor: options.anchor?.(rows) ?? "viewport",
        edgeSlots: options.edgeSlots?.({
          start: retained[0]?.start ?? { available: false },
          end: retained.at(-1)?.end ?? { available: false },
        }),
        onCommit: () => {
          pages = retained;
          items = nextItems;
          trimEdge = edge;
          try {
            options.onChange?.(items, rows);
          } finally {
            if (evicted.length) options.onEvict?.(evicted, edge);
          }
        },
      };
    }, signal);
  }

  async function load(edge: Edge, context?: ReachContext): Promise<boolean> {
    const next = boundary(edge);
    if (
      disposed ||
      (request && !request.signal.aborted) ||
      trimming ||
      !next.available ||
      context?.signal.aborted
    ) {
      context?.complete();
      return false;
    }
    const active = new AbortController();
    request = active;
    const cancel = (): void => active.abort();
    context?.signal.addEventListener("abort", cancel, { once: true });
    try {
      // Settle promptly on abort even if a source ignores its signal. Its late
      // success or failure is observed but cannot change this window.
      const result = await new Promise<Page<T, C> | null>((resolve, reject) => {
        const abort = (): void => resolve(null);
        active.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() =>
            active.signal.aborted
              ? null
              : options.load({
                  edge,
                  cursor: next.cursor,
                  signal: active.signal,
                }),
          )
          .then(
            (page) => {
              active.signal.removeEventListener("abort", abort);
              resolve(page);
            },
            (error: unknown) => {
              active.signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
      });
      if (!result || disposed || active.signal.aborted || request !== active)
        return false;
      const added = unique(result.items, new Set(items.map(options.key)));
      const candidate = [...pages];
      if (added.length) {
        const page = { ...result, items: added };
        if (edge === "start") candidate.unshift(page);
        else candidate.push(page);
      } else {
        // Advance explicit availability/cursor without accumulating empty pages.
        const index = edge === "start" ? 0 : candidate.length - 1;
        const old = candidate[index];
        if (old) candidate[index] = { ...old, [edge]: result[edge] };
      }
      return await apply(
        candidate,
        edge === "start" ? "end" : "start",
        active.signal,
      );
    } catch (error) {
      if (active.signal.aborted || disposed) return false;
      throw error;
    } finally {
      context?.signal.removeEventListener("abort", cancel);
      if (request === active) request = null;
      context?.complete();
    }
  }

  function reconcile(): Promise<boolean> | null {
    if (disposed || request || trimming || items.length <= options.maxItems)
      return null;
    const state = options.list.state;
    const range = `${state.start}:${state.end}:${state.count}`;
    if (range === lastRange) return null;
    lastRange = range;
    trimming = true;
    return trim();
  }

  async function trim(): Promise<boolean> {
    try {
      return await apply(pages, trimEdge, lifetime.signal);
    } catch (error) {
      lastRange = "";
      throw error;
    } finally {
      trimming = false;
    }
  }

  return {
    get items() {
      return items;
    },
    get loading() {
      return request !== null;
    },
    canLoad: (edge) => !disposed && boundary(edge).available,
    load,
    reconcile,
    dispose: () => {
      disposed = true;
      request?.abort();
      lifetime.abort();
      pages = [];
      items = [];
    },
  };
}
