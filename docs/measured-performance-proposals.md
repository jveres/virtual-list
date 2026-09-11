# Measured performance proposals

The September 11, 2026 investigation retains two internal changes: cached
staged-input validation and clip wrappers allocated only for mounted rows.
Neither changes the public API or delays synchronous geometry updates. The
remaining proposals stay out of the runtime pending stronger evidence or a
separate API design.

The later [core and runtime audit](core-runtime-audit.md) uses these retained
changes as its baseline and adds algorithmic measurements and architecture
refactoring findings.

## Method and limits

Measurements use installed Firefox 155.0.1, fresh temporary profiles, closed
DevTools, and the external LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
and 60 Hz. The browser content area is 1900 × 965 pixels. Follow the
[Firefox-first workflow](firefox-profiling.md) when repeating these results.

Native scroll captures use the complex streaming-chat fixture: 160 active
turns, 400 branch nodes, local decoded images, tables, code, math, attachments,
and tool panels. Each capture has twelve upward native gestures, 90 events
per gesture, 60-pixel deltas, approximately 16.667 ms between events, and
700 ms settling pauses. Setup and image warmup are outside measurement.
These gestures include release phases, not real trackpad momentum.

Separate CPU comparisons use actual list instances in the installed browser,
160, 1,000, or 10,000 simple rows, and alternating variant order. Their
programmatic scroll commands and frame waits test geometry and lifecycle;
they are not evidence of native gesture release or physical smoothness.
Integer-millisecond browser timers limit small-cost measurements. DOM-node
counts are not heap-byte measurements.

## Retained changes

The retained changes remove repeated work without weakening geometry or
element-lifetime guarantees.

### Staged-input validation

A staged 80-row append checks its source after rendering rows and across
frames. In the instrumented fixture, the unchanged source required 113 array
scans. Caching successful validation reduced this to one scan, while still
performing all 113 cancellation and freshness checks.

At 10,000 source items, baseline scan time was 2–12 ms across five runs; cached
scan time was below the timer's resolution. Overall append completion stayed
around 190 ms: frame scheduling still dominates, so this is a reduction in
validation work, not a demonstrated end-to-end latency improvement.

The cache tracks both array identity and in-place item revisions. It preserves
identity-equivalent snapshots and changes restored before the next check;
an unconditional input-epoch cancellation would not. Tests cover those cases,
changed-item cancellation, aborts, and disposal.

### Mounted-only clip wrappers

Measured row elements remain retained, preserving their local state. Only
their private clip wrappers are released on unmount and rebuilt on re-entry.
Mounted same-height promotions preserve the existing wrapper and offset.
Declared positioned cards still mount directly.

The 10,000-row fixture retained 10,000 wrappers before this change and 35
afterward. All 10,000 rendered row elements still exist: this is not general
element eviction. Five alternating pairs in each browser session produced
these median boot times:

| Comparison | Control | Mounted-only wrappers |
|---|---:|---:|
| Prototype, first session | 73 ms | 51 ms |
| Prototype, fresh repeat | 74 ms | 49 ms |
| Integrated implementation | 77 ms | 52 ms |

The integrated fixture's four-command re-entry trip measured 44 ms versus
47 ms, including frame waits. Do not describe that as a scrolling speedup.
Checks verify exact geometry after resize, retained element identity and
local state, and balanced destruction. Unit tests also cover same-height
promotions and recovery after failed detached measurement.

The focused WebKit resize regression initially failed. Subscription tracing
showed that the lab's paint observer, not the runtime observer, still watched
five detached rows: its later MutationObserver cleanup assumed the removed
wrappers still contained their elements. The lab now unsubscribes through
`onUnmount`. The resize regression retains its error assertions and also
checks that observers release detached rows.

## Other proposals

These decisions apply to the scoped experiments below, not every possible
implementation of the broader ideas.

| Proposal | Decision and evidence |
|---|---|
| Cached wheel-edge geometry | Not retained. A shadow diagnostic found three stale edge decisions in 1,788 shared-helper checks, though none in its 1,080 wheel calls. A wheel-only prototype did not establish a repeatable overall benefit sufficient to change this sensitive path. |
| Skip the post-commit viewport read | Rejected as implemented. When a teardown resized the viewport, the cached path published height 700 instead of the actual 300. The control published 300. |
| Skip held-row remeasurement | Rejected as implemented. A detached row that grew from 40 to 140 pixels still committed as 40 and remained wrong after two frames because it was off-screen. The control committed 140 immediately. |
| Defer token measurement | Experimental only. Four updates per batch reduced measured-row reads from 80 to 20 across twenty batches; sixteen reduced 320 to 20. Geometry was stale immediately after every batch. This needs explicit asynchronous API semantics; it is not enabled by default. Synchronous-call timing excludes the deferred work. |
| Slot layout/style containment | Not retained. A native complex-chat capture completed, but no repeatable user-facing improvement was established. A blanket containment change needs broader CSS compatibility checks. |
| Bounded measured-element retention | Full eviction remains deferred: it changes element-local state and remount semantics. The narrower wrapper-only change above is retained instead. |
| Shared snapshot diff summary | A limited key-comparison cache did not improve the 10,000-row measured snapshot median materially: 1.79 versus 1.78 ms; declared snapshots were 2.31 versus 2.35 ms. A broader diff rewrite remains unproven. |
| DPR, canvas-write, and observer-size micro-optimizations | Canvas-write guarding showed no consistent gain across list sizes and APIs. Observer-size reuse has no demonstrated performance benefit here and still needs freshness validation. DPR caching's initial declared-snapshot median improved from 2.44 to 2.09 ms, but a fresh repeat was 2.31 versus 2.26 ms with overlapping results; measured snapshots were 1.84 ms in both variants. None is retained. |
| Normal-flow mounted window | Experimental only. A height-changing synthetic fixture reduced per-update time from roughly 0.12–0.14 ms to 0.04–0.06 ms. The prototype explicitly excludes positioned layouts and has not passed the complete anchoring, reserve-space, or cross-engine contract. |

## Native scroll comparison

Baseline and integrated captures both complete two paging commits, growing
the scroll surface from 24,701 to 66,349 pixels, with thirteen scroll-end
events. The exact gesture at which an edge commits varies; compare the common
first four moving gestures when attributing costs before paging.

| Capture | Scroll events | Frame p95 | Maximum interval | Intervals over 25 ms |
|---|---:|---:|---:|---:|
| Baseline `run-LddjJN` | 803 | 17.08 ms | 17.54 ms | 0 |
| Baseline `run-Yjipxz` | 795 | 17.18 ms | 17.58 ms | 0 |
| Integrated `run-VpLeU3` | 826 | 17.08 ms | 17.52 ms | 0 |
| Integrated `run-DOc3wT` | 830 | 17.16 ms | 17.64 ms | 0 |

The measurement windows are approximately 30–31 seconds. These results do
not demonstrate a jitter fix: regular animation-frame callbacks do not prove
smooth physical presentation, and scripted gestures do not reproduce real
trackpad momentum.

## Local evidence and storage

Raw captures and metadata remain under ignored `browser-artifacts/`; nothing
was uploaded. The relevant CPU results are in these directories:

- `core-round-bench-3hPj7q`: staged-input scan counts and time.
- `core-round-bench-T8WP3E`: uninstrumented staged append comparison.
- `core-round-bench-O7bUNO`: staged cancellation and identity-equivalence checks.
- `core-round-bench-H2uTuZ` and `core-round-bench-ESjrjR`: wrapper prototypes.
- `core-round-bench-YAWkW5`: integrated wrapper comparison.
- `core-round-bench-Xu19cq`: post-read and held-row counterexamples.
- `core-round-bench-41qtee`: frame-batched token measurement.
- `core-round-bench-1wp7DS`: canvas-write guard.
- `core-round-bench-q27aBF`: key-comparison cache.
- `core-round-bench-H54QjM`: normal-flow prototype.
- `core-round-bench-HnGlP9` and `core-round-bench-PSZ4uN`: transaction-level DPR
  cache and fresh repeat.

The capture runner now checks for 10 GiB free before starting, reuses one Swift
compiler cache, and removes its temporary browser profile after shutdown.
Captures are preserved; this safeguard does not impose a retention policy on
evidence. The investigation's CPU runner also removes its temporary profiles.

## Verification

The following checks pass on the retained runtime changes:

- `pnpm run check`, including repository type checking.
- `pnpm test`: 829 tests across 35 files.
- Direct TypeScript checking of `tests/unit/virtual-list.test.ts`.
- `pnpm run test:firefox-profile`: 12 portable checks.
- The quick geometry lab across Chromium, Firefox, and WebKit in all three
  update modes: nine cases with no reported violations or page errors.
- Chat invariants across Chromium, Firefox, and WebKit: no reported violations
  or page errors.
- All five gallery regression scripts, including fractional-DPR paging.
- Runtime resize, follow landing, log, and pin-replacement regressions.

The focused runtime group is not entirely green: `streaming-height` fails
because its standalone markdown host shrinks from 800 to 400 pixels while the
test expects retained height. The same test fails identically against the
unchanged baseline. The renderer and its height-preservation settings are not
changed in this performance pass; this remains a separate known failure.

Browser correctness checks use the installed Playwright engines, not the
installed-Firefox native capture setup. Their wheel events do not substitute
for native gesture-release testing. The native comparisons above provide the
separate movement and paging evidence.

## Next steps

Keep native scroll and correctness regressions separate. Investigate explicit
token batching or a normal-flow backend only with a defined API contract and
representative workloads. Do not infer that these prototypes are ready to ship
from their narrow CPU results.
