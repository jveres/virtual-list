# Bounded paging

Use `createPagedWindow` from `src/companions/index.ts` to retain a moving window of
source pages. The gallery is the first integration: it keeps a soft budget
of 480 photos and restores discarded pages when you scroll back.

## Runtime boundary

`list.updateWindow(update, signal)` evaluates your synchronous update when
scrolling settles, or immediately while idle. Where the browser anchors
natively, it can also commit mid-gesture, away from the scroll edges, unless
the update names an `"end"` or explicit anchor. Its context contains the latest
submitted `items` and the committed `protectedItems`: visible items, overscan,
and pinned or explicitly requested anchors. Edge slots are excluded.

The third argument supports `protectPin: false` for optional offscreen-pin
eviction. Visible/overscan rows and explicit targets remain protected, and
an unsafe proposal resolves `false`. The default retains pin protection.

Return `{ items, anchor?, edgeSlots?, onCommit? }` to commit one snapshot.
Additions, removals, and optional edge-slot changes share the same geometry
commit and anchor-preserving scroll write. The default anchor is `viewport`.
Return `null` for no change. The promise resolves `true` after commit, or
`false` for a no-op, cancellation, or disposal. Preparation errors reject it.
Observer errors also reject it, but don't undo a completed commit: ownership
bookkeeping and queued work finish before the error is reported. `onCommit`
runs for the committed snapshot even if `onState` throws.
Declared-height rows render lazily. If a newly visible row fails to render,
the runtime completes geometry, publication, and ownership bookkeeping before
reporting the error. That row's space remains reserved and rendering retries
on the next window reconciliation; other visible rows still render.
Aborting the signal cancels work that hasn't started, including fetched data
waiting for a gesture to settle.

For explicit layout controls, pass `{ interrupt: true }` as the third argument
to `updateWindow`. It stops scrolling and commits waiting work before invoking
your updater. Build the new layout inside that updater from the latest source
data. A snapshot built before interruption can otherwise overwrite a page that
the interruption just committed. Routine background paging must keep the
default settle behavior.

Explicit navigation can instead use `{ interrupt: "commit" }`. Existing motion
continues while new rows prepare in bounded frame slices. Once ready, the
command stops that motion and commits its replacement. Fresh input cancels the
preparation. The updater runs before takeover, so this mode is for a deliberate
replacement from authoritative source data; cancel any competing page requests
first. A structural change or width change during preparation resolves `false`.

The updater must remain synchronous. Fetch before scheduling it. Don't mutate
the context arrays or synchronously dispatch input from the updater.

`onState(state, viewport)` also supplies the runtime's existing viewport
snapshot (`scrollTop` and `height`). Combine it with `positionOf(key)` for
geometry-based companions without forcing DOM measurements after mounting.

For message selection across loaded windows, see
[conversation-tree navigation](conversation-tree-navigation.md). It records
the distinction between a clamped keyed jump and a pin, including short and
long final messages and atomic removal of the leading loader slot.

## Paging companion

The companion owns the contiguous retained source pages, deduplicates incoming
keys, and trims whole pages from the edge opposite a load. It won't evict a
page containing a protected source key, and it keeps at least one page. The
budget is therefore soft, not a hard cap that can remove visible content.

Set `trim: false` to disable budget eviction, or set
`trim: { offscreenPin: "evict" }` to permit eviction of an offscreen pin.
Omitting `trim`, passing `{}`, or choosing `offscreenPin: "retain"` preserves
the default. See [optional trimming](streaming-consumer.md#optional-trimming)
for pin restoration, source ownership, and soft-budget limits.

Configure these adapters for your content:

- `key(item)` supplies stable source identity.
- `project(items)` creates runtime rows. Use identity for a simple feed or
  chat. A gallery converts photos into justified rows or whole-photo masonry
  items.
- `keysOf(row)` identifies every source item the row depends on. Include
  dependencies of separators, fragments, or layout guard pages.
- Optional `anchor(rows)` maps the current reading point to the new layout.
  Use it when a boundary row changes internally during paging.
- `load({ edge, cursor, signal })` fetches the adjacent source page.
- `onChange(items, rows)` receives the committed retained window.
- `onEvict(items, edge)` releases data-owned caches after commit. This differs
  from `onDestroy`, which describes an element's lifetime.
- Optional `edgeSlots({ start, end })` returns loader slots for the same commit.

Pass the matching runtime `ReachContext` to `paging.load(edge, context)`.
The companion handles `complete()` and cancellation. It serializes loads;
concurrent requests return `false`. Handle rejected load promises in your UI.
A pending trim doesn't block a load. The load supersedes that trim and merges
against the latest retained pages at commit, then trims its opposite edge.
Call `paging.reconcile()` from `onState` and after a load to retry a protected,
over-budget tail. It returns `null` without allocating when no work is needed,
or a promise for a scheduled attempt. Handle errors with
`paging.reconcile()?.catch(reportError)`. Unchanged ranges don't cause repeated
trim attempts.

Call `paging.dispose()` before replacing the source and when disposing the
list. It cancels outstanding fetches and queued commits, so late responses
cannot enter the replacement source. Construct the replacement companion with
the same initial data you submit to the list.

For explicit navigation to an evicted destination, follow the
[restoration sequence](streaming-consumer.md#restoring-an-evicted-destination).
`scrollTo("end")` targets the retained runtime window, not your archive.
The sequence separates source replacement, its starting anchor, and the
subsequent scroll command. It does not change routine paging transactions.

Update retained source items through `paging.updateItem(key, update)`:

```ts
await paging.updateItem(messageId, (message) => ({
  ...message,
  body: message.body + chunk,
}));
```

The synchronous updater receives the latest retained source item, including
submitted live edits, must return an immutable replacement with the same key,
and runs at the runtime's commit boundary. Queued edits and loads preserve
each other's changes. Missing keys and unchanged object references resolve
`false`; key changes reject. Edits don't evict pages. Don't bypass page
ownership with direct `list.updateItem` or `list.setItems` calls.

For one-source-item/one-row streaming updates, configure the optional `live`
adapter and use `paging.updateItemLive`. This submits through the runtime's
live row path rather than waiting for scroll settle. Its promise describes
submission, not geometry commit; structural projection changes still use
`updateItem`. See [live paging](streaming-consumer.md#live-paging) for source
ownership, preparation retries, failure recovery, and eviction semantics.

## Offscreen-pin trimming decision

The user approved optional offscreen-pin trimming on September 13, 2026,
as SI-02 of the [integration plan](streaming-integration-plan.md). It was
implemented in `732e143`; the
[candidate review](reports/streaming-release-review-2026-09-13.md) records
verification on `9af905c`. Approval of this design isn't release approval.

Without the opt-in, `updateWindow` protects the persistent pin even when
it is outside the visible and overscan window. A contiguous, whole-page
pager can therefore retain the latest pinned page and every intervening
page while the reader browses older history. The same need occurs in a
live event viewer: keep the current event pinned while following, but
permit its page to leave memory while reading older events.

The alternatives don't preserve the required behavior:

- `pinning: false` avoids that retention but removes prompt/event pinning.
- Ignoring `protectedItems` in the pager cannot distinguish a pin from a
  visible row or an explicit navigation target.
- Replacing through `setItems` bypasses the pager's idle transaction and
  staged-preparation safeguards.

The accepted extension adds only `protectPin` to the runtime transaction.
Budget and eviction policy remain in the optional pager. Opted-in proposals
must retain visible/overscan rows and explicit targets, including a target
returned by the updater. Unsafe synchronous proposals resolve `false`;
staged proposals revalidate protection before commit. Removing the pin and
its trailing reserve belongs to that same anchor-preserving commit, not
host-side scroll correction. No second scroll controller or per-frame
retention scan is introduced.

The [optional-trimming contract](streaming-consumer.md#optional-trimming)
defines the three policies, soft budget, declarative pin restoration without
navigation or follow rearming, and the lack of imperative-pin restoration.
The [live-paging contract](streaming-consumer.md#live-paging) covers archived
tokens and source replacement. These maintained contracts replace the
original proposal's duplicated API description; the integration plan retains
its SI-02a through SI-02d completion record.

## Cursor and refresh semantics

Each `Page<T, Cursor>` supplies `items`, `start`, and `end`. Each boundary is
either `{ available: true, cursor }` or `{ available: false }`. Cursors are
opaque and may be strings, numbers, or structured bookmarks. Don't infer
exhaustion from an empty or entirely deduplicated page: the explicit boundary
advances even when no new items arrive.

A boundary must restore the immediately adjacent page. If your source cannot
restore an evicted edge, mark that continuation unavailable. The companion
doesn't retain an unbounded cursor history or synthesize reverse cursors.

The feed demo's Bluesky and Lemmy adapters distinguish pagination from head refresh
in practice: their top request fetches the latest head, not the page just
before the retained window. Don't pass that refresh operation as a restoration
cursor. Use a separate refresh/reset flow or a source-specific replay bookmark.
The companion doesn't automatically drain empty pages or retry failures;
your source/UI controls that policy.

## Gallery continuity and costs

The gallery advances compact page checkpoints from its deterministic photo
generator. It retains only row-group state and per-column weights and counts,
not discarded photo arrays or a full-history layout. Surviving photos keep
their original grouping and column ownership at each responsive density.
The retained layout begins at a complete row or at the first retained masonry
card's top. A shortened first band preserves every retained card's top, and
later bands keep their absolute boundaries. A photo-based anchor handles that
boundary band's expansion during top loading, including when the viewport top
sits inside the loader. Band edges align with the runtime's device-pixel grid
to avoid a gap after a shortened first band. A guard page remains before
protected content. Loading backward restores discarded history.

Image priorities use committed row positions and each drawing's clipped
offsets, not DOM bounds. Both layouts share this path; empty image batches and
unchanged loader metrics avoid unnecessary allocation and DOM writes.

Within a density, resizing reuses the cached plan. Checkpoints cover every
supported density, so changing density doesn't replay the prefix. Forward
paging advances only the newly discarded prefix; the cache holds at most 16
checkpoints, not the full navigation history. Recent backward paging reuses
those checkpoints. Revisiting older, evicted checkpoints reconstructs from
the nearest cached predecessor or from the source origin. This fallback isn't
constant-time. Recreate the history adapter if source aspects change.

A remote gallery can supply `LayoutCheckpoint` with its page cursor through
the shared layout manager's checkpoint provider. It doesn't need the indexed
synthetic-history adapter. Feed and chat adapters don't need this geometry
reconstruction.

Run `pnpm run test:regression -- --group=gallery --match=paging` to check
repeated forward/backward loads, retained counts, mounted nodes,
reading anchors, and resizing in Firefox.
