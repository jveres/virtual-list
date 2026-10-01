# Runtime key-index sharing, October 1, 2026

Sharing immutable key orders and their lookup maps justifies a runtime change.
At 100,000 rows, it removes about **6 MiB** of reported loaded-window storage
and reduces structural update batch times by **13–25%** in this comparison.
Direct construction of positioned numeric buffers does not improve the tested
API times or retained storage and is removed.

The baseline is the working runtime **after** the
[compact-buffer changes](runtime-data-structures-2026-10-01.md), on revision
`7827f94d67081761a1a97b4ee6bae0434128d82a`. It is not the unmodified revision
or a comparison with another virtualization library. These are additional
gains beyond the earlier height and positioned-storage reductions.

The later [allocation and anchor study](runtime-allocation-anchors-2026-10-01.md)
investigates the transient allocation and buffer-accounting questions below.
It adds matched GC profiles, identifies a buffer-materialization accounting
effect, and retains two further improvements. The measurements in this report
remain the historical shared-index comparison.

## Retained change

The internal [KeyIndex](../../src/key-index.ts) owns a copied key array and a
read-only lookup map. Desired state and committed geometry share this object
when their orders match. A pending transaction with a different order owns a
separate index until commit; it cannot change the committed order. Geometry
continues to validate and build its height buffers and tree before adopting
the new order.

The runtime also uses this map for partial staging, removed-row membership,
and successor lookup. It no longer constructs a separate desired-item map,
temporary removal set, or successor map for those operations. Host item indices
subtract the leading edge-slot offset. Reserved slot keys remain unavailable
to `updateItem`, and slot-only changes do not invalidate staged window jobs.

Measurements, rows, declared entries, and pending render state retain their
separate ownership. This change shares identity storage, not mutable item or
geometry state. No public API changes.

## Loaded storage

The following values sum Firefox's explicit fixture-window allocation leaves
after loading and forced collection. They include fixture overhead and are not
whole-browser RAM. The direct-buffer experiment leaves these totals essentially
unchanged; the final candidate contains only key-index sharing in addition to
the baseline's compact buffers.

| Loaded case | Items | Baseline MiB | Shared index MiB | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Stacked list | 1,000 | 1.380 | 1.334 | 3.3% |
| Stacked list | 10,000 | 3.510 | 3.106 | 11.5% |
| Stacked list | 100,000 | 30.709 | 24.711 | 19.5% |
| Positioned list | 1,000 | 1.873 | 1.836 | 2.0% |
| Positioned list | 10,000 | 4.337 | 3.940 | 9.2% |
| Positioned list | 100,000 | 34.469 | 28.479 | 17.4% |

At 100,000 rows, the reported `Map` class decreases by 5 MiB and the `Array`
class by 1 MiB in both layouts. Loaded buffer accounting remains the same.
This matches removal of one full key map and one duplicate key array. The
standalone geometry controls retain their existing storage because they have
no second runtime index to share.

Loaded content-process physical footprints provide a coarser comparison:
stacked lists decrease from 73.140 to 66.968 MiB, and positioned lists from
82.976 to 77.319 MiB. These include browser state and allocator capacity.

## API timings and rejected construction experiment

These are medians of three timed batches within each capture, after warmup.
An append/remove or prepend/remove pair makes two complete `setItems` calls.
Times include fixture array construction, validation, runtime work, and any
collection during the synchronous calls.

| Work at 100,000 items | Baseline ms | Direct buffers ms | Shared index ms |
| --- | ---: | ---: | ---: |
| Stacked reorder, 4 replacements | 319 | 335 | 249 |
| Stacked append/remove, 4 pairs | 581 | 576 | 504 |
| Stacked prepend/remove, 4 pairs | 611 | 593 | 461 |
| Positioned reorder, 4 replacements | 345 | 363 | 275 |
| Positioned append/remove, 4 pairs | 668 | 675 | 553 |
| Positioned prepend/remove, 4 pairs | 676 | 677 | 561 |
| One positioned item edit, median of 60 calls | 51 | 52 | 51 |

The shared-index batches do not overlap the baseline batch ranges in these six
large structural cases. For example, stacked reorder is 312–325 versus
236–255 ms; positioned reorder is 333–354 versus 274–279 ms. This supports
keeping the change alongside its retained-storage benefit. There is one valid
capture per implementation, not three independent replications of each.

At 10,000 rows, shared-index positioned reorder improves from 28 to 22 ms per
four replacements. Append/remove improves from 53 to 46 ms, and prepend/remove
from 55 to 46 ms. Individual positioned edits do not establish an improvement:
the 60-call totals are 331 versus 342 ms. At 1,000 rows those totals are 88
versus 99 ms. Millisecond clock resolution and scheduling limit interpretation
of these small calls. No general hot-path or item-edit speedup is claimed.

The rejected candidate filled numeric columns directly while evaluating host
placement callbacks, then transferred their buffers into positioned geometry.
It preserved lane validation, origin normalization, and edge slots, and passed
focused tests. Its 100,000-row edit total rises from 3,179 to 3,240 ms, and
its structural batches show no useful gain. Loaded positioned memory is
34.469 versus 34.470 MiB. The extra construction and ownership interface is
therefore removed. Its exact source remains in the reproduction patch.

## Natural collection and peak-memory limits

The maintained runner adds `--workload=structures-natural`. Each case starts
from a collected loaded checkpoint, performs the deterministic workload without
requesting collection between operations, and then records an unforced
checkpoint before the existing collected and released checkpoints. Each
checkpoint records whether collection was requested. The unforced checkpoint
still opens a temporary diagnostic tab; it is not passive GC tracing.

Uncollected window totals depend strongly on GC timing. The 100,000-row stacked
case reads 142.165, 109.813, and 50.624 MiB for baseline, direct, and shared
variants. The positioned case reads 59.700, 103.514, and 94.693 MiB. These are
point samples of live and uncollected allocations, not retained-storage savings
or allocation-rate measurements.

The content process's cumulative lifetime physical peak ends at **283.669,
252.871, and 307.528 MiB**, respectively. The shared candidate's peak is
**8.4% higher** than baseline despite lower loaded storage. The peak covers
the entire ordered workload and diagnostic collections, not one isolated
operation. This comparison does not establish a peak-memory or GC-pause
improvement; the higher observed peak is a remaining limitation of the retained
change. The direct candidate's lower single peak is insufficient to justify
its complexity given the other results and the uncollected variability.

The previous buffer-accounting discrepancy also remains. After repeated
construction, the reported `ArrayBuffer` class can disappear while geometry
remains live and passes its numeric checks. Both baseline and shared loaded
100,000-row positioned cases report 2.297 MiB in that class; both report zero
after exercise. The rejected direct path instead retains 1.531 MiB of class
attribution after exercise. This is further reason to use matching **loaded**
checkpoints for storage claims. The cause is not established here.

Mozilla's [reporter documentation](https://firefox-source-docs.mozilla.org/performance/memory/memory_reporting.html)
describes allocation traversal and counter accounting, and its
[about:memory guide](https://firefox-source-docs.mozilla.org/performance/memory/about_colon_memory.html)
distinguishes explicit allocation trees from overlapping process metrics.
These sources were checked on October 1, 2026. They explain the measurement
boundaries; they do not establish the cause of this discrepancy.

## Workload, environment, and reproduction

The reusable [fixture](../../scripts/firefox-profile/fixtures/data-structures.js)
retains the previous five cases at 1,000, 10,000, and 100,000 items. It adds
single-row append/removal and prepend/removal pairs, with four warmup pairs and
three timed batches of four pairs per edge. Full reorder batches, exact
geometry checks, 60 measured edits after ten warmups, navigation, and disposal
remain. All three valid captures have identical fixture and runner hashes.

At 100,000 rows, all captures observe three scroll and three scroll-end events
per list case, with 8,698,152 CSS pixels of stacked travel and 3,198,117.75
positioned travel. API scrolling checks movement only. No native gesture,
momentum, boot-time, sampled CPU, or physical-presentation claim is made.

All captures use installed Firefox **157.0**, build **20260924084938**, on
macOS **27.0.1**, build **26A434**, with fresh temporary profiles and closed
DevTools. LU28R55 geometry is 1920 × 1080 logical pixels, scale 2, 60 Hz.
The browser is 1900 × 1049 at `(1450, 31)`, with 1900 × 964 content and DPR 2.

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures-natural --output=browser-artifacts/structure-followup
```

Exactly three valid captures form this comparison:

| Variant | Artifact directory | UTC interval |
| --- | --- | --- |
| Compact-buffer baseline | `browser-artifacts/structure-followup-baseline/run-eh6eH2` | 20:15:07–20:16:44 |
| Direct construction, rejected | `browser-artifacts/structure-followup-direct/run-PLLCcs` | 20:21:25–20:23:03 |
| Shared index, retained | `browser-artifacts/structure-followup-shared/run-0FB705` | 20:25:42–20:27:15 |

The earlier baseline attempt `structure-followup-baseline/run-7TM0xh` is invalid:
the new synthetic prepend row initially produced a negative lane. The fixture
was corrected and passed the three-engine regression before the valid baseline.
The shared capture rejected one inconsistent process-counter sample and passed
on retry. All valid runs completed every case and cleaned up without errors.

Compact summaries, source hashes, patches, exact commands, and environment
metadata remain under ignored `browser-artifacts/`. Raw captures, temporary
profiles, helpers, caches, and owned servers are removed. The final runner
only clarifies its measurement-description text after capture; the reproduction
patches retain the exact measured version.

## Remaining structural work

Append, prepend, and removal still rebuild exact geometry and evaluate host
callbacks for a full snapshot. This comparison measures that cost but does not
implement a chunked or incremental tree. Skipping unchanged-looking items would
require a contract for height and placement dependencies; callbacks can change
their output without item identity changing. An incremental geometry design
needs its own profile and comparable experiment before a further patch.

## Verification

New regressions cover shared orders with independent measurements, rejected
shared-order updates, and edits during held prepends with leading-slot removal
in both measured and declared modes. Existing transaction, anchor, pin, staged
job, and positioned-geometry tests remain the correctness gate.

`pnpm run check` passes, with the two existing diagnostic CSS `!important`
warnings. `pnpm test` passes **5,636 tests in 54 files**. The initial sandboxed
unit run could not bind the relay tests' local sockets; rerunning with socket
access passes. `pnpm run test:firefox-profile` passes **188 checks**.

The data-structure, lifecycle, and staged-row regressions each pass in Firefox,
Chromium, and WebKit. All **seven gallery regression scripts** pass, including
paging, fractional DPR, layout switches, resize anchoring, cached image reveal,
and reload. These browser checks establish correctness, not cross-engine
performance. Documentation links resolve, and final runtime and fixture hashes
match the retained candidate's capture.

The final process audit finds no owned profiling browser, helper, regression
worker, or server. The pre-existing Vite server and unrelated browser processes
remain untouched. Each capture directory contains only its compact summary,
reproduction metadata, and source patch.
