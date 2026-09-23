import { createPagedWindow, type PagedWindow } from "../../src/paging";
import {
  createVirtualList,
  type ReachContext,
  type VirtualList,
} from "../../src/virtual-list";
import { initMarkdown } from "../shared/markdown";
import {
  mustGet,
  setAttributeIfChanged,
  setTextIfChanged,
} from "../shared/utils";
import { mountPost, renderPost, unmountPost } from "./render";
import {
  type FeedCursor,
  type FeedPost,
  type FeedSource,
  fetchFeedPage,
} from "./source";

const viewport = mustGet("viewport");
const select = mustGet("source", HTMLSelectElement);
const refresh = mustGet("refresh", HTMLButtonElement);
const status = mustGet("status");
const params = new URLSearchParams(location.search);
function positive(name: string, fallback: number, cap: number): number {
  const n = Number(params.get(name));
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, cap) : fallback;
}
const retain = positive("retain", 100, 2000);
const chunk = positive("chunk", 25, 100);
select.value = params.get("source") === "lemmy" ? "lemmy" : "bsky";
let dispose = (): void => {};
let generation = 0;
let markdownReady: Promise<void> | undefined;

async function reset(): Promise<void> {
  const version = ++generation;
  dispose();
  const lifetime = new AbortController();
  let list: VirtualList<FeedPost> | undefined;
  let pager: PagedWindow<FeedPost, FeedCursor> | undefined;
  let error = "";
  let evicted = 0;
  let pages = 1;
  let busy = false;
  let headBusy = false;
  let headMessage = "";
  let headEndpoint = "";
  const edgeWork = { start: Promise.resolve(), end: Promise.resolve() };
  let reconcileQueued = false;
  const source: FeedSource = select.value === "lemmy" ? "lemmy" : "bsky";
  const current = (): boolean =>
    generation === version && !lifetime.signal.aborted;
  dispose = () => {
    lifetime.abort();
    pager?.dispose();
    list?.dispose();
  };
  const url = new URL(location.href);
  url.searchParams.set("source", source);
  history.replaceState(null, "", url);
  status.textContent = "Loading feed…";
  status.title = "Loading feed…";
  delete viewport.dataset.retained;
  delete viewport.dataset.pages;
  delete viewport.dataset.evicted;
  viewport.replaceChildren();
  const placeholder = document.createElement("p");
  placeholder.className = "feed-placeholder";
  placeholder.textContent = "Loading public posts…";
  viewport.append(placeholder);

  const top = document.createElement("div");
  top.className = "feed-edge";
  const topLabel = document.createElement("span");
  function spinner(): HTMLElement {
    const element = document.createElement("span");
    element.className = "boundary-spinner";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  top.setAttribute("role", "status");
  top.dataset.edge = "start";
  top.append(spinner(), topLabel);
  const bottom = document.createElement("div");
  bottom.className = "feed-edge";
  const bottomLabel = document.createElement("span");
  bottom.setAttribute("role", "status");
  bottom.dataset.edge = "end";
  bottom.append(spinner(), bottomLabel);
  function sync(): void {
    if (!current() || !pager) return;
    setAttributeIfChanged(top, "data-state", headBusy ? "loading" : "idle");
    setAttributeIfChanged(bottom, "data-state", busy ? "loading" : "idle");
    setTextIfChanged(
      topLabel,
      headBusy
        ? "Loading newer posts…"
        : headMessage ||
            (evicted
              ? `${evicted} earlier posts discarded`
              : "At the newest posts"),
    );
    setTextIfChanged(
      bottomLabel,
      error ||
        (busy
          ? "Loading older posts…"
          : pager.canLoad("end")
            ? "Scroll for older posts"
            : "No more posts"),
    );
    setAttributeIfChanged(bottomLabel, "title", bottomLabel.textContent);
    const text = `${pager.items.length} retained / ${retain} target · ${list ? list.state.end - list.state.start : 0} mounted · ${pages} pages${busy || headBusy ? " · loading" : ""}${error ? ` · ${error}` : ""}`;
    setTextIfChanged(status, text);
    setAttributeIfChanged(status, "title", text);
    setAttributeIfChanged(
      viewport,
      "data-retained",
      String(pager.items.length),
    );
    setAttributeIfChanged(viewport, "data-pages", String(pages));
    setAttributeIfChanged(viewport, "data-evicted", String(evicted));
  }
  async function load(context?: ReachContext): Promise<void> {
    if (!pager || !current() || busy || headBusy) {
      context?.complete();
      return;
    }
    busy = true;
    error = "";
    sync();
    try {
      // Empty/deduplicated pages still carry a continuation. Keep one reach
      // alive until there is progress, rather than requiring a loader button.
      // Bound the work so a broken source cannot spin through pages forever.
      for (let attempt = 0; attempt < 4; attempt++) {
        const lastKey = pager.items.at(-1)?.key;
        const committed = await pager.load(
          "end",
          context
            ? {
                signal: context.signal,
                complete: () => {},
              }
            : undefined,
        );
        if (!committed) break;
        pages++;
        if (!pager.canLoad("end")) break;
        if (
          pager.items.at(-1)?.key !== lastKey &&
          (list?.state.totalSize ?? 0) > viewport.clientHeight
        )
          break;
      }
    } catch {
      if (current()) error = "Couldn’t load posts";
    } finally {
      context?.complete();
      busy = false;
      sync();
    }
  }
  async function loadNewer(context?: ReachContext): Promise<void> {
    if (!pager || !current() || busy || headBusy || !headEndpoint) {
      context?.complete();
      return;
    }
    headBusy = true;
    headMessage = "";
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    lifetime.signal.addEventListener("abort", cancel, { once: true });
    context?.signal.addEventListener("abort", cancel, { once: true });
    if (context?.signal.aborted) controller.abort();
    sync();
    try {
      const fresh = await fetchFeedPage(
        source,
        { endpoint: headEndpoint, token: "" },
        chunk,
        controller.signal,
      );
      if (!current() || controller.signal.aborted) return;
      const keys = new Set(pager.items.map((post) => post.key));
      const added = fresh.items.filter((post) => !keys.has(post.key)).length;
      if (!fresh.items.length) headMessage = "No newer posts";
      else {
        const committed = await pager.refreshHead(fresh, controller.signal);
        if (!current() || controller.signal.aborted) return;
        headMessage = committed
          ? added
            ? `${added} newer posts loaded`
            : "Feed is up to date"
          : "Refresh needed";
      }
    } catch {
      if (current() && !controller.signal.aborted)
        headMessage = "Couldn’t load posts";
    } finally {
      lifetime.signal.removeEventListener("abort", cancel);
      context?.signal.removeEventListener("abort", cancel);
      context?.complete();
      headBusy = false;
      sync();
    }
  }
  function onState(): void {
    sync();
    if (reconcileQueued || !pager || !current()) return;
    reconcileQueued = true;
    queueMicrotask(() => {
      reconcileQueued = false;
      if (!current()) return;
      void pager?.reconcile()?.catch((reason: unknown) => {
        error = reason instanceof Error ? reason.message : String(reason);
        sync();
      });
    });
  }
  function reach(edge: "start" | "end", context: ReachContext): void {
    if (!pager) {
      context.complete();
      return;
    }
    // The runtime has already aborted the opposite reach. Let its cleanup
    // finish before starting this one, rather than consuming the new reach
    // while the old request still has its busy flag set.
    const previous = edgeWork[edge === "start" ? "end" : "start"];
    edgeWork[edge] = previous.then(() => {
      if (!current() || context.signal.aborted) {
        context.complete();
        return;
      }
      return edge === "start" ? loadNewer(context) : load(context);
    });
  }
  try {
    // Share renderer initialization across source changes, but never share feed
    // cursors, pending commits, or retained rows across session generations.
    markdownReady ??= initMarkdown().catch((reason: unknown) => {
      markdownReady = undefined;
      throw reason;
    });
    const [initial] = await Promise.all([
      fetchFeedPage(
        source,
        undefined,
        chunk,
        lifetime.signal,
        async (input, options) => {
          const response = await fetch(input, options);
          if (response.ok) {
            const endpoint = new URL(String(input));
            headEndpoint = `${endpoint.origin}${endpoint.pathname}`;
          }
          return response;
        },
      ),
      markdownReady,
    ]);
    if (!current()) return;
    const seen = new Set<string>();
    initial.items = initial.items.filter((post) => {
      if (seen.has(post.key)) return false;
      seen.add(post.key);
      return true;
    });
    viewport.replaceChildren();
    list = createVirtualList(viewport, {
      items: initial.items,
      key: (post) => post.key,
      render: (post) =>
        renderPost(
          post,
          (key) => {
            void pager
              ?.updateItem(key, (item) => ({
                ...item,
                expanded: !item.expanded,
              }))
              .catch((reason: unknown) => {
                error =
                  reason instanceof Error ? reason.message : String(reason);
                sync();
              });
          },
          viewport.clientWidth,
        ),
      boot: "start",
      overscanPx: 900,
      onMount: mountPost,
      onUnmount: unmountPost,
      onState,
      onReachStart: (context) => {
        reach("start", context);
      },
      onReachEnd: (context) => {
        reach("end", context);
      },
      edgeSlots: {
        start: { key: "feed-start", height: 64, render: () => top },
        end: { key: "feed-end", height: 64, render: () => bottom },
      },
    });
    pager = createPagedWindow({
      list,
      initial,
      key: (post) => post.key,
      maxItems: retain,
      project: (items) => items,
      keysOf: (post) => [post.key],
      load: ({ cursor, signal }) =>
        fetchFeedPage(source, cursor, chunk, signal),
      onChange: sync,
      onEvict: (items, edge) => {
        if (edge === "start") evicted += items.length;
        sync();
      },
    });
    sync();
    if (list.state.totalSize <= viewport.clientHeight && pager.canLoad("end"))
      void load();
  } catch (reason) {
    if (!current()) return;
    status.textContent = "Feed unavailable · use Refresh feed to retry";
    status.title = status.textContent;
    placeholder.textContent =
      reason instanceof Error ? reason.message : String(reason);
    viewport.replaceChildren(placeholder);
  }
}

select.addEventListener("change", () => void reset());
refresh.addEventListener("click", () => void reset());
window.addEventListener("pagehide", () => dispose());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void reset();
});
void reset();
