# Post-integration hardening audit

## Executive summary

This round starts from `9407fbe` with `markdown-viewer` pinned to v0.2.4.
The review covers runtime transaction and cancellation boundaries, paging,
geometry, measurement ownership, companions, integrations, and recent demo
streaming changes. It does not re-audit the separate renderer repository.

Four medium findings were reproduced and fixed. No high finding was
identified. Final verification and the performance comparison are recorded
below. The review is scoped evidence, not proof that every input and browser
behavior is defect-free.

> Review the added tests before merging. Automated audits can miss defects
> or encode an incorrect expectation.

## Findings and resolution

These findings concern observable correctness, failure recovery, and missing
regression coverage. Style preferences alone are not medium findings.

### 1. Short lists cancel their own start load

Location: `src/reach.ts`, `ReachController.check`. Category: correctness and
async error coverage. Severity: medium. The unconditional opposite-edge
abort cancelled start requests when both 800 px proximity zones overlapped,
even without an end callback. An empty or short list could never load its
first start page through the supplied signal.

The old path called `abort(opposite)` whenever an edge first entered its
zone. The fixed path requires `distance <= ENTER_PX` and
`oppositeDistance > ENTER_PX`. Cancellation remains active after crossing
the overlap, without refiring an already delivered reach.

Five new tests failed against the original implementation. Coverage now
includes empty lists, overlap boundaries, simultaneous short-list reaches,
leaving the overlap, disposal, and reentrant abort listeners. The browser
regression uses the real `createVirtualList` and `createPagedWindow` APIs
for 0-, 1-, and 8-row initial windows.

### 2. Sticky-header render failures leak or leave blank content

Location: `src/companions/sticky-headers.ts`, construction, `setActive`,
`setIncoming`, and `updatePosition`. Category: error recovery and assertions.
Severity: medium. An initial render failure left an overlay attached without
a returned handle. Later failures recorded an ordinal before rendering
succeeded, so later refreshes could leave an empty slot indefinitely.

The original order was `activeGroup = ordinal; fillSlot(...)`. The fixed
order records the ordinal only after success. Construction cleans up before
rethrowing. Later failures hide the overlay, restore inline headers, and
invalidate the last scroll position so the next publication can retry.

Initial rendering and active/incoming retry tests failed before the fix.
A second pass also reproduced a blank previous header after scrolling back
from a failed render. That test now passes. Default scroll sampling remains
before callbacks or DOM writes, with an additional ordering regression.

### 3. Destroyed companions can hide live headers again

Location: `src/companions/sticky-headers.ts`, `destroy`, public methods, and
`hideInlineFor`. Category: lifecycle correctness. Severity: medium. A late
refresh could suppress inline headers after the overlay was removed.
Destruction or disablement from a render or element-lookup callback had the
same risk.

The fixed companion records disposal before cleanup. Public methods become
no-ops, and in-progress rendering and lookup stop before suppressing inline
content. New tests reproduce late refresh and reentrant lookup failures.
They also cover disposal during rendering, repeated method calls, and
disable/re-enable recovery after either callback changes state.

### 4. Mutable header-key arrays bypass cache invalidation

Location: `src/companions/sticky-headers.ts`, `refresh`. Category: state
ownership and missing edge coverage. Severity: medium. The old `keys =
nextKeys` assignment retained the host array. If the host replaced a key in
that array at the same geometry, comparison saw identical arrays and kept
the old rendered label.

The companion now uses `keys = [...nextKeys]` when keys or geometry change.
A new test changes `a` to `b` in the same host array and requires the overlay
to display `b`. It failed before this fix. Unchanged refreshes still retain
their existing overlay nodes.

## Iteration record

Each pass reviews the affected behavior and its surrounding lifecycle.
Regression tests assert signals, committed items, visible content, and
cleanup rather than private call counts.

| Pass | Result |
| --- | --- |
| Initial review | Reproduced short-list cancellation, header render failures, and post-destroy inline suppression. |
| Recovery review | Reproduced backward-scroll recovery after a partial render failure. Added reentrant cancellation and render-disposal coverage. |
| Ownership review | Reproduced reused-key-array invalidation, disposal inside element lookup, and disable/re-enable failures during callbacks. Preserved pre-write default scroll sampling. |
| Final review | Rechecked fixes, cancellation boundaries, failure fallback, source ownership, and regression isolation. No remaining high or medium findings in the reviewed scope. |

## Test coverage and property-based opportunities

The suite grows from 934 to 951 unit tests without a new dependency.
The new browser regression covers empty and short start-page loading.
No line-coverage percentage is claimed. The existing configuration resets
mocks globally, and `pnpm run check` includes test files in type checking.

The test review follows the error-handling, async-testing, test-doubles, and
property-based-testing guidance from `accelint-ts-testing`. The existing
geometry tests already compare positioned membership with interval
intersection and compare optimized anchors with source-order lookup.
Streaming display normalization already has idempotence examples.

Future generated tests can extend mixed geometry-operation sequences and
transcript export/import round trips. `fast-check` is not installed, and this
round adds no package for that optional work. These are coverage opportunities,
not unresolved demonstrated correctness failures.

## Verification

Formatting, lint, application/test type checking, all 951 unit tests, all 24
portable profiling checks, and both isolated source-consumer builds pass.
The renderer package still emits its existing omitted-source-map warnings.

The focused browser runs cover Firefox 153.0, Chromium 151.0.7922.34, and
Playwright WebKit 26.5. The new short-list paging regression, existing
sticky-header handoff regression, and paged streaming consumer regression
pass in all three engines. Native Safari and real trackpad momentum are
not tested in this round.

## Native Firefox performance

The capture uses Firefox 155.0.1, a fresh temporary profile, closed DevTools,
and native macOS input on the LU28R55. The display is 1920 × 1080 logical
pixels at 2× scaling and 60 Hz. The measured browser window is 1900 × 1049,
with a 1900 × 965 content viewport.
The synthetic fixture imports 160 turns with tables, code, math, tool panels,
and local PNGs. This is rich-history scrolling, not active trail animation.

The baseline and repeat use the same command against an isolated Vite server:

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url=http://127.0.0.1:4193/demos/streaming/ --layout=none \
  --setup=scripts/firefox-profile/fixtures/rich-chat.js --warmup-ms=2000 \
  --down=0 --up=10 --ticks=120 --live
```

The initial short run `run-34pKAd` did not reach paging and is excluded from
the comparison. The first repeat `run-kPcNtk` recorded a 32.6 ms interval,
with verification tasks near startup. It is retained locally but not used
to claim a regression or improvement. The table compares the original
baseline with two isolated repeats. The intermediate repeat precedes the
last disable/re-enable guards; the final repeat includes every source change.

| Metric | Baseline `run-OblO0U` | Intermediate `run-AjyA3m` | Final `run-ScfvvQ` |
| --- | --- | --- | --- |
| Measurement duration | 31.560 s | 31.535 s | 31.411 s |
| Frame interval p95 / maximum | 17.28 / 17.62 ms | 17.02 / 17.64 ms | 17.10 / 17.58 ms |
| Frame intervals above 25 ms | 0 | 0 | 0 |
| Scroll events / scroll ends | 1182 / 11 | 1184 / 11 | 1185 / 11 |
| Programmatic scroll corrections | 1 | 1 | 1 |
| Content main-thread CPU time | 671.836 ms | 760.066 ms | 671.400 ms |
| Average content main-thread CPU, one core | 2.129% | 2.410% | 2.137% |
| Active-input CPU p95 per 100 ms, one core | 6.063% | 7.154% | 5.606% |
| Scroll-handler p95 / maximum | 0.377 / 2.309 ms | 0.442 / 2.281 ms | 0.412 / 1.737 ms |
| Runtime nearest-JavaScript sample share | 0.349% | 0.403% | 0.656% |

All three runs reach the same scroll positions after each input burst. A
start-page load increases the scroll height from 21,400 to 39,664 px, with
one anchor correction. This confirms actual movement and paging rather
than a stationary frame-timing sample.

Final content-thread CPU time is effectively unchanged from the baseline.
Runtime-attributed samples increase, while total CPU and frame timing do
not show a corresponding increase. This sampled attribution includes native
descendants of JavaScript frames; it is not an isolated runtime CPU timer.
The intermediate CPU result also shows run-to-run variation. These captures
do not establish either a performance gain or a causal performance regression.

Raw captures remain ignored under `browser-artifacts/firefox/`. CPU figures
measure one content thread, not the whole application. Regular animation
frames do not prove smooth physical presentation, and one paired comparison
does not establish a performance gain. No performance optimization is made
in this correctness round.

All five captures completed, and their temporary browser profiles were
removed. The regression browsers and isolated Vite server were closed.
The process audit found no remaining audit browser or native helper; the
pre-existing development server was left running.
