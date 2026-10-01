# Runtime allocation and anchor lookup, October 1, 2026

Two further changes justify keeping: reuse the declared-item map during snapshot
staging, and use the existing positioned lane index for pure anchor searches in
gaps and overlapping layouts. At 100,000 items, large structural update batches
improve by about **5–11%**. Ordinary gap-anchor batches fall from **825 ms to
0–1 ms** for 1,000 queries; the overlap control falls from **1,001 ms to 52–53 ms**.
The candidate repeats these gains in a second fresh Firefox session.

The baseline is the working runtime **after** the
[compact buffers](runtime-data-structures-2026-10-01.md) and
[shared key indexes](runtime-key-index-2026-10-01.md), on revision
`7827f94d67081761a1a97b4ee6bae0434128d82a`. This measures additional gains against
that already optimized runtime, not against the unmodified revision or another
library. Retained storage stays essentially unchanged. Neither lower peak memory
nor shorter worst GC pauses is established.

## Profile findings and retained changes

The baseline's positioned edit phase identifies `indexItems` as the largest
nearest runtime frame: 675 samples, versus 522 and 525 in the two candidate
captures. Samples are 2 ms apart and include native work beneath the recorded
JavaScript frame; these counts are not exclusive CPU durations. The gap-anchor
phase places all 1,651 samples inside `anchorAt`, confirming the linear fallback
as the relevant cost.

In [snapshot staging](../../src/virtual-list.ts), declared entries already own
each item and its height. Previously, indexing also inserted every item into a
second temporary map. Staging now reads the item from the declared entry and
checks duplicates in that map. Measured rows and staged jobs keep their item map.
Key and height callback order, duplicate validation, failure atomicity, and
rendered item identity remain unchanged. Full positioned updates still evaluate
all height and placement callbacks.

[Positioned anchor lookup](../../src/positioned-geometry.ts) now uses lane prefix
maxima for containing candidates, the sorted lane order for following candidates,
and a reverse search bounded by prefix maxima for previous candidates. It checks
actual bottoms when intervals overlap. Source-order ties, inclusive tops,
exclusive bottoms, and exclusion results remain unchanged. The indexed path
applies only to predicates marked pure and finite query coordinates. Arbitrary
predicates keep their observable source-order calls. Visibility caches and lane
cursors are unaffected.

No new retained index, public API, item cache, or geometry ownership layer is
introduced. Nested intervals and broad exclusions can still require a linear
scan; this is not a logarithmic worst-case guarantee.

## Matched API measurements

These values are medians of three timed batches after warmup, except the ordinary
gap row, which shows the full 0–1 ms candidate range at the clock's resolution.
Each append/remove or prepend/remove pair makes two complete `setItems` calls.
The batches include fixture array construction and collection during synchronous
calls. Individual edits use 60 measured calls after ten warmups.

| Work at 100,000 items | Baseline ms | Candidate ms | Repeat ms |
| --- | ---: | ---: | ---: |
| Stacked reorder, 4 replacements | 251 | 230 | 224 |
| Stacked append/remove, 4 pairs | 480 | 458 | 440 |
| Stacked prepend/remove, 4 pairs | 489 | 466 | 445 |
| Positioned reorder, 4 replacements | 293 | 279 | 273 |
| Positioned append/remove, 4 pairs | 593 | 559 | 547 |
| Positioned prepend/remove, 4 pairs | 598 | 568 | 555 |
| One positioned edit, median | 55 | 52 | 50 |
| Ordinary gap anchors, 1,000 queries | 825 | 0–1 | 0–1 |
| Overlap gap anchors, 1,000 queries | 1,001 | 53 | 52 |

The overlap workload has four lanes and one full-height interval in the first
lane, excluded from anchoring. Query coordinates visit deterministic gaps across
the whole layout. The ordinary case has four non-overlapping lanes. The candidate
does not spend zero time on ordinary gap queries; the batch falls below the
millisecond clock resolution in some samples. Both candidate captures record
`[0, 1, 0]` ms, compared with `[826, 825, 825]` ms at baseline.

Five of the six large structural cases have disjoint baseline and candidate
batch ranges. Stacked reorder overlaps: 232–257 ms at baseline, 225–238 ms in
the candidate, and 222–235 ms in the repeat. This is a three-capture comparison,
with only one baseline session, not a statistical confidence interval.

Positioned edit totals are 3,360, 3,151, and 2,989 ms; p95 is 62, 58, and 58 ms.
At 10,000 rows, edit medians remain 5 ms and totals are 302, 294, and 298 ms.
At 1,000 rows, totals rise from 76 to 88 and 82 ms, while the median remains
1 ms. The small-call data does not establish a useful gain and includes a small
observed regression. Stacked edit medians stay below millisecond resolution.

Unchanged controls remain comparable: 50,000 fully measured geometry lookups
take 25, 25, and 24 ms; ten geometry reorders take 163, 165, and 164 ms; ten
positioned rebuilds take 55, 53, and 54 ms. The containing-anchor/window control
takes 5, 5, and 4 ms for 10,000 queries.

## Allocation, GC, and peak-memory limits

Removing the temporary map avoids constructing another 100,000-entry item table
for each declared snapshot. This is a transient allocation reduction by code
structure. Loaded list storage is unchanged: about 24.775 MiB for stacked lists
and 28.548 MiB for positioned lists in every capture. These values are Firefox's
explicit fixture-window reporters after collection, not whole-browser RAM.

The diagnostic records GC slices inside marked workload phases. The totals below
sum minor GC, major GC slices, and cycle-collector slices, including warmup and
frame waits. Treat them as sums of marker durations. Forced diagnostic
collections are outside those phases.

| GC slices across the 100,000-item case | Baseline ms | Candidate ms | Repeat ms |
| --- | ---: | ---: | ---: |
| Stacked list | 680.4 | 643.7 | 666.4 |
| Positioned list | 1,294.6 | 1,210.9 | 1,209.9 |

Total recorded GC work is modestly lower, but pause tails are not consistently
better. During positioned edits, the largest minor-GC slice is 8.360, 7.590,
and **11.155 ms**. The largest major-GC slice is 5.141, 5.036, and **8.021 ms**.
The faster repeated API workload therefore does not establish a worst-pause fix.

The content process's cumulative lifetime physical peak is **310.184, 278.808,
and 310.277 MiB**. The repeat removes the apparent peak reduction from the first
candidate. Parent-process peaks are 389.697, 457.859, and 388.650 MiB. These
include browser state, profiler buffers, serialization, and diagnostic work;
they cannot be assigned solely to runtime allocations.

Unforced window samples also vary sharply. The stacked case reports 25.721,
145.523, and 25.757 MiB; the positioned case reports 128.451, 84.994, and
56.758 MiB. These include uncollected objects and do not measure allocation rate.
Mozilla documents [native allocation sampling](https://firefox-source-docs.mozilla.org/tools/profiler/memory.html)
as a Nightly feature with substantial overhead. This installed-release study
uses sampled JavaScript and GC markers, not native allocation-rate tracing.

## Typed-array reporting discrepancy

The fixture now includes an explicit accounting probe. After exercise and
collection, it reads `.buffer` from the two live numeric arrays and collects
again. It neither rebuilds geometry nor keeps an additional copy of the data.
All three captures show the same effect at 100,000 entries.

| Baseline component | Exercised window MiB | After `.buffer` MiB |
| --- | ---: | ---: |
| Fully measured geometry | 10.058 | 11.594 |
| Positioned geometry | 2.536 | 4.072 |

The reported `ArrayBuffer` class changes from absent to 1,605,744 bytes in each
case. The geometry remains live and passes exact numeric checks throughout.
This supports an accounting explanation for the earlier disappearing buffers,
rather than a claim that the backing storage had been collected.

Mozilla's [typed-array implementation](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/js/src/vm/TypedArrayObject.cpp)
creates a buffer wrapper lazily. For malloc-backed elements, `ensureHasBuffer`
adopts the existing allocation when the wrapper is requested. That mechanism is
consistent with this experiment. The source is Mozilla's current main branch,
not an exact source audit of the installed build, so the specific reporter cause
remains an inference. Both Mozilla sources were checked on October 1, 2026.
Buffer materialization stays in the diagnostic fixture, outside production.

## Incremental append, prepend, and eviction

The isolated control constructs twenty 100,000-entry Fenwick trees in a median
12 ms, or about **0.6 ms per tree**. Full geometry reordering costs about 16 ms
per call; full list updates cost much more. Eliminating the tree construction
alone therefore offers a small bound on the tested structural cost.

No chunked tree or incremental positioned snapshot is added. A broader design
would also need to avoid key validation, measured-height transfer, or host
callback evaluation. Height and position outputs can change without item
identity changing, so skipping those callbacks needs an explicit dependency
contract. Bulk eviction and real application paging distributions remain separate
workloads; the one-row removal pairs here do not establish their performance.

## Environment and reproduction

All comparisons use installed Firefox **157.0**, build **20260924084938**, on
macOS **27.0.1**, build **26A434**, with fresh temporary profiles and closed
DevTools. The LU28R55 display is 1920 × 1080 logical pixels, scale 2, 60 Hz.
Browser geometry is 1900 × 1049 at `(1450, 31)`, with 1900 × 964 content and
DPR 2. No performance work runs concurrently with these captures.

The maintained [fixture](../../scripts/firefox-profile/fixtures/data-structures.js)
covers six cases at 1,000, 10,000, and 100,000 items. Each case gets a separate
2 ms profile to keep its markers inside the recording buffer. Raw profiles are
reduced to compact [phase summaries](../../scripts/firefox-profile/structure-analysis.mjs)
and deleted. Reproduce the diagnostic with:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --diagnostic --output=browser-artifacts/structure-diagnostics
```

Exactly three complete captures supply API, GC, and checkpoint-memory evidence:

| Variant | Artifact directory | UTC interval |
| --- | --- | --- |
| Shared-index baseline | `browser-artifacts/structure-diagnostics-baseline/run-bKUnpb` | 20:50:12–20:52:02 |
| Candidate | `browser-artifacts/structure-diagnostics-candidate/run-uqXq5k` | 20:56:15–20:58:01 |
| Candidate repeat | `browser-artifacts/structure-diagnostics-repeat/run-WBoOfJ` | 20:58:25–21:00:06 |

All three have identical measured fixture, runner, browser-helper, and analyzer
hashes. Production source hashes match both retained candidate captures. The
reproduction patches preserve the exact versions, commands, and workload.

Two earlier attempts are invalid and excluded: `run-bnfLmf` lost the capture
start marker in one long profile, and `run-fALe5P` hit a parser error on an
unrelated numeric marker name. Per-case captures and a tested numeric-name guard
resolve those failures.

An optional phase-boundary process-counter endpoint was registered after Vite's
HTML fallback and returned no counters in any comparison. That metric is
unavailable. API timers, recorded phase markers, GC summaries, and checkpoint
process counters completed independently and are the evidence above. After the
comparison, the unused endpoint and requests were removed; direct performance
marks remain. The reproduction patches retain those requests outside timed
calls, and the final tooling text states the actual measurement limits.

At 100,000 rows, every list capture records three scroll and three scroll-end
events, with 8,698,152 CSS pixels of stacked travel and 3,198,117.75 positioned
travel. API scrolling verifies movement only. No native momentum, physical
presentation, demo boot, or cross-engine speedup is claimed.

## Verification

New unit coverage compares indexed and source-order anchors across nested
intervals, gaps, ties, permutations, and exclusions in one, four, and seven
lanes. Duplicate-snapshot tests verify callback order, unchanged committed data,
and successful recovery in measured and declared modes. Portable analyzer
checks cover GC clipping, sample attribution, numeric markers, and incomplete
captures.

`pnpm run check` passes with the two existing diagnostic CSS warnings.
`pnpm test` passes **5,641 tests in 54 files**, and
`pnpm run test:firefox-profile` passes **190 checks**.

The data-structure, lifecycle, staged-row, and runtime-boundary regressions all
pass in Firefox, Chromium, and WebKit. All **seven gallery regression scripts**
pass, covering cached reveal, controls, fading, header stability, paging at
multiple DPR values, reload, and resize. These are correctness checks, not
cross-engine performance comparisons.

Documentation links resolve and `git diff --check` passes. Every capture
directory contains only its compact summary, reproduction metadata, and source
patch. Raw profiles, temporary browser profiles, native helpers, caches, and
owned servers are removed. The final process audit finds no owned profiling or
regression session; the pre-existing Vite server and unrelated WebKit processes
remain untouched.
