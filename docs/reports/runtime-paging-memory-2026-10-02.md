# Paging and sustained memory, October 2, 2026

Neither tested pager allocation change justifies retention. Page-load medians
stay essentially unchanged, and small total-time differences don't establish a
useful gain across the workload. Both prototypes are removed. Longer controls
show that the initial memory rise can reverse without forced collection while
active source counts remain bounded.

The memory review also identifies source-retention paths through host-kept
elements and canceled resize-observer registrations. The separate
[observer ownership comparison](runtime-observer-ownership-2026-10-02.md)
records the resulting fixes. This report closes the pager prototypes and the
natural-growth question; it does not claim a general peak-memory reduction.

## Pager comparisons

The baseline is the released **v0.4.11 runtime**, revision
`3f64f33cdd0e3a2ccad8a68edd6eeb5a8bd7049c`. Capture metadata names the subsequent
documentation-only revision `ee1c58bb0517d10d8f41e35e98c7fca8d09a1818`.
Each independent comparison uses that same fresh baseline and two candidate
captures. The second prototype excludes the first prototype's changes.

The baseline's 10,000-item case attributes 164 nearest-runtime samples to the
page ownership builder, 72 to the load merge, and 68 to deduplication. These
2 ms samples include native or host work beneath the recorded frame. They
identify candidate paths, not exclusive CPU durations.

The first prototype consumes the temporary owner-count map after eviction to
form the exposed array in page order. It avoids a flattened intermediate array
and a second deduplication set. The second builds each temporary source-key map
with direct insertions instead of an array of `[key, item]` pairs. Neither adds
a persistent index or changes source ownership rules.

The table gives total wall time for **120 page loads**, in milliseconds.
Each load includes awaited runtime preparation, source generation, projection,
eviction callbacks, and any collection during the call.

| Case and item budget | v0.4.11 | Owner-map candidate | Owner-map repeat | Direct-map candidate | Direct-map repeat |
| --- | ---: | ---: | ---: | ---: | ---: |
| Stacked, 480 | 199 | 190 | 236 | 204 | 225 |
| Positioned, 2,000 | 523 | 507 | 540 | 541 | 532 |
| Stacked, 10,000 | 1,743 | 1,751 | 1,803 | 1,714 | 1,727 |

The large-case median is **14 ms in every capture**. Its p95 values are
19, 19, 19, 18, and 19 ms in table order. The direct-map prototype saves only
0.13–0.24 ms per large load, or 0.9–1.7%, while increasing smaller-case totals.
Its positioned repeat also moves the median from 4 to 5 ms. Across all three
cases, load totals are 2,465 ms at baseline, 2,448/2,579 ms with owner-map reuse,
and 2,459/2,484 ms with direct map construction. No general speedup is retained.

The page clock resolves to milliseconds. Medians and p95 use the profiler's
existing sorted-sample convention. This is not a statistical confidence
interval, and these API results do not measure scrolling presentation.

Post-collection window storage is effectively unchanged: about 2.22 MiB for
408 active stacked items, 5.22 MiB for 1,700 positioned items, and 7.13 MiB for
8,500 stacked items. The lower active counts follow whole-page eviction under
the specified budgets. Large-case GC/CC slice totals are 266.3 ms at baseline,
253.9/288.9 ms with owner-map reuse, and 274.6/274.5 ms with direct construction.
The owner-map repeat's largest minor-GC slice rises from 6.60 to 8.32 ms.
Neither collection work nor pause tails justify either prototype.

## Natural memory controls

Both controls use the v0.4.11 runtime with JavaScript profiling disabled.
Automation remains attached. The first runs 240 cycles per case; the follow-up
runs 960 because the small case is still growing at 240. These answer a
duration question, not a before/after optimization comparison. Their different
cycle counts and reversal points prevent attributing timing differences to
profiling overhead.

The runner collects before and after each case, but never between its cycles.
It samples owned-process footprints every twenty cycles without opening a
diagnostic tab. Each cycle edits a boundary item, loads an overlapping page,
traverses the window, and reconciles eviction. Every fourth cycle also cancels
a source that resolves late. The final quarter pages in the reverse direction.
Pages contain one quarter of the budget and overlap their neighbor by 20%.

At 240 cycles, the small case's content-process footprint rises from 55.56 to
198.02 MiB. Its uncollected fixture window reports 81.08 MiB, falling to
2.26 MiB after collection with the list still active. That short sequence alone
cannot establish a natural plateau.

In the 960-cycle follow-up, the small case reaches 211.21 MiB at cycle 260,
falls to 145.82 MiB at cycle 280, and remains between 141.78 and 159.82 MiB
through the second half. There is no forced collection or diagnostic tab at
that drop. Growth therefore does not continue monotonically in this control.
Profiling is disabled, so no GC marker attributes the exact reclaiming event.

The following values describe sampled content-process physical footprint in
the longer control, not fixture-only memory or whole-browser RAM.

| Case | Maximum sampled MiB | Range over cycles 480–960, MiB | Final sampled MiB | Final active items |
| --- | ---: | ---: | ---: | ---: |
| Stacked, budget 480 | 211.21 | 141.78–159.82 | 154.25 | 408 |
| Positioned, budget 2,000 | 253.23 | 205.79–240.25 | 222.26 | 1,700 |
| Stacked, budget 10,000 | 233.96 | 186.58–233.96 | 226.74 | 8,500 |

Each long case completes 960 successful loads, 240 cancellations, and 2,880
scroll and scroll-end events. Eviction counts are 91,872, 382,800, and 1,914,000
items. Every released list removes its canvas and balances render/destruction
counts. The post-collection released windows are 1.30, 1.64, and 1.82 MiB.
The fixture retains timing and performance-mark records; this floor is not a
measurement of an empty production page.

The later samples and bounded ownership do not establish an unlimited-duration
guarantee, a lower peak, or better GC pauses. Source payloads are synthetic
2,048-character strings; their engine representation is not assumed to be a
flat two-kilobyte allocation. The full process also includes browser and
automation state. Uncollected window checkpoints open a temporary diagnostic
tab, while the per-cycle physical samples do not.

Mozilla's [memory-report documentation](https://firefox-source-docs.mozilla.org/performance/memory/about_colon_memory.html)
distinguishes explicit allocation trees from other overlapping measurements and
describes collection controls. Its
[profiler memory guide](https://firefox-source-docs.mozilla.org/tools/profiler/memory.html)
describes separate allocation instrumentation. This study uses reporter totals,
process counters, and sampled GC slices; it does not measure allocation rates.
Both sources were checked on October 2, 2026.

## Reproduction and scope

Every capture uses installed Firefox **157.0**, build **20260924084938**, macOS
**27.0.1**, build **26A434**, a fresh temporary profile, and closed DevTools.
LU28R55 is 1920 × 1080 logical pixels, DPR 2, at 60 Hz. The outer window is
1900 × 1049 at `(1450, 31)` and the content area is 1900 × 964.

Use the same command with a separate output directory for each variant:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=paging-natural --cycles=120 --diagnostic --display=LU28R55 --output=browser-artifacts/paging-compact-baseline
```

For the controls, omit `--diagnostic` and use `--cycles=240` or `--cycles=960`.
The runner now permits 960 cycles without profiling and keeps the profiled
limit at 240. Other workload limits and defaults stay unchanged.

Compact summaries, patches, source hashes, and commands remain locally under
ignored `browser-artifacts/`:

| Variant | Capture |
| --- | --- |
| v0.4.11 paging baseline | `paging-compact-baseline/run-aNmown` |
| Owner-map reuse | `paging-owner-candidate/run-VW2QAT`, `paging-owner-repeat/run-F5aiD1` |
| Direct source maps | `paging-index-candidate/run-UMExy8`, `paging-index-repeat/run-gUkBls` |
| Unprofiled, 240 cycles | `paging-natural-control/run-Ry3ZVo` |
| Unprofiled, 960 cycles | `paging-natural-long-control/run-RghvUp` |

All seven captures complete thirteen checkpoints with no cleanup errors. The
failed locked-desktop attempt `paging-compact-baseline/run-palIXO` has no
checkpoints and is excluded. All five API captures use the same paging fixture
and movement workload. No capture is extended to increase a completed
comparison's sample size. Raw profiles and owned browser resources are removed.

The [investigation record](runtime-investigations-2026-10-02.md) links these
dispositions to the earlier retained changes and the observer ownership fixes.
