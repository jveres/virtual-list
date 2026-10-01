# Compact declared snapshots, October 2, 2026

Compact snapshot storage and three measured staging changes improve declared
lists over **v0.4.10**. At 100,000 items, loaded fixture-window memory falls by
about **7.1 MiB**. Positioned edits fall from **45 ms to 28–29 ms**, and large
structural batches improve by **12–23%**. These are synthetic installed-Firefox
API results; whole-process peak memory does not improve.

The baseline is the final [pixel-ratio capture](runtime-pixel-ratio-2026-10-02.md),
whose runtime source matches release `0b18812188b776d75816c4bf8e24201009b04c50`.
Its reproduction metadata names the preceding commit plus the patch later
released as v0.4.10. Each subsequent comparison reuses the previous candidate
as its baseline and adds two fresh candidate captures. No unchanged comparison
is extended to increase its sample size.

## Retained changes

The final [snapshot store](../../src/declared-items.ts) owns an item-reference
array and a `Float64Array` of heights, aligned with the existing immutable key
index. This replaces the full `Map<string, { item, height }>` and its per-item
records. Pending and committed snapshots own separate item arrays. Small
`updateItem` patches still own only touched keys in a map, so individual stacked
updates remain independent of list size. Disposal releases the columns.

Snapshot validation reuses the known unique prefix of the current key order.
At the first mismatch, it constructs a validation set from that prefix and
continues checking every remaining key. Height and key callbacks still run in
the same order, including before a later duplicate throws. No unchecked input
is accepted as unique, and no callback result is cached between updates.

Staging reads source items by their already-known position in the copied
snapshot. Declared staging then visits retained rows, previous staged rows, and
edge slots in source order. Unrendered declared items need no row preparation.
Full height and position callbacks still run for every item. Measured-row
staging retains its complete traversal, and targeted updates retain their
single-key preparation.

## Incremental evidence

Storage compaction alone saves memory but slightly increases large structural
times. Further profiles identify duplicate-key validation, item lookup, and
full-list row preparation as the next removable costs. The table separates
those steps so their benefits aren't attributed to storage alone.

| Positioned edit at 100,000 items | Candidate median ms | Repeat median ms |
| --- | ---: | ---: |
| v0.4.10 baseline | 45 | — |
| Compact columns only | 45 | 45 |
| Add known-prefix validation | 37 | 37 |
| Add direct item indexing | 35 | 35 |
| Prepare only retained declared rows and slots | 29 | 28 |

After compaction, `indexItems` accounts for 475 nearest-runtime samples in the
edit phase. Known-prefix validation reduces that to 208 in its first capture.
The next profile puts `itemOf` first with 266 samples; direct indexing removes
that lookup from staging. The remaining preparation scan takes 234 samples
before filtering. These 2 ms samples include native work below a runtime frame;
they aren't exclusive CPU durations.

The earlier [boundary study](runtime-boundary-optimizations-2026-10-01.md)
rejected a combined positioned-index reuse and filtered-preparation prototype
at 10,000 rows. This round revisits preparation after a new profile identifies
its cost at 100,000 rows. It isolates filtering against direct indexing and
doesn't restore positioned-index caching. The isolated 35-to-28–29 ms result
justifies the additional path at this scale.

## Final API comparison

Edits use sixty calls after ten warmups. Structural values are medians of three
timed batches after warmup: four replacements for reorder, and four pairs of
insertion/removal for the other batches. Fixture array construction and any
collection during calls are included. Times have millisecond resolution.

| Work at 100,000 items | v0.4.10 ms | Final candidate ms | Final repeat ms |
| --- | ---: | ---: | ---: |
| One positioned edit | 45 | 29 | 28 |
| Positioned reorder | 256 | 218 | 216 |
| Positioned append/remove | 507 | 398 | 391 |
| Positioned prepend/remove | 513 | 441 | 436 |
| Stacked reorder | 217 | 186 | 187 |
| Stacked append/remove | 425 | 330 | 332 |
| Stacked prepend/remove | 420 | 368 | 366 |

All six large structural batch ranges are below their baseline ranges. The
positioned edit totals are 2,753, 1,841, and 1,802 ms; p95 is 52, 39, and 39 ms.
At 10,000 positioned items, totals fall from 279 to 214 and 231 ms, with median
5 to 4 ms and p95 6 to 5 ms. This isn't a statistical confidence interval.

Individual stacked edits don't improve: at 100,000 items, sixty calls total
18, 30, and 24 ms, with medians 0, 1, and 0 ms and p95 1 ms throughout. The
candidate therefore has a small observed regression in this submillisecond
operation. The savings apply to large snapshots, not every runtime call.

## Memory and collection

Loaded measurements follow forced collection and use Firefox's explicit
fixture-window reporters. They exclude the rest of the browser and aren't
unique physical-RAM measurements.

| Loaded case | v0.4.10 MiB | Final candidate MiB | Final repeat MiB |
| --- | ---: | ---: | ---: |
| Stacked, 10,000 items | 3.132 | 2.670 | 2.671 |
| Positioned, 10,000 items | 3.961 | 3.500 | 3.500 |
| Stacked, 100,000 items | 24.739 | 17.641 | 17.640 |
| Positioned, 100,000 items | 28.500 | 21.402 | 21.402 |

The initial compact-only capture's large positioned case removes exactly
5 MiB of reported map storage and about 3.8 MiB of object storage, adding about
1 MiB of array storage and 0.77 MiB of buffer storage. That supports the
representation change rather than a retained-item-count reduction. The
[earlier buffer-accounting investigation](runtime-allocation-anchors-2026-10-01.md)
still applies: exercised and uncollected checkpoints aren't interchangeable
with the loaded counters, and reporter changes aren't evidence of released
backing storage.

The recorded GC/CC slices across the large positioned case total 1,258.7 ms
at baseline, 1,092.4 ms in the final candidate, and 1,088.8 ms in the repeat.
The largest minor-GC slice increases from 8.56 to 9.30 and 10.08 ms. The content
process's cumulative physical peak also increases, from 296.39 to 304.22 and
311.17 MiB. These include profiler buffers and diagnostic work. Neither a
lower worst pause nor a lower process peak is claimed.

## Reproduction and verification

All captures use installed Firefox **157.0**, build **20260924084938**, macOS
**27.0.1**, build **26A434**, fresh temporary profiles, and closed DevTools.
LU28R55 is 1920 × 1080 logical pixels at DPR 2 and 60 Hz. The outer window is
1900 × 1049 at `(1450, 31)`; its content area is 1900 × 964.

Each variant uses the same command with its own output directory:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --diagnostic --display=LU28R55 --output=browser-artifacts/declared-visible-repeat
```

The deterministic fixture covers 1,000, 10,000, and 100,000 items. Geometry and
positioned-kernel controls run unchanged. Each capture completes 85 checkpoints
with verified movement, scroll ends, geometry, edits, and release, and has no
cleanup errors. Raw profiles and owned browser processes are removed. Compact
metadata, source patches, hashes, and summaries remain under ignored
`browser-artifacts/`:

| Variant | Capture directories |
| --- | --- |
| v0.4.10 baseline | `pixel-ratio-repeat/run-wW3G4H` |
| Compact columns | `declared-snapshot-candidate/run-OzrIcr`, `declared-snapshot-repeat/run-ZkoCFu` |
| Known-prefix validation | `declared-prefix-candidate/run-gWwnGB`, `declared-prefix-repeat/run-VawsMj` |
| Direct indexing | `declared-direct-candidate/run-qk7dea`, `declared-direct-repeat/run-8NbAHy` |
| Final preparation | `declared-visible-candidate/run-vbkNBm`, `declared-visible-repeat/run-fE2knR` |

The profiles add overhead. Diagnostic collections run between cases, and these
API workloads don't measure trackpad momentum or physical presentation.

Validation includes static checks, 5,650 unit tests, 190 portable profiler
checks, both isolated consumer builds, the pixel-grid, boundary, data-structure,
lifecycle, paging, staged-row, and native-anchoring browser regressions, and all
seven gallery regressions. Added tests check independent snapshot ownership,
slot offsets, failure atomicity after a matching key prefix, and source-order
render calls after reordering. The
[investigation record](runtime-investigations-2026-10-02.md) tracks the remaining
paging and sustained-memory work.
