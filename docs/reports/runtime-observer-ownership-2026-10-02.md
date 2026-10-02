# Resize observer ownership, October 2, 2026

Two measured retention fixes release source items after their rows retire.
When the host deliberately keeps 1,152 empty retired row elements, reported
fixture-window memory falls from **62.54 MiB to 7.71–7.72 MiB** after collection.
Only the 96 active source items remain reachable. A separate disposal case
releases all 20 items and elements previously retained by canceled observer
registrations across four disposed list handles.

These are conditional lifecycle fixes. The first saving applies to a host
that keeps retired elements, and the second to disposal with deferred observer
registrations pending. Neither is a claim about normal chat memory, whole-browser
RAM, allocation rates, or physical scrolling smoothness.

## Retired elements and source ownership

The runtime uses a `WeakMap<Element, Row>` to find measured rows when a
`ResizeObserver` entry arrives. Previously, destroying a row left that entry
in the map. If a host retained the element, the map could retain the row and
its source item for the lifetime of the list.

The fixture deliberately retains empty retired roots after removing their
children and item-key attribute. Its shared click handler does not capture an
item. This isolates the runtime reference from a host listener that would
independently keep the item alive. Each replacement creates 96 items, traverses
the list, and retires the previous set. Weak references are read only after a
separate collection task.

| After collection | v0.4.11 | Candidate | Repeat |
| --- | ---: | ---: | ---: |
| Window MiB, 4 replacements | 25.22 | 6.95 | 6.96 |
| Window MiB, 8 replacements | 43.88 | 7.32 | 7.32 |
| Window MiB, 12 replacements | 62.54 | 7.71 | 7.72 |
| Reachable source items, 12 replacements | 1,248 | 96 | 96 |
| Reachable row elements, 12 replacements | 1,248 | 1,248 | 1,248 |
| Host-kept retired elements | 1,152 | 1,152 | 1,152 |

The approximately 54.82 MiB saving, or 87.7%, comes from releasing retired
source data while preserving the host's elements. Releasing the list and host
references leaves zero reachable source items or row elements in all three
captures, with about 1.69–1.70 MiB of fixture-window storage.

The patch deletes a row's reverse entry before host teardown callbacks run.
An identity check preserves a newer entry if the same element now belongs to
another row. The first candidate also omits declared-height rows and edge slots
from the map because the observer never registers them. The paging comparison
below rejects that additional change. The final source keeps the existing index
population and deletes entries for every retired row.

The [ECMAScript WeakMap specification](https://tc39.es/ecma262/multipage/keyed-collections.html#sec-weakmap-objects)
explains why weak keys alone are insufficient here: an accessible key can keep
its associated value available. Explicit deletion ends this association when
the runtime relinquishes the row. The specification does not promise collection
at a particular time. The source was checked on October 2, 2026.

## Disposal during resize delivery

The second fixture grows a mounted measured row to trigger resize delivery.
An `onState` callback requests a replacement, and an `onMount` callback disposes
the list after replacement rows have queued observer registrations. The fixture
keeps the disposed API handles, so canceled work must release its own references.

The baseline already includes the reverse-map fixes above. It cancels the
registration animation frame on disposal but leaves its row array populated.
Across four disposal cycles, 20 source items and 20 elements remain reachable
despite zero active items and balanced render/destruction callbacks.

The retained patch clears this array when disposal cancels the frame.

| After four disposals and collection | Baseline with map fix | Candidate | Repeat |
| --- | ---: | ---: | ---: |
| Window MiB | 2.798 | 1.774 | 1.774 |
| Reachable source items | 20 | 0 | 0 |
| Reachable row elements | 20 | 0 | 0 |
| Retained disposed handles | 4 | 4 | 4 |

Releasing the handles leaves zero items and elements in every capture and
about 1.645 MiB of window storage. The final candidate and repeat also preserve
the earlier map fix: after four replacements with 384 retired roots kept,
only 96 source items remain reachable while all 480 elements remain available.

## Rejected index omission

The source with both ownership fixes is first compared with the saved v0.4.11
paging baseline. This candidate also omits reverse entries for declared rows
under overlapping pages, cancellation, live edits, and whole-page eviction.
Paging algorithms are unchanged; the separate
[pager investigation](runtime-paging-memory-2026-10-02.md) rejects both tested
allocation prototypes.

| Case and item budget | v0.4.11 load total, ms | Omitted entries | Repeat |
| --- | ---: | ---: | ---: |
| Stacked, 480 | 199 | 229 | 187 |
| Positioned, 2,000 | 523 | 564 | 502 |
| Stacked, 10,000 | 1,743 | 1,750 | 1,596 |

Each total covers 120 awaited loads. Large-case medians are 14, 14, and 13 ms;
p95 values are 19, 19, and 17 ms. Whole-workload load totals are 2,465, 2,543,
and 2,285 ms. Edit totals are 428, 574, and 429 ms. These results do not establish
a repeatable general API speedup or slowdown at the page clock's 1 ms resolution.
Every case preserves its active-item budget, 30 cancellations, and 360 scroll
and scroll-end events.

The positioned case's post-collection window storage falls from 5.217 to
5.146 MiB in both repeats; its baseline reports 73,896 bytes under the WeakMap
class. The candidate no longer reports a notable WeakMap class. This reporter
omits classes below its threshold, so absence is not a zero-byte measurement.
The stacked cases remain near 2.21 and 7.13 MiB after collection.

Natural memory and pause results remain mixed. The small case's uncollected
window falls from 46.30 to 14.93/16.00 MiB, while the large case rises from
58.13 to 87.19/60.79 MiB. The large case's maximum sampled content-process
footprint rises from 206.42 to 264.82/271.89 MiB. Its GC/CC slice totals are
266.3, 302.4, and 224.4 ms, and its largest minor-GC slices are 6.60, 18.35,
and 5.59 ms. These controls do not justify a general peak-memory or pause claim.
The ownership fixes are useful independently of this index-population change.

A matching 240-cycle control disables profiling and requests no collection
between cycles. The small case's maximum sampled process footprint falls from
198.02 to 102.69 MiB, but the large case rises from 202.40 to 273.26 MiB. The
positioned case changes from 246.07 to 232.38 MiB. Uncollected window totals are
also mixed: 81.08/26.64/21.69 MiB at baseline and 24.10/74.06/100.66 MiB with
omitted entries. Thus the larger process peak is not limited to a profiled capture.
These single control captures characterize a tradeoff; they establish neither
a repeatable overall memory saving nor a universal maximum.

Post-collection active windows remain bounded at 2.24, 5.19, and 7.20 MiB;
released windows are 1.11, 1.32, and 1.37 MiB. Each case completes 240 loads,
60 cancellations, and 720 scroll and scroll-end events with the same active
counts and eviction counts as its baseline. The runner and workload do not
force collection to achieve the lower small-case process sample.

## Final index cleanup

The alternative keeps the existing index population and deletes each retired
entry, including declared rows and edge slots. The same 240-cycle unprofiled
workload compares this source with the omitted-entry control above. This checks
the newly observed peak tradeoff without expanding the completed profiled
comparison. The final source retains the canceled-registration cleanup too.

| Maximum sampled content-process MiB | Omitted entries | Final cleanup | Repeat |
| --- | ---: | ---: | ---: |
| Stacked, budget 480 | 102.69 | 127.66 | 127.38 |
| Positioned, budget 2,000 | 232.38 | 209.21 | 223.46 |
| Stacked, budget 10,000 | 273.26 | 194.21 | 182.76 |

The alternative repeats a lower large-case peak while retaining both ownership
fixes. It gives up the lowest small-case sample from the omitted-entry version.
For context, the released v0.4.11 control peaks are 198.02, 246.07, and 202.40 MiB.
The selected source avoids the observed large-case regression; these sampled
peaks still do not establish a universal bound or a whole-browser memory saving.

Final uncollected window totals are 46.34/46.21 MiB for the small case,
12.33/12.89 MiB for positioned items, and 56.81/54.52 MiB for the large case.
Post-collection active windows are about 2.24, 5.21, and 7.20 MiB, and released
windows remain 1.11, 1.32, and 1.37 MiB. Both captures preserve all 240 loads,
60 cancellations, 720 scroll and scroll-end events, and the expected active
counts and eviction totals per case.

Load medians are 2, 5, and 17 ms in the candidate and 2, 5, and 16 ms in its
repeat. Whole-workload load totals are 5,653 and 5,496 ms versus 5,543 ms with
omitted entries; edit totals are 947 and 1,003 ms versus 912 ms. The final source
is selected for correct ownership and the repeated large-case memory result,
not for a general timing improvement. No GC markers are recorded in these
unprofiled controls, so they do not establish better pause tails.

## Method and reproduction

Every capture uses installed Firefox **157.0**, build **20260924084938**, macOS
**27.0.1**, build **26A434**, a fresh temporary profile, and closed DevTools.
LU28R55 is 1920 × 1080 logical pixels, DPR 2, at 60 Hz. The outer window is
1900 × 1049 at `(1450, 31)`, with a 1900 × 964 content area.

The original baseline is the v0.4.11 runtime, revision
`3f64f33cdd0e3a2ccad8a68edd6eeb5a8bd7049c`. All captures record the subsequent
documentation-only revision `ee1c58bb0517d10d8f41e35e98c7fca8d09a1818` plus
their source patch and hashes. The two lifecycle comparisons each have one
baseline, one candidate, and one repeat. Their fixture versions are held constant
within each comparison; the disposal mode is added before the second baseline.

The `src/virtual-list.ts` SHA-256 values identify each runtime stage:

| Stage | SHA-256 |
| --- | --- |
| v0.4.11 | `1f9c76c408ce8f2c61d7552865a4b08bf7cd75ad2bce6ed5f6bf7770b4eb4e4e` |
| Reverse-map fixes | `a3adb0434f40c68839ef43f35dbd0f4456daeb97299f843d9abd6c3a01558165` |
| Omitted entries and queue cleanup | `d63f772529dcd787a0ad46e2efe2f43dbb09c40108bd6d02817dafa06aae8f45` |
| Final cleanup with existing index population | `e3b364d2b09923e81d9c5f2de3016f6ed168b805957ad88650fa0fe5b3408ac0` |

Use separate output directories for each variant:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=lifecycle --cycles=12 --display=LU28R55 --output=browser-artifacts/observer-retention-baseline
node scripts/firefox-profile/runtime-retention.mjs --workload=lifecycle --cycles=4 --display=LU28R55 --output=browser-artifacts/observer-delivery-baseline
node scripts/firefox-profile/runtime-retention.mjs --workload=paging-natural --cycles=120 --diagnostic --display=LU28R55 --output=browser-artifacts/observer-paging-candidate
node scripts/firefox-profile/runtime-retention.mjs --workload=paging-natural --cycles=240 --display=LU28R55 --output=browser-artifacts/observer-paging-control
```

The installed-Firefox lifecycle runner requests GC/CC before each checkpoint.
It records source and element reachability, explicit window allocations, process
counters, actual movement, scroll-end events, and teardown counts. The total is
a [Firefox memory reporter](https://firefox-source-docs.mozilla.org/performance/memory/about_colon_memory.html)
window subtree, not process footprint or a guaranteed operating-system memory
return. Reporter checkpoints open a temporary diagnostic tab. No native gesture
or real trackpad momentum is measured by these instant API traversals.

Compact summaries and reproduction metadata remain under ignored
`browser-artifacts/`:

| Comparison | Baseline | Candidate | Repeat |
| --- | --- | --- | --- |
| Retained roots, 12 cycles | `observer-retention-baseline/run-pS4RIr` | `observer-retention-candidate/run-3CGyrs` | `observer-retention-repeat/run-0SBtCU` |
| Disposal delivery, 4 cycles | `observer-delivery-baseline/run-mQtxj0` | `observer-delivery-candidate/run-iQnq40` | `observer-delivery-repeat/run-s00g5V` |
| Paging, 120 cycles | `paging-compact-baseline/run-aNmown` | `observer-paging-candidate/run-Z5Raac` | `observer-paging-repeat/run-iTgB4a` |
| Unprofiled paging, 240 cycles | `paging-natural-control/run-Ry3ZVo` | `observer-paging-control/run-wSO3em` | Single control per source |
| Existing index population, 240 cycles | `observer-paging-control/run-wSO3em` | `observer-index-control/run-CNswSJ` | `observer-index-repeat/run-RGJisM` |

The first three captures complete 26 checkpoints each; the next three complete
19 each. All finish with no cleanup errors. Owned browsers, temporary profiles,
helpers, and servers are removed. No raw profile is retained or uploaded.

The paging comparison reuses the v0.4.11 baseline from the pager study. Its
paging fixture, source generator, workload, and duration match both observer
candidates. Only unrelated lifecycle fixture modes and the runner's unprofiled
cycle limit change between those captures. Each paging capture completes
13 checkpoints and removes its temporary sampled profiles after analysis.
The 240-cycle controls also complete 13 checkpoints each with no cleanup errors.
Their paging fixtures and workloads match. The final comparison uses the
omitted-entry source as its baseline; the original v0.4.11 control is context,
not an additional trial in that incremental comparison.

## Validation and disposition

The expanded lifecycle regression fails before each respective fix: it finds
480 reachable items instead of 96 with retained roots, then 20 instead of zero
after disposal during delivery. The final source passes both cases. Chromium's
explicit collection provides these automated reachability assertions; installed
Firefox supplies the primary memory comparisons. Firefox, Chromium, and WebKit
all pass the six-mode lifecycle and teardown checks.

The final runtime source passes `pnpm run check`, all **5,650 unit tests** in
55 files, and all **190 portable Firefox profiling checks**. Five runtime browser
regressions pass in Firefox, Chromium, and WebKit: runtime retention, paging
structures, runtime boundaries, staged rows, and data structures. All seven
gallery regressions pass, including paging at DPR 1, 1.25, and 2.

After selecting the final index cleanup, an installed-Firefox integration check
at four cycles verifies all six lifecycle modes on that exact source. It keeps
only 96 source items with 384 retired roots held and releases all source items
and elements after disposal during delivery. The original 12-cycle comparison
above measures the incremental retirement fix; this final check verifies that
the selected index population preserves its ownership behavior. It does not
add a trial to either completed performance comparison.

That check is `observer-final-validation/run-Jmxc3B`, with 19 checkpoints and
no cleanup errors. Its source hash matches both final paging controls and the
release source. All released fixture modes have zero surviving source items
and row elements after collection.

The two ownership fixes are retained, with existing index population preserved.
The additional index omission is rejected. The public API and paging ownership
rules are unchanged. The [investigation record](runtime-investigations-2026-10-02.md)
records the measured dispositions of the remaining audit candidates.
