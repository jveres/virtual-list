# Core and runtime performance audit

The September 11, 2026 audit of baseline `9c30774` retains two changes:
indexed positioned-anchor lookup and boundary-only stacked-row entry work.
It also evaluates architectural simplifications. A known-height tree-build
prototype improves a kernel benchmark but not real list operations, so it
is not retained. No public list API or scroll-settle timing changes.

## Measurement method

Measurements use installed Firefox 155.0.1 with fresh temporary profiles,
closed DevTools, and the external LU28R55: 1920 × 1080 logical pixels at 2×
scaling and 60 Hz. Browser content is 1900 × 965; the isolated list viewport
is 1000 × 700. The original source is preserved in an ignored baseline copy.
Follow the [Firefox-first workflow](firefox-profiling.md) to repeat captures.

CPU comparisons alternate baseline and candidate order, with five pairs per
case in each of two fresh browser sessions, followed by a final integrated
comparison. Timed batches amortize Firefox's integer-millisecond timer
resolution. These are JavaScript/DOM operation
costs, not physical presentation measurements. Native scroll captures are
separate from programmatic CPU workloads. No real trackpad momentum is
injected or claimed.

## Retained improvements

Both changes reuse existing committed geometry; neither adds another cache
or relaxes measurement freshness.

### Reuse lane indexes for anchor lookup

`PositionedGeometry.anchorAt` previously scanned source order to find the
first containing item. A reading point deep in a large list therefore cost
O(N), despite the layout already owning per-lane indexes.

The new lookup searches those indexes, then selects the lowest source-index
containing item. Normal non-overlapping layouts cost O(L log(N/L) + L), where
L is the lane count. Nested intervals with unordered bottoms retain the
original scan. Gaps, excluded content, and nonfinite queries retain the
existing fallback and tie behavior. Visibility-cache cursors are untouched.

Indexed lookup requires a known-pure exclusion predicate. Lists supplying a
host `anchorable` callback retain the original source-order scan, including
callback effects and failures. The generic geometry APIs default custom
predicates to that conservative behavior; only an explicit purity promise
enables indexed lookup.

The fixture uses four lanes, varying 80–239-pixel item heights, and 1,024
deterministic reading points. These are median microseconds per lookup:

| Items | First baseline | First candidate | Repeat baseline | Repeat candidate |
|---|---:|---:|---:|---:|
| 48 | 0.17 | 0.11 | 0.17 | 0.11 |
| 1,000 | 4.8 | 0.2 | 4.8 | 0.2 |
| 10,000 | 42.8 | 0.4 | 42.6 | 0.4 |

At 10,000 items, lookup cost falls about 99%. This establishes a core scaling
gain, not a 100× improvement in an entire gallery interaction. Full layout
validation and DOM work still exist, and normal galleries retain far fewer
than 10,000 photos.

The final compatibility-guarded implementation repeats the 10,000-item
comparison at 43.0 versus 0.4 microseconds. Smaller cases measure 0.18 versus
0.12 microseconds at 48 items and 4.8 versus 0.2 at 1,000 items.

### Visit only stacked entrants

An unchanged stacked window already owns its surviving rows. Reconciliation
now skips the intersection of the old and new index ranges when mounting
entrants. It uses the existing mounting loop without allocating index arrays.
Retirement scanning and lifecycle callback order remain unchanged.

Geometry changes, incomplete renders, positioned windows, and deferred
retirements use the full existing path. Tests cover reversals, disjoint jumps,
zero overscan, resizing before observer delivery, replacement keys, failed
render retries, and disposal during mounting.

The fixture retains 10,000 declared rows with 600-pixel overscan. Each timed
batch performs 500 real `scrollTop` writes plus synchronous scroll-event
dispatch, advancing one row at a time and jumping back every 100 iterations.
The measurement includes DOM reconciliation and layout-related costs. These
are median microseconds per event:

| Row height | First baseline | First candidate | Repeat baseline | Repeat candidate |
|---|---:|---:|---:|---:|
| 4 px | 134 | 118 | 136 | 120 |
| 16 px | 56 | 54 | 60 | 56 |
| 40 px | 38 | 36 | 38 | 36 |

The dense 4-pixel case improves about 12% in both sessions. Ordinary-height
rows show smaller differences with overlapping samples; do not generalize
the dense result to all lists. Coverage and balanced destruction are checked
outside the timed batches.

The final integrated dense-row comparison measures 138 versus 118 microseconds
per event, about 14% lower. Together, the three sessions support a roughly
12–14% improvement for this specific workload.

## Architecture assessment

The review prioritizes removing duplicate ownership or work over moving
functions into more files. Accepted input and committed state must remain
distinct: updates can target a held snapshot that is not committed yet.

### Known-height geometry construction: tested, not retained

Structural commits build the Fenwick tree from previous heights or the
runtime's placeholder estimate, then feed known heights back through point
updates. The prototype supplies every known height during the initial build
and marks it learned, preserving validation atomicity and subsequent dirty
row remeasurement.

At 10,000 items, median kernel build cost improves from 2.53 to 2.26 ms.
However, real measured-row boot changes from 56 to 57 ms, declared-row boot
from 7 to 8 ms, and prepends from 7 to 7–8 ms. Supplying the initial heights
while retaining the later map/measurement replay adds enough work to erase
the benefit. This form stays outside the runtime.

A second prototype also removes the clean-height replay, separating row-state
adoption from kernel updates. Dirty-row reads remain unchanged. Its clean
10,000-item repeat measures 58 versus 56 ms for measured-row boot, 8 versus
8 ms for declared-row boot, and 7 versus 7 ms for measured prepends. Declared
prepends worsen from 7 to 8 ms. Samples overlap, and no consistent overall
runtime benefit is established. This variant is also not retained.

A useful successor must adopt known geometry once, not introduce another
initialization pass. Moving measurement across the commit's read/write fence
is not an acceptable shortcut: held dirty rows still need fresh heights,
and WebKit requires mounted offsets to move before layout-forcing accesses.

### One active extent backend

Positioned layouts use their own extent indexes while `Geometry` continues
to maintain a sequential Fenwick tree. A common keyed anchor/pin kernel with
one active extent backend could remove that duplicate storage and update
work. This is a design candidate, not a measured speedup.

Preserve transitions back to sequential layout, including all-null placement,
by rebuilding the sequential tree from committed heights. Verification must
cover fractional-DPR gallery paging, layout switches, explicit anchors,
overlaps, and pin replacement. Do not create two complete runtimes.

The generic kernel also supports unmeasured keys and changing estimators;
reconstructing from new estimates can change geometry. Prefer an explicit
known-layout snapshot over adding lazy invalidation flags to geometry queries.

### One preparation resource owner

Synchronous preparation and incremental `updateWindow` staging separately
track provisional rows, validated input, measurement roots, render rollback,
and handoff. Disposal must then account for rows, pending work, and an active
commit. One preparation object with explicit staging, acceptance, and abort
ownership could consolidate these paths. Full snapshots and targeted patches
could also have distinct representations instead of nullable fields coupled
to a `partial` flag.

This is primarily a simplification and correctness project. Preserve immediate
destruction of superseded pending rows, same-height promotion timing,
best-effort in-place DOM rollback, and independently failing queued
transactions. No latency gain is established here.

### Separate row lifetime policies

Measured rows retain elements off-screen; declared rows retain data and
destroy elements on exit. Selecting those row operations once could simplify
branches and avoid creating measurement resources for declared-only lists.
Transaction, geometry, navigation, and settling must remain shared. This is
a follow-on design candidate, not a justification to evict measured elements
or change their local-state lifetime.

## Native movement and paging

Dense native captures use 10,000 four-pixel rows, 600-pixel overscan, six
downward and four upward gestures, 90 ticks per gesture, four-pixel deltas,
approximately 16.667 ms between ticks, and 700 ms release pauses. Both move
from 10,000 to 12,160 and back to 10,720 pixels on a 40,000-pixel surface.
There is no paging in this fixture.

The companion complex-chat captures use 160 active turns, 400 branch nodes,
decoded local images, tables, code, math, attachments, and tool panels. They
have twelve upward gestures with 90 ticks, 60-pixel deltas, the same tick
interval and release pauses, and ten-second warmup intervals outside the
measurement. Both complete two paging commits, growing the surface from
24,701 to 66,349 pixels. Edge-commit timing varies between runs; the first
four moving gestures have matching endpoints.

| Workload and capture | Window | Scroll events | Scroll ends | Frame p95 | Maximum |
|---|---:|---:|---:|---:|---:|
| Dense baseline `run-cSlAlH` | 24.38 s | 895 | 10 | 17.20 ms | 17.66 ms |
| Dense candidate `run-dJV9OA` | 25.58 s | 890 | 10 | 17.18 ms | 17.62 ms |
| Chat baseline `run-hm9JXp` | 30.06 s | 740 | 12 | 17.20 ms | 17.66 ms |
| Final chat `run-6zIpo6` | 30.68 s | 829 | 13 | 17.10 ms | 17.62 ms |

All four have zero animation-frame intervals over 25 ms. Dense captures have
no programmatic position writes; chat captures have two paging writes each.
These runs verify movement and release/paging behavior. They do not establish
a native CPU or physical-smoothness improvement; the demonstrated speedups
come from the separate repeated CPU benchmarks.

## Evidence and verification

Raw captures, source variants, setup expressions, and CPU results remain
under ignored `browser-artifacts/`. Nothing is uploaded. Temporary profiles
are removed when each owned browser exits; captures use the shared compiler
cache and existing 10 GiB free-space guard.

CPU evidence directories are `core-round-bench-d7Xun6` (initial baseline),
`core-round-bench-2ruoYx` and `core-round-bench-DjxMYr` (alternating comparisons),
`core-round-bench-ZQhUKj` (final compatibility-guarded implementation),
`core-round-bench-0xRhGh` (initial known-height prototype), and
`core-round-bench-UX8y4o` (clean no-replay repeat). The no-replay exploratory
run `core-round-bench-BKuT7B` is not used for comparative claims because a
profile analysis briefly ran concurrently. The initial oversized run,
`core-round-bench-rbxYOc`, timed out; `core-round-bench-6ewRhW` was interrupted
by a development-server reload. Both are excluded from evidence.

All owned native and CPU browsers exited, and their thirteen temporary
profiles were removed, including failed runs. Raw evidence is preserved.

Final verification passes the following checks:

- `pnpm run check` and direct TypeScript checking of both modified test files.
- `pnpm test`: 866 tests across 35 files, including 37 new cases.
- `pnpm run test:firefox-profile`: 12 portable checks.
- The quick lab in all three update modes on Chromium, Firefox, and WebKit:
  nine cases with zero reported contract violations or page errors.
- Chat invariants on Chromium, Firefox, and WebKit: zero reported violations
  or page errors.
- All five gallery scripts, including fractional-DPR paging and resize.
- Runtime resize, follow landing, log, and pin-replacement scripts.

The initial focused gallery/runtime group finishes with nine passed scripts
and one failure: `streaming-height` expects a standalone markdown host to retain
800 pixels after shrinkage, but it becomes 400 pixels. The same assertion
fails with unchanged baseline `9c30774` served through the test's source
routes. This adapter test and renderer are not changed by the audit.

The follow-up [clean-code audit](clean-code-audit.md) resolves that failure:
the existing development server serves an older renderer without a height
guard. A fresh server with a separate dependency cache passes the unchanged
test against the installed dependency. The initial result is therefore not
evidence of a defect in the current markdown adapter or locked renderer.

Browser regressions use Playwright engines for correctness. Their synthetic
input is not a substitute for the installed-Firefox native captures above.
