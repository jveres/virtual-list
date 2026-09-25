# Profile complex streaming chat in real browsers

Use `pnpm run profile:chat` to capture the actual streaming demo while a local
server delivers a repeatable, complex response. Start with installed Firefox.
Then repeat in installed Chrome and Safari. The workflow keeps compact results
and reproduction recipes, reports unsupported metrics, and separates timing trials
from more expensive diagnostic instrumentation.

This method helps locate work that can cause missed frames. It does not certify
jitter-free physical presentation. A smooth animation-frame trace can coexist
with compositor, input-delivery, or display problems. Follow the
[Firefox-first methodology](firefox-profiling.md), including real trackpad
captures when release or momentum matters.

## Run a capture

The runner owns its server and browser session. Run from the repository root
with dependencies installed. Native display placement and input require macOS,
installed browsers, Swift Command Line Tools, and Accessibility permission.
Keep the test window in front and avoid other activity during measurement.

```sh
# Discover displays. Use the affected display for every comparison.
pnpm run profile:firefox -- --list-displays

# Automatic end-follow while the complete response streams.
pnpm run profile:chat -- --browser=firefox --display=LU28R55 --mode=timing

# Same workload, with operation spans and DOM-access counters.
pnpm run profile:chat -- --browser=firefox --display=LU28R55 --mode=diagnostic

# Read older content while the reply continues offscreen.
pnpm run profile:chat -- --browser=firefox --display=LU28R55 \
  --scenario=scrollback --mode=diagnostic

# Real trackpad input, including release and momentum.
pnpm run profile:chat -- --browser=firefox --display=LU28R55 \
  --scenario=manual --seconds=40 --stream-ms=30000
```

The default reply has 48 sections with tables, TypeScript code, math, lists,
quotes, local images, a reasoning summary, and a search-tool panel. The history
has 160 turns. A local SSE endpoint supplies fixed 96-character chunks on
scheduled deadlines, including small bursts after periodic pauses. It uses the
demo's real provider parser, message updates, renderer, paging, persistence,
sticky headers, and virtual-list runtime. It makes no remote inference request
and needs no credentials. Source overlays and the endpoint exist only on the
temporary diagnostic server; application source files remain unchanged.

By default the stream lasts 12 seconds and capture lasts about 20 seconds,
including finalization and idle settling. Native Firefox scripted gestures
round the window up to whole bursts. Use `--stream-ms`, `--seconds`, `--sections`,
`--history`, and `--trail=off|short|long` to change the workload. Allow at least
three seconds after stream completion. Keep inputs identical for comparisons.
Use `--refresh-hz` if the actual display rate differs from its reported maximum.

Boot is a separate measurement. Use the existing `pnpm run profile:boot` command
against a normal demo server for cold and warm `chat:visible` timing. Streaming
captures warm the page before starting and do not measure navigation performance.

## Browser coverage

The same local stream and common recorder run in each engine. Native browser
telemetry varies, so every report includes capability flags and evidence limits.

| Browser | Automated capture | Additional evidence |
| --- | --- | --- |
| Installed Firefox | Fresh temporary profile; native macOS gestures, automatic follow, or manual input; closed DevTools. | Raw live Gecko profile, per-thread sampled CPU, layout invalidation stacks, script attribution, GC markers, and awake intervals. |
| Installed Chrome | Fresh Playwright-managed profile; native macOS gestures, automatic follow, or manual input; closed DevTools. | CDP trace, V8 sample profile, performance counters, marked-renderer event analysis, and presentation intervals when available. |
| Installed Safari 27+ | Uses `safaridriver --mcp` to launch a separate automation instance; supports follow, native scrollback, and manual input. Requires already-enabled Remote Automation. Use the standalone recorder for older Safari versions. | Common recorder and optional instrumented operations. The MCP connection uses Inspector internally; retain the same transport in comparisons. Capture Web Inspector Timelines separately for native layout, rendering, script, CPU, and memory attribution. |
| Playwright Firefox, Chromium, WebKit | Headless smoke tests of the same stream and recorder. | Correctness evidence only; not substitutes for installed-browser or physical-display measurements. |

Use matching native-browser commands:

```sh
pnpm run profile:chat -- --browser=chrome --display=LU28R55 --mode=timing
pnpm run profile:chat -- --browser=chrome --display=LU28R55 \
  --mode=diagnostic --scenario=scrollback
pnpm run profile:chat -- --browser=safari --display=LU28R55 --mode=diagnostic
pnpm run profile:chat -- --browser=safari --display=LU28R55 \
  --mode=diagnostic --scenario=scrollback
```

Safari 27's [built-in MCP server](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/)
launches its own automation instance. The runner identifies the new process,
places its window on the requested display, and closes the owned tab and driver
at completion or cancellation. It preserves pre-existing Safari processes and
does not change browser settings. The capture records its transport, driver
version, window geometry, and cleanup status in `run.json`.

On the tested Safari 27 build, HTTP WebDriver tried to attach to the regular
Safari instance, which rejected it because it was not launched for automation.
The MCP path avoids that startup failure and permits native input. Its Inspector
connection adds measurement overhead even with the Inspector UI closed. Compare
MCP captures with the same transport; use the standalone manual workflow for a
control without this connection.

The obsolete HTTP WebDriver adapter was removed from this runner. WebDriver
automation windows restrict native user input; Apple's
[WebDriver documentation](https://developer.apple.com/documentation/safari-developer-tools/webdriver)
describes those isolated windows. Use the manual workflow below on older
Safari versions and for browsers without an automated adapter.

For a Chrome style-recalculation investigation, enable invalidation stacks on
a short, reduced workload:

```sh
pnpm run profile:chat -- --browser=chrome --mode=diagnostic \
  --trace-invalidations --display=LU28R55 --refresh-hz=60 \
  --seconds=8 --stream-ms=4000 --sections=12 --history=40
```

This option records reasons, affected nodes, CSS selectors when available, and
mutation stacks. It has substantial overhead; the full default workload can
overflow Chrome's trace buffer and lose the required markers. Use it to locate
causes, then repeat the full workload without the flag to measure performance.
The runner rejects this flag outside installed Chrome diagnostic mode, and the
comparison tool rejects captures with different invalidation settings.

## Read the report

Each invocation creates a unique directory under `browser-artifacts/chat-profile/`.
The capture prints that path. Raw profiles, recordings, traces, screenshots,
and per-run helpers are removed after analysis, on success and failure. The
small summaries and source replay files remain; nothing is uploaded.

| Artifact | Purpose |
| --- | --- |
| `run.json` | Revision, dirty-file list, workload hash, original-source hashes for overlays, options, browser/display metadata, server delivery deadlines, completion, and cleanup status. |
| `summary.json` | Validity, distributions, slow-frame attribution, expensive operations, repeated-call candidates, geometry accesses, DOM churn, and paging changes. |
| `reproduce.json`, `reproduce.patch` | Exact command, revision, source hashes, and changes from that revision, including untracked source. Apply the patch in a separate worktree to reconstruct the measured code. |
| `firefox-cpu.json`, `firefox-attribution.json`, `firefox-bursts.json` | Sampled native costs and stacks across runtime, demo, renderer, and browser work. |
| `chrome-analysis.json`, `chrome-metrics.json` | Marked-renderer events, styled-element distributions, optional invalidation causes, sampled script attribution, other-thread categories including compositor/raster/GPU work, and before/after CDP performance counters. Shared-process work is not necessarily caused by this page. |

To reproduce a capture, check out its revision, apply its source patch, install
the locked dependencies, and run the saved command. Match the browser build,
display, refresh rate, and window geometry recorded in `run.json`. Verify the
workload hash and validity. This reproduces the code, synthetic input, and
procedure; OS scheduling and real trackpad timing still vary. If a new question
needs more detail, extend the analysis and rerun the fixture instead of keeping
a large raw archive.

Source replay includes integration CSS, dependency patches, and the pnpm
workspace configuration as well as application and profiling source. A patched
dependency is reconstructed by the locked install after you apply the source
patch; don't edit the installed package by hand.

Firefox burst summaries bound write details to 64 evenly spaced writes and
eight nearest input events per write. They preserve total and omitted counts.
Extend the analyzer and rerun when an event-order question needs more detail.

Chrome invalidation summaries retain the 64 most frequent cause groups, with
up to eight stack frames and eight selectors per example. They report total
records and omitted groups or example details. Counts describe invalidations,
not the duration of a style flush. Empty invalidation results in timing mode
mean that tracing category was disabled.

The most useful metrics are grouped by question:

| Question | Evidence and interpretation |
| --- | --- |
| Did the stream really run? | Expected versus delivered character/chunk counts, completion event, delivery intervals, server deadline lateness, backpressure, and cancellation. |
| Did scrolling really move? | Cached scroll positions, moving-frame intervals, wheel events, scroll-end events, and viewport state. Read moving intervals separately from idle frames. |
| Where did frame time go? | Slow frame intervals joined to overlapping synchronous spans, native sampled stacks, layout/style/paint markers, and per-thread CPU where available. |
| Was work repeated? | Calls per animation-frame interval and exact unchanged-text candidates at the same message-content host. Check tool, cursor, and mounting changes before calling them unnecessary. |
| Did geometry work multiply? | `readHeights`, `measureRows`, `commitHeight`, commit, reconciliation, publication, and sticky refresh spans; layout-sensitive property/method access counts attributed to the current instrumented caller. |
| Did DOM or retained data grow? | Mutation counts; node/image/scroll-height snapshots at capture boundaries; retained-count changes and held-state samples. Initial/final heap sizes are Chromium-only when exposed and are not leak proof. |
| Was input delayed? | Wheel-event age and handler-to-next-rAF delay. These are main-thread observations, not input-to-display latency. |
| Did the browser stall? | Long-task and long-animation-frame entries where supported; native tasks, GC slices, layout/paint, raster/compositor/GPU tracks. Missing entries mean unavailable data. |

The animation-frame sampler reads only cached numbers. Geometry and node-count
snapshots happen at capture boundaries. Diagnostic mode wraps selected
synchronous operations with `try/finally`, so exceptions and return values keep
their original behavior. The transform requires every target exactly once and
fails if source structure changes. Generated diagnostic line numbers differ
from normal source; use the operation label and recorded original-source hash.

Inclusive spans overlap. Self time subtracts only nested instrumented work;
it still includes browser work and uninstrumented descendants. Timer precision
varies by browser, so zero-duration calls are not proof of zero cost. Geometry
reads are potential flush sites, not proof that a layout was forced. Chrome's
[Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
provides additional forced-style/layout attribution for supported long frames.

## Investigate and compare

Treat invalid captures as failed evidence. A report is invalid when the stream
does not finish with the expected input, movement is insufficient, gesture
evidence is missing for a gesture scenario, the page errors, focus/visibility or
geometry changes, or a bounded telemetry buffer overflows. A load that never
becomes ready or a native display mismatch fails the runner. Fix the capture
before interpreting its timings. Reaching an edge for part of a trial still
requires inspecting the per-frame movement; a valid whole run does not validate
every individual gesture.

Use this investigation sequence:

1. Capture two timing trials on the affected display. Keep browser version,
   window, scaling, refresh rate, stream hash, trail, and scenario identical.
2. Capture the same input in diagnostic mode. Compare overall timing with the
   timing trials to estimate recorder overhead; do not use diagnostic results
   as an unqualified production benchmark.
3. Inspect `work.expensive`, `slowFrames`, and native stacks. Sort by self time
   to avoid ranking nested inclusive time as separate CPU cost.
4. Inspect `work.repeatedWithinFrame` and `unchangedTextCandidates`. Follow the
   call path and state changes. Multiple necessary calls are not a defect.
5. Form a specific hypothesis, such as repeated parsing of unchanged text or
   repeated geometry reconciliation without a state change. Use a diagnostic
   control to test that hypothesis before changing production behavior.
6. Run correctness regressions, then repeat timing captures in interleaved
   baseline/fixed order. Compare at least three trials per version. Retain compact
   summaries and reproduction recipes; report distributions and uncertainty.
7. Repeat in the other installed browsers and with real trackpad gestures.
   Validate visible jitter on the affected physical display; use manual marks,
   an external recording, or browser presentation tracks as appropriate.

The comparison command refuses changed mode, workload, browser, display/window,
refresh rate, scenario, evidence type, automation transport, or invalid runs:

```sh
node scripts/firefox-profile/chat-analysis.mjs --compare \
  browser-artifacts/chat-profile/BASELINE/summary.json \
  browser-artifacts/chat-profile/FIXED/summary.json
```

The workload also records paging state, but a follow-only run may never cross a
page boundary. Increase history or use a longer scrollback/manual trial to test
page preparation and eviction. Verify actual retained-count/status progress
before drawing paging conclusions.

Use browser-specific attribution to investigate a cost that appears in one
engine. Keep browser build and automation transport fixed within each comparison.
Retain an engine-specific patch only when repeated measurements support it and
correctness and performance checks in the other engines pass. Extend the native
analyzer and rerun the fixture when compact results lack the detail needed for a
new hypothesis. This avoids keeping raw traces indefinitely.

## Manual Safari and other browsers

The standalone server supports real input without automation interception. Use
a fresh test browser profile or private session, on the affected display.
Each reload restores the same synthetic history on this diagnostic origin.

```sh
node scripts/firefox-profile/chat-server.mjs --diagnostic --stream-ms=30000
```

Open the printed URL. With Inspector closed, press **Option+Shift+P** to start
the stream and recorder. Scroll away, release the trackpad, reverse direction,
and use **Scroll to bottom** to test catch-up. After the stream completes and
the page settles, press **Option+Shift+S** to download the recording. Keep the
recording under ignored `browser-artifacts/` and analyze it with:

```sh
node scripts/firefox-profile/chat-analysis.mjs path/to/recording.json \
  --manual --refresh-hz=60 > path/to/summary.json
```

After checking the summary, remove the downloaded raw recording. Keep the
workload hash, source revision or patch, browser build, and input procedure
with the summary so the manual workload can be repeated.

The offline command defaults to 60 Hz. Pass `--manual` only for a real-browser
capture whose display and input you verified. Record the full browser build,
display geometry, scaling, refresh rate, and input procedure alongside the
download. Stop the
server with **Ctrl+C** and close the test session when done.

For Safari native attribution, repeat the same workload in a separate diagnostic
trial with Web Inspector Timelines recording. Enable JavaScript & Events,
Layout & Rendering, CPU, and memory tracks as needed. Locate
`chat-profile-start` and `chat-profile-end`; analyze the export locally, then
remove it after saving the compact summary.
Use the existing `scripts/firefox-profile/safari-timeline.mjs` analyzer for the
supported Web Inspector export format. Record Inspector overhead separately;
do not compare this trial directly to an Inspector-closed timing baseline.
WebKit's [Timelines reference](https://webkit.org/web-inspector/timelines-tab/)
explains which layout, rendering, script, and allocation data those tracks expose.

## Verify the tools

Portable checks cover deterministic input, instrumentation drift and exception
handling, bounded recording, cleanup of wrappers, invalid evidence, comparisons,
and trace attribution. The browser regression exercises the full local stream
through Firefox, Chromium, and WebKit:

```sh
pnpm run check
pnpm test
pnpm run test:firefox-profile
pnpm run test:regression -- --group=runtime --match=chat-profiler
```
