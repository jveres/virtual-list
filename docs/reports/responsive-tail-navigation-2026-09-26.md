# Responsive navigation to an evicted chat tail

The streaming demo starts native movement through the loaded window while it
prepares an evicted tail. Previously, bottom navigation stopped the current
gesture and waited for preparation before starting the animation. The user
confirmed prompt, smooth behavior after the change, both from rest and during
swipe momentum.

## Implementation

`updateWindow` accepts `interrupt: "commit"` for explicit navigation. It renders
and measures hidden rows in bounded frame slices while existing motion
continues. When ready, it ends that motion and commits the replacement. Fresh
input still invalidates the command through the runtime's input epoch. Default
paging and immediate `interrupt: true` retain their existing behavior.

The demo first requests native scrolling to the loaded window's end, then uses
this preparation mode. A successful replacement starts a second native scroll
to the restored end. The pager is disposed before preparation and recreated
after the commit. Cancellation preserves the old window; the existing live
message reconciliation preserves tokens or a stop received during preparation.

A loaded window already at its end has no approach distance. Its loading
indicator remains useful while the tail prepares. This change overlaps work
with movement; it does not eliminate rendering cost or animate through every
evicted page.

## Firefox diagnostic comparison

The comparison uses installed Firefox 156.0.1, fresh temporary profiles, closed
DevTools, and the deterministic button workload: 160 history turns, 48 reply
sections, 44,230 reply characters, a 12-second stream, and a 20-second capture.
The workload hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

The external LU28R55 was disconnected. Both valid runs use the built-in Retina
display at 2× scaling and 60 Hz, a 1420 × 788 window at `(10, 41)`, and a
1420 × 704 content viewport. An attempted external-display run failed before
capture and supplies no evidence. These desktop measurements establish the
preparation/request sequence; they do not measure physical iOS presentation or
resolve an external-display performance report.

The final bottom command restores the evicted tail after streaming has stopped:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Click to first native smooth request | 277 ms | 2 ms |
| Click to reported end arrival | 1,131 ms | 1,136 ms |
| Largest frame interval in the first 1.8 seconds | 33.24 ms | 33.44 ms |
| Largest interval while position changes | 17.32 ms | 33.44 ms |
| Largest staging span across bottom commands | 45 ms | 42 ms |

Preparation overlaps motion in the candidate, so its slowest preparation frame
now counts as moving. This is an initial-response improvement, not evidence of
lower rendering cost. Both runs report all four requested edges and zero
uncovered pixels at cached geometry publications. The later
[staged-layout investigation](staged-row-layout-2026-09-26.md#corrected-navigation-metric)
found that this probe can complete bottom navigation at the old window's edge;
the completion metric alone does not prove restored-tail arrival. Coverage
publications do not prove that every physical frame paints correctly.

Local run IDs are `firefox-diagnostic-WKlXCj` and
`firefox-diagnostic-Y81pL8`. Both retain source hashes, patches, workload metadata,
and compact summaries. Raw captures and temporary browser profiles were removed.
The baseline streaming/runtime source matches `a0b42fc`; intervening `4c82c6d`
changes the scroll-settle lab and device diagnostics, not the measured chat path.

Reproduce on the same display with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons \
  --mode=diagnostic --scheduler --display=0
```

Future summaries expose `firstSmoothRequestMs` and
`firstDirectionalMovementMs` separately. These runs predate those derived fields;
the request delays above come directly from their retained write timestamps.
The new movement metric uses existing cached frame samples, adding no layout
reads. It cannot distinguish command motion from concurrent momentum or layout
without the accompanying event sequence.

## Verification

The type/style check, all 1,054 unit tests, and all 125 portable profiler checks
pass. Runtime tests cover preserving motion during preparation and canceling
both immediate and deferred takeovers on fresh input. Focused browser tests
pass in Firefox, Chromium, and WebKit for immediate approach, final landing,
bounded paging, keyboard cancellation, and a concurrent stream stop.
All 14 chat-scrolling scripts pass across their configured engines. The first
group run was interrupted during script 12; scripts 12–14 passed in separate
completed runs afterward.

The user's confirmation covers the stationary and momentum cases in the local
demo. The separate intermittent top-loading failure on iOS remains open in the
[iOS investigation](ios-scroll-handoff-2026-09-26.md).
