# Fast scrolling through loaded chat, September 29, 2026

This follow-up finds no additional CPU improvement to retain. The current
runtime remains unchanged. Adding `content-visibility: auto` to its measured,
fixed-height native slots lets Firefox skip some rendering, but increases
style, layout, and display-list work in the matched fast-scroll workload.
The candidate is reverted after three timing trials.

The retained changes improve measurement: a faster native-input preset,
constant-geometry validation, and a bounded browser-skipping event counter.
They complement the [earlier DOM-operation rounds](dom-scroll-operations-2026-09-29.md).

## Conditions and workload

All captures use revision `9ca45b2` plus the recorded profiling-tool patches,
installed Firefox **157.0**, build **20260924084938**, and the pinned
`markdown-viewer` **v0.8.10**. Firefox has updated since the earlier rounds;
their Firefox 156 results are not a matched baseline for these trials.
Each run creates a fresh temporary browser profile with DevTools closed.

The LU28R55 is 1920 × 1080 logical pixels, 2× scaling, at 60 Hz on macOS 27.
The outer window is 1900 × 1049 at 1450, 31, and its inner area is 1900 × 964.
The chat viewport is 815 px tall. No contention workers or concurrent test
suites run during capture.

The deterministic `tools` history contains 20 fully loaded turns, 30 closed
tool calls, and 115,395 payload characters. Initial and final DOM counts are
both 1,485 elements.
The workload hash is
`c95e7dbf6242aecf7ffe5cad2d56b875958f665481c8a5c7d5e1416043635e7d`.

The fast plan sends three downward and three upward native macOS gestures.
Each contains 30 events at 48 px, 16.667 ms apart, followed by a 700 ms pause.
Input speed is about 2,880 px/s, three times the earlier plan, over the same
4,320 px travel band in each direction. This is uniform native input with
gesture release phases, not real trackpad momentum.

All three timing trials record 180 wheel events, six scroll-end events,
26 mounted-range changes, and exactly 4,320 px of movement in both directions.
They start and end at 1,987.5 px with 9,110 px scroll height. No response
request, streamed chunk, paging operation, or held state occurs.

## Diagnostic attribution

A separate original-runtime diagnostic capture, `ggwRmH`, records 20 mounts
and 20 unmounts. Their inclusive synchronous spans total 5 ms and 14 ms,
respectively. No individual row operation exceeds 2 ms. The scroll-handler
span totals 42 ms over 180 calls, including nested reconciliation and host work.
The diagnostic wrappers add cost; these figures are attribution evidence,
not a comparison with the uninstrumented timing trials.

Geometry queries, action-state refresh, image scans, and collapse observation
remain small in this workload. Native style/layout and DOM retirement provide
more plausible remaining headroom than another change to the anchoring state
machine or repeated geometry lookup.

## Browser-managed rendering experiment

The candidate adds `content-visibility: auto` only after a measured native
slot has an explicit height. The
[CSS containment specification](https://www.w3.org/TR/css-contain-2/#content-visibility)
allows the browser to skip offscreen content. Known slot heights avoid relying
on estimated intrinsic sizes. The property also introduces containment and
rendering-state transitions; those costs must be measured.

The setup records
[`contentvisibilityautostatechange`](https://developer.mozilla.org/en-US/docs/Web/API/ContentVisibilityAutoStateChangeEvent)
events without geometry reads. The candidate records 27 transitions into
skipped rendering and 18 back into rendering during measurement. These counts
do not mean 27 unique rows. The restored runtime records no such transitions.
The original baseline precedes this counter addition; its event metric is
unavailable. The candidate and restored trial use the same listener.

| Measure | Original `gLEJL1` | Candidate `OV8FSt` | Original restored `vFjJ0S` |
| --- | ---: | ---: | ---: |
| Capture duration | 8.166 s | 8.189 s | 8.179 s |
| Content main-thread CPU | 205.5 ms | 290.6 ms | 222.1 ms |
| CPU average, one core | 2.52% | 3.55% | 2.72% |
| Style passes / total | 101 / 28.5 ms | 193 / 36.4 ms | 99 / 29.6 ms |
| Synchronous reflows / total | 60 / 13.4 ms | 99 / 19.4 ms | 60 / 14.5 ms |
| Display-list builds / total | 66 / 23.2 ms | 109 / 40.3 ms | 64 / 23.2 ms |
| Scroll handler total | 29.6 ms | 33.9 ms | 31.8 ms |
| Scroll handler p95 | 1.029 ms | 0.938 ms | 0.995 ms |
| Moving rAF interval p95 | 17.08 ms | 17.08 ms | 17.06 ms |

The candidate uses 31–41% more content main-thread CPU than the two originals
in these trials and nearly doubles style-pass count. Its extra rendering
transitions do not remove the DOM recycling that the virtualizer already does.
That is sufficient to reject the experiment; it does not isolate every source
of the CPU difference or prove a general cross-browser regression. Wheel
timings and garbage collection also vary. Marker totals are nested wall times
and must not be added to sampled CPU time.

The candidate and restored capture pass the added per-state and per-frame
constant-size gate. All captures have identical initial and final dimensions.
Regular rAF callbacks cannot establish smooth physical presentation. These
runs do not resolve Safari jitter, reproduce OS contention, or measure memory
peaks. No Safari or Chrome optimization is inferred from them.

## Reproduction

Run the original workload with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=steady \
  --steady-speed=fast --mode=timing --display=LU28R55 --refresh-hz=60 \
  --trail=off --sections=1 --stream-ms=1000 --content=prose \
  --history-content=tools --output=browser-artifacts/fast-scroll-exploration
```

Use `--mode=diagnostic` for operation attribution. Omitting `--steady-speed`
retains the original 90-event, 16 px normal-speed plan. The fast plan requires
at least 135 observed wheel events, six scroll ends, bidirectional travel,
mounted-range churn, stable modeled size, and no paging or stream activity.

Compact evidence remains under ignored
`browser-artifacts/fast-scroll-exploration/`. Each capture retains the exact
command, source patch and hashes, generated setup, browser build, display
geometry, summaries, and deterministic workload metadata. Apply the candidate
patch from `OV8FSt` to reproduce that rejected variant. Browser builds and OS
scheduling can change; compare fresh controls rather than treating these
numbers as fixed expectations.

## Verification and cleanup

`pnpm run check` passes with the two existing CSS `!important` warnings.
All 5,623 unit tests and all 181 portable profiler checks pass. The new checks
cover CLI rejection, equivalent travel at both speeds, input coverage,
unsupported plans, geometry changes, measurement-window event filtering,
unavailable historical telemetry, event limits, and geometry-free sampling.
The installed-Firefox captures exercise the native fast plan. No application
performance patch or dependency change remains, so this round adds no new
application browser regression workload.

Raw profiles, recordings, temporary browser profiles, and per-run binaries
are removed by the capture runner. About 553 KiB of compact summaries and
reproduction data remain. The shared, reproducible compiler cache is removed,
freeing about 196 MiB. All four runs record successful server cleanup and raw
data removal. The final process audit finds no owned profiling browser, capture
runner, or native helper left running.
