import { KeyTable } from "./key-index";
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

interface RetainedPage<T, C> {
  items: readonly T[];
  keys: readonly string[];
  indexByKey: KeyTable;
  start: PageBoundary<C>;
  end: PageBoundary<C>;
}

/**
 * A bounded, contiguous sequence of source pages. Cursors live only on retained
 * pages; restoring a discarded page is the source's job. A feed refresh is not
 * a continuation: dispose/recreate on a source reset, or merge it separately.
 */
export function createPagedWindow<T, C, Row>({
  initial,
  ...options
}: PagedWindowOptions<T, C, Row>): PagedWindow<T, C> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1)
    throw new Error("maxItems must be a positive safe integer");
  const indexPage = (page: Page<T, C>): RetainedPage<T, C> => {
    const deduped: T[] = [];
    const keys: string[] = [];
    const indexByKey = new KeyTable(keys, page.items.length);
    for (let i = 0; i < page.items.length; i++) {
      const item = page.items[i] as T;
      const key = options.key(item);
      const nextIdx = deduped.length;
      keys.push(key);
      if (!indexByKey.insertUnique(key, nextIdx, keys)) {
        keys.pop();
        continue;
      }
      deduped.push(item);
    }
    return {
      items: deduped,
      keys,
      indexByKey,
      start: page.start,
      end: page.end,
    };
  };
  // Do not keep the initial page on the options captured by live methods.
  const firstPage = indexPage(initial);
  let pages: RetainedPage<T, C>[] = [firstPage];
  let items: readonly T[] = firstPage.items;
  let itemKeys: readonly string[] = firstPage.keys;
  let itemIndexByKey: KeyTable = firstPage.indexByKey;
  let disposed = false;
  let request: AbortController | null = null;
  let trimEdge: Edge = "start";
  let trimming = false;
  let lastRangeStart = -1;
  let lastRangeEnd = -1;
  let lastRangeCount = -1;
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
    propose: () => RetainedPage<T, C>[] | null,
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
          let totalRawKeys = 0;
          for (let p = 0; p < candidate.length; p++) {
            totalRawKeys += (candidate[p] as RetainedPage<T, C>).keys.length;
          }
          let retained: RetainedPage<T, C>[];
          const evicted: T[] = [];
          if (
            shouldTrim &&
            totalRawKeys > options.maxItems &&
            candidate.length > 1
          ) {
            const protectedKeys = new Set<string>();
            for (let i = 0; i < protectedItems.length; i++) {
              for (const key of options.keysOf(protectedItems[i] as Row))
                protectedKeys.add(key);
            }
            retained = candidate.slice();
            const owners = new Map<string, number>();
            for (let p = 0; p < retained.length; p++) {
              const pageKeys = (retained[p] as RetainedPage<T, C>).keys;
              for (let i = 0; i < pageKeys.length; i++) {
                const key = pageKeys[i] as string;
                owners.set(key, (owners.get(key) ?? 0) + 1);
              }
            }
            // Keep at least one page, even when a source returns a large page.
            while (owners.size > options.maxItems && retained.length > 1) {
              const page = edge === "start" ? retained[0] : retained.at(-1);
              if (!page) break;
              let blocked = false;
              for (let i = 0; i < page.keys.length; i++) {
                const key = page.keys[i] as string;
                if (protectedKeys.has(key) && owners.get(key) === 1) {
                  blocked = true;
                  break;
                }
              }
              if (blocked) break;
              if (edge === "start") retained.shift();
              else retained.pop();
              for (let i = 0; i < page.keys.length; i++) {
                const key = page.keys[i] as string;
                const remaining = (owners.get(key) ?? 1) - 1;
                if (remaining) owners.set(key, remaining);
                else {
                  owners.delete(key);
                  evicted.push(page.items[i] as T);
                }
              }
            }
          } else {
            retained = candidate;
          }
          if (candidate === pages && retained.length === pages.length)
            return null;
          let nextItems: readonly T[];
          let nextKeys: readonly string[];
          let nextIndexByKey: KeyTable;
          if (retained.length === 1) {
            const sole = retained[0] as RetainedPage<T, C>;
            nextItems = sole.items;
            nextKeys = sole.keys;
            nextIndexByKey = sole.indexByKey;
          } else {
            let maxCount = 0;
            for (let p = 0; p < retained.length; p++) {
              maxCount += (retained[p] as RetainedPage<T, C>).items.length;
            }
            const builtItems: T[] = [];
            const builtKeys: string[] = [];
            const builtIndex = new KeyTable(builtKeys, maxCount);
            for (let p = 0; p < retained.length; p++) {
              const page = retained[p] as RetainedPage<T, C>;
              const pageItems = page.items;
              const pageKeys = page.keys;
              for (let i = 0; i < pageItems.length; i++) {
                const key = pageKeys[i] as string;
                const at = builtItems.length;
                builtKeys.push(key);
                if (!builtIndex.insertUnique(key, at, builtKeys)) {
                  builtKeys.pop();
                  continue;
                }
                builtItems.push(pageItems[i] as T);
              }
            }
            nextItems = builtItems;
            nextKeys = builtKeys;
            nextIndexByKey = builtIndex;
          }
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
              itemKeys = nextKeys;
              itemIndexByKey = nextIndexByKey;
              sourceRevision++;
              // Equal numeric ranges can describe different source pages after
              // a prepend/trim. A committed window permits a fresh retry.
              lastRangeStart = -1;
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
  ): {
    index: number;
    previous: T;
    next: T;
    pages: RetainedPage<T, C>[];
  } | null {
    const index = itemIndexByKey.get(key);
    if (index === undefined) return null;
    const previous = items[index] as T;
    const next = update(previous);
    if (options.key(next) !== key)
      throw new Error("updated item must keep its key");
    if (next === previous) return null;
    const nextPages = new Array<RetainedPage<T, C>>(pages.length);
    for (let p = 0; p < pages.length; p++) {
      const page = pages[p] as RetainedPage<T, C>;
      const at = page.indexByKey.get(key);
      if (at === undefined) {
        nextPages[p] = page;
      } else {
        const pageItems = page.items.slice();
        pageItems[at] = next;
        nextPages[p] = { ...page, items: pageItems };
      }
    }
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
    const nextItems = items.slice();
    nextItems[index] = next;
    items = nextItems;
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
      let cachedIncoming: RetainedPage<T, C> | null = null;
      return await apply(
        () => {
          // Merge at commit, after any queued trim or source edit has landed.
          cachedIncoming ??= indexPage(result);
          const incoming = cachedIncoming;
          const candidate = pages.slice();
          let addsNew = false;
          for (let i = 0; i < incoming.keys.length; i++) {
            if (itemIndexByKey.get(incoming.keys[i] as string) === undefined) {
              addsNew = true;
              break;
            }
          }
          if (addsNew) {
            // Keep source pages intact: a cursor cannot describe a sliced
            // overlap after its neighboring page is evicted. Deduplicate only
            // the exposed window, preserving local edits in every owner.
            const mergedItems = new Array<T>(incoming.items.length);
            for (let i = 0; i < incoming.items.length; i++) {
              const existingIdx = itemIndexByKey.get(
                incoming.keys[i] as string,
              );
              mergedItems[i] =
                existingIdx !== undefined
                  ? (items[existingIdx] as T)
                  : (incoming.items[i] as T);
            }
            const page: RetainedPage<T, C> = {
              ...incoming,
              items: mergedItems,
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
    if (
      state.start === lastRangeStart &&
      state.end === lastRangeEnd &&
      state.count === lastRangeCount
    )
      return null;
    lastRangeStart = state.start;
    lastRangeEnd = state.end;
    lastRangeCount = state.count;
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
          lastRangeStart = -1;
          return null;
        },
        trimEdge,
        lifetime.signal,
      );
    } catch (error) {
      lastRangeStart = -1;
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
    refreshHead: (page, signal = lifetime.signal) => {
      let cachedFresh: RetainedPage<T, C> | null = null;
      return apply(
        () => {
          if (request) return null;
          cachedFresh ??= indexPage(page);
          const fresh = cachedFresh;
          if (!fresh.items.length) return null;
          const firstKey = itemKeys[0];
          const lastKey = fresh.keys[fresh.keys.length - 1];
          const overlap =
            lastKey !== undefined ? (itemIndexByKey.get(lastKey) ?? -1) : -1;
          if (
            firstKey !== undefined &&
            (overlap < 0 || fresh.indexByKey.get(firstKey) === undefined)
          )
            return null;
          for (
            let checked = 0;
            checked <= overlap && checked < itemKeys.length;
            checked++
          ) {
            if (fresh.indexByKey.get(itemKeys[checked] as string) === undefined)
              return null;
          }
          // Preserve local state such as expanded text on overlapping posts.
          const headItems = new Array<T>(fresh.items.length);
          for (let i = 0; i < fresh.items.length; i++) {
            const existingIdx = itemIndexByKey.get(fresh.keys[i] as string);
            headItems[i] =
              existingIdx !== undefined
                ? (items[existingIdx] as T)
                : (fresh.items[i] as T);
          }
          const head: RetainedPage<T, C> = { ...fresh, items: headItems };
          const tail = pages.filter((old) =>
            old.keys.some((key) => fresh.indexByKey.get(key) === undefined),
          );
          return [head, ...tail];
        },
        "end",
        AbortSignal.any([signal, lifetime.signal]),
      );
    },
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
      itemKeys = [];
      itemIndexByKey = new KeyTable([], 0);
    },
  };
}
