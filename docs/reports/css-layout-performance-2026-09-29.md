# CSS and row layout, September 29, 2026

The retained change replaces the assistant row's column flex layout with block
layout and gives its content `display: flow-root`. Its only in-flow child already
fills the row; the action toolbar is absolutely positioned. The inner formatting
context preserves the old flex item's margin boundary, including empty replies.
Markup, clipping, row measurement, and compositing hints stay unchanged. The user
confirms that the initial preview looks correct; regression checks catch and
correct an empty-reply spacing issue before the final measurements.

The corrected Firefox comparison shows a small direct layout saving and lower
overall main-thread CPU in the candidate run. Chrome shows no improvement in
the corrected pair. These short captures support keeping the simpler layout
for the primary Firefox target; they do not establish how much of the total
time difference comes from this CSS change, or prove smoother presentation.

## Method and conditions

The investigation uses the performance and web-perf skills, with the repository's
Firefox-first methodology. Installed Firefox is the primary timing target.
Chrome DevTools tooling supplies secondary selector and invalidation attribution.
No DevTools UI is open during the timing captures.

All captures use revision `9ca45b2` plus the recorded patches, with
`markdown-viewer` **v0.8.10**. They run in fresh temporary browser profiles on
the LU28R55 at 1920 × 1080 logical pixels, 2× scaling, and 60 Hz. The outer window
is 1900 × 1049 at 1450, 31 on macOS 27. Installed Firefox is **157.0**, build
**20260924084938**, with a 1900 × 964 inner window and 815 px chat viewport.
Installed Chrome is **154.0.8037.58**, with a 1900 × 962 inner window and 813 px
chat viewport. Comparisons stay within each browser.

The deterministic history has 20 fully loaded turns, 30 closed tool calls, and
115,395 tool-payload characters. Its workload hash is
`c95e7dbf6242aecf7ffe5cad2d56b875958f665481c8a5c7d5e1416043635e7d`.
Each run uses three down and three up native macOS gestures, with 30 events at
48 px, 16.667 ms apart, and 700 ms pauses. This covers 4,320 px each way without
paging or streaming. These scripted gestures do not reproduce real trackpad
acceleration, released momentum, or OS contention.

All captures pass the movement, scroll-end, loaded-history, and stable-size
gates. Scroll height stays 9,110 px. Firefox records 26 mounted-range changes;
Chrome records 38. No test suite runs alongside a timing capture.

## Corrected Firefox layout comparison

After fixing empty-reply margin containment, a fresh pair measures that exact
implementation. The corrected candidate runs first, followed by the restored
original control. The comparison tool accepts the browser, display, geometry,
workload, and instrumentation match. This second round addresses a code change;
it does not extend the completed first round to pad the sample count.

| Measure | Original `DR2h65` | Block + flow-root `dlMOyQ` |
| --- | ---: | ---: |
| Capture duration | 8.165 s | 8.135 s |
| Content main-thread CPU | 181.2 ms | 158.4 ms |
| Style passes / total | 93 / 26.0 ms | 88 / 23.1 ms |
| Synchronous reflows / total | 57 / 10.85 ms | 57 / 9.88 ms |
| Display-list builds / total | 60 / 19.6 ms | 60 / 18.6 ms |
| Moving rAF interval p95 | 17.02 ms | 17.00 ms |

Layout time is about 9% lower, a saving of 0.97 ms over the entire capture.
Content main-thread CPU is 12.6% lower in this pair. The small direct layout
saving does not explain all the CPU difference, and short runs retain scheduling
variation. Regular frame callbacks do not prove smoother physical presentation.

## Initial layout candidate and rejected edge case

The three timing trials interleave the candidate with original controls. The
candidate changes only the assistant row's layout property. It lacks the final
content formatting boundary and is not the retained implementation.

| Measure | Original `G3Zn2q` | Block layout `drnn7T` | Original restored `sjseTk` |
| --- | ---: | ---: | ---: |
| Capture duration | 8.223 s | 8.152 s | 8.081 s |
| Content main-thread CPU | 207.8 ms | 174.3 ms | 195.1 ms |
| Style passes / total | 88 / 27.7 ms | 88 / 25.6 ms | 89 / 27.1 ms |
| Synchronous reflows / total | 57 / 12.10 ms | 57 / 11.07 ms | 57 / 11.87 ms |
| Display-list builds / total | 60 / 21.9 ms | 59 / 19.0 ms | 60 / 21.0 ms |
| Moving rAF interval p95 | 17.04 ms | 17.12 ms | 17.06 ms |

Layout time is 7–8% lower in the candidate, an absolute saving of about 1 ms
over the entire capture. Overall content CPU is 11–16% lower, but the layout
measurement alone cannot explain that difference. There is one candidate trial,
so scheduling variation remains a limitation. Marker totals are inclusive wall
times and must not be added to sampled CPU time. Frame callbacks show no
meaningful improvement in cadence.

Although the preview looks correct, the existing empty-reply footer regression
finds a 22 px action-button gap instead of 16 px. The role label's 6 px bottom
margin collapses outside the content box after it stops being a flex item.
Adding `flow-root` to that content box restores the original geometry without
restoring the row's flex layout. All 42 footer cases pass in Firefox, Chromium,
and WebKit before measuring the corrected variant.

## Chrome selector attribution and timing

The diagnostic capture `9GQTIv` adds Chrome's
[selector-statistics trace categories](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/trace/types/TraceEvents.ts)
to the existing invalidation mode. The capture contains 182 selector-stat events,
371 selector/stylesheet pairs, and 104,790 match attempts. Reported selector
matching totals 4.861 ms. The slowest individual rules are:

| Selector purpose | Total matching time | Attempts | Matches |
| --- | ---: | ---: | ---: |
| Hide controls during streaming | 0.243 ms | 2,485 | 0 |
| Date-slot overflow exception | 0.238 ms | 406 | 0 |
| KaTeX descendant styling | 0.201 ms | 4,970 | 1,720 |

These costs do not justify broad selector rewrites. Zero matches during this
loaded-history capture do not make a rule unused: the controls and boundary
headers have other required states. The scoped footer and cursor selectors also
remain intact.

The trace records DOM removal/addition as the main source of layout invalidation.
Copy-button hover transitions generate local style updates. There is no measured
case here for rebuilding message markup or removing containment. The earlier
[browser-skipping experiment](fast-scroll-exploration-2026-09-29.md) already
rejects `content-visibility: auto` for this workload. Paint containment also has
a documented iPad rendering regression in the stylesheet.

Selector statistics and invalidation stacks have substantial overhead, as
Chrome's [profiling guidance](https://developer.chrome.com/docs/devtools/performance/selector-stats)
explains. The diagnostic capture's 127.9 ms of style recalculation is not a
production timing result. The first round's two subsequent timing trials omit
those categories and compare the original with the initial, incomplete candidate:

| Measure | Original `CyZOV7` | Block layout `5afvPc` |
| --- | ---: | ---: |
| Capture duration | 8.127 s | 8.125 s |
| Main-thread task time, CDP | 331.4 ms | 295.5 ms |
| Style recalculation total | 25.7 ms | 22.9 ms |
| Layout total | 21.8 ms | 21.4 ms |
| Paint total | 27.3 ms | 26.6 ms |
| Moving rAF interval p95 | 17.4 ms | 17.6 ms |
| Moving intervals above the long-frame threshold | 3 | 4 |

Chrome task time is an elapsed task metric, not Firefox's sampled CPU metric.
Its 11% reduction in this pair does not establish a layout-speed improvement;
layout changes by only 0.4 ms. Neither browser result proves a jitter fix.
This round does not measure physical memory or Safari performance.

The second round measures the corrected implementation against a fresh Chrome
control. It does **not** retain the initial candidate's apparent task-time gain:

| Measure | Original `tqHoeE` | Block + flow-root `f52CSA` |
| --- | ---: | ---: |
| Capture duration | 8.151 s | 8.099 s |
| Main-thread task time, CDP | 297.5 ms | 304.9 ms |
| Style recalculation total | 22.2 ms | 21.5 ms |
| Layout total | 20.3 ms | 20.6 ms |
| Paint total | 26.3 ms | 26.4 ms |
| Moving rAF interval p95 | 17.6 ms | 17.6 ms |
| Moving intervals above 25 ms | 4 | 5 |

Task time is 2.5% higher in the corrected candidate, and layout differs by
0.3 ms. A single pair cannot establish that small difference as a regression or
as noise. There is no Chrome performance gain to claim. The retained decision
rests on the Firefox result and simpler equivalent layout, with cross-engine
geometry checks. The first round uses three Firefox timing trials and three
Chrome captures, including the diagnostic; the corrected round uses two timing
trials per browser.

## Reproduction and retained tooling

Run the current layout with:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=steady \
  --steady-speed=fast --mode=timing --display=LU28R55 --refresh-hz=60 \
  --trail=off --sections=1 --stream-ms=1000 --content=prose \
  --history-content=tools --output=browser-artifacts/css-layout-exploration
```

Use `--browser=chrome` for the same native input plan in installed Chrome. Add
`--mode=diagnostic --trace-invalidations` to attribute CSS costs. The analyzer
retains full selector totals and the 64 most expensive selector/stylesheet pairs,
including matching attempts, successes, and fast rejections. It excludes events
outside the marked renderer and capture window. Selector timing is converted
from Chrome's microseconds to milliseconds.

New summaries distinguish selector statistics from older invalidation-only
captures, so the comparison tool rejects mixed instrumentation. The initial
`9GQTIv` diagnostic predates that summary field; its retained selector events and
source patch identify the instrumentation, and it is not a timing control.

Compact evidence remains under ignored
`browser-artifacts/css-layout-exploration/`. Every run preserves its command,
source patch and hashes, deterministic setup, workload, browser, and display
metadata. Use each run's `reproduce.patch` to recover the measured original or
candidate. Raw traces, profiles, screenshots, and temporary browser profiles are
removed by the runner. No captures are uploaded.

## Verification

`pnpm run check` passes with the two existing CSS `!important` warnings. All
5,623 unit tests and 182 portable profiling checks pass. The first unit run's
24 relay-test failures were loopback-server `EPERM` errors in the sandbox; the
authorized rerun passes without code changes.

The final layout passes the relevant existing browser regressions:

- `chat-footer`: 42 cases across Firefox, Chromium, and WebKit, covering seven
  reply shapes at desktop and touch widths, stable streaming completion,
  toolbar spacing, and hit targets.
- `image-cursor-spacing`: 12 cases across all three engines, preserving equal
  16 px gaps and stable static/streaming heights, with and without tool panels
  or action footers.
- `chat-simulated-tool-stability`: send and regeneration in all three engines,
  preserving tool nodes, visibility, and focus behavior.
- `chat-answer-follow`: all three engines pass the answer-start and end-follow
  cases with leading, delayed, and interleaved tools.
- `hover-layout`: Firefox and WebKit keep streaming and gallery hover rules
  limited to paint properties.

Use `pnpm run test:regression -- --match=NAME` to rerun a named script. For
`chat-footer`, repeat with `BROWSER_ENGINE=firefox`, `chromium`, and `webkit`;
the other scripts run their listed engine coverage automatically. These engine
tests establish layout correctness, not physical presentation in installed
Safari. The footer assertion now includes its actual geometry when it fails.

All ten captures record successful server cleanup and raw-data removal. Removing
the two reproducible compiler caches frees 392.5 MiB. The ten compact captures
retain about 1.52 MiB of summaries and reproduction files. The final process
audit finds no profiling browser, native helper, regression worker, or owned
server left running. The pre-existing demo server remains available on port 5173.
