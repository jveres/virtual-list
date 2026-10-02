# Verification reports

These records preserve measured results, audit findings, and rejected
approaches for specific revisions and workloads. They aren't current API
specifications or a promise that every historical observation still applies.
Use the [consumer guide](../streaming-consumer.md) and
[API reference](../integration-api.md) for integration, and the
[release record](../streaming-integration-plan.md) for the `v0.2.0` scope.

## October 2 clean code audit

The [clean code audit](clean-code-audit-2026-10-02.md) closes four medium-priority
findings across three passes: failed benchmark cleanup, an obsolete translation
probe, duplicated profiler cleanup, and borrowed Safari session ownership.
Unused internal exports and a duplicate license notice are removed. The final
reachability check reports zero issues; intentional repetition is documented.

## October 2 exploration closeout

The [closeout](runtime-exploration-closeout-2026-10-02.md) reconciles the full
cleanup and web-research queue: two retained preparation changes, measured
rejections, the estimated-geometry reference, and the missing bottleneck that
prevents a placeholder patch. No measured gain remains unimplemented and no
experiment in that queue remains open. Device and renderer limits are explicit.

## October 2 large-history preparation

The [large-history comparison](history-preparation-2026-10-02.md) retains a
larger preparation slice at rest: 5,000 exact rows complete in 2.66–2.67 seconds
instead of 10.46 seconds, using 64–66% less sampled preparation CPU. Active
scrolling keeps the original limit. A TanStack reference confirms large savings
from deferring unvisited rows, but retains estimated geometry and remains a
benchmark control rather than a production mode.

## October 2 large table preparation

The [large-table staging comparison](large-table-staging-2026-10-02.md)
retains a demo preparation change that reduces a 1,200-row table's largest
frame gap from 50.6 to 18.1–18.3 ms. Readiness increases by 189 ms and sampled
CPU by 33–35 ms. Code-block staging is rejected because a long synchronous
rendering pause remains while total readiness more than triples.

## October 2 constrained table layout

The [constrained-table comparison](constrained-table-layout-2026-10-02.md)
finds no useful fixed-layout gain against automatic layout with the same column
widths, wrapping, images, and live edits. A restored control confirms the
rejection. Fixtures preserve exact content and geometry across all three
engines; production CSS is unchanged.

## October 2 longer measured paging

The [480-cycle measured-paging control](runtime-measured-paging-duration-2026-10-02.md)
shows the small case's early process-memory growth reversing naturally, with
bounded active items and balanced disposal in both cases. It closes the
120-cycle duration question for the tested workload without a runtime change
or a claim about unlimited-duration bounds.

## October 2 cleanup and remaining scope

The [cleanup and scope audit](runtime-remaining-scope-2026-10-02.md) removes
405.21 MiB of generated caches, screenshots, helpers, and obsolete copies while
preserving compact evidence. It separates the closed runtime candidate queue
from longer measured-paging memory runs, large-row renderer work, and conditional
table, placeholder, and estimated-geometry experiments. No new gain is claimed.

## October 2 large rows, uneven reflow, and measured streaming

The [rendering and allocation follow-up](runtime-rendering-allocation-2026-10-02.md)
rejects block skipping after a Firefox selection failure, confirms that one-row
resize batching cannot divide a giant row's layout stall, and rejects a
temporary-allocation prototype after ordinary timing and memory comparisons.
The runtime remains v0.4.12. New fixtures cover completed Markdown rows,
heterogeneous reflow, measured paging, live text, images, and width changes.

## October 2 observer ownership and completed investigations

The [observer ownership comparison](runtime-observer-ownership-2026-10-02.md)
fixes source retention through host-kept retired elements and canceled resize
registrations. With 1,152 empty retired roots deliberately retained, reported
window storage falls from 62.54 to 7.71–7.72 MiB. Disposal during resize delivery
also releases 20 previously retained items and elements across four handles.

The [paging and sustained-memory investigation](runtime-paging-memory-2026-10-02.md)
rejects two pager allocation prototypes after matched comparisons. Longer
unprofiled controls show that early process-memory growth reverses while source
ownership remains bounded. The
[investigation record](runtime-investigations-2026-10-02.md) closes the audit's
candidate queue and records its workload and presentation limits.

## October 2 pixel-ratio reads

The [pixel-ratio comparison](runtime-pixel-ratio-2026-10-02.md) confirms an 8%
improvement for large positioned edits and 4–6% shorter positioned structural
batches by sharing device-grid reads within synchronous passes. Subsequent
comparisons cover declared snapshots, paging, and observer ownership.

## October 2 compact declared snapshots

The [declared-snapshot comparison](runtime-declared-snapshots-2026-10-02.md)
retains compact item/height columns, known-prefix validation, direct snapshot
indexing, and preparation of retained declared rows only. Against v0.4.10,
100,000-item positioned edits improve from 45 to 28–29 ms, structural batches
improve 12–23%, and loaded fixture-window storage falls by about 7.1 MiB.
Worst GC pauses and whole-process peaks don't improve.

## October 1 runtime allocation and anchor lookup

The [allocation and anchor follow-up](runtime-allocation-anchors-2026-10-01.md)
removes duplicate transient item indexing and extends indexed anchor search to
gaps and overlaps. A matched Firefox candidate and repeat confirm large-query
gains and about 5–11% shorter large structural batches. The report explains the
typed-array accounting discrepancy and records the absence of a consistent
peak-memory or worst-GC-pause improvement.

## October 1 shared runtime key indexes

The [key-index follow-up](runtime-key-index-2026-10-01.md) shares immutable key
orders between desired state and committed geometry. Against the compact-buffer
baseline, it removes about 6 MiB of reported loaded storage at 100,000 rows and
reduces structural batch times by 13–25%. Direct positioned-buffer construction
is rejected. The report also records the higher observed process peak and the
limits of uncollected memory samples.

## October 1 runtime data structures

The [data-structure comparison](runtime-data-structures-2026-10-01.md) replaces
the learned-height hash table and per-item positioned objects with numeric
buffers. It compares installed-Firefox memory and API costs at 1,000, 10,000,
and 100,000 items, including a sparse-height control and mounted list cases.
The report records memory-accounting limits and the structures left unchanged.

## October 1 runtime source retention

The [lifecycle memory comparison](runtime-retention-2026-10-01.md) finds and
fixes retained initial snapshots in list and pager options, plus the last
source snapshot on disposed list handles. Installed Firefox collects retired
items after the fix. Keeping twelve disposed handles drops from 56.36 MiB to
2.24 MiB of reported fixture-window memory; normal disposal with handles
released already collects its items and rows.

## October 1 runtime boundary optimizations

The [implementation comparison](runtime-boundary-optimizations-2026-10-01.md)
retains bounded resize draining and a cheaper declarative pin scan. It records
the tradeoff between shorter frame gaps and later exact resize completion,
and rejects positioned, edge-slot, and pager prototypes after a restored
original-runtime control.

## October 1 complete runtime audit

The [complete runtime audit](runtime-complete-audit-2026-10-01.md) reviews every
source module and measures large-window edits and resize completion in two
installed-Firefox captures. It confirms remaining costs in detached-row resize
draining, positioned edits, and edge-slot changes, plus conditional pin/pager
costs. No production patch or measured optimization gain is claimed.

## October 1 declared-row pooling

The [pooling measurement](declared-pooling-2026-10-01.md) tests a bounded host
pool with 10,000 declared-height cards in installed Firefox. It eliminates
240 card-tree constructions and reduces host rendering time, but total CPU
matches the restored non-pooled control and frame timing does not improve.
Production behavior stays unchanged; the reusable fixture and cross-browser
identity, geometry, and cleanup regression remain.

## October 1 virtualization and layout web research

The [web-research review](virtualization-web-research-2026-10-01.md) compares
six virtualization projects with the current runtime and prior Firefox results.
It prioritizes rendering within huge rows, constrained table layout, scroll-seek
placeholders, declared-row pooling, and an estimate-based large-history control.
Those were research hypotheses. Subsequent comparisons reject declared pooling
and the tested block-skipping mechanism; the
[remaining-scope audit](runtime-remaining-scope-2026-10-02.md) records which
questions still lack measurements. The web review itself claims no speedup.

## October 1 bottom navigation

The [bottom-navigation investigation](bottom-navigation-2026-10-01.md)
identifies an explicit cancellation and restart when restoring an evicted
chat tail. The candidate uses one native animation after preparation; the
report records the startup-latency tradeoff and matched Firefox captures.

## September 30 runtime performance audit

The [runtime audit](runtime-performance-audit-2026-09-30.md) records fresh
Firefox 157 baselines for 10,000 declared rows, gallery masonry, rich-chat
paging, and complex streaming. No workload has a frame over 25 ms, and it
finds no high or medium runtime finding. Streaming viewport reads and demo
Markdown rendering are recorded as low-severity and out-of-scope costs.

## September 29 scroll listener isolation

The [listener-isolation investigation](scroll-listener-isolation-2026-09-29.md)
records mixed user observations with recycling, scroll callbacks, and input
listeners disabled. Development-only controls now separate scroll events from
wheel/touch/pointer input and support complete listener removal. A CSS-only
static fixture isolates scroll height. The investigation is closed with a
browser/macOS presentation issue as the working conclusion; no production
performance change or new timing improvement is claimed.

## September 29 CSS and row layout

The [CSS and layout investigation](css-layout-performance-2026-09-29.md) replaces
an unnecessary assistant-row flex context with block layout and preserves its
content's margin boundary with `flow-root`. The corrected Firefox pair records a
small layout saving and lower total CPU; Chrome records no improvement.
The report records the initial candidate's empty-reply spacing failure and its
correction. Selector attribution finds little remaining matching-cost headroom.
The profiler now supports Chrome's native loaded-history scroll plan and compact
CSS selector statistics. The report separates these results from presentation
smoothness and memory claims.

## September 29 fast-scroll follow-up

The [fast-scroll exploration](fast-scroll-exploration-2026-09-29.md) repeats the
loaded-chat investigation in installed Firefox 157 at three times the earlier
input speed. A fixed-height `content-visibility: auto` candidate does skip
rendering, but adds style, layout, and display-list work without a CPU saving.
It is reverted. The fast native-input preset, stable-geometry checks, and
bounded browser-skipping event metric remain in the profiler.

## September 29 DOM work during scrolling

The [DOM-operation investigation](dom-scroll-operations-2026-09-29.md) separates
retained-row recycling from paging and streaming. Five Firefox comparison rounds
test header style guards, mount-window batching and pointer location, two inline
image URL implementations, and combined hover-selector and wheel-read changes.
None provides a repeatable CPU gain that justifies a production optimization;
all candidates are reverted. Reusable steady-scroll, tool-heavy, and bounded
image fixtures, DOM classification, pointer control, and readiness checks remain.
The short original-image memory run misses its settling budget; the full
12-cycle repeat passes unchanged limits. Final repository and profiler checks
pass, and temporary captures and compiler caches are removed.

## September 29 main-thread CPU and retained resources

The [CPU and resource-ownership investigation](main-thread-memory-2026-09-29.md)
finds a 12.7% main-thread CPU reduction for a prose stream in Firefox, with no
meaningful rich-Markdown parser improvement. The `markdown-viewer` `v0.8.10`
release bounds shared code-line caching and pins `comrak-wasm` `v0.6.2`.
The demo releases images when a conversation is replaced. The
report distinguishes retained-resource accounting from physical browser memory
and records a rejected cache cap that increased CPU work.

## September 29 scroll hot path

The [scroll-handler audit](scroll-hot-path-2026-09-29.md) compares native Firefox
scrollback with and without bounded CPU contention. It finds small handler costs
and reduces concurrent style work: 21% less main-thread CPU from a local spinner
animation, then another 18% from bounded selectors and cursor-local spacing.
An owning-repository trail index in `markdown-viewer` `v0.8.8` reduces CPU by
9% in the separate visible end-follow workload, after user confirmation.
The confirmed `v0.8.9` single-text-node path reduces that workload by another
5.3%; a subsequent array-copy experiment was rejected. Memory captures can now
require actual trail rendering instead of relying on the fresh demo's default.
These are matched Firefox captures, not proof of resolved presentation jitter.

## September 29 Safari streaming follow

The [streaming-follow investigation](safari-streaming-follow-2026-09-29.md)
checks native scroll responses, records a rejected shorter-retarget experiment,
and adds compact motion diagnostics without changing runtime scrolling.

## September 29 clean-code and anchor audit

The [audit and anchor report](clean-code-anchor-audit-2026-09-29.md) records
Safari process-ownership and display-copy failure fixes, the user-confirmed
Chrome version-switch reserve correction, collapse/reflow and bottom-navigation
fixes, 4,464 geometry combinations, 252 browser combinations, and matched
Enter-to-send captures. Its follow-up covers partial-scroll collapse and
terminal assistant branches, with 190 Chromium/WebKit browser cases and a later
successful three-engine release check after the Firefox launch workaround.

## September 29 streaming chat memory

The [memory investigation](chat-memory-2026-09-29.md) attributes excess Firefox
image memory to duplicate decodes and retired-row image resources, and Safari
peaks to oversized composited surfaces and temporary display-copy pixels. It
records the measured worker cleanup, browser baselines, passing Firefox/Safari
memory gates, and the unresolved Chrome stress-budget result.

The [scroll regression follow-up](scroll-regressions-2026-09-29.md) records the
subsequent Safari shift/navigation and Firefox bottom-loader reports, corrected
Firefox release cases, and user-confirmed Safari paging recovery. Live captures
also exposed a stale canvas floor and image-row height changes. It records their
candidate fixes, rejected compositing controls, and the DevTools-free diagnostic.

The [compositing comparison](compositing-memory-2026-09-29.md) separates canvas
and message hints, corrects Safari process ownership, and records a greater
than twofold transient memory increase when Safari's canvas hints are removed.
It supersedes the older process-selection method for this decision.

## September 28 Safari chat image layers

The [image-layer report](safari-image-layers-2026-09-28.md) records repeated
user-confirmed smooth scrolling after moving compositing hints from entire
native-flow rows to individual chat images. It supersedes the September 27
whole-row promotion decision and distinguishes visual evidence from timings.

## September 28 Safari momentum tail

The [momentum tail report](safari-momentum-tail-2026-09-28.md) traces 1–2 px
shifts at the end of a Safari momentum scroll to WebKit's compositing of
nested scrollers. A WebKit-only CSS rule makes code blocks and tables wrap
instead of scrolling sideways. A static control page reproduces the
behavior without the runtime.

## September 28 runtime architecture performance round

The [architecture round](runtime-architecture-performance-2026-09-28.md)
applies three runtime changes: incremental skeleton sync, one-key declared
updates, and two-tier width re-measurement. The width change relaxes a
documented rule. Headless measurements show the gains at 1,000 and 10,000
rows. One native Firefox pair shows unchanged frame timing in the streaming
demo.

## September 28 runtime performance audit

The [runtime audit](runtime-performance-audit-2026-09-28.md) profiles
10,000 declared rows, gallery masonry, and imported-chat paging in Firefox.
It finds no runtime bottleneck worth a change. Chat long frames come from
host row rendering. A timer-coalescing candidate changed settle ordering and
was reverted.

## September 28 Safari HDR chat images

The [HDR chat image report](safari-hdr-chat-images-2026-09-28.md) traces
image-heavy chat lag to HDR gain-map photos in Safari. Inline chat images now
render in standard range, and large data-URL images use display copies made
in a worker. The user reports smooth scrolling on both displays; the traces
are single real-input observations, not a controlled benchmark.

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
The [October 2 cleanup](runtime-remaining-scope-2026-10-02.md#cleanup) removes
later generated caches, screenshots, helpers, and obsolete prototype copies
while verifying that retained evidence stays unchanged.

Run IDs in historical reports remain labels even after pruning. Their commands
and tracked fixtures reproduce synthetic workloads with a new run ID. Exact
manual gestures and older unrecorded source edits cannot be replayed. New
captures include source hashes and a patch against their revision so that
uncommitted code can be reconstructed before repeating the procedure.

Follow the [Firefox workflow](../firefox-profiling.md) for new
investigations. Add future curated reports here with their revision,
workload, results, and limitations; link them from this index.
