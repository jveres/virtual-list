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

To separate historical tool construction from ongoing streaming, add
`--history-content=tools` and use a short reply:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=scrollback \
  --display=LU28R55 --mode=diagnostic --seconds=30 --stream-ms=1000 \
  --sections=1 --content=prose --history=160 --history-content=tools
```

This keeps the rich history's visible text and adds two closed thinking panels
and one search result per assistant, with bounded synthetic string payloads.
Tool history supports up to 320 turns to fit the probe's localStorage seed.
The default `--history-content=rich` preserves the original workload. Check
the loaded range in the summary: a run that only traverses retained rows does
not measure new-page construction. The
[DOM-operation report](reports/dom-scroll-operations-2026-09-29.md) records both
cases and their limits.

Boot is a separate measurement. Use the existing `pnpm run profile:boot` command
against a normal demo server for cold and warm `chat:visible` timing. Streaming
captures warm the page before starting and do not measure navigation performance.

## Profile steady scrolling through loaded messages

Use `steady` to measure scrolling through existing content without sending a
reply or loading another page. This scenario supports installed Firefox and
Chrome and requires exactly 20 history turns, which is also its default.
Start with Firefox:

```sh
pnpm run profile:chat -- --browser=firefox --display=LU28R55 \
  --scenario=steady --mode=timing
```

The setup loads the whole conversation and chooses an interior starting point.
The fixed plan sends three downward gestures followed by three upward gestures,
each with 90 native events at 16 px per event and 16.667 ms intervals. A 700 ms
pause follows each gesture. The planned travel is 4,320 px in each direction;
capture takes about 15 seconds including native control overhead. `--seconds`
does not change this plan. Setup fails if the content cannot provide a viewport
of clearance at both ends of the travel band.

Add `--steady-speed=fast` to cover the same travel band at three times the
input speed. Each gesture then contains 30 native events at 48 px per event,
still 16.667 ms apart, or about 2,880 px/s. Capture takes about eight seconds
including the same 700 ms pauses and native control overhead. The default
`--steady-speed=normal` uses about 960 px/s. Both are uniform scripted input;
neither reproduces trackpad acceleration or released momentum.

Use `--browser=chrome` for a secondary layout or CSS attribution check with the
same native plan. Compare timing within one browser: browser chrome changes the
available viewport height, and layout engines can choose different row ranges.

Validity requires the following conditions throughout the capture:

- All 20 turns remain loaded, with a constant item count and no paging,
  navigation handoff, or held states.
- The modeled content size remains constant through every sampled state and
  frame. Initial and final viewport height and scroll height must match.
- No response request, stream delivery, or streamed character is recorded.
  `stream.done: false` is expected because no reply starts.
- At least 3,240 px of movement occurs in each direction, with at least four
  mounted-range changes. Diagnostic mode also requires at least four mounts
  and four unmounts.
- At least 405 of the planned 540 normal-speed wheel events, or 135 of the
  planned 180 fast-speed events, and six scroll-end events are recorded. A
  truncated gesture sequence cannot pass on travel alone.
- The viewport stays inside the interior range, and the usual focus, display,
  scroll-end, and telemetry checks pass.

Start with timing mode for native CPU samples. Use `--mode=diagnostic` for
operation and DOM counters, and compare captures with the same mode and inputs.
The generated `reproduce-setup.js` and recorded gesture plan preserve the setup
without retaining raw profiles. Native events include gesture phases but no
momentum phase; use a manual capture for real trackpad release behavior.

The setup also listens for `contentvisibilityautostatechange` without reading
geometry. `steady.browserSkipping` counts transitions into skipped rendering
and back into rendered content during measurement. These are event counts,
not numbers of unique rows, bytes saved, or paint durations. Older recordings
without the listener report this metric as unavailable. A capture that reaches
the 1,000-event telemetry cap is invalid. The runtime does not enable
`content-visibility: auto`; this metric supports controlled experiments.

To separate pointer-hover work from row recycling, repeat a scripted Firefox
`steady` or `scrollback` capture with `--pointer-x=0.02`. The value is a fraction
of the viewport width; the default is `0.5` (center), and the accepted range is
`0.01..0.99`. On a wide chat viewport, `0.02` places the pointer in the empty
left gutter. This does not disable hover styling or change application behavior.
Check `run.json` → `browser.gesturePoints`: it retains the actual client/screen
coordinates and whether each gesture starts over a message. A narrow viewport
may have no empty gutter. The control is rejected for manual input, automatic
end-follow, and other browsers. Compare matched movement and row changes before
attributing a timing difference to pointer position.

### Exercise inline raster images

Add `--history-content=images` to exercise image source restoration as rows are
removed and mounted again. This preset requires exactly 20 history turns and
adds one distinct 960×360 PNG to each of the 10 assistant replies:

```sh
pnpm run profile:chat -- --browser=firefox --display=LU28R55 \
  --scenario=steady --mode=timing --history-content=images
```

The replies keep the rich fixture's text, tables, and code. Each image has an
inline data URL and explicit width and height. The generator creates seeded
pixel noise with a four-color PNG palette before capture. It uses no remote
assets or private content, and no generated binary files need to be committed.
The existing `rich` and `tools` presets remain unchanged.

The generator enforces a 2 MiB limit for the serialized 20-turn history and a
5 MiB limit for its estimated UTF-16 localStorage footprint. These limits bound
fixture input, not browser heap, decoded image memory, or GPU allocation.
Workload metadata records the image count, dimensions, PNG asset bytes, inline
source bytes, serialized history bytes, and estimated storage bytes.

For replay, match `historyImageGenerator.node` and
`historyImageGenerator.zlib` as well as the workload hash. Fixed seeds reproduce
the pixels, but compression output can differ between Node or zlib versions.
The workload hash covers the generated sources through the serialized turns
and response events; compare that hash before attributing a timing difference
to application code.

Steady image captures require at least one mounted image at each boundary,
with every mounted image reporting `complete: true` and natural dimensions of
960×360. The summary keeps the existing `imageBoundaries[].decoded` field name
for this readiness count and records its limitation. The probe does not await
`img.decode()`, observe GPU readiness, or measure physical presentation.
Data and blob display URLs both pass, so changing the display representation
does not invalidate an otherwise matched comparison. Boundary image reads run
only at capture start and finish, never in the animation-frame sampler.

## Compare a renderer fix before release

Use the same local-renderer preview as the demo when testing a fix in the owning
`../markdown-viewer` checkout. Build that checkout first with `pnpm run build`,
then run the capture here:

```sh
MARKDOWN_VIEWER_LOCAL=1 pnpm run profile:chat -- --browser=firefox \
  --display=LU28R55 --scenario=follow --mode=diagnostic
```

The preview uses a separate Vite cache. Its reproduction record includes the
renderer revision, source hashes, build command, and `upstream.patch`. Capture
an unchanged owner build before the candidate so both sides use the same module
loading path. Normal captures and normal demo builds keep the pinned dependency.

For a parser change, build `../comrak-wasm` with its Rust/Wasm toolchain and add
`COMRAK_WASM_LOCAL=1`. This works independently of the renderer preview, so a
parser comparison can retain the released renderer on both sides. The record
includes the parser revision, source hashes, generated JS/WASM hashes, available
build-tool versions, build command, and `parser.patch`. Renderer previews also
record generated runtime hashes. Compare rebuilt hashes before capturing;
source hashes alone cannot detect a stale preview build.
The same environment variables also select owner builds in `pnpm run dev`.
Use unchanged and candidate owner builds with the same preview flags; installed
dependency files remain untouched.

Pass `--content=prose` to exercise growing plain prose while retaining
the rich history, tool events, chunk size, and stream duration. The default
`--content=rich` keeps the existing Markdown workload. These measure different
parser costs; report them separately and compare identical workload hashes.

To apply bounded CPU contention, prefix the profiling command with
`node scripts/firefox-profile/cpu-contention.mjs --`. The helper runs four worker
threads, each attempting 10 ms of CPU work in a 20 ms period, and stops them when
the command exits. The reproduction record preserves these settings and the
wrapper command. This models CPU contention only; it does not reproduce GPU or
memory pressure or another application's exact scheduling.

## Profile send after loading older history

For a simulated-provider send regression, use the focused installed-Chrome
capture. This is a browser-specific exception to the Firefox-first workflow.
Supply the original transcript locally; the runner records its hash and size
without copying its contents into the report or sending it to a provider.

```sh
node scripts/firefox-profile/imported-send.mjs \
  --transcript=/path/to/local-chat.md --display=LU28R55 --refresh-hz=60
```

The runner maximizes an isolated Chrome window, imports the transcript, and
presses Page Up until the loaded history range expands. It presses Page Up once
more, lets scrolling settle, and sends a message. A capture fails if older
history did not load, the viewport is too close to the end, the glide does not
land, or focus, geometry, or recording validity changes.

`summary.json` reports time spent preparing the send, time to first scroll
movement, time to landing, frame intervals, and scroll-step distributions.
A long send task can finish before the first animation callback: regular later
frame intervals do not mean the send was responsive. `--mode=diagnostic` adds
operation costs. Reply streaming after landing is excluded because simulated
token delays are random. The shared Chrome trace covers the full four-second
capture, so inspect event times before attributing its costs to the glide.

Use the same input hash, browser build, display, window geometry, and loaded
range for comparisons. Raw traces and screenshots are removed after analysis.
Keep the original transcript in its existing private location to reproduce the
capture. `--browser=engine-firefox`, `engine-chromium`, or `engine-webkit` runs
headless correctness controls; these do not establish native performance.
Headless WebKit uses scripted viewport paging because Page Up does not reliably
scroll its focused viewport. The input method is recorded in `run.json`.
Keyboard setup does not test trackpad momentum or prove smooth presentation.

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
MCP captures with the same transport. For a follow or button control, disconnect the
owned driver before measurement:

```sh
pnpm run profile:chat -- --browser=safari --scenario=follow \
  --display=LU28R55 --refresh-hz=60 --safari-detached
```

The page waits on a local server gate. The runner terminates only its owned
driver with `SIGKILL`, waits for exit, then releases the gate. A graceful driver
exit closes Safari's automation window before it can record. The page starts
and exports the recording itself; the runner closes the owned Safari instance
afterward. `run.json` records the detached transport and cleanup. This option
requires Safari and the follow or buttons scenario; it does not support manual
gestures or scripted scrollback.

This control removes the live Inspector client during measurement. It does not
prove that connecting Inspector earlier had no lasting effect. Use the
standalone manual workflow for a session that never connects Inspector. Do not
combine connected and detached transports into one performance baseline.

The obsolete HTTP WebDriver adapter was removed from this runner. WebDriver
automation windows restrict native user input; Apple's
[WebDriver documentation](https://developer.apple.com/documentation/safari-developer-tools/webdriver)
describes those isolated windows. Use the manual workflow below on older
Safari versions and for browsers without an automated adapter.

For a Chrome style-recalculation investigation, enable invalidation stacks and
CSS selector statistics on
a short, reduced workload:

```sh
pnpm run profile:chat -- --browser=chrome --mode=diagnostic \
  --trace-invalidations --display=LU28R55 --refresh-hz=60 \
  --seconds=8 --stream-ms=4000 --sections=12 --history=40
```

This option records reasons, affected nodes, CSS selectors when available,
mutation stacks, and per-selector matching costs. `chrome-analysis.json` keeps
selector totals and the 64 most expensive selector/stylesheet pairs, including
attempts, matches, and fast rejections. Totals include omitted pairs. Zero
selector-stat events means no statistics were captured, not zero CSS cost. These
statistics identify candidates; their instrumented clocks are not clean timing
measurements. See Chrome's
[selector statistics guidance](https://developer.chrome.com/docs/devtools/performance/selector-stats).

For scrolling alone, combine the flag with `--scenario=steady`,
`--steady-speed=fast`, and `--history-content=tools`. The same workload without
the flag supplies the timing control. The
[CSS and layout report](reports/css-layout-performance-2026-09-29.md) records
the first investigation using this method.

The flag has substantial overhead; the full default workload can
overflow Chrome's trace buffer and lose the required markers. Use it to locate
causes, then repeat the full workload without the flag to measure performance.
The runner rejects this flag outside installed Chrome diagnostic mode, and the
comparison tool rejects captures with different invalidation or selector-stat
settings, including older invalidation-only captures.

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
| `reproduce-setup.js` | Generated pre-capture setup for steady scrolling; checks the loaded history and positions the viewport before measurement. |
| `upstream.patch`, `parser.patch` | Optional owner-preview source changes. The reproduction record also includes generated runtime hashes and available parser build-tool versions; generated binaries are not retained. |
| `firefox-cpu.json`, `firefox-attribution.json`, `firefox-bursts.json` | Sampled native costs and stacks across runtime, demo, renderer, and browser work. |
| `chrome-analysis.json`, `chrome-metrics.json` | Marked-renderer events, styled-element distributions, optional invalidation causes, sampled script attribution, other-thread categories including compositor/raster/GPU work, and before/after CDP performance counters. Shared-process work is not necessarily caused by this page. |
| `safari-sample-summary.json` | Optional native main-thread stack counts for a selected interval. Includes the 40 most frequent WebCore, WebKit, JavaScriptCore, and IPC symbols; recursive calls count once per stack path. |

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

`chrome-analysis.json` also retains `slowWindows`: up to eight non-overlapping
renderer events lasting at least 16 ms, with the 20 largest inclusive sampled
stacks and the 12 largest leaf self-time entries in each interval. The separate
`selfFrames` list keeps expensive leaves visible when many ancestor frames fill
the inclusive list. Both lists report omitted counts. Times are relative to the
capture marker. Nested events do not create duplicate windows, recursive
frames count once per sample, and samples are clipped to the selected interval. `selfMs` and
`inclusiveMs` are sampled wall time, not CPU utilization. Inspect
`maxSampleGapMs` before interpreting a stack: a long sampling gap weakens its
attribution. Overlapping sample intervals count once, with discarded overlap
reported as `overlappingSampleMs`. Missing CPU data produces `null` frames.
This analysis runs after capture and adds no work to the page's scroll path.
The 16 ms cutoff also retains short stalls near a 60 Hz frame budget; an
event's duration alone does not prove that a frame missed presentation.

Diagnostic probe version 4 also times native `insertBefore`, `removeChild`,
and `remove` calls. `work.domOperations` reports totals and up to 64 individual
calls lasting at least 4 ms. A large DOM rebuild can consist entirely of short
calls, so `bursts` groups mutations within the innermost instrumented operation
when its total duration reaches 16 ms. It retains up to 64 bursts, each with the
16 most expensive method/parent-tag/child-tag groups and omitted counts.

Burst records include the operation, stream phase, delivered character count,
call count, and cumulative native-call time. These timers exclude the recorder's
bookkeeping; enclosing operation spans include it. Parent classes are bounded
examples, not grouping keys. The recorder retains no text content or DOM-node
references and adds no layout reads. These diagnostics add per-mutation work:
compare the same probe version and mode, and use timing mode to assess overhead.
Missing records mean no qualifying retained event, not absence of DOM work.

Probe version 5 corrects bottom-button completion during tail restoration.
Reaching the old loaded window's end is only an intermediate destination. The
probe now requires `atEnd`, the latest transcript page loaded, and no pending
window handoff. State samples retain the latter two flags without reading DOM
geometry. Top-button completion still targets the current loaded window's
start. Version 4 captures can show an early bottom completion and cannot prove
that the restored tail was reached. Compare equal probe versions; the
[staged-layout report](reports/staged-row-layout-2026-09-26.md) separates the
version 4 performance comparison from version 5 completion validation.

Probe version 6 adds `work.domOperations.byConnection`: bounded totals for
connected insertions, moves, and removals, detached operations, no-op removals
or empty fragment insertions, and failures. Classification reads tree state
before each call, without layout reads or subtree walks. Moving a connected
node into a detached parent counts as connected removal. These are call counts,
not affected-subtree sizes or paint costs. Host image, collapse, viewer-mount,
action-state, and tool-construction spans help separate hooks from runtime
mounting. Keep probe versions and instrumentation identical in comparisons.

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
| Did tasks stall with the frames? | `--scheduler` adds timer lateness, posted-task delay, animation callback duration, and trail lifecycle markers. A frame gap with responsive timers has different evidence from a gap that also delays tasks. |

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

## Check programmatic navigation and rendered content

Use the buttons scenario to test the actual top and bottom controls during
streaming and again when idle:

```sh
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --display=LU28R55 --mode=diagnostic --scheduler --safari-detached
```

The default 12-second stream presses top at 3 seconds, bottom at 6 seconds,
top at 15 seconds, and bottom at 17.5 seconds. The scenario needs a stream
of at least 8 seconds and at least 7.5 seconds afterward. A capture fails if
any command does not reach its requested edge or scroll-end events are missing.
Edge arrival uses the runtime's cached state. Pending history can subsequently
change the scroll range while preserving the reading anchor.

`navigation` reports the frame intervals overlapping each command's first
1.8 seconds, including a long interval that started before the click. It also
records scroll writes and their instrumented callers, retaining the first
120 writes per window plus total and omitted counts. Timing mode marks these
write counts as unavailable; zero means no writes only in diagnostic mode.
`firstSmoothRequestMs` measures click-to-native-request latency.
`firstDirectionalMovementMs` measures the first sampled movement in the requested
direction after that request. Existing momentum and layout changes can also
move the viewport, so interpret the latter with the write log and workload.
Both fields are `null` when the required observation is unavailable. Request
submission alone does not prove that scrolling has started on the display.
Native animations appear as `scrollTo` requests; custom-animation frame records
are no longer collected.
These measurements do not prove that the browser displayed the content.

`coverage` checks the union of mounted, connected rows against the visible
content interval whenever the runtime publishes its viewport. It uses cached
row geometry and does not add layout reads to the animation sampler. A missing
interval suggests a window update problem. Complete coverage cannot rule out
missing paint, stale browser layers, or compositor movement between events.

For a separate Safari rendering diagnostic, keep the driver connected and take
browser screenshots during the same button sequence:

```sh
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --display=LU28R55 --mode=diagnostic --scheduler --safari-snapshots
```

The runner takes six viewport snapshots and analyzes the message column after
measurement. `run.json` records capture timing, the dominant quantized color
fraction, and horizontal luminance-edge density. A nearly uniform image can
reveal blank content; compare it with mounted coverage and the expected content.
There is no universal density threshold for all messages or themes. Browser
snapshots can force paint and add overhead, so this is separate diagnostic
evidence. It does not measure physical display presentation. Raw screenshots
follow the same automatic cleanup policy as other synthetic captures.

The comparison tool rejects different probe versions, screenshot settings,
and native-sampling settings. Compare matching timing captures separately
from these diagnostics.

## Diagnose Safari scheduling gaps

Use the optional scheduling probe when frame intervals alone cannot explain a
pause. It works in all supported browsers and requires no native tracing tool:

```sh
pnpm run profile:chat -- --browser=safari --display=LU28R55 \
  --refresh-hz=60 --mode=diagnostic --scheduler --trail=long
```

The common recorder saves both the animation timeline timestamp and callback
entry time. `frames.callbackGapMs` measures actual callback spacing;
`callbackEntryLagMs` measures how far entry follows the supplied timestamp.
Neither measures display presentation.

With `--scheduler`, `summary.json` also contains:

- `scheduling.timerLatenessMs`: delay beyond a rescheduled 16 ms timer's due
  time. The timer does not enqueue catch-up work after a stall.
- `scheduling.postRafTaskMs`: time from the frame sampler to a posted
  `MessageChannel` task. Only one task can be pending. This includes other
  callbacks, browser work, and scheduling delays; it is not a paint duration.
- `scheduling.rafCallbacks`: callback counts, total time, and maximum time.
  Slow callbacks include at most 600 characters of function source to help
  identify anonymous closures. Names can collide, and callbacks queued before
  capture are not wrapped.
- `scheduling.trailChanges`: direct trail-layer additions/removals and group
  removals, timestamped when the mutation observer delivers them. These markers
  locate cleanup but do not measure its cost.
- `scheduling.trailDisposals`: frame, callback, timer, and posted-task
  distributions overlapping each layer removal, from 100 ms before to 200 ms
  after observer delivery. This includes fast cleanup that never appears in
  the slow-frame list. An overlapping long interval retains its full duration.
- `slowFrames[].scheduling`: overlapping timer, task, and callback observations,
  plus trail changes within 100 ms of the interval.

Timer and task lateness do not identify JavaScript CPU, garbage collection, or
native rendering by themselves. Compare lifecycle timing and controlled
workloads before attributing a cause. For example, compare `--trail=long`,
`--trail=short`, and `--trail=off` in three trials to test whether a pause follows
the fade duration. These are causal controls, not equivalent visual workloads.

The probe adds a timer, posted tasks, callback wrappers, and a child-list
observer. Keep it enabled with the same version in paired measurements; the
comparison tool rejects a mismatch. Ordinary timing mode leaves these off.
No layout reads are added to the frame sampler. Raw probe records follow the
same automatic cleanup and reproduction policy as other chat captures.

### Sample native Safari work

On macOS, use the system `sample` tool to attribute a known interval without
installing Xcode or opening Web Inspector. For the default workload's final
trail cleanup:

```sh
pnpm run profile:chat -- --browser=safari --display=LU28R55 \
  --refresh-hz=60 --mode=diagnostic --scheduler --safari-detached \
  --safari-sample=13.7:2:10
```

The three values are start time in seconds, duration in seconds, and sampling
interval in milliseconds. The runner requires diagnostic mode, limits duration
to 1–10 seconds, and leaves at least one second before capture end. Adjust the
start time when changing the workload or fade duration.

The runner excludes pre-existing WebContent processes. Before measurement, it
uses a 600 ms CPU calibration in its test page to identify one new WebContent
process, then waits one second. Ambiguous ownership fails the capture. It
samples only that process, terminates its own sampler on cancellation or
timeout, summarizes the main-thread call graph, and removes the raw stack file.
The command and sampling settings are retained in reproduction metadata.

Stack counts are inclusive and overlap. They identify native work present in
the chosen interval, not exact per-frame CPU durations. Sampling suspends the
process: a 1 ms interval substantially amplified the observed Safari stall.
Use 10 ms for initial attribution, and validate improvements with separate
captures without sampling. The comparator rejects different sampling settings.

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
   baseline/fixed order. Limit each comparison round to three trials per browser
   unless the user requests more. Retain compact summaries and reproduction
   recipes; report distributions and uncertainty.
7. Repeat in the other installed browsers and with real trackpad gestures.
   Validate visible jitter on the affected physical display; use manual marks,
   an external recording, or browser presentation tracks as appropriate.

The comparison command refuses changed mode, workload, browser, display/window,
refresh rate, scenario, evidence type, automation transport, scheduling-probe
version, or invalid runs:

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
