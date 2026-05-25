# virtual-list

`virtual-list` is a dynamic-height virtual list experiment for chat-style
interfaces. It replaces the earlier phantom scroller work with a native
scrolling viewport, a measured size model, and a small reusable TypeScript
runtime.

The current focus is preserving native scroll behavior while rows are measured,
loaded, trimmed, and corrected at runtime. The demos cover chat transcripts,
streaming messages, dynamic network-backed loading, masonry images, and
justified photo rows.

## Run the demos

Use the existing Vite setup from this directory.

```sh
pnpm install
pnpm run dev
```

Open these pages from the dev server:

- `/demos/chat-history/chat-history.html` shows 10,000 chat history rows.
- `/demos/dynamic-content/dynamic-content.html` shows dynamic top and bottom
  content loading over a 10,000-row transcript window.
- `/demos/dynamic-content/dynamic-content.html?source=bsky` shows the same
  dynamic loading path with Bluesky public feed data.
- `/demos/dynamic-content/dynamic-content.html?source=lemmy&debugRenderDrift=1`
  enables render drift reports for the dynamic content demo.
- `/demos/masonry/masonry.html` shows dynamic masonry photo loading.
- `/demos/photo-gallery/photo-gallery.html` shows dynamic justified photo rows.
- `/demos/streaming/streaming.html` shows append, streaming, cancel, and
  sticky user-message scroll behavior.
- `/demos/streaming/streaming.html?instant` disables simulated token delays for
  faster manual testing.

## Runtime architecture

The virtualizer lives in `src/dynamic-virtualizer.ts`. It owns the scroll
viewport, injects a single content layer, and mounts only the rows that overlap
the viewport plus pixel overscan.

The runtime uses these pieces:

- A native `overflow-y: auto` viewport with `overscroll-behavior-y: contain`,
  `-webkit-overflow-scrolling: touch`, and thin gray scrollbars on transparent
  tracks.
- A single relative content layer whose height is the current total modeled
  height.
- Absolutely positioned rows placed at their modeled prefix offset with
  `translateY()`.
- A `Float64Array` of row sizes backed by a Fenwick tree for prefix sums and
  index lookup.
- A `ResizeObserver` on mounted rows to replace estimates with real border-box
  heights.
- A viewport `ResizeObserver` to keep the current anchor stable when the list
  area changes height.

There is no phantom element, scroll runway, idle rebase, or runtime-owned chunk
trimming in this version. The browser owns the scroll range directly, and the
runtime keeps that range accurate by updating measured row sizes. Hosts that
keep a retained data window can trim their own arrays with `setCount()` or
`syncLayout()`.

## Measurement and scroll correction

Every row starts with `getItemHeight(index)`. This value is the host's current
known height for the row, not a loose estimate. The host must pre-measure rows
before adding them to the virtualizer when scroll stability matters.

Use `createDynamicVirtualizerItemMeasurer()` when the host wants
runtime-compatible pre-measurement without duplicating the hidden measurement
DOM. The measurer builds one item at a time, measures it at the current
viewport width, applies the same `dv-content` and `canvasClassName` styling as
the visible list, normalizes the result, and removes the hidden node before
returning.

The runtime defensively normalizes host-provided numbers at this boundary.
`getCount()` values that aren't finite positive integers become `0`, and
`getItemHeight(index)` values that aren't finite positive numbers become `1`.
This keeps invalid host data from poisoning the size tree, but it doesn't
replace the host's responsibility to provide accurate heights.

When a mounted row reports a real height, the runtime updates the size tree and
applies one correction pass. This mounted measurement is a refinement path for
small changes, viewport resizing, theme changes, and streaming content that
grows while visible. It is not meant to recover from large unknown heights.

> **Warning:** On iOS Safari, writing `scrollTop` during native momentum can
> stop or destabilize the scroll animation. If `getItemHeight(index)` returns
> large underestimates, the browser can reach a native boundary before the true
> content boundary. The host must provide near-exact heights before insertion
> for stable iOS scrolling.

The correction rules are:

- If the viewport was already at the bottom, scroll back to the modeled bottom.
- If a measured row above the current anchor changes height, adjust
  `scrollTop` by that height delta.
- If the changed row is at or below the anchor, keep `scrollTop` unchanged.

This keeps one frame of work in the measurement hot path: consume pending
measurements, update the model, render the affected range, and apply the needed
scroll correction in the same animation frame.

## Sticky top reserve

`setStickyIndex(index)` reserves temporary trailing space so the given row can
align to the top of the viewport with a normal `scrollToIndex(index, "top")`
call. The method does not scroll by itself. It only adjusts the scroll range.

The reserve is created only when the real item content already overflows the
viewport. It shrinks as measured content below the sticky row grows, and it is
cleared when the real content provides enough scroll range. This keeps short
conversations from creating blank scroll space while still letting a newly sent
message move to the top before the assistant response fills the space below it.

## Public API

Measure rows before insertion with `createDynamicVirtualizerItemMeasurer`, then
create a virtualizer with `createDynamicVirtualizer`.

```ts
const itemMeasurer = createDynamicVirtualizerItemMeasurer({
  viewport,
  canvasClassName: "chat-canvas",
  buildItem: (index) => buildMessageElement(index),
});

let measuredMessageHeights = messages.map((_, index) =>
  itemMeasurer.measure(index),
);
itemMeasurer.dispose();

const virtualizer = createDynamicVirtualizer({
  viewport,
  canvasClassName: "chat-canvas",
  getCount: () => messages.length,
  getItemHeight: (index) => measuredMessageHeights[index],
  buildItem: (index) => buildMessageElement(index),
  overscanPx: 700,
  onRangeChange: (state) => {
    updateControls(state.atTop, state.atBottom);
  },
  onReachTop: async () => {
    virtualizer.setBoundarySlot("top", loadingSlot);
    const olderMessages = await loadOlderMessages();
    const olderHeights = measureMessages(olderMessages);
    virtualizer.syncLayout({
      addedBefore: olderMessages.length,
      topSlot: null,
      apply: () => {
        messages = [...olderMessages, ...messages];
        measuredMessageHeights = [...olderHeights, ...measuredMessageHeights];
        return true;
      },
    });
  },
  onReachBottom: async () => {
    virtualizer.setBoundarySlot("bottom", loadingSlot);
    const newerMessages = await loadNewerMessages();
    const newerHeights = measureMessages(newerMessages);
    virtualizer.syncLayout({
      bottomSlot: null,
      apply: () => {
        messages = [...messages, ...newerMessages];
        measuredMessageHeights = [...measuredMessageHeights, ...newerHeights];
        return true;
      },
    });
  },
});
```

Pass `renderMode: "full"` to mount every current row instead of only the
virtual range. The default is `renderMode: "virtual"`. Full mode is useful for
bounded retained windows when diagnosing mount and unmount churn.

The returned object exposes:

- `state` for the latest count, mounted range, measured count, scroll position,
  total modeled size, and top or bottom state.
- `invalidateMeasurements()` after the host remeasures rows for a width, theme,
  font, or orientation change.
- `setCount()` after append, remove, or replace operations.
- `syncLayout(update)` after count changes that need to be applied atomically
  with boundary slot changes. Use `apply` for host data mutations that must be
  committed with the virtualizer layout update. Return `false` from `apply` to
  cancel the update.
- `setCount({ addedBefore })` after prepending rows before the current first row
  outside an active boundary load. Use `syncLayout({ addedBefore, apply })` for
  boundary-triggered prepends.
- `setCount({ removedBefore })` after trimming rows from the start of the
  loaded window.
- `setBoundarySlot("top" | "bottom", slot | null)` for scrollable boundary
  rows such as loading, no-more, and error states.
- `getBoundaryElement("top" | "bottom")` for direct access to a mounted
  boundary row.
- `setPlaceholderSlot(slot | null)` for empty-list content such as initial
  loading, empty, and error states.
- `getPlaceholderElement()` for direct access to the mounted empty-list row.
- `scrollToIndex(index, align, options)` for item navigation. This targets the
  item itself, so `scrollToIndex(0, "top")` keeps the top boundary slot above
  the viewport and `scrollToIndex(count - 1, "bottom")` keeps the bottom
  boundary slot below the viewport.
- `scrollToOffset(offset, options)` for absolute scroll-offset navigation
  through the runtime.
- `scrollToTop(options)` and `scrollToBottom(options)` for boundary navigation.
  These methods target the native scroll range and include boundary slots.
- `followBottom(options)` to keep the viewport following the current bottom
  while content grows. Wheel, touch, and pointer input stop the follow.
- `stopFollowBottom()` to cancel an active bottom follow.
- `setStickyIndex(index)` to reserve trailing space for top alignment.
- `getMountedElement(index)` for direct mounted-row updates.
- `refreshIndex(index)` and `refreshMounted()` for rebuilding row DOM.
- `dispose()` for cleanup.

The config also accepts host callbacks:

- `onRangeChange(state)` for mounted range, measured count, total size, and
  true top or bottom changes.
- `onReachTop(state)` and `onReachBottom(state)` when a stable top or bottom
  boundary slot enters the native viewport.
- `onScrollStart(state)` and `onScrollEnd(state)` for runtime scroll lifecycle
  boundaries.

The module also exports `measureDynamicVirtualizerItem(config)` as a one-shot
wrapper for single-row measurement. Both measurement APIs are intentionally
separate from the live instance so the host can measure rows before the
virtualizer exists, before appending a new message, or before loading a chunk
into an existing list.

Use `planDynamicVirtualizerPixelWindowFromStart()` and
`planDynamicVirtualizerPixelWindowFromEnd()` when a retained host window needs
to load enough rows to cover a target pixel height instead of a fixed row
count. The streaming demo uses this to load roughly a viewport-height multiple
from the newest transcript tail and to prepend older messages in similarly
sized batches.

Boundary slots are optional host-owned rows before item `0` and after the last
item. The host provides a stable `key`, a measured `height`, and a `build()`
function. The runtime positions the slot, includes it in `scrollHeight`, and
keeps normal item indexes unchanged. Use one `syncLayout()` call when a loading
slot state changes together with a prepend or append, so the slot update and
count shift happen in one anchor-preserving update.

If a boundary callback exists and the host passes `null` for that slot, the
runtime keeps a 1 px sentinel so future boundary detection can re-arm. For
visible loading, no-more, or error affordances, keep a fixed-height boundary
slot and change only its host-rendered contents.

Top boundary slot changes by themselves don't move `scrollTop`. This lets the
host reveal a loading spinner at the native top edge without immediately
scrolling past it. Real prepends still preserve the existing visual anchor when
the host passes `addedBefore`.

Placeholder slots are optional host-owned rows for the `count === 0` state.
They don't affect indexes or the modeled item size. Use them for initial
loading, empty, and error states before rows are available.

Velocity placeholders are optional host-owned row DOM for fast virtual scrolling.
Pass `buildPlaceholder(index)` to create lightweight row content, and tune
`placeholderVelocityThreshold` if the default `8` px/ms threshold is too high
or too low for the host. The runtime uses hysteresis: it enters placeholder mode
when velocity crosses that threshold and exits when velocity falls below half
that threshold. Existing real rows stay mounted, newly mounted rows use
placeholders while fast mode is active, placeholders keep the same modeled
height from `getItemHeight(index)`, and placeholders are replaced with real
`buildItem()` rows when fast mode exits or scrolling ends.

`debugRenderDrift` is an optional diagnostics flag. Pass `true` to log mounted
row drift with `console.warn`, or pass a reporter function to collect drift
records. The runtime compares each mounted row's actual DOM rect against its
modeled `translateY()` position and measured height. The runtime skips all drift
reads when the option is unset or `false`, so normal scroll rendering doesn't
call `getBoundingClientRect()` for this debug path.

In the dynamic content demo, add `?debugRenderDrift=1` to the URL. The console
prints one activation line when the flag is enabled. It logs warnings only when
at least one mounted row drifts beyond the runtime epsilon. The demo also keeps
the last reports on `window.__vlRenderDriftReports` and increments
`window.__vlRenderDriftCount`. Because drift checks read DOM rects, use this
flag only for diagnostics; it is not a scroll performance mode.

## Dynamic loading

Hosts can keep only part of a data set in memory and load more rows when the
native viewport reaches either boundary. Use `onReachTop` and `onReachBottom`
for boundary notifications. The runtime detects those boundaries with stable
top and bottom boundary slots observed by `IntersectionObserver`.

The reach callbacks fire once per visible boundary-slot entry. They re-arm after
the slot leaves the viewport, so the host doesn't receive a callback on every
scroll frame while the slot remains visible.

If loading happens asynchronously, the host can set a boundary slot from the
reach callback. A loading spinner, a no-more state, and an error state are all
ordinary slot DOM nodes from the runtime's perspective. The runtime doesn't own
loading semantics; it only makes the host-provided node part of the scrollable
content.

Deferred loading splits network and DOM work without host scroll-state
bookkeeping. Use `onReachTop` or `onReachBottom` to start the network request
as soon as the user reaches a boundary. When the rows are ready, call
`syncLayout(...)`. The runtime queues row prepends, appends, and retained-window
shifts while native scrolling is active and applies them from its `scrollend`
path.

Slot-only updates apply immediately while native scrolling is active. This lets
the host show a loading spinner as soon as a boundary is reached. Layout updates
with `apply`, `addedBefore`, `removedBefore`, or a count change are deferred
until scrolling settles. Put boundary-load array mutations inside `apply` so the
host data changes in the same step as the virtualizer's count and size model.

The runtime treats `scrollend` as blocked while touch or pointer input is still
active. In that case, a later native `scrollend` flushes deferred layout
updates. If the browser already emitted the final `scrollend` before the input
ended, the runtime finalizes on the next animation frame after release. This
avoids committing deferred boundary rows while Safari is still settling a
rubber-band edge gesture without leaving a completed load stuck in its loading
state.

Only one boundary load must own the visible loading state at a time. If a new
top or bottom load starts while any boundary load is still running or waiting
for deferred layout, cancel the active load and ignore its late result. For
network-backed sources, pass an `AbortController` into the source loader and
use `controller.signal` in `fetch()` so cancellation stops the request instead
of only discarding the response.

`onRangeChange` is also edge-aware rather than frame-aware. The callback fires
when the mounted range, mounted count, measured count, modeled total size, or
true top or bottom state changes. It doesn't fire for every scroll frame when
the rendered range and edge state remain unchanged.

For bottom appends outside an active boundary load, update the host data and
call `setCount()`. The current `scrollTop` is preserved, so newly appended rows
extend the scroll range below the current view. For boundary-triggered appends,
use `syncLayout({ apply })` so the host data and runtime count commit together
after native scrolling settles.

For top prepends, pass `addedBefore` in the same `syncLayout()` update that
mutates the host data. The runtime shifts the existing size model by the added
row count, fills the new leading rows from `getItemHeight(index)`, and adds the
inserted height to `scrollTop`. That keeps the same visible row anchored while
the newly loaded rows become available above it.

For top trims, update the host data and call
`setCount({ removedBefore: rowCount })`. The runtime shifts the retained size
model toward local index `0` and subtracts the removed height from `scrollTop`.
That keeps the visible anchor stable while rows before it leave the loaded
window.

Top prepends rely on the same height contract as the rest of the runtime: the
new rows must have near-exact `getItemHeight(index)` values before insertion.
Prepend and trim anchor corrections write `scrollTop` because there is no
native CSS primitive for preserving the old visual anchor across inserted or
removed rows.

## Chat history demo

The chat history demo is the large-list baseline. It repeats the shared sample
conversation to create 10,000 rows and pre-measures those templates once before
initializing the virtualizer.

That template measurement satisfies the runtime height contract for repeated
rows. The runtime continues to refine mounted row sizes as mounted rows report
real heights.

The demo also verifies:

- Bottom initial load.
- Appending 100 messages.
- Top and bottom index navigation.
- Theme switching with markdown and code block refresh.
- Async Shiki loading without remounting the full list.

## Shared demo utilities

The demo pages share a small helper module in `demos/demo-utils.ts`. It keeps
demo-only plumbing out of the runtime source and removes duplicated code across
the pages.

The shared helpers cover:

- Required DOM lookup with optional element-type validation.
- Theme button synchronization and event binding.

Hidden row measurement is handled by the runtime module. Demo helpers remain
demo-only plumbing and are not part of the virtualizer API.

## Dynamic content demo

The dynamic content demo keeps a target window of rows loaded in the virtualizer.
It defaults to a retained target of 100 rows and 50-row load chunks. You can
change those values with `?retain=300&chunk=50`. The header source selector can
switch between the local synthetic transcript, Bluesky's public Discover feed,
and Lemmy public post lists. Network sources start at the natural top of the
loaded feed, while the synthetic transcript starts near the middle so both
directions have data immediately. All sources pre-measure every loaded row
before exposing it to the virtualizer.

The render mode button switches the runtime between virtual rows and full
retained DOM rows. You can also use `?render=full`. Full mode keeps every row
in the retained window mounted while preserving the same runtime scroll model,
boundary slots, measurements, and scroll APIs. Use it to compare normal
virtualization against mount-free retained-window rendering.

Boundary loading is always deferred while native scrolling is active. The host
displays a boundary spinner as a scrollable row, starts the fetch from the reach
callback, and calls `syncLayout()` when the chunk is ready. The runtime applies
the ready chunk after native scrolling ends.

When a boundary load starts, the demo cancels any in-flight or pending boundary
load with an `AbortController`. This prevents stale loading spinners and stops
network requests when momentum carries the viewport from one edge to the other
before the first load commits.

Top loading uses `syncLayout({ addedBefore, topSlot, apply })`, because that
prepend path must write `scrollTop` to preserve the currently visible anchor
while replacing any top boundary slot. Bottom loading uses
`syncLayout({ bottomSlot, apply })`, because the host still needs the ready rows
to commit through the same deferred layout path. If the loaded window exceeds
the retained target, the host trims rows from the opposite end only when the
rows to trim are outside the mounted range. The trim uses the same runtime
layout path as the load operation, so retention changes remain anchored to the
current view.

The status bar shows the loaded global index window and mounted global index
range. The host still provides near-exact row heights through
`getItemHeight(index)` before each chunk enters the virtualizer. The demo uses
`createDynamicVirtualizerItemMeasurer()` to keep chunk heights in the same CSS
context as the visible list. Network posts render text as sanitized or escaped
HTML and render images as reserved-aspect media blocks so image loading doesn't
change the measured row height.

The top and bottom toolbar buttons use `scrollToIndex()` with smooth scrolling
because they jump to the loaded item window, not to the boundary slots. That
keeps the top spinner slot above the first loaded row and the bottom spinner
slot below the last loaded row. Demos that need to inspect the boundary slots,
such as masonry and photo gallery, use `scrollToTop()` and `scrollToBottom()`
instead.

When the list has no rows, the demo uses a placeholder slot for initial loading,
empty results, and source errors. Use `?debugRenderDrift=1` to enable the
runtime's mounted-row drift reporter. The demo stores the last reports on
`window.__vlRenderDriftReports` and increments
`window.__vlRenderDriftCount` for browser-driven checks.

## Streaming chat demo

The streaming demo exercises the runtime with content that changes after it is
mounted. Sending a message appends the user row first, calls
`setStickyIndex(userIndex)`, and then scrolls that user row to the top of the
viewport. The assistant placeholder is appended after that scroll finishes, so
the response fills the space below the user message as it streams.

The demo keeps a linear transcript outside the virtualizer and loads only a
pixel-sized retained window into the live list. The initial bulk load uses the
newest rows needed to cover the viewport-height factor, and top boundary loads
prepend older rows with the same pixel-window planner. The footer shows the
loaded transcript range, loaded height, mounted range, mounted count, and
measured count for manual checks.

The assistant status label uses:

- A blue pulse while the assistant is thinking.
- A green pulse while tokens are streaming.
- No dot when the message is done.
- A red dot when the stream is cancelled.

The streaming delays are demo simulation code. They are not part of the
virtualizer hot path.

## Masonry demo

The masonry demo exercises variable-position image groups in a single
virtualizer instance. The host precomputes group heights, keeps fixed-height
boundary slots at the top and bottom, and uses the runtime `onReachTop`,
`onReachBottom`, `onScrollStart`, and `onScrollEnd` callbacks for loading.

## Photo gallery demo

The photo gallery demo uses justified rows instead of masonry columns. Each
virtualized row is one complete photo strip with precomputed height, so the
runtime mounts and unmounts row bands rather than independent column fragments.
The host keeps fixed-height boundary slots and commits pending top or bottom
loads only from the runtime `onScrollEnd` callback.

## Performance notes

The virtualizer keeps scrolling work small and predictable.

- Scroll events schedule a single render frame.
- ResizeObserver entries are batched into a single measurement frame.
- Prefix offset reads and index lookup are `O(log n)` through the Fenwick tree.
- DOM updates are bounded to the mounted range plus overscan.
- Existing mounted elements are reused when the range overlaps.
- Range changes are incremental: rows leaving the buffered range are removed,
  rows entering it are appended, and overlapping rows stay attached.
- Hidden pre-measurement is host-driven and happens outside scroll handling.
- Velocity placeholders are host-driven and only affect newly mounted rows.
- Scroll-settle timers are lifecycle gates, not per-row render work.

The demos cache rendered markdown HTML by message or template and theme. When
the Shiki highlighter loads or the theme changes, only mounted rows are rebuilt.
The highlighter loader is single-flight, so concurrent `loadHighlighter()` calls
reuse the same in-flight initialization. The streaming demo uses stable
per-message cache keys, so token updates replace the current rendered HTML
instead of accumulating stale cache entries.

## Browser behavior

The runtime uses normal browser scrolling instead of emulating momentum. That is
intentional: touch, wheel, native scrollbar, and rubber-band behavior stay owned
by the platform.

The viewport contains overscroll chaining with `overscroll-behavior-y: contain`.
Safari can emit transient internal `scrollTop` values while a scrollable element
is rubber-banding at an edge. Letting that gesture chain to the page can produce
visible repaint flicker around the virtualized content. Containing overscroll
keeps the bounce on the list, preserves native rubber-band momentum, and avoids
that page-level repaint path.

When measurements change during scroll, the runtime writes `scrollTop` only for
the correction that preserves the active anchor or bottom state. On browsers that
accept those writes during momentum, corrections happen immediately. On browsers
that defer or coalesce scroll writes during native momentum, the next render or
measurement pass catches up from the current native scroll position.

## Validation

Use the project check before committing runtime or demo changes.

```sh
pnpm run check
```

This runs Biome checks and TypeScript.
