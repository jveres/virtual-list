# Runtime data structures, October 1, 2026

Two compact numeric representations justify a runtime change. Learned heights
now share the existing key-to-index lookup, and positioned geometry stores tops
and bottoms in numeric buffers instead of one copied object per item. The main
benefit is retained memory. Isolated positioned rebuilds also improve; the
broader API timings do not establish a general runtime speedup.

The later [key-index follow-up](runtime-key-index-2026-10-01.md) uses these
compact buffers as its baseline and measures the remaining identity-sharing
and direct-construction candidates. The results below describe this earlier
comparison.

The subsequent [allocation study](runtime-allocation-anchors-2026-10-01.md)
shows that requesting a live typed array's `.buffer` can restore missing memory
attribution. The figures below remain historical reporter totals; they are not
an exact accounting of all backing storage.

The following values are Firefox's reported fixture-window allocations after
loading and forced collection. They include fixture and runtime overhead, are
not whole-browser RAM, and compare identical workloads with the original
runtime at `7827f94` against the candidate. Both candidate captures agree to the
shown precision, except for a 0.001 MiB variation in the largest stacked list.

| Loaded case | Items | Original MiB | Candidate MiB | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Measured geometry component | 100,000 | 14.789 | 10.560 | 28.6% |
| Positioned geometry component | 100,000 | 8.664 | 4.014 | 53.7% |
| Stacked list | 1,000 | 1.406 | 1.384 | 1.6% |
| Stacked list | 10,000 | 3.720 | 3.521 | 5.3% |
| Stacked list | 100,000 | 34.960 | 30.732 | 12.1% |
| Positioned list | 1,000 | 1.960 | 1.886 | 3.8% |
| Positioned list | 10,000 | 4.993 | 4.329 | 13.3% |
| Positioned list | 100,000 | 43.360 | 34.469 | 20.5% |

## Research and structure inventory

The research targeted representations that remove allocations without changing
the runtime's exact geometry and transaction rules. TanStack Virtual's current
[single-lane implementation](https://raw.githubusercontent.com/TanStack/virtual/main/packages/virtual-core/src/index.ts)
stores start/size pairs in a `Float64Array` and materializes item objects when
needed. This supports testing numeric storage here; it does not establish a
Firefox performance result or justify importing its cache and proxy design.

The [ECMAScript typed-array specification](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-typedarray-objects)
defines eight-byte `Float64Array` elements. Keeping that precision preserves
fractional heights and large coordinates. A four-byte `Float32Array` would
lose some fractional boundaries as coordinates grow. Lane identifiers remain
ordinary safe integers; they are not narrowed to 32 bits. Sources were checked
on October 1, 2026.

The review covered every runtime source module and optional companion. The
following decisions distinguish measured candidates from code-inspection
findings that do not justify a patch.

| Area | Current structures and decision |
| --- | --- |
| `fenwick.ts` | Already uses a contiguous `Float64Array`, a linear build, cached total, and logarithmic queries. Keep it; a segment tree adds storage, and narrower floats reduce precision. |
| `geometry.ts` | Keys, a key-to-index `Map`, Fenwick storage, and a second learned-height `Map`. Replace only the second map with indexed doubles; measure reorder transfer and sparse costs. |
| `positioned-geometry.ts` | Copied item objects, per-lane index/prefix-bottom arrays, and one cached visibility result. Replace the copied objects with tops/bottoms buffers. Keep lane and immutable result arrays; this does not add a second index or a history of cached windows. |
| `virtual-list.ts` identity and transactions | Desired items/index, committed geometry, declared item/height entries, and staged/deferred maps have distinct lifetimes. Sharing or merging them needs a separate transaction design. No measured justification for that larger rewrite. |
| `virtual-list.ts` row lifecycle | Row `Map`, mounted/hidden/dirty/stale `Set`s, and element `WeakMap` support identity and targeted work. Measured rows deliberately retain rendered content in the loaded window. Bit sets or object pooling would require extra stable IDs and lifecycle handling. Keep them. |
| `virtual-list.ts` task and hook queues | Short arrays drained at lifecycle boundaries. No measured large queue or queue cost; a ring buffer would add state without demonstrated benefit. |
| `paging.ts` | Page/item arrays plus temporary deduplication, protection, and owner-count collections. Persistent owner indices would add retained state; the earlier copy prototype had no useful gain. Keep immutable snapshots and page eviction behavior. |
| `scroll-settle.ts` | At most eight recorded programmatic positions plus active pointer IDs. A deque cannot materially improve this bounded array. |
| `reach.ts` | Per-edge sets own abort controllers. Keep explicit request cancellation and removal. |
| `follow.ts`, `native-glide.ts`, `wheel-policy.ts`, `viewport-repaint.ts` | Mainly scalar state and callbacks; no large collection to compact. |
| Sticky headers and reading anchors | Parallel header arrays, a small hidden-element list, and caller-provided replacement arrays. No measured volume or allocation cost justifies specialized storage. |
| `index.ts`, `types.ts`, companion exports | Public exports and contracts, with no material retained collection. |

This is not proof that all further improvements are impossible. In particular,
sharing immutable identity snapshots across transactions remains a larger,
unmeasured design opportunity. It is outside the two justified changes here.

## Retained implementation

[`Geometry`](../../src/geometry.ts) stores learned heights in a `Float64Array`
aligned with its current key indices. Zero means unmeasured because valid
heights are strictly positive. A key change transfers learned values through
the old key index into a new buffer. The complete candidate is validated before
commit, so duplicate keys or a throwing estimator preserve the prior geometry.
Removed keys forget their measurements, and unmeasured keys still consult the
estimator. Measurement uses the existing index lookup once.

[`PositionedGeometry`](../../src/positioned-geometry.ts) owns two numeric
buffers, one for tops and one for bottoms. It no longer retains the copied
`{top, height, lane}` object for each input item. Lane membership is already
represented by the lane index arrays. Validation, overlap handling, source-order
anchor selection, cached window identity, and immutable delta arrays remain.

The sparse control exposes the height-buffer tradeoff. With only 64 learned
heights among 100,000 keys, loading rises from **9.791 to 10.560 MiB**. Dense
storage costs eight bytes for every key. This is acceptable for this internal
kernel because the runtime commits a measured or declared height for every
loaded row; it is not an estimate-only virtualizer. A future sparse-estimation
mode must revisit this choice. No adaptive sparse/dense container is added.

## API costs

Timings below are medians of batches within each capture. They measure
synchronous API wall time, including any allocation and collection during that
call. They are not sampled CPU or physical frame timing.

| Work at 100,000 items | Original ms | Candidate 1 ms | Candidate 2 ms |
| --- | ---: | ---: | ---: |
| Geometry read/search batch, 50,000 operations | 26 | 22 | 38 |
| Repeated height measurements, 50,000 operations | 19 | 7 | 17 |
| Geometry reorder batch, 10 replacements | 185 | 180 | 167 |
| Positioned window/anchor batch, 10,000 queries | 4 | 4 | 5 |
| Positioned rebuild batch, 10 rebuilds | 65 | 46 | 46 |
| Stacked list reorder batch, 4 replacements | 349 | 318 | 340 |
| Positioned list reorder batch, 4 replacements | 369 | 356 | 359 |
| One positioned list item edit | 56 | 54 | 53 |

The isolated positioned rebuild improves from 6.5 to 4.6 ms per rebuild,
including construction of the same input array: about **29% less median batch
time** in both candidate captures. At 10,000 items the corresponding batches
are 6, 5, and 5 ms. The positioned edit still reconstructs a full layout, so
its large-window cost remains substantial: 60 measured edits total 3,509,
3,318, and 3,296 ms. The smaller full-list improvement is not a general speedup
claim.

Read/search results vary in both directions, including a 72 ms outlier in the
last candidate. Small stacked edits generally resolve near the page clock's
one-millisecond resolution. Sparse queries also vary, and sparse 100,000-key
reorders rise from 152 to 164/160 ms per batch. The changes are retained for
the clear storage reduction and the isolated rebuild result, not a claim that
every operation gets faster.

## Workload and accounting limits

The reusable [fixture](../../scripts/firefox-profile/fixtures/data-structures.js)
runs five cases at 1,000, 10,000, and 100,000 items in a fixed order: fully
measured geometry, geometry with 64 learned heights, four-lane positioned
geometry, and mounted stacked/positioned lists with declared heights. Data is
synthetic and deterministic, with no remote assets or private inputs.

Geometry uses fractional heights and checks every offset after reorder.
Positioned queries compare exact membership against direct interval tests.
Query reading points lie inside rows, avoiding the separate gap-fallback scan.
Height batches repeatedly submit the same deterministic values; after the
first batch, most measurements are unchanged. They must not be interpreted as
50,000 distinct Fenwick updates. Rebuilds and reorders use three timed batches;
queries and repeated measurements use five, after a warmup. List edits run one
per animation frame, discard ten warmup edits, and time sixty further calls.

Lists verify the edited DOM, extent, navigation, and disposal. At 100,000 items,
all three captures record six scroll and six scroll-end events for the stacked
case, and three of each for the positioned case. Travel is respectively
8,699,179.5 and 3,198,117.75 CSS pixels. Scrolling uses instant API commands;
there is no native gesture, momentum, presentation, or boot-time claim. The
animation-frame waits do not sample layout.

Each checkpoint forces Firefox garbage collection, cycle collection, and
memory-pressure cleanup through a temporary `about:memory` tab, then sums the
fixture's explicit window reporter leaves. The
[Firefox reporter documentation](https://firefox-source-docs.mozilla.org/performance/memory/about_colon_memory.html)
explains that these are allocation categories with separate overlapping
process metrics. Forced collection changes normal GC and cache behavior.

The third capture investigates an accounting discrepancy: after repeated
candidate rebuilds, the `ArrayBuffer` class total disappears from the window
subtree even though the geometry remains live and passes its numeric checks.
For the 100,000-item positioned component that class accounts for 1,605,744
bytes when loaded. For the full positioned list it accounts for 2,408,616
bytes. The later window total falls by roughly those amounts without a matching
drop in process heap. The cause was not established. This report therefore
uses the **loaded checkpoints**, not the smaller post-exercise totals, for
memory comparisons. It does not claim the apparent extra reduction as a gain.

Content-process physical footprint provides a separate, coarser check. The
loaded 100,000-item positioned list is 86.05 MiB originally and 79.74/79.72 MiB
with the candidate. The stacked case is 72.34 versus 70.25/71.14 MiB. These
include allocator capacity and browser state, and are not exact per-structure
sizes. `heap-allocated` alone rises with the candidate's numeric buffers; it
does not include all the other allocation categories being removed. GC-heap
and unclassified-heap reporter values are unavailable in these summaries.

## Environment and reproduction

All valid captures use installed Firefox **157.0**, build **20260924084938**,
on macOS **27.0.1**, build **26A434**, with a fresh temporary profile and closed
DevTools. The LU28R55 is 1920 × 1080 logical pixels, scale 2, 60 Hz. The browser
outer window is 1900 × 1049 at `(1450, 31)`; content is 1900 × 964 with DPR 2.

Run the maintained diagnostic from the repository root:

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=structures --output=browser-artifacts/data-structures
```

Three valid captures form the comparison. Exact commands, revision, fixture
hashes, runtime source patches, browser build, and display geometry remain in
ignored artifacts. All valid captures have matching fixture hashes; the two
candidate captures use the same runtime source.

| Capture | Artifact directory | UTC interval |
| --- | --- | --- |
| Original | `browser-artifacts/data-structures-baseline/run-B3wthr` | 19:43:25–19:44:49 |
| Candidate | `browser-artifacts/data-structures-candidate/run-xzylyA` | 19:46:23–19:47:43 |
| Candidate with class accounting | `browser-artifacts/data-structures-accounting/run-WXCg7n` | 19:50:04–19:51:27 |

An earlier baseline attempt, `data-structures-baseline/run-7GSXyd`, failed
process-counter validation and is excluded. The runner now records invalid
counter samples and retries at most twice. Candidate 1 encountered one sample
whose reported peak was below its current footprint; the retry passed. The
valid original and final candidate needed no retries. Persistent invalid
counters still fail a run. No extra comparison is made beyond these three
valid captures.

The runner removes temporary profiles, helpers, compiler caches, and its server.
Memory-report rows stay temporary; only compact summaries and source replay
metadata remain. Nothing is uploaded and the regular browser profile is not
used. The final fixture only adds explicit void callback bodies to satisfy
lint after capture; reproduction patches retain the exact measured version.

## Verification

The two new unit regressions check fractional coordinates beyond single-
precision range and identity-preserving transfers between learned and estimated
slots. Existing randomized geometry, failure atomicity, overlapping lanes,
source-order predicates, and immutable-window tests also pass.

`pnpm run check` passes, including TypeScript checking of the tests, with the
two existing diagnostic CSS `!important` warnings. `pnpm test` passes **5,633
tests in 54 files**. `pnpm run test:firefox-profile` passes **188 checks**;
its initial sandboxed attempt could not bind local test sockets and was rerun
with socket access.

The data-structure and lifecycle regression scripts each pass in Firefox,
Chromium, and WebKit. All **seven gallery regression scripts** pass, covering
paging, fractional and integral DPRs, layout switches, resize anchoring, image
reveal, and reload. These browser runs establish correctness, not cross-engine
performance. The final process audit preserves the pre-existing Vite server
and finds no remaining owned browser, helper, or server.
