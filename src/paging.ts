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
  list: Pick<VirtualList<Row>, "updateWindow" | "state"> &
    Partial<Pick<VirtualList<Row>, "updateItem">>;
  initial: Page<T, C>;
  key: (item: T) => string;
  /** Soft unique-item budget: whole-page eviction must retain all protected rows. */
  maxItems: number;
  /** Default: trim whole pages while retaining the pin. False disables budget trimming.
   * Evict permits trimming an offscreen pin; visible/overscan rows and explicit targets stay protected. */
  trim?: false | { offscreenPin?: "retain" | "evict" };
  load: (request: {
    edge: Edge;
    cursor: C;
    signal: AbortSignal;
  }) => Promise<Page<T, C>>;
  /** Layout adapter. Identity for a chat/feed; photos become rows or bands. */
  project: (items: readonly T[]) => readonly Row[];
  /** Optional one-source-item/one-row live lane. Other projected rows must not change. */
  live?: { project: (item: T) => Row; key: (row: Row) => string };
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

export interface PagedWindow<T, C> {
  readonly items: readonly T[];
  readonly loading: boolean;
  canLoad(edge: Edge): boolean;
  load(edge: Edge, context?: ReachContext): Promise<boolean>;
  /** Merge an overlapping fresh head, preserving retained tail cursors and edits.
   * Returns false when the head no longer connects to this retained window. */
  refreshHead(page: Page<T, C>, signal?: AbortSignal): Promise<boolean>;
  /** Edit retained source data here, not through the projected runtime rows. Keys must stay stable. */
  updateItem(key: string, update: (item: T) => T): Promise<boolean>;
  /** Submit a same-key live row update without waiting for scroll settle.
   * Requires the live adapter. Resolves after submission, not geometry commit. */
  updateItemLive(key: string, update: (item: T) => T): Promise<boolean>;
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
): PagedWindow<T, C> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1)
    throw new Error("maxItems must be a positive safe integer");
  const unique = (items: readonly T[]): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = options.key(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  let pages: Page<T, C>[] = [
    { ...options.initial, items: unique(options.initial.items) },
  ];
  let items: readonly T[] = pages[0]?.items ?? [];
  let disposed = false;
  let request: AbortController | null = null;
  let trimEdge: Edge = "start";
  let trimming = false;
  let lastRange = "";
  let sourceRevision = 0;
  const lifetime = new AbortController();

  function boundary(edge: Edge): PageBoundary<C> {
    return (
      (edge === "start" ? pages[0]?.start : pages.at(-1)?.end) ?? {
        available: false,
      }
    );
  }

  async function apply(
    propose: () => Page<T, C>[] | null,
    edge: Edge,
    signal: AbortSignal,
    trim = true,
  ): Promise<boolean> {
    const shouldTrim = trim && options.trim !== false;
    // Any source edit can invalidate staged page preparation. Keep the fetched
    // page and retry against current source data, rather than losing it or its
    // edits.
    let revision: number;
    let applied: boolean;
    do {
      revision = sourceRevision;
      applied = await options.list.updateWindow(
        ({ protectedItems }) => {
          if (disposed || signal.aborted) return null;
          const candidate = propose();
          if (!candidate) return null;
          const protectedKeys = new Set(
            protectedItems.flatMap((row) => [...options.keysOf(row)]),
          );
          const retained = [...candidate];
          const owners = new Map<string, number>();
          for (const page of retained) {
            for (const item of page.items) {
              const key = options.key(item);
              owners.set(key, (owners.get(key) ?? 0) + 1);
            }
          }
          const evicted: T[] = [];
          // Keep at least one page, even when a source returns a large page.
          while (
            shouldTrim &&
            owners.size > options.maxItems &&
            retained.length > 1
          ) {
            const page = edge === "start" ? retained[0] : retained.at(-1);
            if (
              !page ||
              page.items.some((item) => {
                const key = options.key(item);
                return protectedKeys.has(key) && owners.get(key) === 1;
              })
            )
              break;
            if (edge === "start") retained.shift();
            else retained.pop();
            for (const item of page.items) {
              const key = options.key(item);
              const remaining = (owners.get(key) ?? 1) - 1;
              if (remaining) owners.set(key, remaining);
              else {
                owners.delete(key);
                evicted.push(item);
              }
            }
          }
          if (candidate === pages && retained.length === pages.length)
            return null;
          const nextItems = unique(retained.flatMap((page) => page.items));
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
              sourceRevision++;
              // Equal numeric ranges can describe different source pages after
              // a prepend/trim. A committed window permits a fresh retry.
              lastRange = "";
              if (shouldTrim) trimEdge = edge;
              try {
                options.onChange?.(items, rows);
              } finally {
                if (evicted.length) options.onEvict?.(evicted, edge);
              }
            },
          };
        },
        signal,
        {
          protectPin: !(
            shouldTrim &&
            options.trim &&
            options.trim.offscreenPin === "evict"
          ),
        },
      );
    } while (
      !applied &&
      !disposed &&
      !signal.aborted &&
      revision !== sourceRevision
    );
    return applied;
  }

  /** `key`'s item replaced by `update`, in `items` and every page holding it; null when absent or unchanged. */
  function replaced(
    key: string,
    update: (item: T) => T,
  ): { index: number; previous: T; next: T; pages: Page<T, C>[] } | null {
    const index = items.findIndex((item) => options.key(item) === key);
    if (index < 0) return null;
    const previous = items[index] as T;
    const next = update(previous);
    if (options.key(next) !== key)
      throw new Error("updated item must keep its key");
    if (next === previous) return null;
    const nextPages = pages.map((page) => {
      const at = page.items.findIndex((item) => options.key(item) === key);
      if (at < 0) return page;
      const pageItems = [...page.items];
      pageItems[at] = next;
      return { ...page, items: pageItems };
    });
    return { index, previous, next, pages: nextPages };
  }

  async function updateItemLive(
    key: string,
    update: (item: T) => T,
  ): Promise<boolean> {
    // Escape render/publication callbacks before changing page ownership. A
    // runtime transaction may still be about to deliver this pager's onCommit.
    await Promise.resolve();
    if (disposed) return false;
    const adapter = options.live;
    const submit = options.list.updateItem;
    if (!adapter || !submit)
      throw new Error(
        "live updates require a live adapter and list.updateItem",
      );
    const change = replaced(key, update);
    if (disposed || !change) return false;
    const { index, previous, next } = change;
    const row = adapter.project(next);
    const rowKey = adapter.key(row);
    if (rowKey !== adapter.key(adapter.project(previous)))
      throw new Error("live row must keep its key");
    // Source data is authoritative at submission, just like a host's immutable
    // store. Every overlapping page owner receives the same replacement.
    pages = change.pages;
    items = items.map((item, itemIndex) => (itemIndex === index ? next : item));
    sourceRevision++;
    try {
      submit(rowKey, row);
    } catch (error) {
      // An observer may throw after the runtime committed. Never guess whether
      // rollback is safe. Retain the latest source for recovery, cancel pending
      // pages, and require dispose/recreate after a submission failure.
      disposed = true;
      request?.abort();
      lifetime.abort();
      throw error;
    }
    return true;
  }

  async function load(edge: Edge, context?: ReachContext): Promise<boolean> {
    const next = boundary(edge);
    if (
      disposed ||
      (request && !request.signal.aborted) ||
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
      return await apply(
        () => {
          // Merge at commit, after any queued trim or source edit has landed.
          const existing = new Map(
            items.map((item) => [options.key(item), item]),
          );
          const incoming = unique(result.items);
          const candidate = [...pages];
          if (incoming.some((item) => !existing.has(options.key(item)))) {
            // Keep source pages intact: a cursor cannot describe a sliced
            // overlap after its neighboring page is evicted. Deduplicate only
            // the exposed window, preserving local edits in every owner.
            const page = {
              ...result,
              items: incoming.map(
                (item) => existing.get(options.key(item)) ?? item,
              ),
            };
            if (edge === "start") candidate.unshift(page);
            else candidate.push(page);
          } else {
            // Advance explicit availability/cursor without accumulating empty pages.
            const index = edge === "start" ? 0 : candidate.length - 1;
            const old = candidate[index];
            if (old) candidate[index] = { ...old, [edge]: result[edge] };
          }
          return candidate;
        },
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
    if (
      disposed ||
      options.trim === false ||
      request ||
      trimming ||
      items.length <= options.maxItems
    )
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
      // A load owns its boundary until it commits. Its own opposite-edge trim
      // supersedes this attempt, so fetching cannot skip a newly evicted page.
      return await apply(
        () => {
          if (!request) return pages;
          lastRange = "";
          return null;
        },
        trimEdge,
        lifetime.signal,
      );
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
    updateItemLive,
    refreshHead: (page, signal = lifetime.signal) =>
      apply(
        () => {
          if (request) return null;
          const fresh = unique(page.items);
          if (!fresh.length) return null;
          const first = items[0];
          const last = fresh.at(-1);
          const overlap = last
            ? items.findIndex((item) => options.key(item) === options.key(last))
            : -1;
          if (
            first &&
            (overlap < 0 ||
              !fresh.some((item) => options.key(item) === options.key(first)))
          )
            return null;
          const freshKeys = new Set(fresh.map(options.key));
          if (
            items
              .slice(0, overlap + 1)
              .some((item) => !freshKeys.has(options.key(item)))
          )
            return null;
          const existing = new Map(
            items.map((item) => [options.key(item), item]),
          );
          // Preserve local state such as expanded text on overlapping posts.
          const head = {
            ...page,
            items: fresh.map((item) => existing.get(options.key(item)) ?? item),
          };
          const tail = pages.filter((old) =>
            old.items.some((item) => !freshKeys.has(options.key(item))),
          );
          return [head, ...tail];
        },
        "end",
        AbortSignal.any([signal, lifetime.signal]),
      ),
    updateItem: (key, update) =>
      apply(
        () => replaced(key, update)?.pages ?? null,
        trimEdge,
        lifetime.signal,
        false,
      ),
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
