# Streaming chat memory regression

Use `pnpm run test:memory` to check whether repeated scrolling reaches a bounded
memory plateau. The test measures installed browser processes, including graphics
allocations and compressed memory. JavaScript heap size alone misses these costs.

Start a performance investigation with the [Firefox workflow](firefox-profiling.md).
This additional test uses a fixed allocation workload. It does not determine
whether physical trackpad momentum looks smooth.

## Requirements

Run on macOS with Xcode Command Line Tools, Node.js 22 or later, and the installed
browser. Window placement and native input require Accessibility permission.
Safari requires remote automation and external agents to be enabled.

Keep the desktop unlocked and use the affected display. The runner creates an
isolated browser session, maximizes its window on the selected display, and keeps
DevTools closed. A temporary sleep assertion prevents idle display sleep during
the capture. A locked desktop, changed geometry, page error, incomplete workload,
or cleanup failure invalidates the run.

The default reference display is LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
and 60 Hz. Budgets are calibrated for this configuration. Record and review a new
baseline before applying them to different hardware, display sizes, or browser
builds. Do not increase a budget merely to make a regression pass.

## Run the workloads

Run browsers sequentially so they do not compete for the display and graphics
memory. Each command starts and closes its own local server and browser.

```sh
pnpm run test:memory -- --browser=firefox --workload=text
pnpm run test:memory -- --browser=firefox --workload=images
pnpm run test:memory -- --browser=firefox --workload=streaming
pnpm run test:memory -- --browser=firefox --workload=streaming --trail=long
pnpm run test:memory -- --browser=safari --workload=images
pnpm run test:memory -- --browser=chrome --workload=images
```

The default is twelve cycles in one trial. Use `--cycles=6` for a shorter check;
six is the minimum needed for the plateau comparison. Limit comparison rounds to
three trials per browser and variant.

The workloads exercise different allocations:

| Workload | Input |
| --- | --- |
| `text` | The default simulated conversation, including history paging. |
| `images` | 48 imported turns with 24 distinct, locally generated 4000 × 3000 JPEGs. The complete data window loads before measurement. |
| `streaming` | The built-in fast, long reply over the default history. Token-delay randomness is fixed. Scrolling overlaps the reply, then continues after completion. |

The default trail mode is `off`, matching a fresh demo profile. Pass
`--trail=short` or `--trail=long` with the streaming workload to measure trail
allocations. The runner verifies the selected setting and requires rendered
trail rectangles during scrolling. It waits for the first rectangles before
starting, and the first instant-step cycle begins with ten alternating 120-pixel
steps near the reply before traversing history. This keeps the active trail
covered even if streaming finishes while the reply is later offscreen.
Selecting a trail with another workload fails before the browser starts.
The command and summary retain the selected
mode, so comparisons cannot silently substitute a trail-disabled run.

A default cycle sends 80 upward and 80 downward instant scroll steps, 900 CSS
pixels apart, every 40 ms, with 700 ms pauses. This intentionally stresses image
resources and row recycling. It does not simulate a physical gesture.

For native macOS pixel input, add `--input=native`. The runner sends 720 events in
each direction, 100 pixels apart, every 8,333 microseconds. It verifies wheel
input, movement, and scroll-end delivery. These events include gesture phases;
they do not reproduce physical trackpad momentum. Keep that window in front.

Use `--display=NAME` to select another display. `--url=URL` uses an existing demo
server; leave source files unchanged during capture. The default owned server
disables file watching and hot reload.

For a message-layer comparison, repeat the same command with
`--message-layers=off`. The default is `--message-layers=default`, which preserves
the demo's current browser-specific hints. The runner records computed message
hints and canvas transforms at checkpoints. This option does not disable image
or canvas hints. Start each variant in a fresh session; do not compare a warm,
already-scrolled tab with a newly opened one.

Use `--canvas-layer=off` to remove the canvas's `translateZ(0)` and WebKit
`preserve-3d` hints independently. Combine both options to remove message and
canvas hints together. Image hints remain unchanged. These controls remove
explicit layer requests; browsers still choose compositing for scrolling and
other content. They do not disable the browser's compositor.

For manual testing, use `?debug-compositing=no-canvas-layer` on the streaming demo,
or `?debug-compositing=no-canvas-layer,no-message-layers` for the combined control.

For a supplementary local image transcript, use `--workload=images
--transcript=/path/to/chat.md`. This mode requires the owned server and an exported
conversation with at most 48 User/Assistant turns. The file is served only from a
random URL on the local loopback server. The report retains its hash, not its
contents. Canonical synthetic input remains the regression gate because its
expected image coverage is known.

## Understand the result

A passing result requires real movement in every cycle. The image workload also
requires all 48 message keys to be visited, all 24 image rows to decode during the
trial, and a stable document height across completed cycles. The streaming
workload must observe an active reply during scrolling and its later completion.
When a trail is requested, at least one cycle must also observe rendered trail
rectangles; an enabled setting alone is not sufficient.

The test reads `proc_pid_rusage` physical footprint and lifetime peak for owned
processes. A lifetime peak catches temporary graphics explosions even when the
allocation has already become reclaimable at a checkpoint. Process totals can
include shared accounting; they are not an exact measure of unique physical RAM.

Safari's WebKit services have `launchd` as their parent. The runner resolves each
service's responsible application and includes only the isolated Safari process
and its services. This uses a private macOS ownership API also used by
[Chromium](https://chromium.googlesource.com/chromium/src/+/24aa2a50ac03698e7ec5a11251a615b965f5874d/base/process/process_info_mac.cc).
Unavailable ownership information invalidates the run. Older captures selected
new WebKit processes by launch time and may include other applications; use new
paired captures for the compositing decision.

The reference budgets are:

| Metric | Limit |
| --- | ---: |
| Largest process lifetime peak, Firefox/Chrome | 600 MiB |
| Largest process lifetime peak, Safari | 768 MiB |
| Sum of process footprints at a cycle checkpoint | 1,400 MiB |
| Last-three-cycle median minus first-three-cycle median | 64 MiB |
| Range of the final three cycle totals | 40 MiB |

The current large-image Chrome control exceeds the provisional process-peak
limit despite bounded repeated-cycle memory. Its blank-page startup peak also
approaches that limit. Keep the failure visible; Chrome needs a comparable
original-code baseline and attribution before treating this limit as a calibrated
release gate. The [investigation report](reports/chat-memory-2026-09-29.md)
records this limitation and the rejected display-copy experiment. Firefox and
Safari have passing measured references on the configuration above.

A whole Firefox instance has a substantial parent/GPU/process baseline. A total
near 1 GiB can be stable even when the chat content process is small. Compare the
process breakdown and repeated growth as well as the total.

Each run also measures a fresh blank page at the same display geometry before
loading the demo, and a blank page ten seconds after navigating away. The latter
runs after the category diagnostics. Navigation can retain the chat in the
browser's back/forward cache, so this second blank page is not a browser-only
floor. Subtracting totals does not give an exact per-tab cost: processes can
share memory, and caches and background startup work change during a run.

The runner takes compact VM-category summaries after measurement. Firefox also
provides selected `about:memory` counters afterward; opening that page can affect
caches, so those counters diagnose ownership rather than replace the measured
peak. The test never forces garbage collection or sends global low-memory
notifications.

## Check source ownership across runtime lifecycles

The separate lifecycle diagnostic checks replacement within one list, paging
with eviction, disposal with API handles released, and disposal with old API
handles deliberately retained. It uses synthetic source items and measured
rows, without the Markdown renderer, storage, or remote assets.

```sh
node scripts/firefox-profile/runtime-retention.mjs --cycles=12 --display=LU28R55
```

The runner owns its server, installed Firefox instance, and temporary profile.
It checks movement, scroll-end delivery, paging progress, and display geometry.
Every four cycles it records process footprints, then requests Firefox's
`minimizeMemoryUsage` operation through a temporary `about:memory` tab. This
forces garbage collection, cycle collection, and memory-pressure cleanup.
Weak references count surviving source items and rendered row roots without
keeping those objects alive. Memory reporters measure the fixture's window
subtree and the content process heap separately.

Unlike `test:memory`, this diagnostic changes normal collection and cache
behavior. Use it to identify strong ownership, not to predict natural GC
timing, scrolling speed, or physical presentation. A surviving disposed handle
still owns configuration and geometry metadata. Host callbacks can also retain
source data independently. The fixture does not inspect those host stores.

Compact summaries and reproduction patches remain under ignored
`browser-artifacts/runtime-retention/`. Per-run profiles, native helpers,
compiler caches, and servers are removed. No raw heap snapshot is saved.
The [October 1 comparison](reports/runtime-retention-2026-10-01.md) records
the measured source-retention fixes and their limits.

Run the portable fixture regression with:

```sh
pnpm run test:regression -- --group=runtime --match=runtime-retention
```

It verifies lifecycle behavior in Firefox, Chromium, and WebKit. Chromium's
CDP garbage collector additionally checks item and row reachability; the
installed-Firefox diagnostic remains the primary memory comparison.

## Preserve reproducibility

Each run keeps `summary.json`, `reproduce.json`, and `reproduce.patch` under ignored
`browser-artifacts/memory/`. These record the revision, source hashes and patch,
command, workload, browser version, display geometry, and process measurements.
Source metadata is captured before launch. Temporary browser profiles, per-run
helpers, server caches, and raw process reports are removed after analysis.

The deterministic input and thresholds make this a repeatable regression test;
OS allocation and scheduling are not byte-for-byte deterministic. Failed or
invalid runs are retained as such. Never treat a stationary, locked, or
incomplete run as a low-memory success.

Run portable analyzer and profiler checks with `pnpm run test:firefox-profile`.
Keep measured findings in [the reports directory](reports/README.md), with raw
captures excluded from version control.
