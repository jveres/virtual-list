# Verification reports

These records preserve measured results, audit findings, and rejected
approaches for specific revisions and workloads. They aren't current API
specifications or a promise that every historical observation still applies.
Use the [consumer guide](../streaming-consumer.md) and
[API reference](../integration-api.md) for integration, and the
[release plan](../streaming-integration-plan.md) for current release status.

## Streaming integration evidence

These reports support candidate `9af905c`, whose application source is
unchanged from `732e143`. They distinguish fresh candidate checks from
earlier native captures and preserve each investigation's limits.

| Report | Scope |
| --- | --- |
| [Release review](streaming-release-review-2026-09-13.md) | API/ownership review and the clean 78-script candidate sweep. |
| [Integration Firefox comparison](streaming-integration-firefox-profile-2026-09-13.md) | Eight interleaved native captures against main `7caef9a`. |
| [Safari and scoped typography](streaming-ui-verification-2026-09-13.md) | Installed-Safari composer and matching measurement ancestors. |
| [Prepend anchor shift](prepend-anchor-shift-2026-09-13.md) | Rounding diagnosis, regression coverage, and user acceptance. |
| [September 13 clean-code audit](clean-code-audit-2026-09-13.md) | Five resolved findings included in `732e143`; historical working-tree status. |

## September 14 runtime review

The static review below lists candidates after the streaming integration.
The measurement follow-up separates demonstrated gains from rejected or
unproven proposals. The implementation report records the bounded hidden-row
patch and its fresh comparison. The other candidates remain unchanged.

| Report | Scope |
| --- | --- |
| [September 14 runtime static review](runtime-static-review-2026-09-14.md) | Six ranked candidates at `6fc4434`, led by detached streaming measurement; no source changed. |
| [September 14 candidate measurements](runtime-candidate-measurements-2026-09-14.md) | Paired external-display Firefox captures: retention CPU gain, staging frame-cost regression, and remaining evidence limits. |
| [Hidden streaming row implementation](hidden-streaming-row-2026-09-14.md) | Bounded retention, lifecycle coverage, WebKit Find limitation, and a 28.4% median CPU reduction in six fresh native captures. |

## Earlier investigations

Keep these records for their evidence and design lessons. Old test counts,
working-tree notes, and next steps describe the investigation at that time,
not outstanding release gates. The latest release review supersedes earlier
candidate status; it doesn't erase earlier failures or measurements.

| Report | Scope and context |
| --- | --- |
| [Initial integration checkpoint](streaming-integration-checkpoint.md) | Earlier browser results and CPU variance, followed by the later comparison above. |
| [September 13 runtime scroll audit](runtime-scroll-audit-2026-09-13.md) | Seven native captures on `cad7e6e`, before this integration. |
| [September 11 clean-code audit](clean-code-audit.md) | Core review and stale development-server renderer diagnosis. |
| [Core/runtime performance audit](core-runtime-audit.md) | Indexed anchors, stacked entrants, and deferred architecture proposals. |
| [Measured performance proposals](measured-performance-proposals.md) | Retained changes and rejected experiments; its Markdown-height failure is resolved in the later clean-code audit. |
| [Runtime hot-path profile](runtime-hot-path-profile.md) | September 10 capture attribution and limits, including an unavailable historical fixture. |
| [Markdown history profile](markdown-profile.md) | Startup and heap observations at `822a026`; not incremental streaming measurements. |
| [Runtime performance checkpoint](performance-checkpoint.md) | Simple-row update costs and acceptance at `822a026`. |
| [Demo performance audit](demo-performance-audit.md) | September 6 multi-demo measurements, resize/gallery fixes, and unresolved physical-presentation limits. |

Raw profiles, screenshots, and trace data remain local under ignored
`browser-artifacts/`. Follow the [Firefox workflow](../firefox-profiling.md)
for new investigations. Add future curated reports here with their revision,
workload, results, and limitations; link them from this index.
