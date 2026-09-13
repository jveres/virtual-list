# Clean-code audit

> Verification record, not current API guidance. Results and status apply
> to the revision and workload described below. See the
> [release plan](../streaming-integration-plan.md) for current release status.

The September 11, 2026 follow-up reviews the pending core performance changes,
their tests, and the runtime's state and resource ownership. It also checks
the streaming markdown regression and selected demo security boundaries.
No high- or medium-severity source finding remains in the reviewed scope.
This is a scoped code review, not a guarantee that every possible defect or
dependency vulnerability has been discovered.

## Markdown-height regression

The existing server on port 5173 serves an older `markdown-viewer` build.
In an isolated Firefox session, a viewer created from that server has no
height guard and retains no inline minimum height. Its standalone content
shrinks from 800 to 400 pixels.

The installed, locked `markdown-viewer` dependency already contains the guard,
and `demos/streaming/message-content.ts` already enables
`preserveStreamingHeight`. A fresh Vite server on port 5174 with a separate
cache under ignored `browser-artifacts/` passes the unchanged regression.
Both cursor modes retain heights of 800, 800, 800, and 1200 pixels through
shrinkage and growth, and retain 1200 pixels at completion. Separate Chromium
and WebKit repeats produce the same results.

No renderer patch, dependency change, duplicate adapter guard, or relaxed
assertion is needed. Restart a stale development server after dependency
changes; `pnpm exec vite --force` rebuilds its optimized dependencies. Use
`pnpm run test:regression -- --group=runtime --match=streaming-height` for a
runner-owned server instead of reusing an unverified long-running server.

## Review scope and results

The review follows data from submission through preparation, commit,
reconciliation, and disposal. It checks these areas:

- Geometry and positioned-anchor lookup: source-order ties, exclusions,
  overlap fallback, fractional boundaries, and visibility-cache ownership.
- Stacked reconciliation: surviving rows, both entrance spans, geometry
  invalidation, failed-render retries, and lifecycle callback ordering.
- Runtime transactions: held versus committed snapshots, incremental staging,
  cancellation, rollback, queued callbacks, and teardown failures.
- Paging and motion: protected source rows, cursor ownership, aborts, command
  settlement, follow intent, resize takeover, and timer/listener cleanup.
- Demo boundaries: markdown rendering, tool output, attachments, generated
  file references, feed URLs, and persisted settings/history validation.

The two retained core changes reuse existing indexes and range state. They
do not introduce a second cache or change gesture timing. Host exclusion
callbacks keep their original source-order effects unless purity is
explicitly promised. Incomplete reconciliation cannot enable the stacked
intersection shortcut on its next attempt.

The architecture candidates in the
[performance audit](core-runtime-audit.md#architecture-assessment) remain
follow-up design choices, not correctness findings. In particular, combining
preparation ownership needs a dedicated change that preserves rollback and
the distinction between accepted input and committed geometry.

## Test review

The modified tests use exact membership, identity, lifecycle, and error
assertions. Mock cleanup is configured globally. Type checking covers the
repository tests and directly checks both modified test files.

Three additional parameterized cases compare indexed anchor lookup against
the source-order path across one, two, and five lanes, three source-order
permutations, four exclusion patterns, and fractional top/bottom boundaries.
The deterministic equivalence sweep complements the explicit overlap,
empty-layout, callback-failure, and visibility-cache cases. Generated oracle
testing is useful here; the sweep adds that coverage without introducing a
new testing dependency.

## Security checks

The security pass distinguishes executable input from text and sanitized
markdown. It finds no high- or medium-severity issue in these checks:

- No hardcoded credential is identified in the scanned application sources.
- No SQL execution boundary exists in the reviewed browser application.
- Dynamic HTML uses the markdown renderer or fixed UI markup. Tool names,
  ordinary tool output, filenames, and other labels use text insertion.
- Imported attachments validate MIME/name agreement, size, count, and encoded
  data. Generated-file references validate IDs, use a fixed authenticated
  origin with redirects rejected, and download non-executable blobs.
- Feed links restrict URL protocols, and continuation endpoints stay within
  the selected source's allowlist.
- `pnpm audit --json` reports zero known vulnerabilities across 140 reported
  dependencies. Registry auditing does not establish the absence of issues
  in Git-sourced packages or undisclosed vulnerabilities.

API keys remain client-side demo settings, not a production credential
architecture. The review does not certify this browser demo as a multi-user
backend or change its documented trust model.

## Verification

The final verification passes all of these checks:

- `pnpm run check`: formatting, lint, and repository type checks.
- Direct TypeScript checking of both modified test files.
- `pnpm test`: 869 tests across 35 files.
- `pnpm run test:firefox-profile`: 12 portable checks.
- `pnpm run test:regression-runner`: 11 runner checks.
- The complete browser regression suite: 68 passed, zero failed or skipped.
- Separate Chromium and WebKit streaming-height repeats, both cursor modes.
- `pnpm audit --json`: zero known vulnerabilities.

The owned test browsers and isolated server are closed. The existing server
and regular Firefox session are preserved. Raw performance evidence and the
isolated dependency cache remain local under ignored `browser-artifacts/`.

Browser regressions test correctness with Playwright engines; they do not
establish native gesture or physical display performance. The separate native
evidence remains in the performance audit. Upstream missing-source-map
warnings do not fail the unit checks.
