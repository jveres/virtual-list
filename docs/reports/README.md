# Verification reports

These records preserve measured results, audit findings, and rejected
approaches for specific revisions and workloads. They aren't current API
specifications or a promise that every historical observation still applies.
Use the [consumer guide](../streaming-consumer.md) and
[API reference](../integration-api.md) for integration, and the
[release record](../streaming-integration-plan.md) for the `v0.2.0` scope.

## September 27 Safari chat momentum correction

The [chat momentum investigation](safari-chat-momentum-2026-09-27.md)
compares real trackpad captures with ordinary recycling, retained rows, and
native row compositing hints. The user reports no shifts with the hint and
normal recycling. The report distinguishes this visual result from geometry
checks and animation-frame timing.

## September 27 Safari gallery fade follow-up

The [Safari fade follow-up](safari-gallery-fade-follow-up-2026-09-27.md)
records initial-load fades, the retained WebKit compositing hint, and the
remaining user-observed jitter. The scripted captures used different scroll
distances and do not establish a performance improvement. The user accepted
this known limitation for `v0.4.1`.

## September 27 gallery momentum investigation

The [gallery investigation](gallery-momentum-investigation-2026-09-27.md)
compares the fade feature with its predecessor and an overscan preparation
change. The user subsequently reported smooth real trackpad deceleration in
both Firefox layouts; the valid Rows capture recorded no long sampled frame
gaps or programmatic scroll-position writes.

## September 27 clean code audit

The [native-scroll cleanup audit](clean-code-audit-2026-09-27.md) records fixes
for changed-target motion ownership, Firefox cancellation, and interrupted
teardown, with unit and cross-browser regressions.

## September 27 Safari paging follow-up

The [consumed-edge investigation](safari-consumed-reach-2026-09-27.md) captures
the stuck controller in the user's open Safari tab and reproduces a navigation
handoff that consumes a top reach without loading. Explicit edge commands now
permit a retry while preserving the pending-load and ordinary-scroll rules.

## September 26 iOS follow-up

The [iOS scroll handoff investigation](ios-scroll-handoff-2026-09-26.md) records
the confirmed scroll-settle button correction, mobile paging coverage, device
diagnostics, and the still-open paging report.

The [iPad near-top paging investigation](ipad-near-top-paging-2026-09-26.md)
records an anchor adjustment lost in a long-lived Safari page, successful
real-swipe validation of the touch-settle candidate, and fixes for resize,
missing-scrollend, and changing-page-size failures found in further edge cases.

The [responsive tail-navigation follow-up](responsive-tail-navigation-2026-09-26.md)
overlaps native movement with tail preparation, reduces measured request delay
from 277 ms to 2 ms, and records the user's confirmation from rest and momentum.

## September 26 streaming performance follow-up

The [streaming range-reuse investigation](streaming-range-reuse-2026-09-26.md)
extends Chrome attribution to 16 ms stalls, fixes repeated live-range allocation
in the upstream renderer, and records rejected layout controls and the remaining
large-row restoration costs.

The [image lookup batch follow-up](streaming-image-batches-2026-09-26.md)
removes repeated per-image row and transcript scans, rejects a width-containment
control, and distinguishes the remaining restoration work from the measured
binding savings.

The [incremental row-layout follow-up](staged-row-layout-2026-09-26.md) spreads
large completed replies across hidden preparation slices, measures the smaller
worst callbacks in all three browsers, and corrects premature bottom-navigation
completion in the profiler.

## September 25 clean-code and performance audit

The [streaming-trail DOM stability fix](streaming-trail-dom-stability-2026-09-25.md)
uses grouped mutation metrics to identify completed-content rewrites when a reply
moves offscreen. It records the upstream correction and three trials per browser.

The [native listener-order control](native-scroll-listener-control-2026-09-25.md)
records a rejected optimization: changing event order moved attribution without
a repeatable reduction in work.

The [staged tail-restoration follow-up](staged-tail-restoration-2026-09-25.md)
addresses synchronous history rebuilding before bottom navigation, verifies
cancellation and concurrent stream updates, and adds bounded attribution for
individual Chrome stalls.

The [native smooth navigation result](native-smooth-navigation-2026-09-25.md)
records native top/bottom animation, cross-browser completion and cancellation,
blank-content diagnostics, and the user's smoothness confirmation.

The [clean-code and performance audit](clean-performance-audit-2026-09-25.md)
records two resolved medium findings, regression coverage, and paired
installed-Firefox measurements on the external display.

The [streaming chat profiler verification](streaming-chat-profiler-2026-09-25.md)
records the repeatable complex SSE workload, native Firefox and Chrome
captures, operation attribution, cross-engine checks, and the Safari 27
automation startup fix. Use the [workflow guide](../streaming-chat-profiling.md)
for new investigations.

The [first profiler-led optimization](streaming-image-scans-2026-09-25.md)
removes repeated image-preview subtree scans during a mutation batch. It records
18 interleaved installed-browser timing trials, a 6.2% reduction in Chrome's
median main-thread task time, and the limits of the Firefox and Safari results.

The [cursor style-invalidation optimization](streaming-cursor-restyles-2026-09-25.md)
replaces two expensive renderer selectors with a local cursor-block marker.
It records rejected controls and 18 interleaved installed-browser trials:
Chrome's median task time falls 37.5% and style time falls 85.1%, while Firefox
and Safari timings are effectively unchanged. Completion stalls remain.

The [imported-chat send investigation](imported-chat-send-2026-09-25.md)
removes full-transcript export and parsing from simulated sends after loading
older history, with a focused Chrome capture and persistence regressions.

The [status formatter investigation](streaming-status-formatting-2026-09-25.md)
reuses a locale formatter in streaming status updates. It records the small
diagnostic saving, timing controls, and the unresolved completion stalls.

The [stream-finalization investigation](streaming-finalization-2026-09-25.md)
retains processed renderer blocks through completion. It records the upstream
fix, completion-cost reduction, and checks across installed browsers.

The [follow-up review](streaming-followup-review-2026-09-25.md) rejects a
source-range cache and network-read coalescing, records the final native
scrollback check, and identifies the remaining Safari attribution limit.

The [Safari trail disposal fix](safari-trail-disposal-2026-09-25.md) records
native stack attribution, the upstream overlay-order correction, and measured
cleanup without retaining empty trail layers.

The [Safari scheduling investigation](safari-streaming-scheduling-2026-09-25.md)
adds task/frame/lifecycle correlation and disconnected-driver captures. It
links the late pause to trail disposal, distinguishes responsive-task frame
gaps, and records two rejected upstream CSS controls.

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

The [post-integration hardening audit](hardening-audit-2026-09-14.md) records
the review of `9407fbe`, reproduced edge cases, fixes, regression coverage,
and external-display Firefox measurements.

The static review below lists candidates after the streaming integration.
The measurement follow-up separates demonstrated gains from rejected or
unproven proposals. The implementation report records the bounded hidden-row
patch and its fresh comparison. The other candidates remain unchanged.

| Report | Scope |
| --- | --- |
| [September 14 runtime static review](runtime-static-review-2026-09-14.md) | Six ranked candidates at `6fc4434`, led by detached streaming measurement; no source changed. |
| [September 14 candidate measurements](runtime-candidate-measurements-2026-09-14.md) | Paired external-display Firefox captures: retention CPU gain, staging frame-cost regression, and remaining evidence limits. |
| [Hidden streaming row implementation](hidden-streaming-row-2026-09-14.md) | Bounded retention, lifecycle coverage, WebKit Find limitation, and a 28.4% median CPU reduction in six fresh native captures. |

## Renderer experiments

The [September 15 renderer hardening audit](renderer-hardening-audit-2026-09-15.md)
records the v0.3.0 candidate review, three medium-severity fixes, geometry
tooling migration, regression coverage, and package-size limits.

The [renderer-owned trail release audit](streaming-trail-release-audit-2026-09-14.md)
records the v0.2.0 renderer release and pin, lifecycle fixes, ownership review,
and installed-tag verification. It supersedes the prototype integration status
below, but does not replace the historical performance measurements.

The [streaming trail prototype](streaming-trail-prototype-2026-09-14.md) records
the optional renderer experiment, native Safari pixel tests, and measured
Firefox cost. It does not change the virtual-list API or establish a zero-cost
animation.

The [CSS and overlay comparison](streaming-trail-comparison-2026-09-14.md)
records 18 matched Firefox captures of the smaller built-in reply. CSS uses more
content-thread CPU and less Renderer-thread CPU, without a demonstrated overall
CPU improvement. Both options retain regular frame timing in these workloads.

The [shared overlay and complex fixture comparison](shared-streaming-trail-2026-09-14.md)
adds the shared-blend prototype and 12 captures of the 67,760-character fixture.
Its lower CPU median is promising, but the ranges overlap. Every option records
long frames on this workload, including the effect-off baseline.

## September 22 review and jitter investigation

These reports use the user's image-heavy transcript on the external display.
The first reviews the runtime's scroll hot path and measures the
idle-preparation prototype. The second measures input delivery against
display frames in real trackpad captures.

| Report | Scope |
| --- | --- |
| [Hot path review and idle page preparation](idle-page-preparation-2026-09-22.md) | Runtime scroll path at 0.2–0.5% of samples; `prepareDuringScroll` commits older pages about 240 ms sooner in two Firefox captures and is on by default after a manual Firefox and Chrome check. |
| [External-display scroll jitter](external-display-scroll-jitter-2026-09-22.md) | Trackpad events miss the external display's frames about 3.6 times as often as on the built-in display; the cause lies before Firefox's parent process, outside the page. |

## September 23 virtual-list-next

The [virtual-list-next verification](virtual-list-next-2026-09-23.md)
records the replacement orchestration layer on branch `virtual-list-next`:
contract parity, browser invariants, the feature regression suite, code
size, and headless CPU comparisons. It also covers native CSS scroll
anchoring (F5): which structural changes each engine anchors, its
verification, and the "scroll to top" loop it fixed. The architecture
is in [`docs/architecture.md`](../architecture.md).

## Safari 27 investigation

The [September 20 scroll-presentation investigation](scroll-presentation-investigation-2026-09-20.md)
records a user-observed Chrome pause, GPU-process waits, Safari production
controls, and a user-supplied Safari timeline. The timeline identifies repeated
image-source reads, page-preparation costs, and separate long paints. The native
Firefox/Safari follow-up measures a demo-only image-binding improvement and
rejects a raw-attribute candidate. The audit follow-up fixes live-shrink
reconciliation and the gallery fade, and rejects a segment cache that would
not benefit normal scrolling. A further numeric audit finds no live geometry
changes in the captured ordinary scroll passes and attributes a 34 ms paging
stall to an attachment image's data-URL assignment. Row-owned thumbnail Blob
URLs reduce four measured Safari assignments from 85 ms to 3–4 ms, with unchanged
paging progress. Hover is documented and deferred. The native compositor cause
remains unverified. Compositing CSS remains unchanged.

The [September 16 manual-scroll investigation](safari27-scroll-investigation-2026-09-16.md)
records native Safari measurements, rejected diagnostics, compositor hints,
and the mounting-order fix. The retained candidate is nearly perfect in the
user's external-display repeat, but occasional shifts remain. Repeated Firefox
controls motivate scoping `preserve-3d` to WebKit while retaining Safari's
rendering setup. The `v0.2.0` release retains this improvement. The remaining
shifts stay open as a known limitation.

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

## Raw capture retention

Raw profiles, screenshots, and trace data are temporary local analysis inputs
under ignored `browser-artifacts/` and are never committed. At the user's
request, captures are removed after analysis. The September 25 cleanup removes
the remaining old raw trials and obsolete probes. Compact summaries, source
replay metadata, tracked fixtures, and curated reports preserve the useful
results and procedure. New Firefox and chat captures enforce this policy.

Run IDs in historical reports remain labels even after pruning. Their commands
and tracked fixtures reproduce synthetic workloads with a new run ID. Exact
manual gestures and older unrecorded source edits cannot be replayed. New
captures include source hashes and a patch against their revision so that
uncommitted code can be reconstructed before repeating the procedure.

Follow the [Firefox workflow](../firefox-profiling.md) for new
investigations. Add future curated reports here with their revision,
workload, results, and limitations; link them from this index.
