# Build a streaming consumer

Use this guide for integration flow and the
[companion and UI API reference](integration-api.md) for signatures, options,
defaults, lifecycle, and error behavior. You don't need to extract helpers
from a demo; the supported source entry points are listed below.

Start with [the basic example](../examples/streaming-basic/main.ts) for send,
pin, token growth, stop, follow/rearm, and conversation replacement. It uses
only the public runtime entry point and plain text rendering. Run it with
`pnpm run dev`, then open `/examples/streaming-basic/`.

For paging and live updates together, open `/examples/streaming-paged/` and
read [its source](../examples/streaming-paged/main.ts). This separate example
uses a bounded history window with an evictable latest-prompt pin. The full
streaming demo uses the same companion for history and live row updates.
The [release record](streaming-integration-plan.md) documents the completed
merge and the integration's first source release, `v0.2.0`. This guide
describes the current checkout, including changes from later source tags.

For renderer integration, open `/examples/streaming-markdown/` and read
[its source](../examples/streaming-markdown/main.ts). It adds Markdown and an
autosizing composer without importing demo implementation files.

## Supported source entry points

The project uses source-based distribution. Copy `src/` as a unit into a
TypeScript/bundler project; individual internal files are not standalone.
The project does not yet publish an installable package.

The repository compiles against ES2022 and DOM libraries with TypeScript
bundler module resolution. Use a compatible TypeScript/bundler setup and
create DOM-backed lists and helpers only in the browser. Runtime facilities
include `ResizeObserver`, animation frames, and abort signals; paging also
uses `AbortSignal.any`. The source copy doesn't bundle browser polyfills.
The locked development-tool versions are recorded in `pnpm-lock.yaml`;
they aren't runtime dependencies of the copied core.

| Import | Responsibility |
| --- | --- |
| `src/index` | Virtual list creation and public runtime types. |
| `src/companions/index` | Paging, sticky headers, and reading-anchor helpers. |
| `integrations/index` | Optional textarea sizing, chat-text collapse, and streaming display helpers. |
| `src/companions/styles.css` | Default paint suppression for duplicate inline headers. |
| `integrations/markdown.css` | Cursor reservation and nested code/table overflow rules. |
| `integrations/collapse.css` | Collapsed-message layout and toggle positioning. |

The core and companions do not import a Markdown renderer. Copy
`integrations/` separately if you use its UI helpers. Legacy demo helper
paths remain compatibility wrappers, not the supported import path.

Run `pnpm run test:consumer` to build copied basic and paged consumers in a fresh
temporary directory with no demo files or workspace links. This is a source
distribution smoke test, not a package installation or browser test.

## Runtime wiring

Keep one immutable message store in your application. Structural changes go
through `setItems`; a token replaces one message through `updateItem`. The
runtime calls `render(item, existing)` and measures the changed row. Your
renderer updates the existing element or returns a replacement.

Configure `pinning.match` to identify the prompt and
`followBehavior: "smooth"`. Streaming tokens need no update-mode option: a
token that changes nothing above the reader lands at once, even during a
gesture, and other changes wait for the scroll to settle unless native scroll
anchoring keeps the reader still. On send, submit the prompt and empty reply,
then await `scrollTo(promptKey, { align: "start", behavior: "smooth" })`.
A result of `false` means the command did not land, including interruption;
it need not cancel the response. Never write the viewport's scroll position
to compensate for streaming growth.

Use `scrollTo("end")` for explicit follow intent, including rearming after a
row or content start limit. To let leading tool calls scroll out, use
`followMode: "keep-content"` with a read-only `followStart(item, row)` selector
that returns the first answer element. Return `null` until answer text
arrives; exclude tool output and empty cursor containers. This selector is
for measured rows and is cached with their height, not queried on each scroll
frame. The streaming demo exposes this as **Stop when the answer text reaches
the top (skip tools)** in **Settings > General > Autoscroll**.

Use `remeasure(key, { anchor: "viewport" })` for a user
interaction that changes row size, such as opening a tool disclosure. Keep
renderer handles per element and destroy them in `onDestroy`, not on every
temporary unmount. Cancel streams and dispose the old list when replacing
the conversation or unmounting the host.

## Live paging

The optional pager's `updateItemLive` method submits a same-key row update
without waiting for scrolling to settle. Its adapter is deliberately narrow:
one source item maps to one runtime row, and that update must not alter any
other projected rows. Day changes, regrouping, and other structural projections
must use the existing queued update path or replace the source.

```ts
const paging = createPagedWindow({
  list,
  initial,
  maxItems: 60,
  trim: { offscreenPin: "evict" },
  key: (message) => message.id,
  keysOf: (row) => [row.id],
  project: (items) => items,
  live: { project: (message) => message, key: (row) => row.id },
  load: ({ cursor, signal }) => fetchPage(cursor, signal),
});

await paging.updateItemLive(messageId, (message) => ({
  ...message,
  text: message.text + chunk,
}));
```

The updater runs on the next microtask against the latest retained item. This
avoids changing source ownership in the middle of a runtime publication.
Its promise resolves after submission, not after a geometry commit. Unknown
keys, unchanged references, and disposed pagers resolve `false`. Source and
projected row keys must stay stable. Updaters and adapters must be pure.

Every retained page sharing that item receives the replacement. A page that
is still preparing when a live update arrives keeps its staged rows, and its
commit evaluates the page again against current data. If other source
changes cancel that preparation, the pager retries the fetched page against
current data. It doesn't re-fetch that page. `onChange` continues to describe
committed window changes; it is not a per-token event. Read `paging.items`
for the latest submitted source state.

If runtime submission throws, the pager cancels outstanding page work and
stops accepting updates. The latest source remains readable in `paging.items`
until disposal. Recover by saving that data and recreating the pager/list;
do not assume a render or observer exception rolled back a runtime commit.
Adapter validation failures before submission leave the source unchanged.

Persist edits in your data source if they must survive eviction. The pager
retains pages, not an unlimited edit archive. The example updates its fake
archive before submitting each token so an evicted reply restores correctly.

A fetched page is a snapshot, not a subscription. If an evicted item changes
after fetch but before commit, reconcile its current source value from
`onChange` through `updateItemLive`. The full demo does this for late tokens.
Use versioned source data or immutable identity to detect those changes;
don't let a delayed response replace newer authoritative content.

## Optional trimming

Trimming is enabled by default and preserves the persistent pin, including
when it is offscreen. Configure it independently from the live-update adapter:

```ts
trim: false                         // Never evict for the item budget.
trim: { offscreenPin: "retain" }    // Default; omission or {} is equivalent.
trim: { offscreenPin: "evict" }     // Permit eviction of an offscreen pin.
```

Eviction still preserves visible/overscan rows and explicit targets. Whole
pages are evicted, so `maxItems` remains a soft budget. With `trim: false`,
the budget is inactive and `reconcile()` returns `null`. Explicit source
replacement and disposal still release data in every mode.

Match the actual latest prompt ID from the full source in `pinning.match`,
not every user message. Once that prompt's page is evicted, no older prompt
takes its place. Reloading its page restores the pin without navigating or
rearming following. Imperative pins are not remembered after eviction; use
declarative matching when automatic restoration is required.

The companion uses `updateWindow(update, signal, { protectPin: false })`
for opted-in trimming. Custom pagers can use the same flag: an unsafe
snapshot resolves `false`, even for synchronous preparation. The runtime
rechecks staged work before committing and does not change gesture timing.
Normal structural replacements can continue to use the existing default
window update or `setItems` APIs.

## Restoring an evicted destination

`scrollTo("end")` targets the end of the current runtime items, not the end
of your archive. It does not fetch a missing destination. If the latest page
is already retained, call `scrollTo("end", { behavior: "smooth" })` directly.

For an evicted latest page, the application replaces the retained window
before it requests movement. A window is the contiguous group of source
items currently supplied to the list. Use this sequence from a user action:

1. Select or fetch a bounded window that includes the archive's latest item.
   If fetching is asynchronous, discard results superseded by another
   navigation or conversation change.
2. Dispose the old pager before replacing its items.
   Clear its application reference so runtime callbacks cannot reuse it.
3. Submit the projected rows through `setItems` with `interrupt: true` and
   an explicit starting `anchor: { key: firstMessageKey, offset: 0 }`.
   Use the first message's runtime key in the replacement window, not a
   removed key or a separator key.
4. Create the replacement pager from the same source items and their
   `start` and `end` continuations.
   Keep its projection, live-update adapter, and trimming policy consistent.
5. Request `scrollTo("end", { behavior: "smooth" })` after replacement.
   Handle rejected promises and treat `false` as an interrupted or incomplete
   command, not permission to force another scroll.

The starting anchor determines the initial view, not the final destination.
An `"end"` snapshot anchor reaches the destination before animation starts.
A `"viewport"` anchor also fails to guarantee travel when the windows have
no shared rows. The old offset can exceed the replacement's height and
clamp directly to its end. Use a retained reading anchor instead when your
product requires continuity and that anchor survives the replacement.

This sequence applies to an event handler outside runtime callbacks.
`setItems` returns `void` and can defer work during a runtime transaction.
For a replacement that needs a commit result, use
`updateWindow(updater, signal, { interrupt: true })` and await `true` before
navigating. Recreate the pager from the committed source in `onCommit`.
The [runtime boundary](bounded-paging.md#runtime-boundary) defines cancellation
and errors for that path.

To respond immediately when restoring an evicted tail, first request native
smooth scrolling to the current window's end. Prepare the replacement with
`updateWindow(updater, signal, { interrupt: "commit" })`. It stages rows during
that motion, then takes over and commits the replacement when ready. After a
successful commit, request the new end. Fresh input cancels the pending
replacement. A current window already at its end has no approach distance;
show loading feedback while preparation finishes.

The animation crosses only the restored window, not every evicted page in
the archive. The window replacement can change the visible content before
the animation starts. If its content fits within the viewport, no scroll
distance exists. With `followBehavior: "smooth"`, a successful end landing
rearms following. Page restoration alone does not rearm it.

Source selection and the starting view remain application policy. The runtime
owns measurement, clamping, animation, interruption, and following. Do not
add viewport scroll writes or a second animation loop for this sequence.
The [paged-history regression](../scripts/regressions/chat-scrolling/chat-paged-history-regression.mjs)
covers two top-page loads followed by smooth bottom navigation and restoration
from older history. The fix is recorded in commit `6fc4434`.

## Sticky headers and replacements

Wire `onState` to `sticky.refresh(snapshot.scrollTop)` and `onViewport` to
`sticky.update(snapshot.scrollTop)`. The supported companion does not install
a native scroll listener by default. `observeScroll: true` is available for
standalone legacy use; the streaming and history demos use runtime snapshots.

Provide a relatively positioned overlay container, ordered header keys,
`positionOf`, a header renderer, and optional `elementOf` for the inline visual.
Import the companion CSS or provide equivalent paint-only styling for
`vl-sticky-inline-hidden`. Do not suppress the measured row itself. Call
`destroy()` before removing the overlay. The host owns header appearance.

For branch/version replacement, supply semantic `{ from, to }` key pairs to
`replacementAnchor(list, viewport, pairs, inset)`. It selects the first source
row in the supplied order that intersects the viewport below the inset,
preserving its offset even when its top is clipped. A near-pinned offset is
normalized to the inset. The returned `visibilityInset` lets the runtime
reveal the replacement at that inset if its measured height would leave it
fully hidden. Missing and offscreen rows are ignored. The helper reads
geometry but never scrolls. Submit its result as the snapshot's anchor.
`captureItemPlacement` supplies offset, visibility, above-viewport,
and pinned-position facts for edit/send policy without duplicated arithmetic.

Capture immediately before the replacement. If an action may interrupt queued
paging first, capture inside `updateWindow`'s updater with `interrupt: true`,
after takeover. Do not cache these coordinates across asynchronous fetches.

## UI integration contracts

The optional helpers own UI layout, not virtual-list geometry. The collapse
helper and Markdown styles support specific chat markup. They are reusable
adapters, not markup-independent components. Use the documented structure or
supply your own UI adapter without duplicating list scroll control:

- `autosizeTextarea(input, { minHeight, maxHeight, container? })` holds the
  composer box while probing the input. This avoids transient viewport growth
  that can clamp WebKit's scroll position. Bounds are positive border-box
  heights; use `box-sizing: border-box` on the textarea.
- `prepareUserMessageCollapse` prepares the demo-compatible chat markup at
  the supplied viewport width. Pass the list viewport, or an element with its
  typography, as the optional measurement ancestor. Call it before
  returning a new row, then wire its mount/unmount helpers to the runtime.
  It expects `.message-content > .markdown-viewer > .markdown`, and the chat
  collapse styles. General-purpose renderer hooks are not added to the core.
- The collapse callback stores expanded state and calls `remeasure` for
  explicit viewport intent. Restore persistent expanded state when rendering
  a fresh element.

Import the renderer's own CSS before `integrations/markdown.css`. Keep one
Markdown viewer handle per rendered element, update that handle in `render`,
and destroy it in `onDestroy`. The example uses `preserveStreamingHeight:
true`, supplies `isStreaming`, and normalizes display text through
`streamingMarkdownText` only while streaming. Pass the original source text
when finalizing. The helper is not an HTML sanitizer; keep the renderer's
sanitization enabled and render plain user text through `textContent`.

The Markdown example uses the `markdown-viewer` version pinned in
[package.json](../package.json). Its renderer dependency
is separate from the source-only core
and paged examples. The extracted CSS includes the full demo's footer
reservation selectors; a host must supply that markup to use those rules.
Import `integrations/collapse.css` when using the collapse helpers and supply
your own visual button styling. The
[UI verification report](reports/streaming-ui-verification-2026-09-13.md) records
installed-Safari composer and scoped-typography checks. Its tested scenarios
are integration evidence, not implicit guarantees for every renderer or style.

For an optional text fade, pass `streamingTrail: { durationMs: 1200 }` to the
Markdown viewer. It defaults off. The renderer owns text tracking, overlay
geometry, animation, reduced motion, and cleanup; the virtual-list runtime has
no trail option. Set the renderer option to `false` in `onUnmount` and restore
your configuration in `onMount`, including for retained offscreen rows.
Ending a stream lets active fades finish; disabling the option or destroying
the viewer clears them immediately. See the
[renderer API documentation](https://github.com/jveres/markdown-viewer#fade-newly-streamed-text)
for the full lifecycle and rendering-cost contract.

## Verification

The standalone browser regressions exercise public consumers in Chromium,
Firefox, and WebKit. They are correctness tests, not native performance or
installed-Safari evidence.

```sh
pnpm run check
pnpm test
pnpm run test:consumer
pnpm run test:regression -- --group=runtime --match=streaming-consumer
```

The [candidate review](reports/streaming-release-review-2026-09-13.md) records completed
API and browser verification with native-performance evidence and its limits.
The integration first shipped in the `v0.2.0` source tag; the
[release record](streaming-integration-plan.md) documents that milestone.
Later tags include subsequent runtime changes. When copying a tagged source
release, use its matching documentation and verify that it contains the APIs
you need; the current guide also covers APIs absent from `v0.2.0`.
Package publication remains out of scope; distribution uses the supported
source entry points above.
Additional standalone examples are not required.
