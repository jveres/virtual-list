# Safari trail disposal fix

The remaining late Safari pause comes from removing the renderer's trailing
overlay beside a large Markdown subtree. Putting the overlay before the content
preserves the content's last-child state and reduces the disposal pause while
retaining normal cleanup. A smaller rendering gap remains in the measurements.
The fix is released in `markdown-viewer` v0.8.3, commit
`3708f020f2417c194da3d928bb0800a49b39d6b9`, and the consumer pins its GitHub tag.
The separate [native navigation report](native-smooth-navigation-2026-09-25.md)
records the button fix and the user's cross-browser smoothness confirmation.

## Conditions

This continues the [Safari scheduling investigation](safari-streaming-scheduling-2026-09-25.md)
as an explicit Safari-specific exception to Firefox-first investigation. Shared
renderer validation includes installed Firefox and Chrome. The affected LU28R55
display uses 1920 × 1080 logical pixels, 2× scaling, and 60 Hz. Windows are
1900 × 1049 at `(1450, 31)`; this round's Safari inner viewport is 1900 × 997.
The earlier scheduling report used a 1900 × 945 viewport; its runs are not
paired timing baselines for this round.

The workload remains 160 history turns, 48 complex reply sections, a 12-second
stream, and a 20-second capture. It contains 44,230 characters in 461 text chunks
and 466 events. Its hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
Follow captures use isolated sessions with DevTools closed. Safari follow
captures disconnect the owned automation driver before measurement.

## Native attribution and controls

A new `--safari-sample=start:duration:interval` diagnostic captures the owned
WebContent process's native stacks with macOS `sample`. It excludes pre-existing
processes and identifies the test page by a short CPU calibration before capture.
Raw samples are summarized and deleted. The [profiling guide](../streaming-chat-profiling.md#sample-native-safari-work)
describes ownership, overhead, bounds, and reproduction.

The first prototype rejected two ambiguous WebContent candidates before
measurement. Calibration resolved this. A 1 ms sample covering seconds 12–16
amplified the late pause to 670 ms, so it is attribution evidence only. A narrower
10 ms sample covering seconds 13.7–15.7 recorded a 110 ms disposal interval.
Its 140 main-thread stacks included five in `Document::resolveStyle` and two
in `LocalFrameViewLayoutContext::performLayout`. These inclusive counts identify
style/layout work; they are not exact CPU durations or per-frame timestamps.

The controls establish the relevant DOM trigger:

| Control | Late disposal pause | Outcome |
| --- | ---: | --- |
| Narrow the demo's date-header `:has()` selector | 87 ms | Rejected. |
| Disable that selector entirely | 85 ms | Rejected; also changes header clipping. |
| Retain the empty trail layer, restore parent positioning normally | Absent; whole-capture maximum 34 ms | Causal control only; empty layers must still be removed. |
| Insert the overlay before Markdown, remove it normally | Absent; whole-capture maximum 43 ms | Selected upstream fix. |

The new order keeps the large content element last throughout streaming and
cleanup. WebKit's [child-change invalidation source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/style/ChildChangeInvalidation.cpp)
shows subtree invalidation when first/last-child states change. This supports
the mechanism inferred from the native sample and order/removal controls; it
does not identify the exact installed WebKit source revision. The original
overlay already has an explicit stacking order, so changing its DOM order
preserves its painting position.

Exploratory run IDs are `safari-diagnostic-xA3YAa` (failed ownership check),
`zUF1eI` (1 ms sample), `MoSztO` (10 ms sample), `NcQiaG` (narrow selector),
`trfjBy` (disabled selector), `CA8AZL` (retained layer), and `5B6dKw` (leading
layer); the latter six share the `safari-diagnostic-` prefix. No raw stack or
recording files are needed to repeat these synthetic controls.

## Overlay-order validation and the smaller gap

The order-only candidate passed comparable installed-browser captures. Safari's
unsampled timing round used one released baseline and two candidate repeats;
Firefox also used three trials total. Chrome used one pair.

| Browser | Moving p95, baseline → candidate | Moving intervals >25 ms | Whole-capture maximum |
| --- | --- | --- | --- |
| Safari 27.0 | 22 → 20, 20 ms | 9 → 1, 1 | 101 → 34, 37 ms |
| Firefox 156.0.1 | 17.26 → 17.20, 17.06 ms | 1 → 7, 0 | 33.70 → 66.66, 17.58 ms |
| Chrome 153.0.8010.53 | 17.40 → 17.50 ms | 0 → 0 | 17.70 → 17.70 ms |

Firefox's longer candidate gaps did not repeat in its third trial. Its measured
content-thread CPU was 3,810 ms before and 3,723/3,684 ms after; style markers
totaled 655 ms before and 391/458 ms after. These few trials do not establish
a general Firefox CPU improvement. Chrome's main-thread task total was
3,374 → 3,218 ms, also a single-pair observation.

Safari's finer disposal-window metric exposed a remaining 30–32 ms interval
even after the large restyle disappeared. A 10 ms native sample of the order
candidate (`IMc9fL`) recorded a 32 ms gap and no sampled `resolveStyle` calls.
A denser 1 ms diagnostic (`8rM0Zr`) amplified it to 53 ms; its stacks instead
included compositing updates, painting, and event-region updates. Stack counts
are interval attribution, not a timeline proving every sample belongs to the
same frame.

Keeping the viewer positioned (`Vl7Gra`, 32 ms), using a zero-size overlay
anchor (`w2sfvM`, 31 ms), isolating blending (`b9iANm`, 32 ms), and requesting
cleanup in an animation callback (`oq1mRB`, 30 ms) did not remove this gap.
Those controls are rejected. In particular, a single animation callback does
not guarantee a separate rendering transaction from animation-finish delivery.
Promoting only the Markdown content (`V7XKZU`, 29 ms) was also ineffective.
All of these IDs have the `safari-diagnostic-` prefix.

Promoting the viewer host (`9EVt73`, 26 ms), removing animation fill
(`sdzu3A`, 31 ms), retiring blending before delayed cleanup (`o035kb`, 26 ms),
and combining host isolation with promotion (`2SWAot`, 26 ms) also retain a
gap. Those changes are not selected. Delaying cleanup moves work; it does not
establish that the work disappeared.

Timing IDs, with the `<browser>-timing-` prefix, are Safari `00Jlhp` baseline,
`jgfq48`/`DnYMPa` candidate; Firefox `uj7PIs` baseline,
`pMb6KM`/`gsNkL8` candidate; and Chrome `moDAz4` baseline, `SCbOWx` candidate.

## Programmatic button follow-up

The user distinguishes smooth native scrolling from severe top/bottom button
jitter, including while idle, in Safari on LU28R55. The new `buttons` scenario
presses top/bottom during streaming and again after completion. Diagnostic
glide records reuse the runtime's existing position/target values, without
adding geometry reads. They distinguish delayed frames, rejected or corrected
writes, live-target changes, and curve restarts.

An installed Firefox baseline (`firefox-diagnostic-AueW81`) completes both idle
glides with maximum intervals below 18 ms. The Safari order-only baseline
(`safari-diagnostic-i4rdMm`) completes them with maximum intervals of 30 and
87 ms. Neither idle glide restarts, reverses, or differs from its previous
write by a whole pixel. A separate 143 ms interval covers synchronous window
restoration before the bottom glide. This does not support blaming idle jitter
on easing resets. The bottom glide during streaming does restart 121 times
as its destination grows; this is a separate candidate for investigation.

A targeted native sample (`safari-diagnostic-0AcBCU`, seconds 17.4–19.4,
10 ms interval, 21-second capture) contains 137 main-thread samples. Twenty-one
include the `scrollTop` setter and compositing updates; 17 include compositing
requirements calculation, and 11 include clipped overlap bounds. Sampling
amplifies the capture's largest gap to 420 ms, so these counts identify work
but are not unsampled timings. WebKit's
[scroll update implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/rendering/RenderLayerScrollableArea.cpp)
and [compositing traversal](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/rendering/RenderLayerCompositor.cpp)
support the observed synchronous path. The current source is not a mapping
to the installed build.

Removing canvas `preserve-3d` (`mJXZ1D`) retains 28/55 ms idle glide maxima;
it is reverted. Promoting and clipping Markdown content (`h4MQHp`) also retains
pauses and is reverted. Native browser animation (`WI8Tej`) is a diagnostic
control only: its streaming top command competes with the existing follow
glide, so that path is not equivalent. The profiler now also requires each
button command to reach its destination, using the runtime's cached state.
The subsequent [native navigation fix](native-smooth-navigation-2026-09-25.md)
resolves command ownership and arrival detection before enabling native
animation on the demo buttons. It includes the final installed-browser checks,
rendered-content diagnostics, and the user's confirmation.
