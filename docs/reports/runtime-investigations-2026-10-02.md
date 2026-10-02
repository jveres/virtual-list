# Runtime investigation dispositions, October 2, 2026

The remaining candidate queue from the runtime data-structure audit is closed.
Three patch releases retain repeatable gains: fewer device-grid reads, compact
declared snapshots, and two observer ownership fixes. Two pager allocation
prototypes and an additional observer-index omission are rejected. Longer
unprofiled controls resolve the initial
sustained-growth question for the tested duration without establishing a general
peak-memory or GC-pause improvement.

This closes the concrete investigations identified in this audit. It does not
prove that every future workload, browser build, or host renderer is optimal.
The measurements concern source ownership, memory reporters, and API work;
physical presentation and real trackpad momentum remain outside this round.

## Candidate dispositions

| Candidate | Measured disposition |
| --- | --- |
| Share device pixel ratio within synchronous declaration passes. | Retained in [v0.4.10](https://github.com/jveres/virtual-list/releases/tag/v0.4.10). Against v0.4.9, median large positioned edits improve from 49 to 45 ms in two captures; structural batches improve 4–6%. No retained-memory or GC gain is claimed. |
| Compact declared-item snapshots. | Retained in [v0.4.11](https://github.com/jveres/virtual-list/releases/tag/v0.4.11). Against v0.4.10, 100,000-item positioned edits fall from 45 to 28–29 ms and loaded fixture-window storage falls by about 7.1 MiB. Four incremental comparisons cover compact columns, known-prefix validation, direct indexing, and filtered row preparation. |
| Reuse temporary pager ownership counts to avoid flattening and a deduplication set. | Rejected. Large-load medians remain 14 ms; whole-workload load totals are 2,465 ms at baseline and 2,448/2,579 ms in the candidate/repeat. Collection work does not consistently improve. |
| Build temporary source maps directly instead of allocating entry tuples. | Rejected. Large loads save only 0.13–0.24 ms each, while smaller cases slow down; whole-workload totals are 2,459/2,484 ms. Neither general throughput nor GC costs justify retention. |
| Sustained mixed paging with natural collection. | Closed with 240- and 960-cycle unprofiled controls. The small case's process footprint peaks at 211.21 MiB at cycle 260, drops to 145.82 MiB at cycle 280 without forced collection, and stays between 141.78 and 159.82 MiB over cycles 480–960. Active source counts remain bounded. This is a finite-duration observation, not an unlimited plateau guarantee. |
| Reverse element index ownership. | Retained in [v0.4.12](https://github.com/jveres/virtual-list/releases/tag/v0.4.12). Delete every retired row's entry while preserving existing index population. With 1,152 empty retired roots deliberately kept by the host, the incremental comparison reduces post-collection window storage from 62.54 to 7.71–7.72 MiB; source reachability falls from 1,248 to the 96 active items. |
| Deferred resize registrations on disposal. | Retained in v0.4.12. Clearing the canceled queue releases 20 items and elements across four disposed handles. Reported window storage falls from 2.798 to 1.774 MiB in the candidate and repeat. |
| Omit reverse-index entries for rows that are never observed. | Rejected after a larger sampled process peak in the large paging case, with and without profiling. Keeping index population and deleting every retired entry preserves both ownership fixes. The observer report records the incremental control and its repeat. |

The detailed evidence and reproduction commands are in the
[pixel-ratio comparison](runtime-pixel-ratio-2026-10-02.md),
[declared-snapshot comparison](runtime-declared-snapshots-2026-10-02.md),
[paging and memory investigation](runtime-paging-memory-2026-10-02.md), and
[observer ownership comparison](runtime-observer-ownership-2026-10-02.md).
The final pager implementation remains the released v0.4.11 version.

## Measurement conditions and limits

The resumed captures use installed Firefox 157.0, build 20260924084938, with
LU28R55 at 1920 × 1080 logical pixels, DPR 2, and 60 Hz. The outer window is
1900 × 1049 at `(1450, 31)`, with a 1900 × 964 content area. Each capture uses
a fresh temporary profile and closed DevTools. Baseline, candidate, and repeat
hold the relevant fixture and workload constant within each comparison.

The early locked-desktop attempts `pixel-ratio-baseline/run-GFrZXi` and
`paging-compact-baseline/run-palIXO` have zero checkpoints and no cleanup
errors. They are invalid evidence and are excluded. After the desktop is
unlocked, the remaining comparisons complete. Raw profiles are temporary
analysis inputs; compact summaries, source patches, hashes, and reproduction
metadata remain locally under ignored `browser-artifacts/`.

The paging controls verify actual movement, scroll-end delivery, cancellation,
eviction, bounded active items, and disposal. Their API traversals do not model
native gesture release. Longer and shorter controls change both duration and
the reversal point, so their timings are not a profiler-overhead comparison.
Window allocations, content-process footprint, and whole-browser RAM are
separate measurements. The retained-root fixture intentionally keeps retired
DOM; its large saving is conditional on that ownership pattern.

## Validation

The v0.4.10 candidate passes 5,643 unit tests, static checks, 190 portable
profiler checks, and the pixel-grid browser regression. The v0.4.11 changes pass
5,650 unit tests, static checks, all 190 portable profiler checks, both isolated
consumer builds, seven runtime browser regressions, and all seven gallery
regressions. Each report records its measured source hashes.

The final v0.4.12 runtime passes `pnpm run check`, all 5,650 unit tests in 55
files, and all 190 portable profiler checks. Five relevant runtime regressions
pass in Firefox, Chromium, and WebKit: retention, paging structures, runtime
boundaries, staged rows, and data structures. All seven gallery regressions
pass, including paging at DPR 1, 1.25, and 2. The new lifecycle cases reproduce
the ownership failures before their respective fixes and pass afterward.

No measured candidate remains queued for implementation. Future investigation
should start from a new profile, reproduced regression, or materially different
workload rather than reopening the rejected prototypes without new evidence.
