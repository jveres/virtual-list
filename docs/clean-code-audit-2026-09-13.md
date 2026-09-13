# Clean-code audit: September 13, 2026

This audit reviews the working tree on `feat/streaming-integration`, including
the pending streaming consumers, paging extension, and integration helpers.
The review finds and fixes four medium-severity source issues and one
medium-severity test-isolation issue. Follow-up review finds no remaining high-
or medium-severity finding in the reviewed scope. Verification is complete, with
the initial intermittent browser warning and subsequent repeats recorded below.

The audit preserves the existing integration work, the confirmed prepend
rounding fix, and the date-pill revert. It adds no public runtime API or
dependency. Changes remain uncommitted.

## Scope and severity

The review traces source ownership, asynchronous operations, and cleanup through
these areas:

- Runtime submission, detached preparation, commit, rollback, and disposal.
- Pager source edits, overlapping pages, cursors, trimming, and cancellation.
- Follow and command settlement, geometry queries, and companion boundaries.
- Standalone streaming examples, composer sizing, and renderer lifecycle.
- Main chat send/edit/regenerate flows and chat/gallery settings parsing.
- Consumer import boundaries, regression ownership, and relevant unit coverage.

High severity means a substantial data-integrity or lifecycle failure across
normal use. Medium severity means a reproducible failure in a supported path,
or an error-handling gap that leaves the application unable to recover.
File length and cosmetic preferences alone aren't medium-severity findings.

This is a scoped code audit, not a dependency security assessment or a guarantee
that every possible defect has been discovered. It doesn't certify production
credential handling or native scrolling performance.

## Fixed findings

Each finding has a regression that fails before its fix. The tests use the real
runtime or actual demo pages, without exporting implementation details.

| ID | Severity | Category | Location | Impact and fix |
| --- | --- | --- | --- | --- |
| CC-01 | Medium | Async source ownership | [`src/paging.ts`](../src/paging.ts) | A normal `updateItem` during detached preparation silently drops the fetched page. Track every committed source revision, not only live tokens, and retry preparation against current source data. |
| CC-02 | Medium | Lifecycle cleanup | [`examples/streaming-basic/main.ts`](../examples/streaming-basic/main.ts) | A failing final render leaves Send disabled and the stream busy. Always release controls in a nested `finally`. Apply the same cleanup protection to the main chat's finalization. |
| CC-03 | Medium | Input validation | [`demos/streaming/streaming.ts`](../demos/streaming/streaming.ts), [`demos/gallery/gallery.ts`](../demos/gallery/gallery.ts) | Stored JSON `null` crashes startup. Parse as `unknown`, accept only non-null, non-array objects, and validate gallery concurrency as a number before membership checks. |
| CC-04 | Medium | Async error handling | [`demos/streaming/streaming.ts`](../demos/streaming/streaming.ts) | Render failure during send preparation escapes as an unhandled rejection. Send, edit, and regenerate now share a caught event boundary. Await the pin/fly-in operations together so the pin completion branch isn't detached. |
| CC-05 | Medium | Test isolation | [`scripts/regressions/feed/feed-regression.mjs`](../scripts/regressions/feed/feed-regression.mjs) | Standalone renderer fixtures shrink the live feed viewport because they become flex siblings. Position fixtures outside normal flow and assert that the viewport height stays unchanged during mounting and image decoding. |

### CC-01: Staged paging and concurrent edits

The original retry condition compares only `liveRevision`. The new regression
starts a real measured page load, advances one frame, and edits a retained item
through `updateItem`. Before the fix, the load resolves `false`. After the fix,
it resolves `true`, retains all 40 items and the new text, and fetches cursor 20
exactly once. The same parameterized test covers `updateItemLive`.

The change increments `sourceRevision` when source pages commit and when live
data is submitted. It doesn't add a second queue, renderer, or geometry cache.
Aborted and disposed operations still exit without retrying.

### CC-02: Failed finalization

The browser regression injects two renderer failures: one during token output
and one during finalization. Before the fix, the error is reported but Send
stays disabled. After the fix, Send is enabled, Stop is disabled, and a reset
followed by another send produces a complete response in all three engines.

The main chat receives the same nested cleanup structure so finalization and
persistence can't skip release of its active stream controls.

### CC-03: Stored settings

Separate Firefox runs reproduce null-property startup errors in both chat and
gallery before their respective fixes. The browser regression also exercises
arrays, malformed JSON, and an invalid object-valued concurrency setting. These
values fall back to defaults without deleting the stored data.

### CC-04: Main chat error boundary

A one-shot failure in the Markdown DOM insertion during a new send reproduces
an unhandled rejection before the fix. After the fix, the demo reports the
failure once through its error boundary, restores its Send state, and accepts
another message. The regression checks that the retry produces a new reply,
not merely that old messages remain visible.

### CC-05: Feed renderer fixture interference

The first full browser pass reports one WebKit ResizeObserver undelivered
notification in the feed regression. Six focused repeats pass before any
application change. That intermittent notification's exact cause isn't proven.

Investigation finds a deterministic test-isolation defect: standalone renderer
fixtures are appended as flex siblings of the live feed. A new invariant check
fails in Firefox at the 375-pixel image-grid case because fixture insertion
changes the live viewport's height. Fixed-position fixtures preserve the same
renderer styling and width without resizing the application. The regression
now asserts stable viewport height for text fixtures and through image decoding.
Failure messages also identify the active test phase.

This is a harness fix, not a claimed runtime observer or performance fix. No
error is filtered or suppressed. Existing image-height and grid assertions
remain enabled.

## Audit iterations

The audit separates lint success from behavioral evidence:

1. Baseline: type/lint checks, 914 unit tests, and 24 portable profiling-tool
   checks pass. Manual source tracing still identifies the four source issues.
2. Reproduction and fixes: the paging test and browser fault-injection tests
   fail for their intended reasons before each corresponding fix. Focused
   repeats pass after the fixes.
3. Second source pass: recheck revision ownership, abort exits, callback
   exceptions, input validation, promise ownership, and test assertions.
   No additional high- or medium-severity source finding is identified.
4. Broader browser verification identifies CC-05. Add a failing invariant check,
   isolate the fixtures, and repeat the complete feed regression. Review the
   resulting test changes without changing runtime observer timing.
5. Final verification: complete the broad coverage, five feed repeats, and the
   final 108-case refresh-anchor repeat. Recheck the modified source and test
   paths. No further high- or medium-severity finding is identified.

Final finding counts: zero open high, zero open medium; five medium findings
fixed. The isolated WebKit observer notification remains an observation with an
unproven exact cause, not a claimed runtime fix.

## Test review

The added paging case closes an async-coverage gap: the previous live-only test
passes even when structural edits lose a fetched page. Parameterization covers
both public update APIs with exact result, item-count, content, and fetch
assertions. The fake timers advance awaited asynchronous work; the pager and
runtime themselves aren't mocked. Repository mock cleanup remains enabled.

The browser tests operate on actual example and demo pages. Fault injection is
limited to isolated browser contexts, restores the affected DOM setters, and
checks error recovery as well as error reporting. These patterns follow the
testing guidance's async-testing, test-doubles, and organization references.

The test-review findings are the missing structural-edit coverage underlying
CC-01 and the fixture isolation in CC-05. Their impact is missed async races and
unrelated observer activity during renderer assertions, respectively. Both are
fixed through public behavior checks. No test-only runtime export, assertion
relaxation, or error suppression is introduced.

> Review the new tests and their assertions before merging. Generated test
> coverage can still miss behavior or encode an incorrect expectation.

### Property-based testing opportunity

Generated page-overlap sequences could extend the existing deterministic pager
tests. Useful invariants are unique exposed source keys, preserved local edits,
protected-row retention, and no cursor gaps after whole-page eviction. This is
optional additional coverage, not an unresolved medium finding. `fast-check`
isn't installed; this audit doesn't add a testing dependency.

## Verification

These verification checks pass:

- `pnpm run check`: formatting, lint, and repository type checks.
- Direct strict TypeScript checking of `tests/unit/virtual-list.test.ts`.
- `pnpm test`: 915 tests across 39 files.
- `pnpm run build`: production build.
- `pnpm run test:consumer`: both copied, isolated source consumers build.
- `pnpm run test:firefox-profile`: 24 portable checks.
- `pnpm run test:regression-runner`: 11 runner checks.
- Focused streaming consumers: all three scripts pass in Chromium, Firefox,
  and WebKit, including final-render failure recovery.
- Expanded settings/send recovery regression: passes in all three engines.
- Final affected chat-content/chat-editing repeat: 18 scripts pass.
- Feed fixture-isolation fix: five consecutive complete Firefox/WebKit repeats
  pass with viewport-height invariants and all error assertions enabled.
- Final refresh-anchor repeat: all 108 Firefox scenarios pass.

The broad run executes all 76 scripts discovered when it starts: 75 pass and
the feed script reports the single WebKit observer notification described in
CC-05. After the harness correction, five feed repeats pass. The newly added
77th script, `demo-error-recovery`, passes separately in all three engines.
Every current regression script therefore has a passing result across the broad
run and focused repeats; this isn't a claim of one clean 77-script sweep.

The initial expanded send-recovery test used a single-element locator for a
multi-segment reply; the corrected assertion joins all Markdown segments and
requires a new, nonempty reply. No application change was needed for that test
correction. Known upstream missing-source-map warnings don't fail the unit suite.

Browser checks use runner-owned fresh Vite servers and isolated Playwright
engines. They test behavior, not native trackpad momentum, CPU cost, or smooth
physical presentation on the external display. No native performance patch is
proposed or claimed in this audit.

The final process audit finds no owned regression workers, test browsers,
automation sessions, or test servers left running. The pre-existing development
server remains untouched. The audit doesn't modify the user's regular browser
profile or remove existing profiling captures.
