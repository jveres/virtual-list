# Runtime exploration closeout, October 2, 2026

The concrete queue from the cleanup audit and virtualization research is
closed. Two further changes earn implementation: bounded preparation inside
exceptionally large tables, and a larger exact-row preparation slice while
the list is at rest. Other candidates fail a measurement or behavior gate,
or do not target a demonstrated remaining cost under the current contract.

This is a disposition of the investigated workloads, not proof that every
possible renderer, device, or browser is optimal. No measured gain is left
waiting for implementation, and no experiment from this queue remains open.

## Decisions

| Investigation | Decision and evidence |
| --- | --- |
| Longer measured paging without forced collection during the run | Closed by the [480-cycle control](runtime-measured-paging-duration-2026-10-02.md). Early process-memory growth reverses naturally. Active items and disposal stay bounded. No patch follows. |
| Fixed-column table layout | Rejected by the [matched comparison and restored control](constrained-table-layout-2026-10-02.md). Equal column geometry and content yield no useful overall CPU saving. |
| Nested first layout of a large table | Retained in [v0.4.15](https://github.com/jveres/virtual-list/releases/tag/v0.4.15). The worst preparation frame gap falls from 50.6 to 18.1–18.3 ms. The [report](large-table-staging-2026-10-02.md) records the 189 ms readiness cost and increased total CPU. |
| Nested first layout of a large code fence | Rejected in the same comparison. A 184 ms gap remains while readiness rises from 317 to 1,092 ms. Synchronous renderer work still dominates. |
| Estimated geometry for a large loaded history | Measured with a [pinned TanStack reference](history-preparation-2026-10-02.md). Rendering only four initial rows saves substantial preparation work, but leaves a 500 px extent error in this fixture. Width-anchor restoration is verified. This is a different contract, not a production replacement for exact geometry. |
| Exact-row preparation at rest | A new finding from the history baseline, retained in [v0.4.16](https://github.com/jveres/virtual-list/releases/tag/v0.4.16) after candidate and identical-source repeat: 5,000 rows prepare in 2.66–2.67 seconds instead of 10.46 seconds, with 64–66% less preparation CPU. Active-scroll and time-budget limits stay in place. |
| Scroll-seek placeholders | Closed without a production experiment: the relevant entering-content bottleneck is not established in the measured workloads. The evidence and behavior gate are below. |
| Additional batching increases | Not justified by the retained candidate's individual layout costs, which reach 18–24 ms in the 1,000-row case. The existing time budget excludes the final warm layout read. No larger-cap search is opened. |

Cross-item pooling, block skipping, smaller width-reflow batches, pager
allocation substitutions, and runtime data-structure alternatives already
have dispositions in the [earlier audit](runtime-investigations-2026-10-02.md),
[pooling report](declared-pooling-2026-10-01.md), and
[rendering follow-up](runtime-rendering-allocation-2026-10-02.md). No new evidence
supports reopening those completed comparisons.

## Why placeholders do not earn a patch

[Virtuoso's scroll-seek mechanism](https://virtuoso.dev/react-virtuoso/virtuoso/scroll-seek-placeholders/)
substitutes equal-height placeholder content during fast travel and restores
the readable row when seeking ends. That can help when entering content is
expensive. It deliberately changes visible content and introduces restoration
work. Its documentation was checked on October 2, 2026.

The current measured-row runtime builds and retains each row's own DOM.
Scrollback remounts it. The unchanged-core October 2 huge-row baseline
`browser-artifacts/huge-row-baseline/run-lOlLWu/` renders exactly 25 rows in each
case and still has 25 active rows after four traversals; none are destroyed
during the exercise. Ordinary, many-block, code-fence, and table traversals
each record zero gaps above 25 ms, with maxima below 17.7 ms. That is API
traversal evidence, not a native-speed or physical-presentation measurement.

The separate [native fast-scroll attribution](fast-scroll-exploration-2026-09-29.md)
records 20 mounts and 20 unmounts with no individual row operation above 2 ms.
It is historical evidence at its recorded revision, not a fresh v0.4.15 timing
claim. Its browser-skipping candidate increased total CPU, and the
[declared-feed pooling comparison](declared-pooling-2026-10-01.md) also found no
useful overall saving from avoiding its entering card-tree creations.

These observations do not establish a placeholder speedup or prove that one
is impossible. They fail the prerequisite for adding content substitution to
this runtime. The long pauses reproduced here occur during preparation or
renderer work, before ordinary scrollback. Preparation staging addresses the
table case without removing readable content after reveal. A newly reproduced
expensive entering renderer would be new evidence, not an unfinished trial
in this queue.

## Bounds and cleanup

The remaining large-code cost is synchronous host/renderer work. The tested
DOM slicing mechanism does not divide it. Deferred rendering or provisional
geometry needs a host contract that accepts that behavior; no such behavior
is silently added to the list API. Real-device momentum, the historical
intermittent navigation symptom, and the user-stopped external-display jitter
investigation are not resolved by callback timings in these experiments.

The initial [cleanup](runtime-remaining-scope-2026-10-02.md) removes 405.21 MiB
of raw or obsolete local artifacts while preserving evidence hashes and
reconstructable inputs. Subsequent captures retain compact summaries, source
patches, hashes, commands, and display metadata. Capture runners remove raw
profiles, fresh browser data, helpers, and caches when each run ends. Durable
fixtures and regressions are tracked. The pre-existing development server
is preserved.

The individual reports record browser versions, matched LU28R55 geometry,
trial counts, validation, and measurement limits. Further work should start
from a new reproduced cost or an explicitly changed behavior contract.
