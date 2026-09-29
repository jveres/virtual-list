# DOM work during chat scrolling, September 29, 2026

Five comparison rounds found no repeatable CPU gain that justifies retaining a
production change for scrolling already-loaded messages. The rounds test header
style guards, mount-window batching and pointer location, inline image URLs in
two implementations, and a combined hover-selector and wheel-read candidate.
All production candidates and their candidate-only tests were reverted.
Production scrolling, mounting, paging, and image behavior remain unchanged.

The retained improvements are profiling tools: a reproducible `steady` scenario
that excludes paging and streaming, tool-heavy and bounded raster-image fixtures,
pointer-location control, classified DOM counters, and image-readiness checks.
Retained rows already reuse their DOM, and unchanged mounted ranges skip
reconciliation. Earlier attribution captures below provide mount/unmount detail;
their page-construction work is outside the scroll-only comparison. The full
12-cycle original-image memory gate and final repository checks pass; the shorter
memory run's settling failure remains documented separately.

## Scroll-only comparison

All three timing captures use revision
`1084d9f67fe6b81da236b4b30be45dbed74cb50b`, the pinned `markdown-viewer`
`v0.8.10`, and installed Firefox `156.0.1`, build `20260921121718`, on macOS 27.
Each uses a fresh temporary profile with DevTools closed. The LU28R55 is
1920 × 1080 logical pixels, 2× scaling, at 60 Hz. The browser's outer window
is 1900 × 1049, its inner area is 1900 × 965, and the chat viewport is 815
pixels tall. No CPU contention workers or concurrent test suites are running.

The complete 20-turn synthetic conversation is loaded before measurement. Six
native macOS gestures scroll 4,320 pixels down and then 4,320 pixels up through
the same interior band. Each capture records exactly 34 mounted-range changes,
six scroll-end events, no response requests, no streamed chunks, no held paging
state, and no loaded-range changes. Initial and final DOM size is 585 elements.

The middle capture tests guards around repeated unchanged inline `transform`
and `height` assignments in the sticky-header companion. The third restores the
original code. Source patches and hashes distinguish these variants.

| Capture suffix | Variant | Duration | Content main-thread CPU | Scroll handlers, total | Nonempty style passes | DisplayList, total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `Kfw4XR` | Original | 15.275 s | 239.9 ms | 33.0 ms / 536 events | 86 | 23.3 ms |
| `2XxxOG` | Guard unchanged header styles | 15.375 s | 332.8 ms | 48.7 ms / 534 events | 86 | 30.8 ms |
| `LEHtYx` | Original restored | 15.373 s | 231.7 ms | 32.1 ms / 536 events | 85 | 21.9 ms |

The original code uses about 1.5–1.6% of one CPU core on average in this workload.
Its scroll-handler p95 is 0.324–0.328 ms. Native style work totals 17.2–18.4 ms,
and synchronous reflow totals 10.8–11.2 ms. These nested wall-time markers must
not be added to sampled CPU time.

The candidate provides no measured saving and removes no style passes. Several
unrelated timing categories also increase in that capture, so these three runs
do not establish that the extra inline-style reads caused the entire difference.
They do establish that this experiment does not justify a performance patch.
The candidate and its candidate-only regression assertions were removed.

The native gestures exercise real input, row recycling, and reversal. They do
not reproduce released-trackpad momentum, fast-scroll skeleton activation,
image-heavy private conversations, or CPU contention. Moving rAF p95 remains
17.00–17.18 ms; regular callbacks are not proof of smooth physical presentation
and do not resolve the reported Safari jitter.

## Mount/unmount attribution

Three earlier diagnostic captures use the same browser and display. They include
a reply and, in two cases, an older-page load. They are attribution evidence,
not before/after comparisons or substitutes for the scroll-only test above.

| Capture suffix | Workload | Duration | Older pages loaded | Mount / unmount calls | Combined synchronous mount / unmount time |
| --- | --- | ---: | ---: | ---: | ---: |
| `UwgknX` | Rich stream, 48 sections over 12 seconds | 25.61 s | 1 | 33 / 30 | 9 ms |
| `mHLMWq` | Tool history, one-second prose reply | 25.43 s | 0 | 30 / 28 | 23 ms |
| `ZxnIEU` | Same tool history, longer scroll | 35.45 s | 1 | 40 / 38 | 26 ms |

Operation times are inclusive and rounded by Firefox's timer precision. Host
mount hooks can run after the runtime mount span; separate image, collapse,
viewer, and action-state spans cover those hooks. Browser style, layout, and
display-list work can occur later. These costs overlap.

The no-page tool-history capture records 894 scroll events but only 68 calls to
mount-window reconciliation. Retained mounts do not parse Markdown again. In
the two tool-history captures, individual mounts take at most 1 ms and unmounts
at most 2 ms. Preview collection takes only 1 ms in the longer capture. Image
resource release must remain: removing it would reintroduce decoded-image and
graphics-memory retention.

The longer capture also contains a 27.65 ms awake interval during preparation
of an older page. That is a separate workload. No page-preparation changes are
proposed or made as part of this scroll investigation.

Other rejected directions include timer coalescing that can reorder wheel-idle
and scroll-settle callbacks, and paint containment that previously caused blank
rows on iPad. Their correctness risks are not justified by these small measured
scroll costs.

## DOM instrumentation

Probe version 6 classifies wrapped `insertBefore`, `removeChild`, and `remove`
calls as connected insertion, movement, removal, detached work, no-op, or failed
calls. It reads tree state before the call without geometry reads or subtree
walks. The longer tool-history capture records 81 connected insertions in 10 ms,
103 connected removals in 22 ms, and 35 parentless removals below timer resolution.
No wrapped call lasts at least 4 ms and no recorded DOM burst lasts at least
16 ms.

These are not counts of all DOM work: they exclude methods such as `appendChild`
and `replaceWith`, setters such as `innerHTML`, and parsing beneath setters.
One insertion can contain a large subtree. Timing captures omit these wrappers
and diagnostic observers; native profiling remains necessary.

## Reproduction

Run the scroll-only comparison with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=steady \
  --mode=timing --display=LU28R55 --refresh-hz=60 --trail=off \
  --sections=1 --stream-ms=1000 --content=prose \
  --output=browser-artifacts/steady-scroll
```

The workload hash is
`850977a924dd5e94c9def90be53ee342900c8b86100050593fcc9b1b6f5f0927`.
Reply settings remain in fixture metadata, but this scenario never submits a
reply. It uses exactly 20 history turns, fixed native gesture arguments, and a
saved setup script that places the viewport away from both boundaries. Validation
rejects paging, streaming, insufficient travel, and insufficient mounted-range
changes. Diagnostic mode additionally requires actual mounts and unmounts.

The earlier tool-heavy attribution workload is reproduced with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=scrollback \
  --mode=diagnostic --display=LU28R55 --refresh-hz=60 \
  --seconds=30 --stream-ms=1000 --sections=1 --content=prose \
  --history=160 --history-content=tools --trail=long \
  --output=browser-artifacts/dom-scroll
```

Use `--seconds=20` for its no-page control. The tool workload hash is
`7907d8740837020ce46049c3ab7fe7ecc1baf39389c6c0a553a5daf5bdc52959`.
It adds 240 closed synthetic tool calls with 925,955 payload characters. The
initial rich capture uses default rich history/content, `--seconds=20`,
`--stream-ms=12000`, and `--sections=48`; its hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

Compact summaries, exact commands, source patches, hashes, and browser metadata
remain under ignored `browser-artifacts/steady-scroll/` and
`browser-artifacts/dom-scroll/`. Reusable fixtures and checks are tracked under
`scripts/firefox-profile/`. No private conversation is used. Raw captures and
temporary browser profiles are removed by the runner.

## Verification and cleanup

`pnpm run check`, all 5,623 unit tests, and all 171 portable profiler checks pass.
The check retains two existing CSS `!important` warnings. The unit and profiler
suites need loopback access for temporary local test servers. The three installed
Firefox runs exercise the new capture path; production browser behavior is
unchanged, so no additional application browser regression suite is needed.

All owned capture browsers, native helpers, and servers have exited. Raw captures,
temporary browser profiles, and the regenerable Swift module cache are removed.
The scroll-only comparison retains about 564 KiB of compact summaries and replay
metadata.

## Second round: heavier rows and boundary batching

The next round keeps paging and streaming excluded, but uses the existing
`tools` history preset. Twenty loaded turns contain 30 closed tool calls and
115,395 payload characters. The viewport contains 1,485 elements at both
capture boundaries, compared with 585 in the first round. The history has no
images; its workload hash is
`c95e7dbf6242aecf7ffe5cad2d56b875958f665481c8a5c7d5e1416043635e7d`.
Browser, display, native gesture plan, source revision, and dependency pins
match the first round.

The candidate rounds stacked-list query bounds outwards to overscan-sized
buckets, as positioned lists already do. The visible range remains covered,
and native spacers continue to balance the mounted rows. Batching could reduce
the number of separate row-boundary layouts, but it can keep extra rows
connected and perform more DOM work at once.

| Measure | Original `Q6ipHk` | Batched boundaries `kGOu6v` |
| --- | ---: | ---: |
| Duration | 15.353 s | 15.409 s |
| Content main-thread CPU | 264.2 ms | 264.3 ms |
| Mounted-range changes | 36 | 24 |
| Nonempty style passes | 113 | 79 |
| Styles total | 26.5 ms | 24.4 ms |
| DisplayList builds / total | 92 / 29.0 ms | 72 / 25.1 ms |
| Scroll handler p95 / maximum | 0.339 / 1.360 ms | 0.210 / 1.148 ms |
| Longest awake interval | 5.45 ms | 10.44 ms |

Both runs travel exactly 4,320 px in each direction and pass steady-scenario
validity. Reducing mounted-range changes by one third does not reduce total CPU
in this pair. The candidate's longest awake interval contains two style/layout
flushes and a small JIT compilation sample. This does not prove that batching
alone caused the larger interval, but it gives no reason to accept the change
on operation counts alone.

The candidate was reverted before the third capture. Pixel-based extra retention
would not bound image memory: one extra row could contain many large images.
Tiny reversals around bucket boundaries could also repeatedly swap a whole batch.
There is no reason to change that behavior or the existing overscan contract for
an unmeasured CPU gain.

Reproduce the heavier original run with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=steady \
  --mode=timing --display=LU28R55 --refresh-hz=60 \
  --history-content=tools --trail=off --sections=1 \
  --stream-ms=1000 --content=prose \
  --output=browser-artifacts/steady-dom-round2
```

Compact artifacts and the rejected candidate's exact source patch remain under
ignored `browser-artifacts/steady-dom-round2/`. Application source is restored.

### Pointer-location control

The third and final capture, `gT4ek1`, uses the original runtime and adds
`--pointer-x=0.02` to the same command. The native runner retains actual input
coordinates for each burst. All six points are at client x=38, inside the
viewport but outside any message. The fixture, display, travel, and 36 range
changes match the baseline; boundary DOM size remains 1,485 elements.

| Measure | Center-pointer original `Q6ipHk` | Gutter pointer `gT4ek1` |
| --- | ---: | ---: |
| Duration | 15.353 s | 15.288 s |
| Content main-thread CPU | 264.2 ms | 411.1 ms |
| Nonempty style passes | 113 | 79 |
| DisplayList builds | 92 | 78 |
| Interruptible reflows | 28 | 5 |
| Scroll events / scroll ends | 536 / 6 | 517 / 6 |
| Maximum wheel-event age at delivery | 16 ms | 101 ms |

The control passes focus, movement, history, and gesture validity. It shows fewer
style/layout opportunities with the pointer outside message content, consistent
with avoiding hover transitions. It does not establish a CPU improvement.
The gutter run also has a long input-delivery outlier and broadly higher timing
costs, including wheel handling. This single pair cannot distinguish pointer
effects from scheduling or other run variation. No hover behavior or CSS selector
change follows from it.

The reusable pointer control is retained in both Firefox profiling entry points,
with validation and replay coverage. It does not add DOM reads to the frame
sampler: coordinates and hit target are read only once before each native burst.
Numeric values outside `0.01..0.99` and inapplicable capture modes fail before
launching a browser or creating capture artifacts.

This round provides no significant production optimization. Image-heavy steady
scrolling remains a separate unmeasured workload: the rich-history fixture's
assistant indices are odd, while its image branch requires a multiple of eight,
so both current history presets contain no images. Large inline image source
restoration is a hypothesis for that workload, not a finding from these captures.

The second-round checkpoint passes `pnpm run check`, all 5,623 unit tests, and
all 173 portable profiler checks. The same two existing CSS warnings remain.
All owned profiling processes have exited. Raw captures, browser profiles, and
the regenerable Swift cache are removed; the three runs retain about 580 KiB
of summaries and reproduction metadata.

## Third round: inline-image prototype

The new `images` history preset exercises image restoration during row recycling
without paging or streaming. Its 20 loaded turns contain 10 distinct inline
960×360 PNGs with explicit dimensions. The fixture contains 868,770 PNG bytes,
1,158,580 inline-source bytes, and 1,172,747 serialized-history bytes. The history
hash is
`4acc41dcdb0f8fcf1c4fc77716dca530fdf4b6b408b1f168efda82ad54ddb172`.
The final capture records Node `v24.21.0` and zlib `1.3.2.1-motley-8002e91`;
the earlier captures have the same workload hash but predate generator-version
metadata.

The browser build, source revision, dependency pin, display, window geometry,
and native gesture plan match the first two rounds. All three captures travel
exactly 4,320 px in each direction, record 30 mounted-range changes, and retain
386 DOM elements at both boundaries. Each boundary has two mounted images, both
reporting complete loads and natural dimensions of 960×360. These DOM readiness
signals do not prove `img.decode()` completion, GPU readiness, or smooth physical
presentation. No response, history-page load, or held paging state occurs.

The middle capture tests a temporary prototype for immutable, known-size inline
images. It converts their data URLs to owned blob display URLs before row-image
suspension, preserves the existing mapping to original sources for preview
identity, and revokes the owned URLs when their rows are destroyed. Responsive
images are excluded. The third capture restores the original data-URL behavior.
This prototype does not establish a lifecycle contract for editable or streaming
image content and is not an accepted production change.

| Measure | Original `e1F6id` | Blob prototype `yYAGwT` | Original restored `ieOgRe` |
| --- | ---: | ---: | ---: |
| Duration | 15.143 s | 15.450 s | 15.184 s |
| Content main-thread CPU | 330.617 ms | 217.827 ms | 310.843 ms |
| Average share of one CPU core | 2.18% | 1.41% | 2.05% |
| Scroll handlers, total | 52.345 ms | 35.888 ms | 50.498 ms |
| Wheel handlers, total | 37.083 ms | 25.919 ms | 33.213 ms |
| Styles, total | 18.640 ms | 13.984 ms | 17.712 ms |
| Synchronous reflow, total | 13.042 ms | 9.418 ms | 12.766 ms |
| DisplayList, total | 23.870 ms | 17.942 ms | 23.895 ms |
| Moving rAF p95 | 17.28 ms | 17.12 ms | 17.28 ms |

The prototype's measured CPU is 30–34% below the two original runs. That is a
promising signal, but not a confirmed causal saving. Wheel handling, styles,
reflow, and display-list timings all fall in the middle run, and the native
profiles attribute only sparse samples directly to image-source restoration.
The two original runs each have two samples attributed to `resumeRowImages` in
the compact script counts. These samples do not explain or quantify the whole CPU
difference. Three captures provide no statistical confidence estimate, and
nested marker durations must not be added to sampled CPU time. This result
justifies further lifecycle and memory work; it does not establish a jitter fix
or a general CPU reduction for the application.

Reproduce the unchanged image workload with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=steady \
  --mode=timing --display=LU28R55 --refresh-hz=60 \
  --history-content=images --trail=off --sections=1 \
  --stream-ms=1000 --content=prose \
  --output=browser-artifacts/steady-images
```

The three compact runs and prototype source patch remain under ignored
`browser-artifacts/steady-images/`. The original image behavior was restored
after this comparison. Raw profiles and temporary browser profiles are removed.

### Original image-memory gate

A separate six-cycle memory run, `xVilaR`, tests the original implementation with
the existing 48-turn fixture containing 24 synthetic 4000×3000 images. It uses
the same Firefox build and LU28R55 display, with the memory runner's 1920-pixel
window width. Its instant-step allocation workload differs from the native
scroll comparison above; it does not compare the prototype's memory behavior.

The run fails the settled-range check: the last three cycle totals span
44.9 MiB, above the 40 MiB limit. Other limits pass: maximum combined physical
footprint is 1,225.3 MiB against 1,400 MiB, the largest process lifetime peak is
472.8 MiB against 600 MiB, and the last-three-cycle median is 24.3 MiB below the
first-three-cycle median. A negative median change does not waive the separate
settling requirement. This run neither establishes a plateau nor proves
unbounded growth.

```sh
pnpm run test:memory -- --browser=firefox --workload=images \
  --cycles=6 --display=LU28R55 --trail=off --input=steps \
  --message-layers=default --canvas-layer=default
```

Its compact summary and reproduction metadata remain under ignored
`browser-artifacts/memory/firefox-images-xVilaR/`. Physical-footprint totals can
include shared process accounting; they are not JavaScript heap measurements.

## Fourth round: owned image URLs rejected

The follow-up implements the ownership needed beyond the earlier prototype.
Static rows receive owned blob display URLs, retain their logical original
sources for preview navigation, and release those URLs when the row is destroyed.
Streaming rows and responsive images remain excluded. Safari display-copy guards
check that the displayed blob still maps to the expected logical source and
that the row still owns it before an asynchronous replacement. They preserve
source identity and disposal safety; they add no decode-completion guarantee.
Targeted validation includes an initial 47-test run and a later 23-test focused
run; these are not a full application browser regression suite.

This round compares the completed candidate, the restored original, and the
candidate again. It uses the same image-workload hash, source revision,
dependency pin, Firefox build, LU28R55 geometry, and fixed gesture plan as the
third round. All captures pass validity, travel 4,320 px in each direction, record
30 mounted-range changes, and retain 386 DOM elements at both boundaries. Both
mounted images at each boundary report complete loads and the expected
960×360 natural dimensions. Their display sources are blobs in the candidate
runs and data URLs in the original run.

| Measure | Candidate `F65lEs` | Original `OPaRHc` | Candidate repeat `vkr3nQ` |
| --- | ---: | ---: | ---: |
| Duration | 15.180 s | 15.344 s | 15.260 s |
| Content main-thread CPU | 349.836 ms | 304.249 ms | 345.624 ms |
| Average share of one CPU core | 2.30% | 1.98% | 2.26% |
| Scroll handlers, total | 57.228 ms | 49.851 ms | 52.311 ms |
| Wheel handlers, total | 41.725 ms | 33.560 ms | 37.564 ms |
| Styles, total | 19.408 ms | 18.145 ms | 19.522 ms |
| Synchronous reflow, total | 15.062 ms | 13.095 ms | 14.224 ms |
| DisplayList, total | 26.419 ms | 22.207 ms | 25.595 ms |
| Moving rAF p95 | 17.20 ms | 17.08 ms | 17.08 ms |

Neither candidate run repeats the earlier CPU gain. This does not establish a
statistically significant slowdown or identify why the prototype's middle run
was faster. It does establish that the completed change has no repeatable CPU
benefit in these captures. The extra ownership paths and encoded blob storage,
while original data-URL strings remain in the model, are not justified by that
result. No memory capture was run for this completed candidate, so its physical
memory cost or saving is unmeasured.

All candidate image code and candidate-only tests were reverted. The original
image lifecycle remains in production. The reusable image workload, readiness
guard, and reproduction support remain in the profiler. No jitter fix or
application CPU reduction is claimed from the two image rounds.

Use the third-round command with
`--output=browser-artifacts/steady-image-owned` to reproduce the workload. The
three compact runs retain their exact variant patches and hashes under that
ignored directory; raw profiles and temporary browser profiles are removed.
The full original-code memory repeat below investigates the six-cycle settling
failure separately.

## Fifth round: hover selector and wheel reads rejected

The final text comparison returns to the 20-turn `tools` history from the second
round. The combined candidate replaces the assistant action hover selector's
parent `:has()` with an equivalent following-sibling selector and adds a
direction-aware guard that avoids unnecessary bottom-geometry reads for upward
wheel input. The focused wheel suite passes 70 tests before capture.

The original, combined candidate, and restored original use the same source
revision, browser build, display geometry, and gesture plan as earlier rounds.
The workload hash remains
`c95e7dbf6242aecf7ffe5cad2d56b875958f665481c8a5c7d5e1416043635e7d`.
All three runs pass validity, traverse 4,320 px in each direction, record 36
mounted-range changes, and retain 1,485 DOM elements at both boundaries.

| Measure | Original `XdPSCV` | Combined candidate `clsM9i` | Original restored `WX3HvD` |
| --- | ---: | ---: | ---: |
| Duration | 15.405 s | 15.173 s | 15.482 s |
| Content main-thread CPU | 259.770 ms | 368.634 ms | 297.410 ms |
| Average share of one CPU core | 1.69% | 2.43% | 1.92% |
| Scroll handlers, total | 36.721 ms | 54.531 ms | 42.583 ms |
| Wheel handlers, total | 25.615 ms | 35.524 ms | 28.766 ms |
| Styles markers | 106 | 106 | 107 |
| DisplayList builds | 75 | 75 | 76 |
| Styles, total | 25.699 ms | 32.672 ms | 28.794 ms |
| Synchronous reflow, total | 12.116 ms | 16.757 ms | 13.717 ms |
| Moving rAF p95 | 17.16 ms | 17.38 ms | 17.04 ms |

The combined candidate reduces neither style-marker counts nor total CPU in this
comparison. Timing varies across unrelated work, including the two original
runs. Three captures cannot establish a statistically significant regression,
and testing both changes together cannot attribute a difference to either one
individually. There is no useful measured gain to retain, so both changes and
their candidate-only tests were reverted.

Reproduce this workload with the second-round command and
`--output=browser-artifacts/steady-final-text`. Compact summaries, variant
patches, and reproduction hashes remain in that ignored directory. Raw profiles
and temporary browser profiles are removed.

## Remaining ideas

The remaining ideas offer no demonstrated significant reduction in these
workloads. Timer coalescing can reorder equal wheel-idle and settle deadlines,
causing Chromium to settle early; preserving their order leaves only small
allocation savings. Sharing collapse observers could reduce per-row allocations,
but measured loaded-row mount costs are already small, and callback/disposal
ordering needs care. The runtime's row observer is already shared and skips
unchanged sizes. Per-scroll task and snapshot objects are bounded transient
allocations, with sparse attribution and no identified growing cache. Viewport
listeners are passive, and optional extra sticky-scroll observation is disabled
here. Lazy closed-tool bodies target first construction rather than steady
scrolling and would change native Find behavior. Image suspension/release and
anchoring protections remain necessary. These findings do not exhaust other
content, browsers, CPU contention, or physical trackpad momentum.

## Full memory repeat and final verification

The original implementation passes the full 12-cycle Firefox image-memory gate
in `KmlYsf`, using the same 24-image allocation workload and display as `xVilaR`.
No application change or budget adjustment separates these runs. The longer run
allows the initially declining footprint to settle; the failed six-cycle result
remains recorded above.

| Measure | Twelve-cycle original | Limit |
| --- | ---: | ---: |
| Largest process lifetime peak | 470.7 MiB | 600 MiB |
| Maximum combined process footprint | 1,207.2 MiB | 1,400 MiB |
| Last-three minus first-three median | −62.9 MiB | 64 MiB |
| Final-three-cycle range | 3.3 MiB | 40 MiB |

The final three combined footprints are 1,104.1, 1,104.7, and 1,107.5 MiB. Every
cycle visits all 48 message keys, and the image-coverage and height checks pass.
This is evidence of a bounded plateau for this workload, not a measurement of
physical scroll smoothness or proof against every future memory regression.

```sh
pnpm run test:memory -- --browser=firefox --workload=images \
  --cycles=12 --display=LU28R55
```

Compact evidence remains under
`browser-artifacts/memory/firefox-images-KmlYsf/`. The runner reports no cleanup
errors. All profiling browsers, native helpers, and owned servers have exited.
Raw profiles and temporary browser profiles are removed, along with about
790 MiB of regenerable Swift caches. The three new timing groups and two memory
runs retain about 2.3 MiB of summaries, source patches, and reproduction metadata.

Final checks pass: `pnpm run check`, all 5,623 unit tests, and all 178 portable
profiler checks. The same two pre-existing CSS warnings remain. No application
source or application test changes remain from these experiments; retained
changes are the reusable profiler workloads, measurement controls, validity
checks, and this report. Cross-browser application regressions were not rerun
after all production candidates were reverted.
