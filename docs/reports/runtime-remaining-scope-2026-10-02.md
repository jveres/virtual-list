# Artifact cleanup and remaining runtime scope, October 2, 2026

Further targeted measurements remain possible, but no verified runtime gain is
waiting for implementation. The strongest unanswered measurement question is
natural memory behavior beyond 120 cycles in the measured-height paging fixture.
Large-row renderer work and several design alternatives also remain distinct
from the completed runtime data-structure audit.

This is an artifact and report audit at revision `0d5efe2`, with a clean starting
working tree. It adds no browser capture, benchmark result, or production
change. The runtime stays at v0.4.12. Historical costs below come from the linked
reports and their recorded revisions; they are not new measurements.

## Cleanup

The cleanup removes 602 ignored artifact files totaling 405.21 MiB, three
completed test logs totaling 24,511 bytes, and 15 empty directories. The removed
artifacts comprise 412 Swift cache files, 100 profiling Vite cache files, 69
screenshots, one generated native helper, 15 duplicate source snapshots, and
five superseded prototype inputs or scripts.

Before deleting the duplicate source snapshots, reconstruction from their
recorded Git revisions and retained patches reproduced all 15 SHA-256 hashes.
The superseded prototype fixtures have measured versions in reproduction
patches or tracked scripts. Compact summaries, rejected-candidate patches,
reproduction inputs, source hashes, commands, and display metadata remain.
An aggregate path-and-content hash verifies that all 2,094 retained evidence
files are unchanged by cleanup.

Local artifacts fall from 479.13 to 74.03 MiB, including the new cleanup manifest
at `browser-artifacts/cleanup-2026-10-02.json`. No raw Firefox profile, Chrome
trace, or Firefox memory-report JSON was present at the start. The final scan
finds no remaining screenshots, capture binaries, raw dumps, or profiling caches.
No owned profiling process was running. The pre-existing development server,
installed dependencies, and tracked sources are preserved.

## Remaining measurement questions

These questions have a concrete evidence gap or measured cost. They do not
establish that another patch will help.

### Longer measured-height paging

The [measured-streaming comparison](runtime-rendering-allocation-2026-10-02.md)
ends its 480-item case while process memory is still growing. Window storage
falls from 98.16 to 4.80 MiB after requested collection, showing collectable
data without establishing when natural collection would occur. Active item
counts and disposal stay bounded. This is not evidence of a retained-source
leak, and the forced-collection result is not a natural-memory plateau.

The earlier [960-cycle control](runtime-paging-memory-2026-10-02.md) uses declared
heights. It does not answer the same question for measured rows with live text,
image changes, and repeated width invalidation. A longer unprofiled
`mixed-natural` run can use the existing
[memory workflow](../memory-profiling.md#sample-allocations-during-measured-streaming).
Keep collection outside the cycle sequence and inspect checkpoints for natural
recovery, sustained growth, and bounded ownership. This is a new duration
question, not a reason to repeat the rejected allocation comparison.

The subsequent [480-cycle control](runtime-measured-paging-duration-2026-10-02.md)
closes this question for the tested duration: small-case process footprint
falls naturally after cycle 120 and stays between 135.64 and 142.13 MiB over
cycles 160–480. No runtime patch follows from that result.

### Large-row rendering and indivisible layout

The [large-row fixture](runtime-rendering-allocation-2026-10-02.md#large-completed-rows)
records 201 ms creation for many independent Markdown blocks and 228 ms for one
3,000-line code fence. Host rendering and DOM construction account for 142 and
179 ms respectively. A separate 2,400-paragraph row retains an approximately
50 ms resize stall even when the runtime processes one row per frame.

Those costs support investigating renderer-owned incremental construction or
windowing inside an exceptionally large block. They do not support another
list-level batch reduction. Selection, copy, find, focus, exact geometry, and
width changes need an explicit contract before removing or delaying content.
The tested block-level `content-visibility` candidate already fails selection
and should not be reintroduced without a corrected mechanism.

The [fixed-column table proposal](virtualization-web-research-2026-10-01.md#2-constrain-expensive-html-layout-where-the-content-permits-it)
also lacks a comparison. The new 1,200-row table fixture supplies a baseline,
not evidence for fixed layout. Test only host-owned tables that accept explicit
column widths and wrapping rules; arbitrary Markdown tables do not promise
those semantics. Renderer changes belong in the owning repository, with its
regression, release, tag, and dependency-pin workflow.

The subsequent [constrained-table comparison](constrained-table-layout-2026-10-02.md)
closes that table question for the tested cases. With identical column geometry
and content, fixed layout supplies no useful CPU or timing gain against the
automatic baseline and restored control. Production CSS stays unchanged.

The subsequent [large-table staging comparison](large-table-staging-2026-10-02.md)
retains table-only preparation in the demo hook: a 1,200-row table's worst
preparation gap falls from 50.6 to 18.1–18.3 ms, with later readiness and more
total CPU. Code-block staging is rejected; its synchronous HTML generation
remains expensive. The experiment closes nested first-layout slicing, without
claiming a renderer-wide solution to arbitrarily large content.

## Conditional design experiments

Two web-research alternatives remain unmeasured. Each requires a workload that
exposes its intended cost and accepts its behavior tradeoff.

| Alternative | Evidence needed before implementation |
| --- | --- |
| [Scroll-seek placeholders](virtualization-web-research-2026-10-01.md#3-use-cheaper-content-during-fast-travel-if-acceptable) | Reproduce expensive entering content during fast travel. Compare scrolling cost and time to restore readable content after release, while preserving geometry, selection, and focus. The latest huge-row traversals have no sampled gap above 25 ms, so they do not establish a stall for this mechanism to fix. |
| [Estimated geometry for much larger histories](virtualization-web-research-2026-10-01.md#5-estimate-geometry-for-much-larger-loaded-histories) | Compare a separate prototype with exact preparation under the same renderer, content, retention, and overscan. Measure boot or restoration latency, correction work, scrollbar drift, reading anchors, and navigation accuracy. Estimates cannot silently replace the current declared-height contract. |

Cross-item pooling, smaller resize batches, pager allocation substitutions, and
the measured transient-allocation prototype already have negative comparisons.
The [runtime dispositions](runtime-investigations-2026-10-02.md) and
[rendering follow-up](runtime-rendering-allocation-2026-10-02.md) close those
candidates. Reopening them needs a different bottleneck or corrected mechanism.

## Separate correctness and presentation limits

The historical [intermittent top-button report](scroll-regressions-2026-09-29.md)
and [physical-device paging report](ios-scroll-handoff-2026-09-26.md) lack a
matching reproduction on the current release. They remain reproduction gaps,
not established current defects or optimization evidence. If the symptoms
recur, use the existing state diagnostics on the affected device.

The external-display [listener-isolation investigation](scroll-listener-isolation-2026-09-29.md)
was stopped at the user's request after jitter also appeared on a static
fixture. This audit does not reopen it or claim that later runtime gains fixed
physical presentation.

Any new performance experiment follows the
[Firefox-first methodology](../firefox-profiling.md): installed browser, fresh
profile, closed DevTools, matched display, a valid unchanged baseline, and at
most three trials per comparison. Use boot marks for startup and native input
for scroll claims. Raw captures stay temporary.

## Verification

The cleanup verifies retained evidence hashes, exact reconstruction of removed
source duplicates, and the absence of remaining raw artifacts. The v0.4.12
runtime source hash remains
`e3b364d2b09923e81d9c5f2de3016f6ed168b805957ad88650fa0fe5b3408ac0`.
Only documentation and ignored artifacts change; no application or profiling
code changes and no browser process starts. Code and browser test suites are
therefore not rerun for this audit.
