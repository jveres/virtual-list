# Runtime performance review — September 14, 2026

> Static review record, not a measurement. Every item below is a candidate
> that needs a Firefox capture or a repeated CPU comparison before it changes
> `src/`. See the [Firefox workflow](../firefox-profiling.md) and the
> [release plan](../streaming-integration-plan.md) for current status.

This review reads every file under `src/` at commit `6fc4434` and looks for
work the runtime repeats, allocates, or forces in its hot paths. It builds on
the September 10–13 investigations and doesn't re-propose the experiments
they rejected. No source changed. The candidates are ordered by the size of
the cost they address, using the earlier captures as the evidence for where
time goes.

## Scope and method

The review covers the orchestrator, the geometry kernel, premeasurement, the
settle controller, paging, and the companions. Demo and integration code is
out of scope; where a host pattern matters, it's named as context only.

Three earlier findings anchor the priorities:

- The [September 13 scroll audit](runtime-scroll-audit-2026-09-13.md) found
  no scroll or wheel handler above 1.5 ms. The largest runtime cost during
  active streaming was detached measurement of the growing, unmounted reply
  (729 and 858 samples in `measureMany`), plus an 8 ms cycle-collection
  slice inside the longest awake interval.
- The [measured proposals](measured-performance-proposals.md) record that a
  staged 80-row append completes in roughly 190 ms, dominated by frame
  scheduling rather than validation work.
- The [core audit](core-runtime-audit.md) measured structural commits at
  10,000 items in the 7–8 ms range for declared rows and prepends.

Rejected experiments that this review doesn't reopen: cached wheel-edge
geometry, skipping the post-commit viewport read, skipping held-row
remeasurement, deferred token measurement, slot containment, bounded element
retention, snapshot diff caching, DPR and canvas-write guards, the
normal-flow window, and known-height tree construction.

## Candidate 1: keep an unmounted streaming row connected between tokens

This is the only candidate aimed at the largest measured cost. It changes the
measurement root's lifetime policy, not the commit contract.

`measureMany` in `src/premeasure.ts` (lines 177–191) attaches every element
to the hidden root, reads one rectangle per element, and detaches them all in
`finally`. When a reply streams while the user has scrolled it out of the
overscan window, every token takes this path: `prepareChanged` renders in
place on the detached element (`src/virtual-list.ts:1347–1354`), `liveCommit`
or the idle commit adds it to `commitMeasured`, and `measureDetached` calls
`measureMany` for that single row. Engines drop the layout tree of a removed
subtree, so each token rebuilds style and layout for the whole reply — tables,
code blocks, and math included — from scratch. A mounted streaming reply, by
contrast, is measured in place with incremental layout. Scrolling away from
a stream therefore makes each token more expensive, not less.

Proposed change: leave the elements of the last `measureMany` call inside the
hidden root until the next call replaces them, the row mounts (`mountRow`
moves the element into its slot, which removes it from the root), or the
row is destroyed. The staged path already relies on this effect: "Keeping the
rows connected between batches preserves the browser's layout work"
(`src/premeasure.ts:113–117`).

Points to verify before retaining it:

- Connected but hidden elements are `isConnected`. Hosts must keep using
  `onMount` as the mount signal; check the streaming markdown adapter and the
  collapse module for `isConnected` reads.
- Images inside a resident element can load and decode while it's hidden.
  That's closer to the mounted behavior than today's, but the height then
  changes between tokens, so confirm the settle re-read still lands once.
- The root has `height: 0`, `overflow: visible`, and `visibility: hidden`, so
  a resident doesn't affect page layout, painting, focus, or find-in-page.
  Confirm no accessibility tree exposure in Firefox and Safari.
- Measure with the streaming fixture after scrolling one viewport above the
  reply. Compare `measureMany` samples and the longest awake interval.

## Candidate 2: stop allocating every page per live token

The paged window's live lane copies the entire retained source on each
token. It isn't slow in wall-clock terms, but it's the runtime's largest
per-token garbage source, and streaming captures showed cycle-collection
slices inside the longest awake intervals.

`updateItemLive` in `src/paging.ts` performs, per token:

- `items.findIndex` over the flat window (line 227).
- `adapter.project(previous)` solely to compare row keys (line 237), a full
  projection of the previous item.
- `pages.map(page => ({ ...page, items: page.items.map(...) }))` (lines
  241–246), which reallocates every page object and every page's item array,
  including pages that don't contain the key.
- `items.map(...)` for the flat window (line 249).

The streaming demo feeds every token through this function
(`demos/streaming/streaming.ts:1278`), so a 3-page, 160-item window allocates
four arrays and three page objects per token.

Proposed change: locate the owning page or pages by key and copy only those
(`page.items.with(index, next)`), replace the flat window with a single
`items.with(index, next)`, and cache the previous row key instead of
projecting the previous item. A `Map<string, number>` from key to flat index,
rebuilt in `onCommit`, removes the linear scan. Semantics are unchanged:
every owner still receives the same replacement. Verify with the paging
unit tests and the chat invariants suite.

## Candidate 3: let the staging budget, not a row count, size each frame

The incremental `updateWindow` path builds rows across animation frames so
the old window stays interactive. Its per-frame cap is stricter than its
time budget, which is why simple appends take longer than they need to.

`stageFrame` (`src/virtual-list.ts:2496–2512`) renders until either eight
rows are built or 3 ms have elapsed. Simple rows render in well under
0.1 ms each, so most frames stop at eight rows with almost the whole budget
unused. An 80-row page therefore needs at least ten frames before its
measurement frame, which matches the measured ~190 ms completion at 60 Hz.

Proposed change: keep the 3 ms budget and raise or drop the row cap (a cap of
64 keeps a bound for pathological renderers). The budget already protects the
frame from heavy rows. The 8-row threshold that decides whether to stage at
all (line 2584) can stay. Measure with the staged append fixture; the
expected effect is fewer frames, not less CPU.

## Candidate 4: consolidate the O(N) passes of a structural commit

A structural `setItems` walks the item list about a dozen times. With paging
keeping N in the hundreds this costs well under a millisecond, so this is a
maintenance-grade cleanup rather than a user-visible win. It matters only for
hosts that don't page.

Passes per structural commit at the current source:

| Pass | Location |
| --- | --- |
| Snapshot copy | `setItems` (`virtual-list.ts:2708`) |
| Key map and declared map | `indexItems` (`snapshot.ts:42–64`) |
| Bracketed key array | `prepare` (`virtual-list.ts:1224–1230`) |
| Diff walk over all keys | `prepare` loop (`virtual-list.ts:1402–1431`) |
| Key comparison and index map rebuild | `adoptItems` (`virtual-list.ts:2716–2732`) |
| Key comparison | `sameKeysAsCommitted` in `applyPrepared` (mid-phase) |
| Key comparison again | `sameKeysAsCommitted` in `commitBody` (line 1750) |
| Key set for removal scan | `commitBody` (line 1753) |
| Removal scan over `rows` | `commitBody` (lines 1754–1758) |
| Key copy, index map, size array, tree build, height sweep | `Geometry.setKeys` (`geometry.ts:301–358`) |
| Prefix comparison for end mode | `resolveMode` (`geometry.ts:453–457`) |
| Second `indexItems` of the same snapshot | `updateWindow` run (line 2579) |
| Source copy for the updater context | `windowUpdateContext` (line 2382) |
| Anchor-prefix walk and optional index map | `confinedBelowAnchor` (lines 2901–2932) |

Positioned snapshots add `preparePositioned` and the `PositionedGeometry`
constructor's per-lane sort on every full prepare, even when positions are
unchanged, and `updateItem` in positioned mode always takes the full
snapshot path (`virtual-list.ts:2796–2800`).

Proposed change: carry the key set and index map that `indexItems` builds on
the prepared snapshot, so `adoptItems`, the removal scan, and
`Geometry.setKeys` reuse them; compute the "old keys are a prefix" fact once
in `setKeys` and expose it to `resolveMode`; and let `updateWindow` pass its
`indexItems` result into `prepare`. Verify with the 10,000-item boot and
prepend comparisons from the core audit, expecting single-digit percent
changes at most.

## Candidate 5: a geometry revision for companions

Hosts can't tell a mounted-range publication from a geometry commit, so they
re-read positions on every window change. Adding one integer to the public
state removes that guesswork.

`onState` fires whenever a state field changes, including `start` and `end`
as the window slides, and after every commit. The chat demos call the sticky
header companion's `refresh` from `onState`
(`demos/streaming/streaming.ts:3570`, `demos/chat-history/chat-history.ts:415`).
`refresh` (`src/companions/sticky-headers.ts:228–253`) calls the host's
`headerKeys`, maps every header through `positionOf`, and compares the
arrays, on every window change during a scroll even though committed
geometry is immutable between commits. The runtime already tracks
`geometryEpoch` for this exact distinction (`virtual-list.ts:596`).

Proposed change: publish the epoch as a `revision` field on
`VirtualListState`, and let `refresh` accept it (or read it) so an unchanged
revision skips the position re-read and only updates the pinned position.
This is an additive API change. The cost today is small — tens of
microseconds for a hundred headers — so measure it only as part of the
scroll-handler p95 in the rich chat capture.

## Candidate 6: small per-scroll-event allocations and timer churn

Each scroll event allocates a handful of short-lived objects and, on Firefox
and Safari, clears and re-arms a timer. The measured handler cost is already
low, so treat this as a list to revisit only if a garbage-collection pause is
ever attributed to scrolling.

- `guarded` allocates a scope array and pushes it on `liveScopes` for every
  scroll event (`virtual-list.ts:775–778`); the array is almost always empty.
- `viewportState` allocates a viewport object per event (line 717), and
  `reconcileWindow` allocates a new memo object whenever the position moved
  inside an unchanged range (lines 1980–1984 and 2081–2085) instead of
  updating the existing one.
- `publish` allocates three closures per event for `notifyCommitted` (lines
  2149, 2158, and 2162).
- `liveCommit` enters `guarded` before discovering that no dirty row sits at
  or below the anchor (lines 1610–1618); the early exit can run first.
- `scheduleWheelScrollEndFallback` clears and creates a timeout on every
  scroll event under the wheel strategies (`scroll-settle.ts:581–589`). A
  timestamp check inside one live timer would arm it once per gesture.

> **Warning:** The settle controller's timing was pinned across five rounds
> of real-browser iteration. Any change to the timer pattern must re-run the
> Firefox, Chrome, and Safari edge battery and the edge-gesture traces, even
> when the intended firing time is identical.

## Host-side note: token coalescing

The runtime commits synchronously per `updateItem`, and deferred token
measurement was rejected because it would change that contract. A host can
still coalesce tokens itself: buffer text that arrives between animation
frames and submit one `updateItem` per frame. The basic examples submit each
chunk with a 12 ms timer (`examples/streaming-markdown/main.ts:120–126`),
which sometimes commits twice per frame, each with its own layout and
measurement. The consumer guide doesn't mention this today; it's a
documentation addition, not a runtime change.

## What the review didn't find

The scroll and glide hot paths hold up under reading. Window reconciliation
memoizes on position, height, and epoch; the Fenwick lookups are
logarithmic; surviving stacked rows are skipped when mounting entrants;
`publish` rebuilds state only when a field changed; commits read every
height before writing any slot; and detached rows share one layout per
batch. The glide re-reads `scrollTop` and `clientHeight` a few times per
frame on a clean layout, which is microseconds. None of these justify a
change.

## Next steps

Capture candidate 1 first: it targets the one cost the profiles attributed
to the runtime, and it's a small change. Candidates 2 and 3 are low-risk and
verifiable with existing unit and browser suites. Candidates 4 through 6 are
cleanups to schedule alongside other work in the same files. Keep the demos
unchanged; the host-side note belongs in the consumer guide.
