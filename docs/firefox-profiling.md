# Firefox-first performance profiling

Start performance investigations with Firefox on the affected display. This
workflow captures the installed browser with native macOS scroll gestures,
without opening DevTools or touching your normal browser profile. Use the
results to identify a bottleneck before changing the runtime.

## Requirements

The capture runner requires macOS, Node.js 22 or later, the Swift compiler
from Xcode Command Line Tools, and an installed Firefox. The invoking app
needs macOS Accessibility permission for window placement and native input.
The profile analyzer and its unit checks do not require macOS.

Start a demo server in a separate terminal:

```sh
pnpm exec vite --host 127.0.0.1 --port 4193 --strictPort
```

## Record a baseline

Identify the affected display before capturing. The default target is the
first external monitor, or the built-in monitor if no external one exists.
Display indices can change when monitors are connected or disconnected.

```sh
pnpm run profile:firefox -- --list-displays
pnpm run profile:firefox -- --display=LU28R55
```

The runner creates a unique directory under `browser-artifacts/firefox/`,
launches a separate Firefox instance with a new browser profile, and sizes
its window to the selected display's usable area. It checks the browser's
position and pixel ratio against that display. It then records six downward
and four upward gestures, including pauses for native release and paging.

The child also receives temporary `MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA`
directories inside its profile. This avoids the macOS 27 profile-discovery
failure described in [Mozilla bug 2060476](https://bugzilla.mozilla.org/show_bug.cgi?id=2060476).
The runner does not request access to your regular Firefox application data
or change macOS permissions. Profile cleanup removes these directories too.

The runner requires at least 10 GiB of free disk space before starting. Swift
compilation uses one shared `.swift-cache/` in the output parent, rather than
a separate cache for every capture. After its browser exits, the runner removes
that run's temporary `browser-profile/`, including after a failed capture.
`run.json` records successful profile removal or a cleanup error. Raw captures,
metadata, logs, and screenshots remain available locally.

The runner focuses the scroll container after navigation and again after
warmup, immediately before measurement. It uses a native click on a temporary
inert overlay so Firefox's address bar cannot retain document focus. The
overlay is removed before capture, and `run.json` records the focus check.
The click does not target a photo or control.

Keep the test window in front and don't interact with other windows during
scripted gestures. Native input stops if the test Firefox loses foreground;
it does not reactivate Firefox during a gesture. The
runner closes only the instance it created, including on most failure paths.
If cleanup fails, inspect the run metadata and process before taking action;
never terminate all Firefox processes.

Use `--help` for all options. These examples change the workload:

```sh
# A short tooling smoke test, not performance evidence.
pnpm run profile:firefox -- --display=1 --down=1 --up=1 --ticks=12

# Match a different installed Firefox or a different demo.
pnpm run profile:firefox -- --firefox=/Applications/Firefox.app/Contents/MacOS/firefox
pnpm run profile:firefox -- --url=http://127.0.0.1:4193/demos/feed/ --layout=none
```

The default scroll element is `#viewport`; use `--viewport` for another
selector. The default gallery layout is masonry; use `--layout=rows` for
justified rows, or `--layout=none` outside the gallery. Other demos may need
their own setup before they contain enough content to scroll. Use manual
capture for interactive setup, or pass `--setup=path/to/setup.js` for a
repeatable workload. The file must contain a synchronous JavaScript expression
that returns a JSON-serializable value, such as an immediately invoked function.
It runs in the test page after warmup and before measurement. The runner waits
another `--warmup-ms` interval after setup so asynchronous page updates can
settle before capture. Use only trusted
local scripts; they can interact with the page and initiate requests. The runner
saves a copy as `setup.js` and records the returned value in `run.json`.

Use the tracked fixtures for repeatable local workloads:

- `scripts/firefox-profile/fixtures/rich-chat.js`: import 160 synthetic
  turns with tables, code, math, tool panels, and local PNGs into the chat.
- `scripts/firefox-profile/fixtures/streaming-chat.js`: start the built-in
  fast reply before measurement. Use a 2-second post-setup warmup so the
  reply is still streaming when capture starts.
- `scripts/firefox-profile/fixtures/complex-stream.html`: serve the synthetic
  67,760-character reply through Vite and use `complex-stream-start.js` as its
  setup expression. The fixture uses fixed chunk deadlines and supports
  `trail=off` and `trail=long` (the renderer-owned shared overlay). The
  [complex trail comparison](reports/shared-streaming-trail-2026-09-14.md)
  records the hands-off capture command and its limits.
- `scripts/firefox-profile/fixtures/declared-rows.html`: serve this page
  through Vite for an isolated 10,000-row runtime control. Pass its URL to
  `--url`, with `--layout=none` and no setup script.
- `scripts/firefox-profile/fixtures/imported-chat-wheel.js` and
  `imported-chat-marks.js`: import a private transcript served under ignored
  `browser-artifacts/`, named by the chat URL's `profile-transcript`
  parameter. The wheel variant leaves scripted gestures as the only input.
  The marks variant records a mark in `frames.json` each time you press `j`
  during a manual capture.

The [September 13 audit](reports/runtime-scroll-audit-2026-09-13.md) records the
workload parameters and commands for paired captures.

To retain renderer and GPU-process tracks that shutdown collection can omit,
add `--live`. This requires a Firefox build that supports `moz:profiler.stop`
(verified with the installed Firefox 155.0.1). The runner saves the profile
before closing its browser. It redirects that temporary browser's profile
download into the capture directory; it doesn't change your normal download
settings or upload the profile. Check `capturedThreads` to verify which tracks
are present.

```sh
pnpm run profile:firefox -- --display=LU28R55 --live
```

## Capture real trackpad gestures

Scripted native gestures include began, changed, and ended phases, but no
momentum tail. They are a repeatable baseline, not an exact replacement for
your trackpad. Use manual mode when the problem depends on momentum, gesture
speed, or a particular interaction:

```sh
pnpm run profile:firefox -- --display=LU28R55 --manual-seconds=30
```

Wait for the terminal's manual-capture message, then scroll the test window.
The script records your input without injecting gestures and closes its
browser when the requested interval ends. No scrolling makes the trial fail.

Keep manual live captures to about 50 seconds. A 90-second capture can
overflow the profiler buffer and lose its start, which the runner's analysis
requires. To compare trackpad-event delivery with display frames, run the
input analyzer. It reads captures whose buffer wrapped:

```sh
node scripts/firefox-profile/input-cadence.mjs browser-artifacts/firefox/run-ID
```

The [external-display jitter report](reports/external-display-scroll-jitter-2026-09-22.md)
explains its measures and limits. Scripted gestures can't reproduce this
kind of defect, because the helper's ticks don't match the display's frames.

## Inspect the artifacts

Each run preserves its configuration and evidence in a new directory. Nothing
is uploaded automatically, and rerunning does not overwrite earlier runs.

- `run.json`: options, monitor geometry, browser version, and completion status.
- `profile.json` and `profile.json.gz`: raw native Firefox profile.
- `frames.json`: animation-frame times, cached scroll positions, scroll-event
  counts, gesture-end counts, page progress, and the diagnostic demos' visible
  counters after each gesture.
- `summary.json`: measurement-window timing and marker summaries.
- `final.png`: a screenshot taken after measurement.
- `browser.log`: browser output, including startup or shutdown errors.
- `setup.js`: the optional workload setup expression used for this capture.
- `browser-profile/`: temporary isolated browser data, removed after shutdown.
  If interrupted cleanup leaves it behind, keep it private and confirm the
  owning browser has exited before removing it.
- `partial-frames.json`: partial evidence when a capture fails, if available.

Open the raw profile locally in [Firefox Profiler](https://profiler.firefox.com/).
Inspect the call tree, markers, and renderer/compositor tracks that are
actually present. Sharing from that interface uploads data; review the capture
and obtain authorization first. Profiles can contain source locations, URLs,
screenshots, and other sensitive data.

Regenerate a summary or run the portable analyzer checks with:

```sh
node scripts/firefox-profile/analyze.mjs browser-artifacts/firefox/run-EXAMPLE
pnpm run test:firefox-profile
```

To attribute content-thread samples and inspect captured layout
invalidations, run the attribution script. It filters function names by a
path fragment (default `/src/`, the runtime). Self samples include native
work beneath the nearest JavaScript frame, but native labels containing
page URLs do not count as JavaScript. Reflow groups identify earlier
invalidation stacks, not necessarily calls that force layout; "sync" means
non-interruptible reflow. The output includes invalidation-to-reflow delays
and counts nonempty style passes between consecutive refresh tick starts.

```sh
node scripts/firefox-profile/attribute.mjs browser-artifacts/firefox/run-EXAMPLE --filter=/src/
```

The [runtime hot path profile](reports/runtime-hot-path-profile.md) records the
corrected attribution and the limits on what it can establish.
The [measured proposal results](reports/measured-performance-proposals.md) record
retained optimizations, rejected experiments, and comparable captures.

For sampled thread CPU and the longest content-thread awake intervals, use
the additional offline tools. Both accept plain or compressed raw profiles
and print JSON to stdout without changing the capture:

```sh
node scripts/firefox-profile/cpu.mjs browser-artifacts/firefox/run-EXAMPLE
node scripts/firefox-profile/bursts.mjs browser-artifacts/firefox/run-EXAMPLE
```

CPU percentages refer to one core. Full 100 ms bins omit a final partial
bin; missing CPU telemetry is unavailable, not zero. CPU deltas are credited
to their sample timestamps, so bin boundaries have sampling uncertainty.
The burst report separates nested callbacks, collection slices, and sampled
stacks: an awake interval is not necessarily one JavaScript task.

The analyzer accepts this runner's raw live and shutdown profiles, including
compressed ones. It does not accept processed exports from Firefox Profiler
share links. Both `ff-profile-start` and `ff-profile-end` markers must exist
in the content thread. Startup, warmup, and final screenshot capture are
outside that window.

## Keep reports and tooling in Git

`browser-artifacts/` is an ignored output directory, not the home for durable
project knowledge. Keep raw profiles, run-local setup copies, trace JSON,
generated screenshots, compiled helpers, and caches there. Keep raw captures
while their investigation is open. After its report is committed, you can
prune them with the user's approval; the report, its commands, and the
tracked fixtures reproduce the workload. Keep irreproducible inputs, such as
manual trackpad captures and Web Inspector recordings, until the user
approves their removal.

Put curated reports under `docs/reports/` and list them in the
[report index](reports/README.md). Keep reusable profiling tools and synthetic
fixtures under `scripts/firefox-profile/`, and browser regressions under
`scripts/regressions/`. Reports must include the commit, workload, display,
commands, summarized results, and limitations without requiring local raw
captures to understand the conclusion. Label raw run IDs as local-only.

Before promoting an exploratory probe, remove personal paths and transcript
content, replace private examples with synthetic inputs, and add assertions
and owned-process cleanup. Do not promote generated dependency copies or
every scratch script merely because they contain JavaScript. The old
`follow-*` probes are exploratory transcript-specific tools, not portable
regressions; their end-follow, pointer, and rearm scenarios belong in the
maintained runtime regression suite. Run the synthetic
[follow/rearm regression](../scripts/regressions/runtime/follow-rearm-regression.mjs)
and [fixture smoke test](../scripts/regressions/runtime/profiling-fixtures-regression.mjs)
with:

```sh
pnpm run test:regression -- --group=runtime --match=follow
pnpm run test:regression -- --group=runtime --match=profiling-fixtures
```

These browser tests check correctness, not native gesture performance. Their
runner owns and closes its temporary server and browser instances.

## Interpret the results

Compare equivalent runs: browser version, monitor, window size, pixel ratio,
refresh rate, layout, retained items, image-loading state, and gesture pattern.
Repeat the baseline and the changed version; one faster run is not proof of
an improvement. Record whether images and caches are cold or warm.

The summary flags animation-frame intervals longer than 1.5 refresh periods.
It uses the monitor's reported maximum refresh rate by default. Set
`--refresh-hz=60`, for example, if the actual rate differs. Variable-refresh
displays need additional care when interpreting that threshold.

Keep these limits explicit in any report:

- Animation-frame callbacks measure main-thread timing, not physical display
  presentation. Regular callbacks do not rule out compositor or display jitter.
- Raw shutdown capture can omit GPU-process threads. Check `capturedThreads`
  before making claims about GPU or compositor behavior. A live capture may
  be necessary for those questions; use `--live` on supported Firefox builds.
- `scrollTop` assignment logging does not capture every possible scroll cause,
  such as `scrollTo()`, browser anchoring, layout clamps, or native APZ movement.
  The runner preserves and wraps an existing instance accessor when a diagnostic
  demo provides one, so that demo's own write telemetry continues to work.
- Marker durations are nested wall-clock durations, not independent CPU costs.
  A complete garbage-collection cycle is not one continuous blocking pause;
  inspect individual slices instead.
- Stationary time at an edge can hide a bad workload. Check moving-frame
  counts, scroll-end events, retained-page status, and scroll-height progress.
- A fresh profile excludes your normal extensions, preferences, open tabs,
  and DevTools overhead. If only the normal session jitters, investigate that
  difference instead of assuming the application is fixed.

## Lessons from the external 4K investigation

The September 6, 2026 investigation established these safeguards:

1. Use the installed Firefox version. The Playwright build was Firefox 153,
   while the affected installed browser was Firefox 155.0.1.
2. Match the external display. A smaller test window on the built-in screen
   was not representative of the LU28R55 at native 2× scaling.
3. Use native input. Playwright wheel events moved the page but did not deliver
   the release behavior needed to commit frozen paging updates.
4. Avoid layout reads in the animation-frame sampler. Read the scroll position
   in a capturing scroll listener, before application mutation, and sample
   only that cached value in animation frames.
5. Keep launches sequential and isolated. A profiler feature warning did not
   mean Firefox had exited; retrying against the same browser profile caused
   a duplicate-launch collision. This runner uses a fresh directory each time.

The clean Firefox 155.0.1 trial captured 868 scroll events across three pages
on the external monitor. Its maximum animation-frame interval was 17.52 ms,
with no programmatic `scrollTop` assignments during measurement. That result
did not reproduce the reported persistent jitter and was not treated as a fix.

## Next steps

After identifying a repeatable bottleneck, make a scoped change, repeat the
same capture, and run the relevant correctness regressions. Preserve both
runs and state what improved and what remains unverified.
