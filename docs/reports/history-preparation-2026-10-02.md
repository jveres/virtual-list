# Large-history preparation, October 2, 2026

Keep a larger preparation slice while the list is at rest. Against v0.4.15's
eight-row cap, preparing 5,000 measured rows falls from 10.46 seconds to
2.66–2.67 seconds, with 64–66% less sampled preparation CPU. Geometry stays
exact. The large case still has one preparation frame gap above 25 ms, with
a similar 33–34 ms maximum. This improves readiness and total work, not the
worst pause or physical presentation.

The separate TanStack reference confirms that estimated geometry can defer
almost all initial content work. Its initial extent is 500 px too large in
this fixture, so that saving does not preserve the current exact-geometry
contract. Keep the reference as development-only tooling, without adding an
estimated mode to the production runtime.

## Exact preparation change

The baseline reveals a concrete scheduling cost: each at-rest frame prepares
at most eight fresh rows, even when their rendering is inexpensive. At 5,000
rows, preparation occupies about 625 slices. Every slice also performs a warm
layout read. Its total sampled preparation CPU is 2.45 seconds during a
10.57-second marked phase, including final settling.

[`virtual-list.ts`](../../src/virtual-list.ts) now permits up to 32 fresh rows
per slice when the scroll phase is idle and no idle-callback deadline is in
use. The existing 3 ms rendering/insertion budget remains. Active scrolling
and idle callbacks retain the eight-row limit. A staged row still yields
after each iterator step. The threshold for scheduling a large window update,
atomic reveal, authoritative height reads, cancellation, and width invalidation
are unchanged.

| Exact-mode measure | Eight-row baseline | 32-row candidate | Identical candidate repeat |
| --- | ---: | ---: | ---: |
| 1,000 rows: preparation completion | 2,117 ms | 555 ms | 546 ms |
| 1,000 rows: completion plus quiet-frame check | 2,231 ms | 674 ms | 668 ms |
| 1,000 rows: preparation CPU | 310.11 ms | 155.79 ms | 149.99 ms |
| 1,000 rows: largest preparation frame gap | 18.16 ms | 18.26 ms | 18.16 ms |
| 5,000 rows: preparation completion | 10,460 ms | 2,660 ms | 2,672 ms |
| 5,000 rows: completion plus quiet-frame check | 10,565 ms | 2,768 ms | 2,780 ms |
| 5,000 rows: preparation CPU | 2,449.77 ms | 836.48 ms | 884.41 ms |
| 5,000 rows: largest preparation frame gap | 33.76 ms | 33.44 ms | 33.94 ms |
| 5,000 rows: synchronous reflow markers, total | 1,365.54 ms | 574.65 ms | 617.13 ms |

Preparation frame gaps above 25 ms stay at zero for 1,000 rows and one for
5,000 rows. Fewer slices reduce repeated preparation/layout work, while each
slice does more. The 1,000-row candidate has a longest synchronous reflow marker
of 23.84 ms, versus 18.32 ms in the repeat and 5.15 ms at baseline. Its longest
refresh tick is 25.32 / 19.50 ms, versus 20.55 ms at baseline. The frame sampler
alone would hide that distinction. These measurements do not justify raising
the cap further: the 3 ms rendering budget excludes the final warm layout read.

At every checkpoint, exact total extent and visible-row offsets match an
independent full-layout oracle. Four distant key jumps, width reduction from
1,100 to 650 CSS pixels, and end/start navigation retain coverage, order,
reading anchors, and accurate targets. The 5,000-row resize still settles in
2,884 ms in all three runs; it is not accelerated by this change. Retained
window storage also stays near 72.9 MiB after requested collection. There is
no retained-memory saving.

## Estimated reference

The reference uses pinned `@tanstack/virtual-core` 3.17.11 with a small
imperative DOM adapter. Both controls retain the same source items, use the
same renderer and CSS, cache each visited row by key, and use zero overscan.
The deterministic rows contain two to eight wrapping paragraphs and four code
lines. They exercise DOM/layout preparation, not Markdown parsing or network
loading. Module initialization precedes all timed phases.

A metadata-only character-width formula estimates each row. An independent
oracle renders the complete history only after all timed work. No oracle
height feeds the estimates. The adapter uses a translated block, element
measurements, stable keys, and explicit reading-anchor restoration on width
changes. This is a reference integration, not an application migration.

| Initial preparation | Exact baseline | Final estimated reference |
| --- | ---: | ---: |
| 1,000 rows: operation / quiet-frame completion | 2,117 / 2,231 ms | 7 / 118 ms |
| 5,000 rows: operation / quiet-frame completion | 10,460 / 10,565 ms | 3 / 119 ms |
| 1,000 rows: sampled preparation CPU | 310.11 ms | 5.14 ms |
| 5,000 rows: sampled preparation CPU | 2,449.77 ms | 4.24 ms |
| Rows initially rendered and measured | Entire history | 4 |
| Initial total-extent error | 0 px | +500 px |

The formula happens to fit this synthetic content closely. It still leaves
a 500 px prefix error at distant targets before width invalidation. The final
reference lands those targets within 0.14 px and preserves the reading anchor
after resize. Its narrow-width estimate matches this fixture's oracle; that is
not evidence that arbitrary rich content can be predicted exactly. Only 19 / 23
rows are rendered during the whole reference exercise. Unvisited content work
is deferred, not made cheaper.

The first estimated trial lacks explicit width-anchor restoration and changes
the first visible row from 499 to 391, or 2,499 to 1,960. That exposed an adapter
requirement, not a TanStack defect. The final trial fixes it and passes the
same all-engine checks. The first trial reports cached snapshot entries;
the final trial counts distinct measured row indexes instead, because matching
estimates need not populate that cache. Do not compare those two counters.

[TanStack's API documentation](https://tanstack.com/virtual/latest/docs/api/virtualizer)
describes incremental measured extents and estimated unvisited rows. It also
describes measurement snapshots and scroll corrections. Those mechanisms are
useful when a host accepts provisional geometry. They cannot silently replace
this repository's measured/declared height promise. The pinned dependency is
used only by the benchmark fixture and regression, never by the runtime or
demos. Documentation and package metadata were checked on October 2, 2026.

The oracle allocates a complete temporary DOM after timing. That deliberately
permits accurate geometry validation but contaminates whole-run memory peaks.
Reported layout arena storage remains after disposal even though DOM storage
falls near the empty-page level. Do not interpret that as retained source rows,
or use this experiment to claim an estimated-mode peak-memory saving.

## Conditions, reproduction, and validation

All captures use revision `33fb455` plus recorded patches and hashes, installed
Firefox 157.0 build `20260924084938`, macOS 27.0, fresh temporary profiles and
application data, and closed DevTools. LU28R55 is 1,920 × 1,080 logical pixels,
DPR 2, 60 Hz. Window geometry is 1,900 × 1,049 at `(1450, 31)`, with a
1,900 × 964 content area. Frame samplers read timestamps only. CPU covers the
selected content main thread from 2 ms samples. Markers can overlap; do not
add them to CPU. Profiling affects timings. API jumps do not test native
gesture release, real momentum, or smooth physical presentation.

The estimated-geometry comparison uses three captures: exact baseline,
estimated prototype, and corrected estimated adapter. The separate preparation
cap comparison reuses that unchanged exact baseline and adds a candidate and
identical-source repeat. No completed comparison is expanded for extra samples.
The intervening fixture changes affect the estimated adapter and out-of-phase
validation, not the exact workload. The final candidate and repeat source
hashes are identical.

Compact evidence, source patches, commands, and geometry remain under:

- `browser-artifacts/history-exact-baseline/run-eztdAr/`
- `browser-artifacts/history-estimated/run-mOiFPe/`
- `browser-artifacts/history-estimated-anchored/run-uNKYGu/`
- `browser-artifacts/history-exact-rest32/run-yKZ1No/`
- `browser-artifacts/history-exact-rest32-repeat/run-C3U9PC/`

All captures complete with empty cleanup-error arrays and retain only summary,
reproduction metadata, and source patch files. The
[history workflow](../memory-profiling.md#compare-exact-and-estimated-history-preparation)
explains how to restore the old baseline and run each control.

Static checks, a direct strict check of the edited unit test, all 5,656 unit
tests, 195 portable profiler checks, and both isolated consumer builds pass.
History, staged-row, and runtime-boundary regressions pass in Firefox, Chromium,
and WebKit. Paging structures, short-list paging, and mid-stream paging also
pass in all three engines. The new unit case verifies that an expensive render
still yields
under the time budget; cancellation and stale-width tests verify destruction
against the rows actually prepared rather than a hard-coded slice count.
