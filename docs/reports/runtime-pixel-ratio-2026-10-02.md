# Pixel-ratio reads during snapshots, October 2, 2026

Reading the device pixel ratio once per synchronous declaration pass improves
large positioned updates enough to retain the change. At 100,000 items, median
edit time falls from **49 ms to 45 ms** in both candidate captures. Positioned
structural batches improve by about **4–6%**. The comparison is against
`v0.4.9`, revision `01f9cdea881561225205ca539b58350bbdac9acc`, including all
previous data-structure and anchor improvements.

## Change and evidence

The fresh baseline's positioned-edit phase records 180 nearest-runtime samples
in `pixelRatio`, versus 496 in `indexItems`. The candidate reads the ratio once
while declaring snapshot heights and once while placing the positioned snapshot.
It passes that value through quantization and origin calculation. `pixelRatio`
leaves the top fifteen attributed frames in both candidate captures.

The ratio isn't retained across calls or asynchronous work. Individual edits
and later snapshots still read the current device grid, and all host height and
position callbacks still run. The
[CSSOM View draft](https://drafts.csswg.org/cssom-view/#dom-window-devicepixelratio)
defines the ratio using current page zoom and the output device. The new tests
cover changes between snapshots and individual edits at ratios 1, 1.25, 1.5,
and 2. The Chromium regression also exercises live device-scale changes.

## Matched results

Structural values below are medians of three timed batches after warmup.
Reorder batches make four replacements; append/remove and prepend/remove
batches make four pairs, or eight full `setItems` calls. Edit medians use sixty
calls after ten warmups. Timings include synchronous collection and fixture
array construction, and have millisecond resolution.

| Work at 100,000 items | v0.4.9 ms | Candidate ms | Repeat ms |
| --- | ---: | ---: | ---: |
| One positioned edit | 49 | 45 | 45 |
| Positioned reorder | 267 | 251 | 256 |
| Positioned append/remove | 538 | 509 | 507 |
| Positioned prepend/remove | 548 | 519 | 513 |
| Stacked reorder | 220 | 221 | 217 |
| Stacked append/remove | 441 | 429 | 425 |
| Stacked prepend/remove | 444 | 428 | 420 |

The large positioned structural batch ranges don't overlap their baseline
ranges. Edit totals are 3,003, 2,762, and 2,753 ms; p95 is 56, 51, and 52 ms.
At 10,000 positioned items, totals improve from 289 to 273 and 279 ms, while
medians are 5, 4, and 5 ms. This is three browser sessions with one baseline,
not a statistical confidence interval.

Small stacked batches don't improve: at 1,000 items, reorder medians increase
from 3 to 4 ms, append/remove from 6 to 6–7 ms, and prepend/remove from 5 to
6 ms. These are batch costs, not per-item times. No small-list speedup is
claimed. Unchanged 100,000-item geometry controls remain comparable: ten
reorders take 165, 162, and 163 ms; ten positioned rebuilds take 59, 55, and
55 ms.

Loaded fixture-window storage stays about 24.74 MiB for stacked lists and
28.50 MiB for positioned lists. Positioned-case GC marker totals are 1,230.7,
1,262.6, and 1,258.7 ms, so the speedup doesn't establish less GC work. The
content process's cumulative physical peak is 309.36, 295.34, and 296.39 MiB;
that includes profiler, browser, and diagnostic allocations and doesn't isolate
a runtime-memory saving. The representation and retained item counts don't
change.

## Reproduction and verification

All three valid captures use installed Firefox **157.0**, build
**20260924084938**, on macOS **27.0.1**, build **26A434**, with fresh profiles
and closed DevTools. LU28R55 is 1920 × 1080 logical pixels at DPR 2 and 60 Hz.
The outer window is 1900 × 1049 at `(1450, 31)`; its content area is
1900 × 964.

Run the same command with an output directory for each variant:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --diagnostic --display=LU28R55 --output=browser-artifacts/pixel-ratio-baseline
```

Compact results and source patches are retained locally:

| Variant | Directory under `browser-artifacts/` |
| --- | --- |
| Baseline | `pixel-ratio-baseline/run-cxqmHx` |
| Candidate | `pixel-ratio-candidate/run-Hlojpt` |
| Repeat | `pixel-ratio-repeat/run-wW3G4H` |

Each records 85 checkpoints, completes the deterministic workload, and reports
no cleanup error. The earlier locked-desktop attempt `run-GFrZXi` is invalid
and excluded. Raw profiles and owned browser sessions are removed.

The profiler samples every 2 ms and includes native work below the recorded
runtime frame. Diagnostic collections run outside marked timed phases, but
alter caches and collection behavior between cases. These are synthetic API
measurements, not native-gesture or physical-presentation results.

Validation includes static checks, 5,643 unit tests, 190 portable profiler
checks, the Chromium pixel-grid regression, and the runtime-boundary,
data-structure, lifecycle, paging, and gallery browser regressions. The
[investigation record](runtime-investigations-2026-10-02.md) tracks the next
comparison rounds.
