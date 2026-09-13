# Streaming integration release review — September 13, 2026

> Verification record, not current API guidance. Results and status apply
> to the revision and workload described below. See the
> [release plan](../streaming-integration-plan.md) for current release status.

The API and ownership review finds no blocking API issue in candidate
`9af905c` on `feat/streaming-integration`. The implementation remains
`732e143`; `9af905c` adds the API reference, browser evidence, and reusable
verification scripts. The comparison baseline is main commit `7caef9a`.
This review does not authorize a merge, tag, or package publication.

## Public surface and compatibility

The source declarations and implementation match the
[API reference](../integration-api.md), with these changes from the baseline:

| Surface | Added or changed contract | Migration impact |
| --- | --- | --- |
| Core `VirtualList.updateWindow` | Optional third-argument `protectPin`, default `true`; `WindowUpdateContext.protectedItems` reflects that policy. | No opt-out by default. `false` still protects visible/overscan rows and explicit targets, including staged-commit revalidation. |
| Paging | `PagedWindowOptions.trim`, `PagedWindowOptions.live`, and `PagedWindow.updateItemLive`. | Existing consumers retain pin protection and queued structural edits. Live submission is opt-in and isn't a geometry-commit promise. |
| Sticky headers | Supported `createStickyHeaders`, `StickyHeaders`, and `StickyHeadersConfig`; `observeScroll` defaults to `false`. | Wire runtime snapshots. The old demo wrapper retains its native-listener default. |
| Reading anchors | `captureItemPlacement`, `replacementAnchor`, `ItemPlacement`, and `KeyReplacement`. | Additive geometry readers. The host supplies replacement identities and fallback policy. |
| Composer | `autosizeTextarea` and `TextareaSizeOptions`. | Optional DOM helper; finite positive border-box bounds and explicit call timing. |
| Collapse | `prepareUserMessageCollapse`, `mountUserMessageCollapse`, `unmountUserMessageCollapse`, and `syncUserMessageCollapse`. | Optional five-line chat-markup adapter, not a generic renderer lifecycle. The old demo module re-exports it. |
| Streaming text | `streamingMarkdownText` and `EMBEDDED_IMAGE_PATTERN`. | Display-only normalization and syntax matching, not sanitization or storage transformation. |
| Entry points and styles | `src/index.ts`, `src/companions/index.ts`, `integrations/index.ts`, companion styles, Markdown styles, and collapse styles. | Source-based imports; the package remains private. Core types and existing paging types are re-exported, not new runtime concepts. |

The core barrel exports `createVirtualList` and the existing public types:
`AnchorPolicy`, `AnchorRequest`, `Edge`, `EdgeSlot`, `ExplicitAnchor`,
`FollowMode`, `GeometryViewport`, `ItemPosition`, `ReachContext`,
`RemeasureOptions`, `ScrollingUpdates`, `ScrollOptions`, `ScrollTarget`,
`VirtualList`, `VirtualListOptions`, `VirtualListState`, `WindowUpdate`, and
`WindowUpdateContext`. The companion barrel also re-exports existing
`createPagedWindow`, `Page`, `PageBoundary`, `PagedWindow`, and
`PagedWindowOptions`. Internal DOM utilities aren't supported entry points.

The review checks defaults, return timing, error handling, cancellation,
ownership, styles, and disposal. Documentation corrections clarify that
queued edits see submitted live source data, that live submission doesn't
override the runtime's update policy, and that Safari/scoped-typography
verification has completed for the recorded scenarios.

The existing row-rounding fix is a behavior change, not a new API. Its
scope and evidence remain in the
[prepend investigation](prepend-anchor-shift-2026-09-13.md).

## Runtime and application ownership

The full streaming demo uses supported companion imports and public runtime
declarations. Its direct `src/virtual-list` import uses public symbols;
the standalone consumers use the supported barrels. No core dependency
imports demos, integrations, or the Markdown renderer.

The review traces send, token updates, paging, branch replacement, explicit
navigation, and disposal. The demo doesn't write the list viewport's scroll
position or run a separate animation-frame correction/follow controller.
The pager owns retained source pages; live edits update all overlapping
owners. Source replacement disposes that ownership before recreating it.

The remaining application logic has explicit product responsibilities:

- Conversation trees, selected branches, timestamps, source cursors, and the
  full transcript archive belong to the application.
- Providers, cancellation epochs, persistence, attachments, loader appearance,
  and synthetic latency aren't runtime infrastructure.
- Late-token reconciliation restores authoritative source content after a
  fetched page commits; it doesn't correct geometry.
- Tree-heading navigation measures a mounted heading on explicit navigation
  and submits the destination through runtime `scrollTo`. Prompt stepping
  selects a product-specific key using committed positions.
- Sticky headers use runtime snapshots. Composer sizing, collapse preparation,
  and renderer handles use the separate UI layer and documented lifecycle.

No additional core extension, companion abstraction, or example app is
needed to resolve the five original integration concerns.

## Candidate verification

The following commands run against the application and tests in `9af905c`.
Subsequent working-tree edits are documentation only.

| Check | Result |
| --- | --- |
| `pnpm run check` | Passed. |
| `pnpm test` | 915 tests in 39 files passed. |
| `pnpm run build` | Passed, including the three existing consumers. |
| `pnpm run test:consumer` | Both isolated source-consumer builds passed. |
| `pnpm run test:firefox-profile` | 24 portable checks passed. |
| `pnpm run test:regression-runner` | 11 runner checks passed. |
| `pnpm run test:regression` | One complete sweep: 78 passed, zero failed, zero not run. |

The unit suite still reports the known upstream Markdown viewer missing
sourcemaps. They aren't new runtime failures. Browser regressions use each
script's declared engine coverage; not every script covers all three engines.
Device emulation and mocked provider/sharing paths don't establish
physical-device, native share-transfer, or live-provider behavior.
Expected injected-render failures appear in the error-recovery test logs;
the recovery assertions pass. The sweep includes all 108 refresh-anchor cases.

The final process audit finds no regression workers, Playwright browsers,
Safari driver, or task-owned server remaining. The pre-existing Vite server
is preserved. The repository formatter makes no changes; application and
test source remain identical to the pushed candidate.

## Native evidence and release decision

There is no application or profiling-tool source diff between `732e143` and
`9af905c`. The [native Firefox comparison](streaming-integration-firefox-profile-2026-09-13.md)
and [Safari/scoped-typography verification](streaming-ui-verification-2026-09-13.md)
therefore cover the same application source. They weren't rerun or relabeled
as captures taken on `9af905c`.

The Firefox comparison doesn't reproduce the earlier CPU increase. Safari
composer checks and matching scoped measurement ancestors pass. These results
don't establish universal physical smoothness, maximum streaming throughput,
real-trackpad momentum, arbitrary host CSS, or delayed web-font behavior.
Raw captures remain local and ignored.

Technical verification is complete for this branch candidate. Commit the
documentation signoff, obtain the release decision, merge only when authorized,
and verify the exact resulting main commit before an authorized tag.
Source-based distribution remains the approved scope; publication is separate.

## Pre-merge documentation cleanup

The initial review covered 23 Markdown files under `docs/` and validated
102 local file links across documentation, README, and repository instructions.
The user approved consolidation and report reorganization on September 13,
2026. That cleanup is now complete:

- Fourteen verification/audit reports, including this one, moved to
  `docs/reports/`. The [report index](README.md) gives each a scope and
  historical context, including the previously unlinked demo performance audit.
- Current API and workflow guides remain directly under `docs/`.
- The accepted trimming rationale, approval, rejected alternatives, and
  non-chat use case moved into the
  [paging guide](../bounded-paging.md#offscreen-pin-trimming-decision).
  The duplicate proposal file was removed; its original is recoverable from Git.
- SI-02a through SI-02d completion is recorded in the
  [integration plan](../streaming-integration-plan.md), which remains active
  until the merge/release decision is complete.
- Incoming and internal relative links were updated. Reports now distinguish
  revision-specific evidence from current API guidance; original measurements
  and historical outcomes are preserved.

No raw profiling data was deleted or uploaded. This is a documentation-only
cleanup, not another application/browser verification run. The source and
test results above retain their original candidate identity.

Cleanup verification passes `pnpm run check`, `git diff --check`, and checks
of 141 local links, including 14 Markdown heading targets. All 14 reports
retain their evidence tables and code fences. Twelve otherwise change only
links and verification labels; the checkpoint and this review also update
cleanup status. No application, test, dependency, or profiling-tool source
changed.
