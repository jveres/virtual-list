import {
  createPagedWindow,
  type Page,
  type PagedWindow,
} from "../../src/companions/index";
import { createVirtualList } from "../../src/index";

interface Message {
  id: number;
  text: string;
}
// The fake archive is application data, not a hidden virtualizer cache.
const archive: Message[] = Array.from({ length: 120 }, (_, id) => ({
  id,
  text: `Message ${id}\n${"Synthetic archived content. ".repeat(12)}`,
}));
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const retained = document.querySelector<HTMLOutputElement>("#retained")!;
const streamButton = document.querySelector<HTMLButtonElement>("#stream")!;
const lifetime = new AbortController();
let pager: PagedWindow<Message, number> | undefined;
let streaming = false;

function page(start: number): Page<Message, number> {
  return {
    items: archive.slice(start, start + 20),
    start:
      start > 0
        ? { available: true, cursor: start - 20 }
        : { available: false },
    end:
      start + 20 < archive.length
        ? { available: true, cursor: start + 20 }
        : { available: false },
  };
}
function report(error: unknown): void {
  status.value = String(error);
}
const initial = page(100);
const list = createVirtualList(viewport, {
  items: initial.items,
  key: (item) => String(item.id),
  // Match the source's actual latest prompt, never an older retained message.
  pinning: { match: (item) => item.id === 118 },
  scrollingUpdates: "live",
  followBehavior: "smooth",
  render: (item, existing) => {
    const row = existing ?? document.createElement("article");
    row.dataset.key = String(item.id);
    row.textContent = item.text;
    return row;
  },
  onReachStart: (context) => {
    if (pager) void pager.load("start", context).catch(report);
    else context.complete();
  },
  onReachEnd: (context) => {
    if (pager) void pager.load("end", context).catch(report);
    else context.complete();
  },
  onState: (state) => {
    viewport.dataset.following = String(state.following);
    viewport.dataset.totalSize = String(state.totalSize);
    void pager?.reconcile()?.catch(report);
  },
});
pager = createPagedWindow({
  list,
  initial,
  maxItems: 60,
  trim: { offscreenPin: "evict" },
  key: (item) => String(item.id),
  keysOf: (item) => [String(item.id)],
  project: (items) => items,
  live: { project: (item) => item, key: (item) => String(item.id) },
  load: async ({ cursor }) => page(cursor),
  onChange: (items) => {
    retained.value = `${items.length} retained`;
    retained.dataset.first = String(items[0]?.id);
    retained.dataset.last = String(items.at(-1)?.id);
  },
});
retained.value = `${pager.items.length} retained`;
const listeners = { signal: lifetime.signal };
document.querySelector("#older")!.addEventListener(
  "click",
  () => {
    void pager?.load("start").catch(report);
  },
  listeners,
);
document.querySelector("#newer")!.addEventListener(
  "click",
  () => {
    void pager?.load("end").catch(report);
  },
  listeners,
);
streamButton.addEventListener(
  "click",
  () => {
    if (streaming) return;
    streaming = true;
    streamButton.disabled = true;
    status.value = "Streaming";
    void (async () => {
      try {
        for (let token = 0; token < 100 && !lifetime.signal.aborted; token++) {
          const previous = archive[119]!;
          const next = {
            ...previous,
            text: `${previous.text}\nToken ${token + 1}: streamed through the pager.`,
          };
          archive[119] = next;
          await pager?.updateItemLive("119", () => next);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      } finally {
        streaming = false;
        streamButton.disabled = false;
        status.value = "Done";
      }
    })().catch(report);
  },
  listeners,
);
window.addEventListener(
  "pagehide",
  () => {
    lifetime.abort();
    pager?.dispose();
    list.dispose();
  },
  { once: true },
);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
