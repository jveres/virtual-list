# Large rows, uneven reflow, and measured streaming, October 2, 2026

This follow-up tests three workloads outside the completed
[data-structure investigation](runtime-investigations-2026-10-02.md): rendering
inside a huge measured row, resizing rows with unequal layout costs, and
temporary allocations during measured-height paging and streaming.

None of the tested candidates justifies a production change. Block skipping
fails selection, one-row resize batches retain the giant-row stall, and fewer
sampled allocation objects do not produce a useful unprofiled timing or memory
gain. The final runtime remains v0.4.12. Reusable fixtures, compact profiling
analysis, and correctness regressions preserve the investigations.

## Large completed rows

The baseline uses the released v0.4.12 runtime and the actual demo Markdown
renderer. Each list contains one large row and 24 small surrounding rows.
The large row has identical block wrappers in both variants. Four traversals
each write 25 deterministic offsets, waiting two animation frames per offset.
A subsequent width change from 1,100 to 650 CSS pixels checks exact geometry,
content preservation, and full-row text selection.

| Row content | DOM elements inside row | Synchronous list creation | Host Markdown rendering and DOM construction | Content-main-thread CPU across four traversals |
| --- | ---: | ---: | ---: | ---: |
| 12 sections, each with prose and 25 code lines | 2,881 | 58 ms | 43 ms | 155 ms |
| 120 sections, each with prose and 25 code lines | 28,801 | 201 ms | 142 ms | 200 ms |
| One 3,000-line TypeScript fence | 27,011 | 228 ms | 179 ms | 182 ms |
| One 1,200-row, four-column table | 7,225 | 55 ms | 18 ms | 165 ms |

The host column is part of list creation, not an additional cost. These are
controlled creation measurements after module initialization, not cold or warm
demo boot times. All four traversal cases have zero sampled animation-frame
gaps above 25 ms; their largest gaps are about 17.7 ms. This establishes neither
physical display smoothness nor real trackpad behavior.

The tested block-skipping candidate measures each block once, applies
`content-visibility: auto` with its exact intrinsic block size, and rebuilds
that cache after width changes. Initial parsing, highlighting, and DOM creation
still happen before skipping starts. A code fence or table remains one block.

**Reject the candidate.** After the width-cache rebuild, installed Firefox loses
content in full-row selection:
the ordinary case returns 3,606 non-whitespace characters, versus 22,138 before
skipping. Waiting two animation frames after creating the selection does not
resolve it. The candidate run fails its correctness gate, so it supplies no
valid speedup evidence. The default browser regression tests the plain variant;
`RENDERING_VARIANT=skip` reproduces the rejected experiment.

The behavior is a measured limitation of this experiment, not the intended CSS
contract. MDN documents that [`content-visibility: auto` preserves selection,
focus, and find-in-page](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility).
Its [intrinsic-size documentation](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain-intrinsic-size)
also explains remembered sizes. Those features do not remove the need to verify
the actual browser and invalidate sizes when content or width changes.

Large-row creation remains expensive in these fixtures. Automatically splitting
one host-owned code fence or table would need new rendering, selection, and
geometry behavior. This experiment does not justify adding that behavior to
the list runtime.

## Unequal resize costs

Each resize case retains 320 measured rows. The uniform control has eight
wrapping paragraphs per row. The mixed case has 300 paragraphs in every 16th
row and two in the others. The spike case has one 2,400-paragraph row and two
paragraphs in every other row. Four width changes alternate between 650 and
1,100 CSS pixels. Each checks all cached heights, every prefix offset, total
size, and a mounted row's DOM geometry after completion.

The production 32-row drain completes the uniform and mixed cases without any
sampled frame gap above 25 ms. The spike case has one such gap per resize.
A temporary one-row cap isolates whether inter-row scheduling can remove it.

| Case | Original 32-row cap: completion range | One-row cap: completion range | Original: largest gap | One-row cap: largest gap |
| --- | ---: | ---: | ---: | ---: |
| Uniform | 432–440 ms | 5,515–5,547 ms | 17.5 ms | 17.7 ms |
| Mixed | 432–434 ms | 5,382–5,390 ms | 17.5 ms | 17.7 ms |
| Single spike | 450–478 ms | 5,414–5,439 ms | 50.0 ms | 50.6 ms |

**Reject smaller batches for this finding.** Even a single-row batch retains
the spike. The largest synchronous reflow is 42–51 ms at baseline and
51–56 ms with one-row batching. Across the four spike resizes, main-thread CPU
rises from 315 to 1,927 ms. More animation-frame scheduling and commits increase
the completion delay without dividing the expensive row's layout work.

This does not prove that no adaptive scheduler could help another distribution.
It shows that the reproduced stall remains when the batch is already one row.
There is no verified gain here to justify scheduler state or a new public
contract. The production cap is restored to 32 rows.

The third and final trial repeats the restored runtime. Uniform and mixed
cases again have no gaps above 25 ms. The spike again has one per resize,
with a maximum of 49.9 ms, 449–466 ms completion, and 304 ms total main-thread
CPU. That agrees with the original control and rejects the one-row change.

## Measured paging, streaming, and allocation sources

The `mixed-natural` workload uses 480- and 2,000-item budgets with measured
heights. Pages contain one quarter of the budget and overlap by 20%. Each cycle
submits six live text edits, updates intrinsic image dimensions asynchronously,
loads a page, reconciles eviction, and traverses to the middle. Every fourth
cycle also cancels a load and changes the viewport width. The final quarter
reverses paging direction. Checks verify overlap edits, cancellation, decoded
image dimensions, mounted heights, bounded item counts, and disposal.

The valid 40-cycle baseline samples 5,239 JS object creations in the small case
and 18,815 in the large case. Their recorded sizes sum to 276,472 and 965,976
bytes. **These sums are sampled object sizes, not total allocated bytes.**
The main commit and measured-window staging frames account for about 23% of
sampled creations in the large case. Source inspection identifies map-entry
iteration and staging pairs as a narrow candidate. Pager ownership snapshots,
host DOM creation, and fixture assertions also allocate.

Firefox's [allocation documentation](https://raw.githubusercontent.com/firefox-devtools/profiler/main/docs-user/memory-allocations.md)
distinguishes JS object-creation samples from native allocation tracking. JS
samples do not track frees or survival. Native tracking requires Nightly;
this investigation uses the installed release build. The analyzer keeps
nearest page and nearest runtime frames separately because a runtime caller
can include host work beneath it. Sites refer to served JavaScript locations.

The prototype changes map-entry iteration in `commitBody` to `Map.forEach`,
builds fresh staging pairs only for missing rows, and builds the staging index
with direct insertions. It preserves key callbacks, source snapshots, page
ownership, and cancellation. Its source hash is
`15c991a439c3d574494f0cb87f085375183384c9d1729690d8bbbf0ccc2b4a3e`.

| Forty-cycle allocation diagnostic | Original | Prototype |
| --- | ---: | ---: |
| Sampled object creations, 480 items | 5,239 | 4,521 |
| Sampled object sizes, 480 items | 276,472 bytes | 228,160 bytes |
| Sampled object creations, 2,000 items | 18,815 | 15,465 |
| Sampled object sizes, 2,000 items | 965,976 bytes | 834,720 bytes |
| Largest minor-GC slice, 2,000 items | 4.845 ms | 5.711 ms |
| Total cycle-collection slices, 2,000 items | 67.39 ms | 68.59 ms |

The sampled creation count falls by 14–18%, but collection pauses do not
consistently improve. Instrumented main-thread CPU falls by about 9.5%; that
includes allocation-recording overhead and does not establish the same saving
in ordinary execution. Separate 120-cycle unprofiled controls test actual API
wall timing and memory behavior.

**Reject the allocation prototype.** In the unprofiled 120-cycle comparison,
page-load totals change from 26,422 to 26,415 ms for 480 items and from 103,086
to 103,031 ms for 2,000 items: below 0.06% in both cases. Total resize completion
changes from 14,648 to 14,666 ms and from 34,661 to 34,677 ms. These operations
include frame waits and staged rendering, so this does not establish zero
internal CPU benefit; it establishes no useful end-to-end improvement here.

The small case's uncollected window storage is 98.16 versus 98.37 MiB, falling
to 4.80 MiB in both after collection. The large case retains 16.01 MiB in both
after collection. The content process ends the large case at 129.78 MiB at
baseline and 164.72 MiB with the prototype. Lifetime peaks are nearly unchanged
at approximately 231 and 230 MiB; they also include preceding cases and
diagnostic tabs. The higher ending footprint is not a general memory-regression
claim, but it supplies no memory benefit to justify the prototype.

Sampled frame gaps also do not consistently improve. The small case has two
gaps above 25 ms at baseline and five with the prototype; the large case has
three in each. No physical presentation or GC-pause improvement is claimed.
The runtime changes are removed before the final restored control.

The third and final unprofiled trial confirms the rejection. Restored page-load
totals are 26,406 and 103,130 ms; resize totals are 14,641 and 34,635 ms. Retained
window storage remains 4.80 and 16.01 MiB. The large case ends at 164.69 MiB
of content-process footprint, essentially the prototype's 164.72 MiB. That
shows why the earlier lower endpoint cannot establish a regression or a gain.
All three trials have nearly identical load and resize completion costs.
Live-edit timings include six animation-frame waits per cycle; their smaller
differences do not establish a corresponding CPU saving.

Natural collection is visible in the larger baseline: content footprint falls
from 179.39 MiB at cycle 60 to 126.52 MiB at cycle 80 without forced collection,
then stays at 127.52–129.78 MiB at cycles 100–120. The small case is still growing
at its cutoff, and its forced-collection drop shows collectable data, not a
finite-duration plateau. Neither result establishes unlimited-duration memory
bounds. All captures preserve bounded active items and balanced row disposal.

## Measurement conditions

Installed Firefox 157.0, build `20260924084938`, macOS 27.0; fresh temporary
profiles and closed DevTools. LU28R55 is 1,920 × 1,080 logical pixels, DPR 2,
60 Hz. The outer window is 1,900 × 1,049 at `(1450, 31)`; content is
1,900 × 964. The scroll viewport starts at 1,100 × 924 CSS pixels.

The runner verifies display geometry, document identity, actual scroll
movement, scroll-end delivery, workload completion, and disposal. Animation-frame
samplers read timestamps and cached list state, without DOM layout reads.
Geometry assertions run outside the samplers. CPU values interpolate the
boundaries of 2 ms samples and cover the selected content main thread only.
Rendering markers can nest; they are not additive independent CPU costs.
Missing marker names do not establish zero rendering work.

Memory checkpoints report the fixture window's explicit allocation subtree and
owned-process physical footprints separately. Diagnostic collection uses a
temporary `about:memory` tab. A natural checkpoint precedes requested GC and
cycle collection; collection between cases changes cache and GC behavior.
Profiles add overhead. Raw captures are removed after compact analysis.

The initial large-row baseline `huge-row-baseline/run-DTLAgm` is invalid: its
fixture tolerance incorrectly assumed device-pixel rounding at DPR 2. The
runtime uses whole CSS pixels for native-flow rows at integral pixel ratios.
The corrected fixture allows that documented rounding and retains strict
prefix and total-size checks. The failed run is excluded from the results.

The initial 120-cycle allocation capture
`measured-streaming-allocations/run-TjBApZ` is also invalid. The 2,000-item
case exhausts the diagnostic buffer and loses its start marker. The analyzer
rejects it; neither its timing nor its partial allocation summary establishes
a gain. Allocation captures are limited to 40 cycles afterward. Longer
unprofiled controls remain separate from sampled allocation diagnostics.

## Reproduction

The reusable fixture is
[`rendering-workload.js`](../../scripts/firefox-profile/fixtures/rendering-workload.js).
Compact summaries, source patches, file hashes, commands, browser build, and
display metadata remain locally under ignored `browser-artifacts/`.

```sh
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=huge --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/huge-row-baseline
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=huge --variant=skip --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/huge-row-skipping
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=resize --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/uneven-resize-baseline
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=resize --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/uneven-resize-one-row
node scripts/firefox-profile/runtime-retention.mjs --workload=rendering --scenario=resize --variant=plain --cycles=4 --diagnostic --display=LU28R55 --output=browser-artifacts/uneven-resize-restored
node scripts/firefox-profile/runtime-retention.mjs --workload=mixed-natural --cycles=40 --diagnostic --allocations --display=LU28R55 --output=browser-artifacts/measured-streaming-allocations
node scripts/firefox-profile/runtime-retention.mjs --workload=mixed-natural --cycles=120 --display=LU28R55 --output=browser-artifacts/measured-streaming-baseline
```

Valid large-row baseline: `huge-row-baseline/run-lOlLWu`. Rejected selection
experiment: `huge-row-skipping/run-Dzi7c3`, marked invalid. All start from
revision `991f5cd212aed98e03760c3649ac071990c2ac42`; their reproduction patches
record the additional fixtures and analysis tools.

Resize baseline: `uneven-resize-baseline/run-gbo2Yq`; one-row control:
`uneven-resize-one-row/run-ri4gzQ`. Reproduce the one-row control with its saved
source patch, which changes only `WIDTH_DRAIN_ROWS` in production code.
Restored control: `uneven-resize-restored/run-3kqhIi`. The final runtime has
SHA-256 `e3b364d2b09923e81d9c5f2de3016f6ed168b805957ad88650fa0fe5b3408ac0`,
identical to v0.4.12. The resize comparison stops after these three trials.

Allocation baseline: `measured-streaming-allocations/run-j9CpDi`; prototype:
`measured-streaming-candidate-allocations/run-yyhZY0`. The 120-cycle unprofiled
baseline is `measured-streaming-baseline/run-nKXp0S`; prototype:
`measured-streaming-candidate/run-vromUU`. Use the prototype's saved source
patch and matching command to reproduce it. Different cycle counts change
duration and reversal timing; do not compare their wall times as a speedup.
The restored final trial is `measured-streaming-restored/run-LoAiY4`. The
ordinary timing comparison stops after these three valid captures. The two
shorter allocation captures provide attribution only.

## Validation and disposition

The final tree passes `pnpm run check`, all 5,650 unit tests in 55 files, and
all 195 portable profiler checks. The first sandboxed profiler-check attempt
cannot open three local test servers; rerunning with local-server permission
passes all checks. The two existing CSS `!important` warnings remain unchanged.

The rendering regression passes all seven plain cases in Firefox, Chromium,
and WebKit. The paging regression passes its three declared cases and both
measured cases in all three engines. These checks validate geometry, content,
selection in the plain rendering control, cancellation, overlap edits, image
dimensions, movement, and disposal. Their headless timings are not performance
evidence. The rejected runtime prototype also passed the unit suite and the
focused Firefox measured-paging regression before measurement.

All captures finish cleanup without errors. Only compact summaries and
reproduction metadata remain; raw profiles, temporary browser profiles,
helpers, and server caches are removed. The final process audit finds no owned
browser, automation session, helper, or server. Unrelated user processes are
preserved.

All three concrete investigations are complete. No production changes remain,
and no new runtime release is justified. This closes the tested candidate queue,
not every possible future renderer, device, or browser workload.
