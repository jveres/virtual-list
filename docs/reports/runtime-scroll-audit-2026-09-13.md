# Firefox runtime scroll audit — September 13, 2026

> Verification record, not current API guidance. Results and status apply
> to the revision and workload described below. See the
> [release plan](../streaming-integration-plan.md) for current release status.

Seven native Firefox captures found no slow wheel/scroll event handler or
animation-frame interval above 25 ms in the tested workloads. This is not a
claim that the whole app is CPU-spike-free: active streaming has substantial
short bursts of content measurement and final Markdown rendering. No runtime
patch was made.

## Environment and scope

All captures used commit `cad7e6edd41e3efa6cd9340b97e4546f83aa7924`, on clean
`main`, with installed Firefox 155.0.1. The LU28R55 external display reported
1920×1080 logical pixels, 2× scaling, and 60 Hz. Firefox content was 1900×965
logical pixels. Each capture used a fresh temporary browser profile, closed
DevTools, 1 ms native profiling, and live collection including renderer and
compositor tracks. Raw captures remain local and ignored by Git.

## Captures

The run IDs below identify local directories under `browser-artifacts/firefox/`.
Raw captures are not included in Git. Each local capture includes
`run.json`, `profile.json`, `profile.json.gz`, `frames.json`, `summary.json`,
`cpu-audit.json`, and a final screenshot. Every run completed successfully
and removed its temporary browser profile.

| Workload | Run | Duration (s) | Scroll events / ends | RAF p95 / max (ms) | Scroll handler p95 / max (ms) | Wheel handler max (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Default 100-turn chat | `run-ZOU0jf` | 30.888 | 719 / 14 | 17.06 / 17.60 | 0.443 / 0.830 | 0.775 |
| Rich 160-turn chat | `run-aMNyPF` | 30.690 | 827 / 13 | 17.10 / 17.68 | 0.579 / 1.405 | 1.245 |
| Rich chat repeat | `run-wNo3j0` | 30.508 | 827 / 13 | 17.06 / 17.62 | 0.637 / 1.239 | 0.991 |
| 10,000 declared-height rows | `run-F82h4c` | 30.600 | 1070 / 12 | 17.04 / 17.54 | 0.281 / 1.078 | 0.223 |
| 10,000-row repeat | `run-Xmgk5C` | 29.933 | 1067 / 12 | 17.18 / 17.68 | 0.314 / 0.507 | 0.185 |
| Fast reply during scrollback | `run-Oa4JFy` | 30.117 | 725 / 13 | 17.24 / 17.64 | 0.423 / 0.808 | 0.313 |
| Fast reply repeat | `run-x9hvKo` | 29.612 | 722 / 14 | 17.04 / 17.52 | 0.478 / 0.863 | 0.923 |

All seven runs had zero intervals above the 25 ms reporting threshold.
Together they recorded 5,957 scroll events over about 212 seconds. Moving
frame counts were checked separately; these were not stationary-only trials.

Chat captures used 12 upward gestures, each with 90 native ticks of 60 pixels,
16.667 ms between ticks, and a 700 ms release pause. Rich chat imported 160
synthetic turns, including 80 replies with tables, TypeScript, math, tool
panels, and local 1280×720 PNGs. Each rich run grew the scroll surface from
21,393 to 39,651 to 57,909 pixels through two paging commits, and finished
at the same position, 7,458 pixels. Final screenshots confirm the rich
content and loaded range of 85–160/160.

The isolated runtime fixture used 10,000 rows of 40–88 pixels, a 640,000-pixel
scroll surface, and started at item 5,000. Six downward and six upward
gestures used 120 pixels per tick, twice the chat speed. Both runs traveled
from 320,000 to 384,800 pixels and back, had 12 scroll ends, maintained a
bounded mounted range, and recorded no runtime scroll-position writes.

Streaming captures sent the built-in fast long reply before measurement,
then scrolled back while tokens continued. Early scroll-height growth
confirms overlap: 14,161/14,181 to 14,751 to 14,771 pixels before the first
paging commit. The stream's randomized token delay means these are workload
repeats, not identical token schedules. These runs used a 2-second warmup
before and after setup; rich chat used 10 seconds before and after setup.
The isolated control and default chat used a 10-second warmup.

## CPU attribution

CPU values below come from the content thread's sampled `threadCPUDelta`
values, recorded in microseconds. Percentages refer to one CPU core, not
whole-machine utilization. Full 100 ms bins exclude the final partial bin.
Active-input bins exclude bins crossing the harness's input/pause phases;
these labels are not an independent measurement of physical finger release.

| Workload | Average content-thread CPU | Peak 100 ms bin | Peak active-input bin |
| --- | ---: | ---: | ---: |
| Default chat | 3.06% | 26.17% | 14.68% |
| Rich chat | 3.10% | 37.72% | 9.23% |
| Rich repeat | 3.39% | 38.86% | 10.14% |
| 10,000 rows | 3.17% | 9.36% | 9.36% |
| 10,000-row repeat | 3.49% | 6.95% | 6.95% |
| Streaming | 6.93% | 59.50% | 27.64% |
| Streaming repeat | 7.83% | 47.23% | 33.05% |

The rich-chat peaks fell in the release pauses around paging preparation,
not the active-input bins. The largest refresh tick was 13.107 ms. Source
and stack inspection identify bounded `updateWindow` staging: host rendering
followed by a batched warm layout read. The staging code pauses while a
gesture is active and preserves exact measurements before committing.

Streaming is a real CPU cost, not a zero-cost result. The largest runtime
attribution was detached measurement of the growing, unmounted reply:
729 and 858 nearest-JavaScript samples in `measureMany` and its height-read
callback. These are samples including native style/layout beneath JavaScript,
not measurements of pure JavaScript execution. The runtime measures dirty
rows together; this trace does not establish a redundant full-list scan or
a per-row read/write layout loop in the wheel/scroll handler.

The largest continuous content-thread `Awake` interval was 20.000 ms in the
first streaming run. Its markers show a 9.936 ms timer callback containing
final Markdown rendering and sanitization, a 0.942 ms refresh tick, and an
8.009 ms Firefox cycle-collection slice. It is not a 20 ms wheel handler or
one 20 ms JavaScript task. The repeat's largest `Awake` interval was
11.815 ms; its largest timer callback was 10.239 ms. No content-thread
`Awake` interval reached 50 ms in any capture.

These bursts prevent a blanket “CPU-spike-free” verdict. Removing exact
offscreen measurement or suppressing final rendering solely to flatten
the graph would change behavior; this investigation did not establish a
safe runtime patch for that goal.

## Hot-path source review

The reviewed runtime paths match the measured low handler costs:

- `scroll-settle.ts` uses passive wheel/scroll listeners and bounded input
  state. Its native boundary reads remain important to clamp/edge correctness.
- `virtual-list.ts` reconciles the visible/overscan window, skips unchanged
  ranges, and skips surviving stacked rows when mounting entrants. It does
  not scan all 10,000 items per scroll event.
- `geometry.ts` and `fenwick.ts` provide logarithmic stacked position lookup.
- `publish` avoids rebuilding public state when observable fields are
  unchanged. Host callbacks remain part of the end-to-end handler cost.
- `commitMeasured` batches mounted and detached measurements before height
  writes. `premeasure.ts` uses one connected measurement layout for a batch.

The default chat logged one paging write under the harness label `up-9`.
Raw event timing places it about 7.3 ms before that gesture's first wheel
event, following the prior scroll end. The label is set before the native
helper delivers input; this is not evidence of a write during an active
wheel gesture. Rich-chat paging writes were both labeled as release pauses.

## Reproduction and analysis

Start the local server with the repository command. The reusable fixtures
and analysis tools are tracked under `scripts/firefox-profile/`. Run-local
`setup.js` copies preserve the original setup used in each capture.

For example, from the repository root:

```sh
pnpm exec vite --host 127.0.0.1 --port 4193 --strictPort
pnpm run profile:firefox -- --display=LU28R55 \
  --url=http://127.0.0.1:4193/demos/streaming/ --layout=none \
  --setup=scripts/firefox-profile/fixtures/rich-chat.js \
  --warmup-ms=10000 --down=0 --up=12 --ticks=90 --delta=60 \
  --interval-ms=16.667 --settle-ms=700 --live
node scripts/firefox-profile/cpu.mjs browser-artifacts/firefox/run-wNo3j0
node scripts/firefox-profile/bursts.mjs browser-artifacts/firefox/run-Oa4JFy
```

For the default chat, omit `--setup` and keep the other rich-chat options.
For the declared-row control, use
`--url=http://127.0.0.1:4193/scripts/firefox-profile/fixtures/declared-rows.html`,
omit `--setup`, and set `--down=6 --up=6 --delta=120`.
For active streaming, use
`'--url=http://127.0.0.1:4193/demos/streaming/?fast-long'`,
`--setup=scripts/firefox-profile/fixtures/streaming-chat.js`, and
`--warmup-ms=2000`; keep the other rich-chat options. Repeat each workload
with identical options, one capture at a time.

At capture time, the profiling harness's 12 portable checks passed. This is tooling
verification, separate from the seven actual browser captures. No tracked
source changed, so application correctness tests were not rerun.

## Limits and conclusion

No actionable wheel/scroll-handler performance defect was identified in
these captures. This does not establish “no findings” for every workload:
streaming measurement and Markdown completion remain CPU costs, and no
before/after improvement is claimed because no runtime patch was made.

Native scripted gestures have no real trackpad momentum tail. RAF timing
does not prove smooth physical presentation. Fresh browser profiles omit
the user's normal extensions and settings. The 1 ms sampler can miss short
functions and exhibit sampling variation; handler markers and CPU deltas
are reported separately. Native stacks were inspected locally without
uploading captures; many native addresses remain unsymbolicated.

All seven temporary Firefox profiles were removed by the runner. No
profiling Firefox instance or native helper remained at the process audit.
The dedicated port-4193 server was stopped after the investigation; the
user's pre-existing development server was left running.
