# Runtime hot path profile

This report records a Firefox-first audit of the runtime's scroll, commit,
and measurement paths on September 10, 2026, at commit `3a483d7` plus the
change described below. Two workloads drove the installed Firefox 155.0.1
with native macOS scroll input on the external LU28R55 display: the
streaming chat demo loaded with the complex fixture, and the dynamic-height
lab in chaos mode. Both were captured before and after the change with
identical parameters.

The corrected attribution credits about one percent of chat samples and
two percent of lab samples to the nearest runtime JavaScript frame,
including native work beneath it. No animation-frame interval exceeded
1.5 refresh periods in any capture. This does not establish smooth physical
presentation or rule out redundant layout work. One small runtime cleanup
was made; the profile does not establish a performance improvement.

## Method

The captures reuse the existing runner and analyzer. A new portable script,
`scripts/firefox-profile/attribute.mjs`, attributes content-thread samples
to JavaScript functions and groups non-interruptible reflows by their
captured invalidation stacks. Native labels containing page URLs are not
JavaScript frames. Self samples include native work below the nearest
JavaScript frame; inclusive counts overlap.

Firefox captures a cause stack when layout is invalidated, potentially
milliseconds before layout runs. "Reflow (sync)" means non-interruptible
reflow, not necessarily JavaScript-forced layout. The captured DOM API may
invalidate layout without flushing it. See Gecko's
[`SetNeedLayoutFlush`](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/layout/base/PresShellInlines.h)
and [reflow marker emission](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/layout/base/PresShell.cpp).
The script reports the delay from invalidation to reflow separately.
Nested marker durations are wall-clock times inside the later reflow, not
CPU costs of the invalidating call.

- Browser: Firefox 155.0.1, fresh profile, DevTools closed, live capture.
- Display: LU28R55, 1920×1080 logical at 2×, 60 Hz; window 1900×965.
- Chat workload: `browser-artifacts/complex-chat-setup.js` (160 active
  turns, 400 branch nodes, 1280×720 images, tool panels), 10 s warmup,
  12 upward gestures of 90 ticks at 60 px, 700 ms settle. Every capture
  committed one scrollback page (133–160 to 109–160 of 160) and ended at
  the same scroll height.
- Lab workload: chaos enabled after a 4 s warmup, six downward and four
  upward gestures of 90 ticks at 40 px. The lab's random source is seeded,
  but gesture timing changes which operations interleave, so lab totals
  vary between captures by roughly ten to twenty percent.
- Captures: chat `run-qY1TVc` (before) and `run-5wbvP3` (after); lab
  `run-2gI7g5` (before) and `run-YhofHQ` (after); removal experiments
  `run-nShOwL` and `run-isrqtt`. All under ignored `browser-artifacts/`.

## Results

Animation-frame callback timing is similar in all four captures. The tables
below list the measurement windows; sample counts are 1 ms samples of the
content process main thread. The corrected attribution was rerun against
the same four raw captures, without changing them or recording new runs.

| Chat scrollback | Before | After |
| --- | ---: | ---: |
| Window | 29.2 s | 30.6 s |
| Frame interval p95 / max | 17.16 / 17.60 ms | 17.20 / 17.66 ms |
| Intervals over 25 ms | 0 | 0 |
| Scroll events / scrollends | 740 / 12 | 742 / 12 |
| Samples with any script | 599 | 529 |
| Sync reflows | 326, 142 ms | 324, 122 ms |
| Style flushes | 1813, 238 ms | 1788, 201 ms |
| Scroll handler total / p95 | 217 ms / 1.67 ms | 168 ms / 1.40 ms |
| Minor GCs | 6, 3.4 ms | 7, 3.8 ms |

| Lab chaos | Before | After |
| --- | ---: | ---: |
| Window | 25.3 s | 25.0 s |
| Frame interval p95 / max | 17.12 / 17.66 ms | 17.22 / 17.62 ms |
| Intervals over 25 ms | 0 | 0 |
| Scroll events / scrollends / writes | 864 / 109 / 135 | 866 / 83 / 109 |
| Chaos operations / commits | 80 / 128 (23 live) | 82 / 143 (22 live) |
| Violations / clipped paints | 0 / 0 | 0 / 0 |
| Samples with any script | 1004 | 924 |
| Sync reflows | 3096, 340 ms | 3352, 400 ms |
| Style flushes | 4468, 230 ms | 4884, 310 ms |
| Minor GCs / slices | 45 / 27, 24 ms | 56 / 20, 25 ms |

## Where the runtime's time goes

The chat's runtime samples concentrate in measurement, edge checks, and
wheel-idle timers. Sample counts below are from the before capture. "Self"
means nearest JavaScript frame, not exclusive JavaScript execution time.

| Chat, runtime frames | Inclusive | Self | What the self time is |
| --- | ---: | ---: | --- |
| `updateWindow` stage frame | 224 | — | Host renders plus the stage's warm layout read |
| `handleWheel` | 153 | 4 | See the two rows below |
| `boundaryAtNativeEdge` | 86 | 85 | `scrollTop` read flushes style for freshly mounted rows |
| `armWheelIdle` | 57 | 48 | `setTimeout`; 35 samples are the profiler capturing timer stacks |
| premeasure `append` | 99 | 98 | The stage's warm `getBoundingClientRect`, including native reflow |
| `onScrolled` | 63 | — | 18 in `unmountRow`, about 20 in the host's `onState` |
| `unmountRow` | 21 | 21 | `Element.remove` |

The lab's runtime samples are dominated by measurement and settle commits.

| Lab, runtime frames | Inclusive | Self | What the self time is |
| --- | ---: | ---: | --- |
| `setItems` → `prepare` → `measureDetached` | 399 / 305 / 290 | — | Chaos inserts, swaps, and replacements |
| `measureMany` and its read callback | 288 | 283 | Layout of new rows in the measurement root, including native reflow |
| `commitMeasured` | 129 | — | Mounted rows in place, retained rows detached |
| `settleGesture` → `interruptNativeScroll` | 110 / 100 | 6 | The overflow toggle's forced reflow at commands |
| viewport `ResizeObserver` | 83 | — | Chaos width flips remeasure every row |
| `applyPrepared` → `liveCommit` | 79 / 73 | — | Streaming tokens under "live" |
| `indexItems` | 25 | 17 | Key validation per `setItems` |
| `createSlot` | 7 | 7 | Five style writes and a probe per slot |

## Captured layout invalidations

These groups identify captured invalidation sites, not necessarily the
calls that later flush layout. "Total" and "p50" describe the subsequent
reflow markers; "Site" identifies the code in the captured cause stack.

| Chat | Count | Total | p50 | Site |
| --- | ---: | ---: | ---: | --- |
| `setTextIfChanged`, `textContent` | 56 | 73.1 ms | 1.18 ms | Host |
| premeasure `append`, warm read | 35 | 19.2 ms | 0.24 ms | Runtime, by design |
| `unmountRow`, `Element.remove` | 53 | 19.0 ms | 0.32 ms | Runtime |
| User-message collapse prepare and update | 46 | 29.2 ms | 0.43–0.90 ms | Host |
| `viewportState`, `scrollTop` | 2 | 0.3 ms | — | Runtime |

| Lab | Count | Total | p50 | Site |
| --- | ---: | ---: | ---: | --- |
| `measureMany` read, `getBoundingClientRect` | 845 | 177.6 ms | 0.13 ms | Runtime, inherent |
| `setTextIfChanged`, lab status text | 565 | 70.3 ms | 0.12 ms | Host |
| `unmountRow`, `Element.remove` | 207 | 31.9 ms | 0.07 ms | Runtime |
| Lab log flush, `scrollHeight` | 242 | 17.3 ms | 0.01 ms | Host |
| Lab `scrollTop` getter hook | 190 | 25.3 ms | 0.12 ms | Host |
| `measureMany`, `replaceChildren` | 848 | 5.7 ms | 0.004 ms | Runtime |
| Lab `scrollTop` setter hook | 75 | 1.3 ms | 0.005 ms | Host |

For example, the chat's `textContent` invalidations precede their reflows
by a median 3.18 ms and a maximum 7.38 ms. One such reflow runs under a
native refresh tick with no JavaScript frame in its sampled stack. These
markers do not show the status write synchronously forcing that work.
Likewise, the small `replaceChildren` marker total does not measure the
cost of moving elements into the measurement root.

## Findings

Each finding states what the evidence shows and what was decided.

- **Wheel-handler style computation is visible; redundancy is unresolved.**
  The `scrollTop` read in `boundaryAtNativeEdge` flushes style for rows
  mounted by the preceding scroll event: 75 of its 86 samples are style
  computation. The
  aggregate style-flush count cannot establish whether a frame restyles
  twice. Grouping nonempty `Styles` markers between consecutive refresh
  tick starts finds 104 of 1753 intervals with multiple passes before the
  cleanup, and 100 of 1836 after, with a maximum of six in both. These are
  refresh intervals, not physical display frames, and multiple passes do
  not by themselves prove wasted work. The edge read was not changed.
- **Coalescing the wheel-idle timer changes settle timing.** Replacing the
  cancel-and-rearm pair per wheel tick with one deadline timer keeps the
  idle moment but not the timer order: a cooldown timer scheduled after the
  last tick then fires before the re-armed remainder, and the pinned
  chromium trace settled at 172 ms instead of 296 ms through the pending
  settle check. The unit suite caught it; the change was reverted. Most of
  the sampled cost was the profiler capturing timer stacks.
- **Removal is an invalidation site, not a proven flush caller.** The chat
  has 53 reflows associated with `unmountRow` / `Element.remove` cause
  stacks. Their median invalidation-to-reflow delay is 0.87 ms, with a
  maximum of 2.64 ms. The earlier removal experiments used the same cause
  attribution, so they do not establish synchronous removal flushes or
  whether reordering removals would save work. Not changed.
- **Measurement is required by the current contract.** Detached premeasure
  reads row heights in a measurement root before mounting them in the
  canvas. The lab has 845 reflow markers associated with that read callback,
  with a median duration of 0.13 ms. Deferring measurement would change the
  exact-geometry contract, but these markers alone do not establish that
  every layout pass is necessary. Not changed.
- **Commit reads preserve clamp handling.** A commit reads the viewport
  before its writes and once after them, because the engine may clamp the
  position after a canvas change. This code structure does not establish
  two layout flushes per commit; cause stacks alone cannot measure that.
  Not changed.
- **Slot creation parsed five declarations and probed the engine per
  slot.** `createSlot` now probes `overflow: clip` once and assigns the
  resolved declaration through a single `cssText` parse. The lab's
  `createSlot` self samples went from 7 to 4, which is within noise; the
  change is a cleanup with no behavior difference, verified by the unit
  suite and the browser invariants.
- **Host-side invalidations, reported and not changed.** The chat's status
  text and user-message collapse modules appear in cause stacks associated
  with 73 ms and 29 ms of later reflows, respectively. These are not
  synchronous host-call costs or estimates of savings from changing them.

## Verification

The original runtime cleanup passed `pnpm run check`, 740 unit tests, the
seven analyzer checks, the Firefox chat invariant suite (no violations or
errors), the quick Firefox lab scenario under "live" (no violations, no clipped
paints), the 108 refresh-anchor cases, and the generated-file cases. The
before and after captures match in paging progress, scroll height, and
element counts at gesture release.

The attribution correction passes five additional portable checks covering
native URL labels, non-HTTP JavaScript frames, invalidation timing,
per-interval style counts, and invalid profiles. The corrected report uses
the existing raw captures; no new performance comparison is claimed.

## Limitations

- Animation-frame intervals measure main-thread timing, not display
  presentation.
- Scripted native gestures have no trackpad momentum tail; the chat's
  700 ms pause committed one page per capture rather than two.
- Inclusive sample counts overlap; marker durations are nested wall-clock
  times. Neither adds up to exclusive CPU cost.
- The lab's chaos interleaving differs between captures, so its totals are
  indicative, not paired measurements.
- Invalidation stacks cannot distinguish JavaScript-forced layout from
  later native refresh work. Confirm suspected forced layouts using stacks
  during the reflow itself before proposing a patch.

## Next steps

Further investigation can cover ten-thousand-row `setItems` cost (see the
[performance checkpoint](performance-checkpoint.md)) and startup
premeasurement, as well as whether repeated style passes in these captures
are avoidable. For the scroll and commit paths, repeat these captures after
any change to `scroll-settle.ts`,
`premeasure.ts`, or the commit functions, and compare the runtime rows of
`attribute.mjs` before claiming a difference.
