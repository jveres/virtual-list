# Companion and UI integration API

Use this reference for the optional APIs added by the streaming integration.
The runtime owns list geometry, scroll correction, following, and commit
timing. These helpers don't replace those responsibilities. You own source
data, rendering, product policy, and integration cleanup.

Import companions from `src/companions/index.ts` and UI helpers from
`integrations/index.ts`. These are source entry points, not published package
names. See the [consumer guide](streaming-consumer.md#supported-source-entry-points)
for distribution and styles, and the [runtime API](../README.md#public-api)
for list creation, updates, pinning, and following.

## Paging

`createPagedWindow<T, C, Row>(options)` returns `PagedWindow<T, C>`. `T` is
your source item, `C` your opaque cursor, and `Row` the projected runtime
item. Creation records `initial`; it doesn't submit those rows to the list.
Initialize the list from the same projected data.

`Page<T, C>` contains `items: readonly T[]`, `start`, and `end`. Each
`PageBoundary<C>` is `{ available: true, cursor: C }` or
`{ available: false }`. A cursor restores the immediately adjacent page;
an empty page doesn't imply exhaustion.

### Options

`PagedWindowOptions<T, C, Row>` defines source ownership and projection:

| Option | Contract |
| --- | --- |
| `list` | Requires runtime `updateWindow` and `state`; also requires `updateItem` when using live updates. |
| `initial` | Initial source page and both continuations. |
| `key(item)` | Stable source key, a string. |
| `maxItems` | Positive safe integer; invalid values throw at creation. The unique-source-item budget is soft. |
| `trim` | Omitted, `{}`, or `{ offscreenPin: "retain" }` retains pin protection. `{ offscreenPin: "evict" }` permits offscreen-pin eviction. `false` disables budget trimming. |
| `load({ edge, cursor, signal })` | Returns `Promise<Page<T, C>>`. `edge` is `"start"` or `"end"`; honor cancellation. |
| `project(items)` | Pure projection from retained source items to runtime rows. |
| `keysOf(row)` | Iterable of all source keys a row depends on, including separator or fragment dependencies. |
| `live` | Optional `{ project(item): Row, key(row): string }`. One source item must map to one stable-key row without changing other rows. |
| `anchor(rows)` | Optional runtime anchor request for a projected replacement; defaults to `"viewport"`. |
| `edgeSlots({ start, end })` | Optional `{ start?, end? }` slots for the same window commit; each supplied value is an `EdgeSlot` or `null`. |
| `onChange(items, rows)` | Called after ownership advances to the committed window. Not a per-token notification. |
| `onEvict(items, edge)` | Called after committed data eviction. Release data-owned caches here, not in element `onDestroy`. |

### Returned members

The pager owns all retained source edits. Don't bypass it with direct
`list.updateItem` or `list.setItems` calls while retaining the same pager.

| Member | Result and timing |
| --- | --- |
| `items` | Read-only latest retained source array, including submitted live updates. |
| `loading` | `true` while a load owns a request, including fetched work waiting to commit. |
| `canLoad(edge)` | Whether the continuation is available and the pager isn't disposed; not a guarantee that a concurrent load will be accepted. |
| `load(edge, context?)` | `Promise<boolean>`; `true` after commit. Unavailable, concurrent, canceled, or disposed loads return `false`. Pass the matching runtime `ReachContext`; the pager handles `complete()` and cancellation. |
| `refreshHead(page, signal?)` | `Promise<boolean>`; merges a connected overlapping head while preserving retained edits and tail cursors. Returns `false` for a disconnected/empty head, an active load, or canceled/no-op work. Not a source reset. |
| `updateItem(key, updater)` | `Promise<boolean>`; runs a synchronous immutable updater at the queued window boundary and resolves after commit. Source key must stay stable. Missing keys and unchanged references return `false`. |
| `updateItemLive(key, updater)` | `Promise<boolean>`; runs on the next microtask and resolves after runtime submission, **not** geometry commit. Requires `live`; source and row keys must stay stable. Missing keys, unchanged references, and disposal return `false`. |
| `reconcile()` | `Promise<boolean> \| null`; retries protected, over-budget trimming. Returns `null` when no attempt is needed, including `trim: false`. |
| `dispose()` | Returns `void`; cancels fetches and queued work. Dispose before replacing source ownership or disposing the list. |

`updateItemLive` delegates to runtime `updateItem`; it doesn't override the
list's `scrollingUpdates` policy. Configure `scrollingUpdates: "live"` for
height-changing tokens to render during a gesture. The pager's structural
operations still wait for idle.

Handle rejected operation promises, including
`paging.reconcile()?.catch(reportError)`. Invalid live configuration, changed
keys, and thrown adapters reject rather than returning `false`. Keep updaters
and adapters pure: invalidated page preparation can be retried against newer
source data without fetching the page again.

If live runtime submission throws, the pager cancels pending work and stops
accepting updates. Save `items` if needed, then recreate the pager/list; don't
assume an observer error rolled back a commit. Validation failures before
submission leave source ownership unchanged.

See [bounded paging](bounded-paging.md) for structural transaction errors,
cursor restoration, and refresh rules. See [live paging](streaming-consumer.md#live-paging)
for overlapping ownership and late-token reconciliation, and
[optional trimming](streaming-consumer.md#optional-trimming) for declarative
pin restoration. Trimming bounds retained pages, not your transcript archive.

There is no pager command that selects an arbitrary archived destination.
The application selects its source window and supplies the runtime command.
Use the [restoration sequence](streaming-consumer.md#restoring-an-evicted-destination)
to replace pager ownership before smooth navigation to an evicted latest page.

## Sticky headers

`createStickyHeaders(config: StickyHeadersConfig): StickyHeaders` creates
an overlay in `container` and immediately reads committed header geometry.
Create it after the list is available. Keep header keys in list order and
limit them to the current retained window.

| Config field | Contract |
| --- | --- |
| `container` | A `position: relative` ancestor of the viewport. The overlay attaches to its top; align that top with the intended sticky boundary. |
| `viewport` | The list's scroll element. |
| `headerKeys()` | Current ordered `string[]` of header keys. |
| `positionOf(key)` | Committed `{ top, height }` or `null`; use runtime `positionOf`. Supply keys with known geometry. |
| `renderHeader(slot, ordinal)` | Fill the overlay slot for a zero-based index in `headerKeys()`. Replace prior content; don't move the inline header out of its row. |
| `elementOf(key)` | Optional inline visual lookup. Return the pill/header content, **not** the runtime's measured row wrapper. |
| `observeScroll` | Defaults to `false`. `true` enables a native listener and animation-frame fallback for standalone use. |

Wire the runtime callbacks as follows, allowing for callbacks before the
companion has been created:

```ts
onState: (_state, viewport) => sticky?.refresh(viewport.scrollTop),
onViewport: (viewport) => sticky?.update(viewport.scrollTop),
```

`onState` has two arguments; its second argument supplies the viewport
snapshot. Don't pass the first argument as a scroll snapshot.

| Method | Contract |
| --- | --- |
| `refresh(scrollTop?: number): void` | Re-read ordered keys and committed geometry, then update the overlay and inline suppression. Without an argument, reads `viewport.scrollTop`. |
| `update(scrollTop: number): void` | Move against cached geometry. Pass the runtime snapshot; don't add a separate geometry sampler. |
| `setEnabled(enabled: boolean): void` | Initially enabled. Disabling hides the overlay and restores inline visuals. Re-enabling uses cached geometry; keep calling `refresh` on commits while disabled. |
| `destroy(): void` | Restore inline visuals, cancel the fallback frame, remove its listener, and remove the overlay. Stop callback forwarding before teardown. |

Import `src/companions/styles.css` or supply equivalent styling for
`vl-sticky-inline-hidden`. The provided CSS uses `visibility: hidden` on
the inline visual, preserving row size. The overlay is decorative
(`aria-hidden="true"`) and ignores pointer input; keep accessible content
in the inline row.

Geometry refresh doesn't force `renderHeader` to rerun when keys and
positions are unchanged. If only a label or theme-specific rendered markup
changes, recreate the companion or update host-owned overlay content. There
is no content-invalidation method. The companion doesn't manage loader-slot
placement or reserve placeholder space.

## Reading and replacement anchors

These functions read committed geometry; they don't scroll or replace data.
Both accept a list exposing `positionOf` and a viewport exposing read-only
`scrollTop` and `clientHeight`, in CSS pixels. Capture on a discrete action,
not in a scroll sampler or before an asynchronous fetch.

### `captureItemPlacement`

`captureItemPlacement(list, viewport, key: string, inset = 0)` returns
`ItemPlacement | null`. A missing key returns `null`.

| Field | Meaning |
| --- | --- |
| `offset` | Row top minus viewport scroll position, in CSS pixels. |
| `above` | Row bottom is at or above viewport coordinate zero. |
| `visible` | Row intersects the viewport below `inset`; not a guarantee that the entire row is visible. |
| `pinned` | Row top is within one CSS pixel of `inset`. This is a geometric test, **not** the runtime's persistent-pin or follow state. |

### `replacementAnchor`

`replacementAnchor(list, viewport, replacements, inset = 0)` returns an
`ExplicitAnchor` (`{ key, offset }`) or `undefined`. Supply an ordered
`readonly KeyReplacement[]`, with each pair `{ from: string, to: string }`.
You own the semantic mapping and must include the destination in the new rows.

The function chooses the first intersecting source row whose top is at or
below `inset`, preserving its offset. If none qualifies, it places the first
row clipped by the inset at that inset. Missing and offscreen source rows
are ignored; no visible candidate returns `undefined`. Array order determines
priority, not an inferred branch relationship or a geometry sort.

Pass the result as the replacement snapshot's `anchor`. If queued work must
be interrupted first, capture inside `updateWindow`'s synchronous updater
with `{ interrupt: true }`, after takeover. See the
[runtime boundary](bounded-paging.md#runtime-boundary) for cancellation and
commit behavior. Explicitly select a fallback anchor when no candidate exists.

## UI helpers

Import these separately from `integrations/index.ts`. They operate on DOM
layout or display text, don't load a Markdown renderer, and don't write the
list viewport's scroll position.

### `autosizeTextarea`

`autosizeTextarea(input: HTMLTextAreaElement, options: TextareaSizeOptions)`
returns `void`. Call after input changes, programmatic value changes, or
width changes; it doesn't install listeners or observers.

- `minHeight` and `maxHeight` are finite, positive border-box CSS-pixel bounds,
  with `maxHeight >= minHeight`. Invalid bounds throw `RangeError`.
- `container` defaults to `input.parentElement`. Supply an explicit element
  to hold that layout box during measurement, or `null` to disable the guard.
- Use `box-sizing: border-box`. The helper writes input height and vertical
  overflow, enabling scrolling at the maximum height. It restores the
  container's prior inline `min-height` after probing, including on failure.

### User-message collapse

`prepareUserMessageCollapse(row, id, initiallyExpanded, remember, width,
measurementContainer?)` returns `void` and prepares one new, detached row.
Call once per element, before returning it from `render`; don't call it on
an already mounted or previously prepared row.

- `row: HTMLElement` must contain
  `.message-content > .markdown-viewer > .markdown`. Missing content is a
  no-op. The supplied CSS also uses the host's `.message.user` classes.
- `id: number` produces `user-message-text-${id}` for `aria-controls`. Keep
  IDs unique across the document, including multiple list instances.
- `initiallyExpanded: boolean` comes from host-owned persistent state.
- `remember(expanded: boolean): void` stores changes from the toggle or
  focus-driven expansion. Keep it safe to call synchronously; schedule
  intent-bearing `remeasure(key, { anchor: "viewport" })` as appropriate.
- `width: number` is the row's measurement width in CSS pixels.
- `measurementContainer` defaults to `document.body`. Match the runtime's
  measurement ancestor, inherited typography, and CSS variables. Preparation
  temporarily attaches the row there and leaves it detached afterward.

Import `integrations/collapse.css`, supply your button appearance and a
computed pixel line-height, and preserve the helper's classes. The fixed
collapse limit is five text lines; it isn't a configurable generic truncator.
Preparation adds a toggle/footer and moves a sibling `.version-nav` into
that footer when present. `.is-editing` disables collapse while editing.

Wire the remaining functions to the element lifecycle:

| Function | Contract |
| --- | --- |
| `mountUserMessageCollapse(row): void` | Call from `onMount`; observes content size and defers collapse layout changes to an animation frame. Remounting reconnects observation. |
| `unmountUserMessageCollapse(row): void` | Call from `onUnmount`; disconnects observation and cancels pending frame work. Retains prepared state for remount. |
| `syncUserMessageCollapse(row): void` | Re-evaluate a connected prepared row after content or editing-state changes. Doesn't replace host-owned expansion state. |

All three functions are no-ops for unprepared rows. Disconnect observation
before discarding a row outside runtime-managed lifecycle. Keep renderer
destruction in `onDestroy`, separate from temporary unmounts. The
[UI verification report](reports/streaming-ui-verification-2026-09-13.md) covers
matching scoped measurement ancestors and installed-Safari composer behavior.
It doesn't guarantee arbitrary host CSS or delayed web-font behavior.

### Streaming display text

`streamingMarkdownText(markdown: string): string` removes trailing whitespace
and appends two newlines when the resulting text ends with an embedded
base64 Markdown image. Use it only for streaming display; preserve the raw
source for storage and final rendering.

`EMBEDDED_IMAGE_PATTERN: string` is a regular-expression source for the
syntactic embedded-image shape, not a `RegExp` instance, URL validator, or
sanitizer. Keep renderer sanitization enabled. See
[renderer integration contracts](streaming-consumer.md#ui-integration-contracts)
for CSS import order, cursor reservation, finalization, and renderer cleanup.
