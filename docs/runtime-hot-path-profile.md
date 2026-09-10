# Runtime hot path profile

This report records a Firefox-first audit of the runtime's scroll, commit,
and measurement paths on September 10, 2026, at commit `3a483d7` plus the
change described below. Two workloads drove the installed Firefox 155.0.1
with native macOS scroll input on the external LU28R55 display: the
streaming chat demo loaded with the complex fixture, and the dynamic-height
lab in chaos mode. Both were captured before and after the change with
identical parameters.

The verdict: the runtime's own code costs about one percent of the content
main thread in both workloads, no animation-frame interval exceeded 1.5
refresh periods in any capture, and the remaining runtime-owned costs are
forced layouts that the measured-height contract requires. One small
runtime change was made. Two candidate changes were measured, found to
alter behavior, and rejected. Host-side costs that the profiles attribute
to the demos are listed but were not changed.

## Method

The captures reuse the existing runner and analyzer. A new portable script,
`scripts/firefox-profile/attribute.mjs`, attributes content-thread samples
to JavaScript functions and groups synchronous reflows by the innermost
JavaScript frame and the DOM API that forced them. Nested marker durations
are wall-clock times inside the flush, not independent CPU costs.

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

Frame pacing is unchanged and clean in all four captures. The tables below
list the measurement windows; sample counts are 1 ms samples of the content
process main thread.

| Chat scrollback | Before | After |
| --- | ---: | ---: |
| Window | 29.2 s | 30.6 s |
| Frame interval p95 / max | 17.16 / 17.60 ms | 17.20 / 17.66 ms |
| Intervals over 25 ms | 0 | 0 |
| Scroll events / scrollends | 740 / 12 | 742 / 12 |
| Samples with any script | 688 | 592 |
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
| Samples with any script | 1045 | 970 |
| Sync reflows | 3096, 340 ms | 3352, 400 ms |
| Style flushes | 4468, 230 ms | 4884, 310 ms |
| Minor GCs / slices | 45 / 27, 24 ms | 56 / 20, 25 ms |

## Where the runtime's time goes

The chat's runtime samples sit in three places. Sample counts are from the
before capture; the after capture ranks the same functions in the same
order.

| Chat, runtime frames | Inclusive | Self | What the self time is |
| --- | ---: | ---: | --- |
| `updateWindow` stage frame | 224 | — | Host renders plus the stage's warm layout read |
| `handleWheel` | 153 | 4 | See the two rows below |
| `boundaryAtNativeEdge` | 86 | 85 | `scrollTop` read flushes style for freshly mounted rows |
| `armWheelIdle` | 57 | 48 | `setTimeout`; 35 samples are the profiler capturing timer stacks |
| premeasure `append` | 99 | 58 | The stage's warm `getBoundingClientRect` |
| `onScrolled` | 63 | — | 18 in `unmountRow`, about 20 in the host's `onState` |
| `unmountRow` | 21 | 21 | `Element.remove` |

The lab's runtime samples are dominated by measurement and settle commits.

| Lab, runtime frames | Inclusive | Self | What the self time is |
| --- | ---: | ---: | --- |
| `setItems` → `prepare` → `measureDetached` | 399 / 305 / 290 | — | Chaos inserts, swaps, and replacements |
| `measureMany` and its read callback | 288 | 140 | Layout of new rows in the measurement root |
| `commitMeasured` | 129 | — | Mounted rows in place, retained rows detached |
| `settleGesture` → `interruptNativeScroll` | 110 / 100 | 6 | The overflow toggle's forced reflow at commands |
| viewport `ResizeObserver` | 83 | — | Chaos width flips remeasure every row |
| `applyPrepared` → `liveCommit` | 79 / 73 | — | Streaming tokens under "live" |
| `indexItems` | 25 | 19 | Key validation per `setItems` |
| `createSlot` | 7 | 7 | Five style writes and a probe per slot |

## Which calls force layout

Grouping the "Reflow (sync)" markers by their captured stacks separates
runtime-owned flushes from host-owned ones.

| Chat | Count | Total | p50 | Owner |
| --- | ---: | ---: | ---: | --- |
| `setTextIfChanged`, `textContent` under `onState` | 53 | 72.2 ms | 1.19 ms | Host |
| premeasure `append`, warm read | 35 | 19.2 ms | 0.24 ms | Runtime, by design |
| `unmountRow`, `Element.remove` | 53 | 19.0 ms | 0.32 ms | Runtime |
| User-message collapse prepare and update | 46 | 29.2 ms | 0.43–0.90 ms | Host |
| `viewportState`, `scrollTop` | 2 | 0.3 ms | — | Runtime |

| Lab | Count | Total | p50 | Owner |
| --- | ---: | ---: | ---: | --- |
| `measureMany` read, `getBoundingClientRect` | 845 | 177.6 ms | 0.13 ms | Runtime, inherent |
| `setTextIfChanged`, lab status text | 560 | 69.9 ms | 0.12 ms | Host |
| `unmountRow`, `Element.remove` | 207 | 31.9 ms | 0.07 ms | Runtime |
| Lab log flush, `scrollHeight` | 242 | 17.3 ms | 0.01 ms | Host |
| Lab `scrollTop` hook and `viewportState` | 186 | 24.6 ms | 0.04–0.17 ms | Host and runtime |
| `measureMany`, `replaceChildren` | 848 | 5.7 ms | 0.004 ms | Runtime, no-op flushes |
| `writeScrollTop` | 75 | 1.3 ms | 0.005 ms | Runtime |
| `interruptNativeScroll`, `offsetHeight` | 30 | 0.7 ms | 0.02 ms | Runtime |

The `replaceChildren` group shows that moving elements into the measurement
root costs nothing measurable; the following `getBoundingClientRect` does the
real work, and that work is the layout of rows the runtime must know the
height of before they mount.

## Findings

Each finding states what the evidence shows and what was decided.

- **Wheel-handler style flush is relocation, not waste.** The `scrollTop`
  read in `boundaryAtNativeEdge` flushes style for rows mounted by the
  preceding scroll event: 75 of its 86 samples are style computation. The
  style-flush count matches the refresh tick count (1813 against 1754), so
  no frame restyles twice. Replacing the read with a cached position would
  change the Firefox edge contract for a saving the profile can't show.
  Not changed.
- **Coalescing the wheel-idle timer changes settle timing.** Replacing the
  cancel-and-rearm pair per wheel tick with one deadline timer keeps the
  idle moment but not the timer order: a cooldown timer scheduled after the
  last tick then fires before the re-armed remainder, and the pinned
  chromium trace settled at 172 ms instead of 296 ms through the pending
  settle check. The unit suite caught it; the change was reverted. Most of
  the sampled cost was the profiler capturing timer stacks.
- **Removal flushes finish a pending reflow.** Each reconcile task shows at
  most one reflow at its first `Element.remove` (53 of 53 chat tasks, 205
  of 207 lab tasks). A bench page under the same runner reproduced one
  reflow at the first removal for plain rows, clipped slots, observed
  elements, and scroll-anchored canvases alike, even after a clean
  `getBoundingClientRect`; headless Firefox 153 under Playwright showed no
  flush in any variant. Gecko's frame constructor completes pending layout
  before removing a frame, so the runtime's row structure isn't the
  trigger and reordering unmounts wouldn't remove the work. Not changed.
- **Measurement flushes are the contract.** Detached premeasure lays out
  new rows once in the measurement root and once more in the canvas. Its
  flush count equals the number of preparations, not the number of rows,
  and the median flush is 0.13 ms; the 10 ms maximum is a chunk load of
  twelve rows with images and code. Deferring offscreen measurement would
  break exact geometry. Not changed.
- **Commit reads are two flushes by design.** A commit reads the viewport
  before its writes and once after them, because the engine may clamp the
  position after a canvas change. The lab's `viewportState` flushes cost
  9 ms in 25 s. Not changed.
- **Slot creation parsed five declarations and probed the engine per
  slot.** `createSlot` now probes `overflow: clip` once and assigns the
  resolved declaration through a single `cssText` parse. The lab's
  `createSlot` self samples went from 7 to 4, which is within noise; the
  change is a cleanup with no behavior difference, verified by the unit
  suite and the browser invariants.
- **Host-side costs, reported and not changed.** In the chat, the status
  text write inside `onState` forces the largest single reflow group
  (72 ms per capture), and the user-message collapse module adds 29 ms; in
  the lab, status text, the log flush, and the `scrollTop` hook add about
  100 ms. These belong to the demos.

## Verification

The change passed `pnpm run check`, 740 unit tests, the seven analyzer
checks, the Firefox chat invariant suite (no violations or errors), the
quick Firefox lab scenario under "live" (no violations, no clipped
paints), the 108 refresh-anchor cases, and the generated-file cases. The
before and after captures match in paging progress, scroll height, and
element counts at gesture release.

## Limitations

- Animation-frame intervals measure main-thread timing, not display
  presentation.
- Scripted native gestures have no trackpad momentum tail; the chat's
  700 ms pause committed one page per capture rather than two.
- Inclusive sample counts overlap; marker durations are nested wall-clock
  times. Neither adds up to exclusive CPU cost.
- The lab's chaos interleaving differs between captures, so its totals are
  indicative, not paired measurements.
- The removal-flush mechanism was characterized by experiment, not by
  reading Gecko; its interaction with the runner's native input remains a
  hypothesis.

## Next steps

Runtime work with a measurable payoff would come from a different
workload, not from these two: ten-thousand-row `setItems` cost (see the
[performance checkpoint](performance-checkpoint.md)) and startup
premeasurement remain the larger absolute costs. For the scroll and commit
paths, repeat these captures after any change to `scroll-settle.ts`,
`premeasure.ts`, or the commit functions, and compare the runtime rows of
`attribute.mjs` before claiming a difference.
