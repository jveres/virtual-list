# Bounded paging

Use `createPagedWindow` from `src/paging.ts` to retain a moving window of
source pages. The gallery is the first integration: it keeps a soft budget
of 480 photos and restores discarded pages when you scroll back.

## Runtime boundary

`list.updateWindow(update, signal)` evaluates your synchronous update when
scrolling settles, or immediately while idle. Its context contains the latest
submitted `items` and the committed `protectedItems`: visible items, overscan,
and pinned or explicitly requested anchors. Edge slots are excluded.

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
waiting for a gesture to settle. This API waits even in `live` mode.

For explicit layout controls, pass `{ interrupt: true }` as the third argument
to `updateWindow`. It stops scrolling and commits waiting work before invoking
your updater. Build the new layout inside that updater from the latest source
data. A snapshot built before interruption can otherwise overwrite a page that
the interruption just committed. Routine background paging must keep the
default settle behavior.

The updater must remain synchronous. Fetch before scheduling it. Don't mutate
the context arrays or synchronously dispatch input from the updater.

`onState(state, viewport)` also supplies the runtime's existing viewport
snapshot (`scrollTop` and `height`). Combine it with `positionOf(key)` for
geometry-based companions without forcing DOM measurements after mounting.

## Paging companion

The companion owns the contiguous retained source pages, deduplicates incoming
keys, and trims whole pages from the edge opposite a load. It won't evict a
page containing a protected source key, and it keeps at least one page. The
budget is therefore soft, not a hard cap that can remove visible content.

Configure these adapters for your content:

- `key(item)` supplies stable source identity.
- `project(items)` creates runtime rows. Use identity for a simple feed or
  chat. A gallery converts photos into justified rows or masonry bands.
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

Update retained source items through `paging.updateItem(key, update)`:

```ts
await paging.updateItem(messageId, (message) => ({
  ...message,
  body: message.body + chunk,
}));
```

The synchronous updater receives the latest committed item, must return an
immutable replacement with the same key, and runs at the runtime's commit
boundary. Queued edits and loads preserve each other's changes. Missing keys
and unchanged object references resolve `false`; key changes reject. Edits
don't evict pages. Don't edit projected rows through `list.updateItem` or
replace them through `list.setItems`: those APIs don't update page ownership.

## Cursor and refresh semantics

Each `Page<T, Cursor>` supplies `items`, `start`, and `end`. Each boundary is
either `{ available: true, cursor }` or `{ available: false }`. Cursors are
opaque and may be strings, numbers, or structured bookmarks. Don't infer
exhaustion from an empty or entirely deduplicated page: the explicit boundary
advances even when no new items arrive.

A boundary must restore the immediately adjacent page. If your source cannot
restore an evicted edge, mark that continuation unavailable. The companion
doesn't retain an unbounded cursor history or synthesize reverse cursors.

Bluesky and Lemmy on `main` distinguish forward pagination from head refresh
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

Run `node scripts/gallery-paging-regression.mjs` against a Vite server on port
4193 to check repeated forward/backward loads, retained counts, mounted nodes,
reading anchors, and resizing in Firefox.
