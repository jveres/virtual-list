# Streaming integration Firefox profile — September 13, 2026

> Verification record, not current API guidance. Results and status apply
> to the revision and workload described below. See the
> [release plan](../streaming-integration-plan.md) for current release status.

Eight native Firefox captures did not reproduce the earlier candidate CPU
increase or identify a new wheel/scroll-handler bottleneck. Rich-history CPU
was lower in both candidate repeats; fast-streaming CPU overlapped the main
baseline. No runtime patch was justified or made. This is a scoped regression
comparison, not a claim that streaming is CPU-spike-free or that physical
presentation is universally smooth.

This follows the [integration checkpoint](streaming-integration-checkpoint.md)
and the [Firefox-first workflow](../firefox-profiling.md). It adds native
fast-reply/scrollback evidence, which the integration checkpoint's previous
rich-history captures didn't cover.

## Environment and controls

The candidate was `732e143ba798dca9ae03634ba9a159934ec33094` on
`feat/streaming-integration`. The working tree contained documentation-only
changes; no runtime, demo, or profiling-tool source changed during this work.
The baseline was an exported source snapshot of main commit
`7caef9adbb94f7301320848ec996141781c1ef66`.

All eight captures used installed Firefox 155.0.1, fresh temporary browser
profiles, closed DevTools, and live native profiling with a 1 ms sampling
interval. Renderer and compositor tracks were present in every capture.
The LU28R55 reported 1920×1080 logical pixels, 2× scaling, and 60 Hz.
Firefox's inner window was 1900×965 CSS pixels at 2×, positioned on that
display. No normal browser profile, personal transcript, or remote provider
was used. Raw data wasn't uploaded.

The candidate ran on port 4193 and the exported baseline on port 4194. Both
used the same installed dependencies. The baseline's only configuration
adjustment permitted Vite to serve those shared renderer assets; application
source was unchanged. An initial baseline `pnpm exec` launch refused an
automatic dependency-install attempt. Starting the installed Vite executable
directly resolved setup without installing dependencies or recording a failed
browser trial.

Captures ran sequentially in candidate/main/candidate/main order for each
workload. Browser caches were fresh, with the documented warmup before
measurement; local dependency optimization and OS caches weren't reset.
Offline CPU analysis between launches finished before the next measurement
window. No second profiling browser ran concurrently.

## Workloads and movement

Both workloads used 12 upward native gestures, each with 90 ticks of 60
pixels, a requested 16.667 ms interval, and a 700 ms release pause. These
scripted gestures include release phases but no real trackpad momentum.

Rich history imported the tracked 160-turn synthetic fixture: tables,
TypeScript, math, tool panels, and local 1280×720 PNGs. Warmup was 10 seconds
before and after setup. All four runs completed two prepends with comparable
position sequences. Candidate height progressed from 21,400 to 39,664 to
36,620 pixels; main progressed from 21,393 to 39,651 to 57,909 pixels.
The small initial differences reflect the candidate's existing row-rounding
change. The lower candidate final height reflects intended tail eviction,
not missing paging progress. Its inspected screenshot showed retained
messages 85–132/160, with the same rich content at the reading point.

Fast streaming used the built-in long reply and a 2-second warmup before
and after setup. The reply's configured token delays are randomized between
4 and 12 ms, so schedules aren't identical. Early scroll-height growth
confirmed generation overlapped measurement: candidate 14,204/14,224 to
14,774 pixels, and main 14,161 to 14,771 pixels, before the first prepend.
Each run completed three paging writes. The stream finalized early in the
roughly 30-second window; reported average CPU includes subsequent scrollback,
not 30 seconds of continuous generation or a maximum-throughputput benchmark.

All runs recorded substantial movement and 12–14 scroll-end events. Across
the eight captures there were 6,200 scroll events, with matching moving-frame
counts. Short edge pauses remain in the workload; the first candidate
streaming run reached the top one gesture earlier because its third prepend
landed before that gesture. The repeat and both main runs reached it during
the final gesture. This limits exact full-window CPU comparisons.

## Measurements

The run IDs identify local-only directories under `browser-artifacts/firefox/`.
CPU is sampled content-thread CPU as a percentage of one core, not whole-app
or whole-machine utilization. Handler durations are wall-clock marker times.

| Workload | Version | Run | Duration (s) | Scroll events / ends | RAF p95 / max (ms) | Scroll handler p95 / max (ms) | Average CPU |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Rich history | Candidate 1 | `run-xANCym` | 30.65 | 827 / 13 | 17.20 / 17.66 | 0.473 / 0.940 | 2.63% |
| Rich history | Main 1 | `run-YvtAXe` | 30.71 | 827 / 13 | 17.06 / 17.62 | 0.562 / 1.030 | 2.97% |
| Rich history | Candidate 2 | `run-7FgcGE` | 30.58 | 823 / 12 | 17.18 / 17.66 | 0.434 / 0.844 | 2.30% |
| Rich history | Main 2 | `run-2mZQ1N` | 30.70 | 824 / 13 | 17.10 / 17.66 | 0.510 / 1.086 | 2.89% |
| Fast streaming | Candidate 1 | `run-FBqlxx` | 30.43 | 723 / 14 | 17.08 / 17.48 | 0.437 / 0.907 | 7.07% |
| Fast streaming | Main 1 | `run-TaQZAQ` | 30.20 | 726 / 13 | 17.32 / 17.62 | 0.405 / 0.728 | 6.94% |
| Fast streaming | Candidate 2 | `run-Gj9v3H` | 30.73 | 723 / 13 | 17.06 / 17.66 | 0.401 / 0.774 | 6.96% |
| Fast streaming | Main 2 | `run-e9m60j` | 30.27 | 727 / 13 | 17.10 / 17.66 | 0.436 / 0.710 | 7.22% |

Every run had zero animation-frame intervals above 25 ms. The largest wheel
handler across all runs was 1.132 ms, on main rich history; the candidate
maximum was 1.051 ms. Streaming wheel handlers peaked below 0.45 ms.

CPU bins and awake intervals expose work that average CPU can hide:

| Workload/version | Active-input 100 ms CPU-bin p95 | Peak 100 ms CPU bin | Longest content-thread awake interval |
| --- | ---: | ---: | ---: |
| Rich candidate 1 | 6.03% | 38.69% | 8.598 ms |
| Rich main 1 | 6.86% | 40.26% | 10.056 ms |
| Rich candidate 2 | 5.42% | 37.01% | 8.298 ms |
| Rich main 2 | 6.57% | 37.20% | 8.525 ms |
| Streaming candidate 1 | 27.58% | 43.73% | 12.520 ms |
| Streaming main 1 | 26.09% | 43.41% | 10.906 ms |
| Streaming candidate 2 | 26.74% | 41.17% | 12.691 ms |
| Streaming main 2 | 27.48% | 52.85% | 35.851 ms |

Telemetry was present in every compared content thread. Full 100 ms bins
exclude the last partial bin; active-input statistics exclude bins crossing
harness phases. Bin boundaries have sampling uncertainty. Neither a CPU bin
nor an awake interval represents a single JavaScript task.

## Attribution and findings

The larger rich-history CPU bins occurred during settled page preparation,
not active-input bins. Candidate stacks show Markdown rendering, collapsed
message preparation, and batched detached measurement. The earlier candidate
CPU increase didn't repeat in this interleaved comparison. Different retained
windows and normal sampling variance prevent treating the lower values as a
proven speedup.

Growing offscreen reply measurement remains the dominant runtime attribution
during streaming. `measureMany` and its height-read callback accounted for
773 and 728 nearest-JavaScript samples in the candidate, versus 775 and 823
on main. These samples include native style/layout below JavaScript; they
aren't pure JavaScript CPU measurements. The captures don't establish a new
pager hot-path bottleneck, redundant full-list scan, or a reason to weaken
exact measurement.

Candidate finalization bursts included transcript serialization/parsing for
host persistence and Markdown post-processing. Their largest timer callbacks
were 11.788 and 12.108 ms. Main's second streaming capture had a larger
35.851 ms awake interval containing an 18.175 ms timer callback, refresh work,
cycle-collector preparation, and an 8.115 ms collection slice. That interval
wasn't a 35 ms scroll handler or one continuous JavaScript task. It also
shows why regular frame callbacks alone cannot establish smooth presentation.

All rich-history writes were recorded in settle phases. Streaming had three
writes per run; one candidate write carried the harness label `up-9`.
Raw event alignment places it about 7.6 ms before that gesture's first wheel
event and about 101.6 ms after the prior scroll end. The label is assigned
before native delivery. It isn't evidence of a correction during active
wheel input; the repeat's writes all carried settle labels.

No new actionable runtime regression was identified in these two workloads.
The evidence supports proceeding past the earlier CPU-variance question for
this candidate. It doesn't establish statistical equivalence, eliminate
existing streaming costs, or close installed-Safari, scoped-typography,
hands-off follow, real-trackpad, or final release-approval checks.

## Reproduction

Serve the candidate on port 4193 and an isolated main export on port 4194,
using the same installed renderer assets. Run one browser at a time and keep
the profiling window in front. For each workload, capture candidate, main,
candidate, main in that order.

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url=http://127.0.0.1:4193/demos/streaming/ --layout=none \
  --setup=scripts/firefox-profile/fixtures/rich-chat.js \
  --warmup-ms=10000 --down=0 --up=12 --ticks=90 --delta=60 \
  --interval-ms=16.667 --settle-ms=700 --live

pnpm run profile:firefox -- --display=LU28R55 \
  '--url=http://127.0.0.1:4193/demos/streaming/?fast-long' --layout=none \
  --setup=scripts/firefox-profile/fixtures/streaming-chat.js \
  --warmup-ms=2000 --down=0 --up=12 --ticks=90 --delta=60 \
  --interval-ms=16.667 --settle-ms=700 --live
```

Change only the URL's port to 4194 for the baseline. Inspect each run with
the existing `cpu.mjs`, `bursts.mjs`, and `attribute.mjs` offline tools under
`scripts/firefox-profile/`. CPU and burst tools read the raw capture and
don't upload or modify it.

## Verification and cleanup

`pnpm run test:firefox-profile` passed all 24 portable checks, and
`pnpm run check` passed. Application unit/browser regressions weren't rerun
because no application or tooling code changed. The eight native captures
are the new performance evidence, separate from these tooling checks.

Every capture completed and removed its temporary Firefox browser profile.
The final process audit found no profiling Firefox, native helper, or owned
server remaining. Both task-owned servers were stopped; the pre-existing
development server was preserved. The temporary main source export was
removed and can be recreated from Git. Raw captures, metadata, screenshots,
and setup copies remain local under ignored `browser-artifacts/`.

No runtime patch, new example app, commit, push, tag, or publication was made.
The earlier API-documentation changes remain intact and uncommitted.
