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
Remaining verification is tracked in [the release plan](streaming-integration-plan.md).

For renderer integration, open `/examples/streaming-markdown/` and read
[its source](../examples/streaming-markdown/main.ts). It adds Markdown and an
autosizing composer without importing demo implementation files.

## Supported source entry points

This branch retains source-based distribution. Copy `src/` as a unit into a
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

Configure `pinning.match` to identify the prompt, `followBehavior: "smooth"`,
and `scrollingUpdates: "live"`. On send, submit the prompt and empty reply,
then await `scrollTo(promptKey, { align: "start", behavior: "smooth" })`.
A result of `false` means the command did not land, including interruption;
it need not cancel the response. Never write the viewport's scroll position
to compensate for streaming growth.

Use `scrollTo("end")` for explicit follow intent, including rearming after a
keep-start limit. Use `remeasure(key, { anchor: "viewport" })` for a user
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

Every retained page sharing that item receives the replacement. A live update
that invalidates detached page preparation causes the fetched page to be
retried against current data. It does not re-fetch that page. `onChange`
continues to describe committed window changes; it is not a per-token event.
Read `paging.items` for the latest submitted source state.

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
`replacementAnchor(list, viewport, pairs, inset)`. It prefers the first
candidate whose top is visible below the inset; otherwise it places the first
clipped candidate at that inset. Rows outside the viewport are ignored. The
helper reads geometry but never scrolls. Submit its result as the snapshot's
anchor. `captureItemPlacement` supplies offset, visibility, above-viewport,
and pinned-position facts for edit/send policy without duplicated arithmetic.

Capture immediately before the replacement. If an action may interrupt queued
paging first, capture inside `updateWindow`'s updater with `interrupt: true`,
after takeover. Do not cache these coordinates across asynchronous fetches.

## UI integration contracts

The optional helpers own UI layout, not virtual-list geometry:

- `autosizeTextarea(input, { minHeight, maxHeight, container? })` holds the
  composer box while probing the input. This avoids transient viewport growth
  that can clamp WebKit's scroll position. Bounds are positive border-box
  heights; use `box-sizing: border-box` on the textarea.
- `prepareUserMessageCollapse` prepares the demo-compatible chat markup at
  the supplied viewport width. Its optional measurement ancestor must match
  the runtime's measurement container and inherited typography. Call it before
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

The Markdown example uses the repository's `markdown-viewer` version
(`v0.1.3`). Its renderer dependency is separate from the source-only core
and paged examples. The extracted CSS includes the full demo's footer
reservation selectors; a host must supply that markup to use those rules.
Import `integrations/collapse.css` when using the collapse helpers and supply
your own visual button styling. The
[UI verification report](reports/streaming-ui-verification-2026-09-13.md) records
installed-Safari composer and scoped-typography checks. Its tested scenarios
are integration evidence, not implicit guarantees for every renderer or style.

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
Follow [the release plan](streaming-integration-plan.md) for remaining
merge/release actions. Additional standalone examples aren't required.
